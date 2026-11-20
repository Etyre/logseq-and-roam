/**
 * Auto-anki core: platform-independent logic shared by the Roam roam/js block and the
 * Logseq plugin. Everything here works on plain trees {uid, text, children} supplied
 * by an adapter; the adapter does all reading and writing of the graph.
 *
 * Concepts
 *   home block     a block tagged #[[auto-generate cards]] or [[LLM-generated cards]]
 *   content blocks the home block's siblings and all their descendants, plus the text of
 *                  the parent block they all sit under (LLM: read)
 *   notes          blocks under the home block in ankify_roam / ankify_logseq format (LLM:
 *                  write, except frozen notes). They are written WITHOUT the ankify tag
 *                  (unless tagCards is on): the user tags the cards they want in Anki.
 *                  A block is known to be a card by its tag or by the state block.
 *   groups         when there are more than a few notes they sit under labelled heading
 *                  blocks (at most two levels deep); a heading is any block under the
 *                  home block that is not a card and has cards below it
 *   state block    a hidden last child of the home block, "#auto-anki-state {json}",
 *                  holding the hash of what the LLM last wrote for every note, the set
 *                  of frozen (user-edited) notes and the content hash of the last run
 *
 * Config: Roam keeps the API key in this browser's localStorage ("auto-anki:apiKey") and the
 * rest in the CONFIG object of roam-adapter.js; Logseq keeps everything in the plugin settings
 * (~/.logseq/settings/logseq-auto-anki.json). The prompt and the examples live in the graph
 * (pages auto-anki/prompt and auto-anki/examples). Logs: the browser / Logseq developer console,
 * prefixed "[auto-anki]". Every system prompt starts with the shared preamble and every call
 * carries the contact_eli and note_to_eli tools (llm-contact.js, loaded before this file; a note_to_eli
 * call stops nothing: the note is kept on "llm-inbox" and in the records, marked as a note, the call is
 * acknowledged and the model is asked again, LlmContact.withNotes); when Claude uses
 * either, the run stops without touching the cards and the message is written to the graph
 * page "llm-inbox" and kept in localStorage ("llm-inbox:records"). A contact_eli call is first put
 * to the model as one question (send, or it was a remark about the task: LlmContact.withConfirm);
 * what it chooses not to send is kept in localStorage ("llm-inbox:unconfirmed").
 */
(function (root) {
  const contact = () => { if (!root.LlmContact) throw new Error("llm-contact.js is not loaded (rebuild: auto-anki/build.sh)"); return root.LlmContact; };
  const DEFAULT_HOME_TAGS = ["auto-generate cards", "llm-generated cards"];
  // adapters may replace this list from their settings (lowercase page names)
  const DEFAULT_OFF_TAGS = ["auto-anki off"];
  const settings = { homeTags: DEFAULT_HOME_TAGS.slice(), offTags: DEFAULT_OFF_TAGS.slice(), app: "auto-anki" }; // app: name recorded in the LLM inbox
  const homeTagsLower = () => settings.homeTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const STATE_TAG = "auto-anki-state";
  const DEFAULT_ANKIFY_TAG = "ankify";

  // ---------- text helpers ----------
  const norm = (s) => String(s || "").replace(/\r/g, "").split("\n").filter((l) => !/^[\w-]+::\s/.test(l)).join("\n").replace(/[ \t]+/g, " ").trim();

  function hash(str) {
    // FNV-1a 32-bit twice with different seeds -> 16 hex chars
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9747b28c;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= c; h2 = Math.imul(h2, 0x01000193) >>> 0; h2 ^= h2 >>> 13;
    }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  }

  const lowerTags = (text) => {
    const tags = [];
    const re = /#\[\[([^\]]+)\]\]|\[\[([^\]]+)\]\]|#([^\s#\[\]]+)/g;
    let m;
    while ((m = re.exec(text || ""))) tags.push((m[1] || m[2] || m[3]).trim().toLowerCase());
    return tags;
  };
  const isHome = (text) => { const h = homeTagsLower(); return lowerTags(text).some((t) => h.includes(t)); };
  const isOff = (text) => { const o = (settings.offTags || []).map((t) => String(t).trim().toLowerCase()); return lowerTags(text).some((t) => o.includes(t)); };
  /** A home block is active unless it carries an off tag or sits inside a template definition. */
  async function isActive(adapter, home) {
    if (!home || isOff(home.text)) return false;
    if (adapter.isInTemplate) { try { if (await adapter.isInTemplate(home.uid)) return false; } catch (e) {} }
    return true;
  }
  const isStateBlock = (text) => /^\s*#\[?\[?auto-anki-state\]?\]?\b/.test(text || "");

  // ---------- state ----------
  // notes[uid] = what the LLM last wrote: {hash, text, back, at}; kept after the note is frozen so
  // (text is stored WITHOUT the ankify tag: ankify_roam/ankify_logseq scan every block's text for the
  // tag, and a state block carrying "#ankify" inside its JSON would itself be turned into an Anki note)
  // the LLM's version and the user's edit can be recorded as an example.
  // examples[noteUid] = {uid, userUid, hash}: the example block on the examples page for that note.
  settings.examplesPage = "auto-anki/examples";
  // groups[uid] = {text}: heading blocks the LLM created (removed again once empty).
  function emptyState() { return { v: 4, contentHash: null, updatedAt: null, llmTags: [], notes: {}, frozen: [], examples: {}, groups: {} }; }

  function parseState(text) {
    if (!text) return emptyState();
    const i = text.indexOf("{");
    if (i < 0) return emptyState();
    try {
      const s = JSON.parse(text.slice(i));
      const st = Object.assign(emptyState(), s, { notes: s.notes || {}, frozen: s.frozen || [], llmTags: s.llmTags || [], examples: s.examples || {}, groups: s.groups || {} });
      delete st.deleted;
      return st;
    } catch (e) {
      console.warn("[auto-anki] unreadable state block, starting fresh", e);
      return emptyState();
    }
  }

  const serializeState = (state) => `#${STATE_TAG} ${JSON.stringify(state)}`;

  // ---------- notes ----------
  const backTexts = (note) => (note.children || []).map((c) => norm(c.text)).filter(Boolean);
  const rawFingerprint = (note) => hash(norm(note.text) + "\n" + backTexts(note).join("\n"));
  // The ankify tag is the user's approval mark, not part of what the LLM wrote: adding or removing
  // it must not count as an edit, so it is left out of the fingerprint.
  const fingerprint = (note) => rawFingerprint({ text: stripTag(note.text, settings.ankifyTag), children: note.children });
  /** Does the note still read as the LLM last wrote it? Also accepts hashes stored before 2026-11-20, which included the tag. */
  const matchesRecord = (rec, n) => rec.hash === fingerprint(n) || rec.hash === rawFingerprint(n)
    || rec.hash === rawFingerprint({ text: ensureAnkifyTag(stripTag(n.text, settings.ankifyTag), settings.ankifyTag), children: n.children });

  const hasTag = (text, tag) => lowerTags(text).includes(String(tag || DEFAULT_ANKIFY_TAG).toLowerCase());
  // A card is a block the user tagged or one the state block records as written by the LLM
  // (new cards carry no tag, so the tag alone no longer tells cards from headings).
  const isCard = (c, tag, state) => hasTag(c.text, tag) || !!(state && state.notes && state.notes[c.uid]);
  const hasNoteBelow = (b, tag, state) => (b.children || []).some((c) => isCard(c, tag, state) || hasNoteBelow(c, tag, state));
  const isHeading = (c, tag, state) => !isCard(c, tag, state)
    && (hasNoteBelow(c, tag, state) || (!!(state && state.groups && state.groups[c.uid]) && (c.children || []).some((k) => norm(k.text))));

  /**
   * Walk the home block's subtree: heading groups (blocks that are not cards and
   * have cards below them, or headings the LLM made that still hold something),
   * notes (every other block with text or children) and the state block. Every
   * note gets groupUid (null = directly under the home block); groups form a tree
   * and are also indexed flat by uid.
   */
  function splitChildren(children, tag, homeUid) {
    let stateBlock = (children || []).find((c) => isStateBlock(c.text)) || null;
    const known = parseState(stateBlock && stateBlock.text);
    const notes = [], groups = [], groupIndex = new Map();
    const walk = (kids, parentUid, list, depth) => {
      for (const c of kids || []) {
        if (isStateBlock(c.text)) { if (!stateBlock) stateBlock = c; continue; }
        if (isHeading(c, tag, known)) {
          const g = { uid: c.uid, text: c.text, parentUid, depth, notes: [], groups: [] };
          list.push(g); groupIndex.set(c.uid, g);
          walk(c.children, c.uid, g.groups, depth + 1);
          continue;
        }
        if (norm(c.text) || (c.children || []).length) {
          c.groupUid = parentUid === homeUid ? null : parentUid;
          notes.push(c);
          const g = c.groupUid && groupIndex.get(c.groupUid);
          if (g) g.notes.push(c);
        }
      }
    };
    walk(children, homeUid || null, groups, 0);
    return { notes, stateBlock, groups, groupIndex };
  }

  /**
   * Bring the frozen set up to date: any note whose fingerprint differs from what the
   * LLM last wrote, or that the LLM never wrote, was edited by the user and is frozen
   * for good. Returns true if the state changed.
   */
  function reconcile(state, notes) {
    let changed = false;
    const frozen = new Set(state.frozen);
    for (const n of notes) {
      if (frozen.has(n.uid)) continue;
      const rec = state.notes[n.uid];
      if (!rec || !matchesRecord(rec, n)) { frozen.add(n.uid); changed = true; }
    }
    // LLM-written notes that no longer exist were deleted by the user
    const vanished = [];
    for (const uid of Object.keys(state.notes)) {
      if (!notes.some((n) => n.uid === uid)) { vanished.push({ uid, rec: state.notes[uid] }); delete state.notes[uid]; changed = true; }
    }
    for (const uid of [...frozen]) {
      if (!notes.some((n) => n.uid === uid)) { frozen.delete(uid); changed = true; }
    }
    state.frozen = [...frozen];
    return { changed, vanished };
  }

  // ---------- examples page: the user's edits, own notes and deletions, graph-wide ----------
  const day = () => new Date().toISOString().slice(0, 10);
  const stripTag = (text, tag) => {
    const t = (tag || DEFAULT_ANKIFY_TAG).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return String(text || "").replace(new RegExp(`\\s*#\\[\\[${t}\\]\\]`, "gi"), "").replace(new RegExp(`\\s*#${t}(?![\\w-])`, "gi"), "").trim();
  };

  async function writeVersion(adapter, parentUid, label, text, back, ankifyTag) {
    const uid = await adapter.createBlock(parentUid, `${label}: ${stripTag(text, ankifyTag)}`, { last: true });
    for (const b of back || []) await adapter.createBlock(uid, b, { last: true });
    return uid;
  }

  /**
   * Record examples for newly frozen notes (edited or user-written), refresh the
   * user's version when a frozen note is edited again, and record deletions.
   * Mutates state.examples; returns true if anything was written.
   */
  async function recordExamples(adapter, home, notes, state, vanished, ankifyTag) {
    const page = settings.examplesPage;
    if (!page || !adapter.appendToPage) return false;
    let wrote = false;
    const frozen = new Set(state.frozen);
    const where = home && home.pageTitle ? ` · page: ${home.pageTitle}` : "";
    for (const n of notes) {
      if (!frozen.has(n.uid)) continue;
      const fp = fingerprint(n);
      const rec = state.notes[n.uid];
      const ex = state.examples[n.uid];
      if (!ex) {
        const label = rec && rec.text ? "EDITED" : "WRITTEN BY THE USER";
        const uid = await adapter.appendToPage(page, `${label} · ${day()}${where}`);
        if (rec && rec.text) await writeVersion(adapter, uid, "LLM wrote", rec.text, rec.back, ankifyTag);
        const userUid = await writeVersion(adapter, uid, "User's version", n.text, backTexts(n), ankifyTag);
        state.examples[n.uid] = { uid, userUid, hash: fp };
        wrote = true;
      } else if (ex.hash !== fp) {
        await adapter.updateBlock(ex.userUid, `User's version: ${stripTag(n.text, ankifyTag)}`);
        const cur = await adapter.getBlock(ex.userUid);
        if (cur) await syncBack(adapter, cur, backTexts(n));
        ex.hash = fp;
        wrote = true;
      }
    }
    for (const { uid, rec } of vanished || []) {
      const ex = state.examples[uid];
      if (ex) {
        const cur = await adapter.getBlock(ex.uid);
        if (cur && !/DELETED/.test(cur.text)) await adapter.updateBlock(ex.uid, cur.text.replace(/^(EDITED|WRITTEN BY THE USER)/, "$1, THEN DELETED"));
        delete state.examples[uid];
        wrote = true;
      } else if (rec && rec.text) {
        const exUid = await adapter.appendToPage(page, `DELETED BY THE USER · ${day()}${where}`);
        await writeVersion(adapter, exUid, "LLM wrote", rec.text, rec.back, ankifyTag);
        wrote = true;
      }
    }
    // examples for notes that vanished without a record
    for (const uid of Object.keys(state.examples)) if (!notes.some((n) => n.uid === uid)) delete state.examples[uid];
    return wrote;
  }

  async function examplesText(adapter) {
    const page = settings.examplesPage;
    if (!page || !adapter.readPageTrees) return "";
    try { return outline(await adapter.readPageTrees(page)).trim(); } catch (e) { return ""; }
  }

  // ---------- outline text for the prompt ----------
  function outline(trees, depth = 0) {
    let out = "";
    for (const t of trees || []) {
      const text = norm(t.text);
      if (text) out += "  ".repeat(depth) + "- " + text.replace(/\n/g, "\n" + "  ".repeat(depth) + "  ") + "\n";
      out += outline(t.children, depth + 1);
    }
    return out;
  }
  const contentHash = (trees) => hash(outline(trees));

  // ---------- ankify formatting ----------
  function ensureAnkifyTag(text, tag) {
    const t = tag || DEFAULT_ANKIFY_TAG;
    if (lowerTags(text).includes(t.toLowerCase())) return text;
    return text.replace(/\s+$/, "") + (/\s/.test(t) ? ` #[[${t}]]` : ` #${t}`);
  }

  /**
   * The text of a card as the tool writes it. New cards carry no ankify tag unless tagCards is
   * on: the user tags the ones they want, and only tagged blocks reach Anki.
   */
  function cardText(raw, tag, tagCards) {
    const text = stripTag(normaliseCloze(raw || "").trim(), tag);
    return tagCards ? ensureAnkifyTag(text, tag) : text;
  }

  function normaliseCloze(text) {
    // Anki's {{c1::x::hint}} -> ankify's {c1:x::hint}; never leave Anki syntax behind
    return String(text || "").replace(/\{\{c(\d+)::(.*?)\}\}/gs, (m, n, body) => `{c${n}:${body}}`);
  }

  const tagToken = (t) => (/[\s#\[\]]/.test(t) ? `#[[${t}]]` : `#${t}`);

  // ---------- "make cards here": a typed trigger or command turns any block into a home block ----------
  /** Length of a slash trigger ending `before` (the text left of the cursor), 0 when there is none. */
  function slashTriggerAt(before, triggers) {
    const lower = String(before || "").toLowerCase();
    for (const raw of triggers || []) {
      const t = String(raw).toLowerCase();
      if (!t || !lower.endsWith(t)) continue;
      const start = lower.length - t.length;
      if (start === 0 || /\s/.test(lower[start - 1])) return t.length;
    }
    return 0;
  }
  /** The block's text with the first home tag appended (unchanged when it already carries one). */
  function tagAsHome(text) {
    const t = String(text || "").replace(/\s+$/, "");
    if (isHome(t)) return t;
    return (t + " " + tagToken(settings.homeTags[0])).trim();
  }

  /** Rewrite the home block text: keep the user's words and the home tag, swap the LLM's tags. */
  function homeTextWithTags(text, oldLlmTags, newTags) {
    let t = text || "";
    for (const tag of oldLlmTags || []) {
      const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t = t.replace(new RegExp(`\\s*#\\[\\[${esc}\\]\\]`, "gi"), "").replace(new RegExp(`\\s*#${esc}(?![\\w-])`, "gi"), "");
    }
    const present = lowerTags(t);
    const add = (newTags || []).filter((x) => x && !present.includes(x.toLowerCase())).map(tagToken);
    return (t.replace(/\s+$/, "") + (add.length ? " " + add.join(" ") : "")).trim();
  }

  // ---------- prompt ----------
  const SYSTEM = `You write and maintain Anki flashcards inside a user's outliner notes (Roam Research or Logseq). A sync tool (ankify) later turns each note block into an Anki note, so the FORMAT rules are strict. The user has made thousands of cards by hand; the SELECTION and STYLE rules below describe how they do it. Follow them closely.

FORMAT
- Each flashcard is one block ("text") with optional child blocks ("back").
- Cloze notes: the deletion goes in single curly braces with a number, e.g. "The mitochondrion produces ATP through {c1:oxidative phosphorylation}." Hint after two colons: "{c1:ATP::three letters}". Deletions with the same number are revealed together; different numbers make separate cards. Never use Anki's double-brace syntax.
- Basic notes: "text" is the prompt and "back" holds the answer as one or more short strings (each becomes a child block). A basic note must have a non-empty back.
- Do not put the #ankify tag or any other tag in "text"; the user tags the cards they keep. Plain text only, apart from **bold**, __underline__ and [[Page]] links.

WHAT TO CARD
- The user's own distillation is the primary source. After reading, they distill what they learned into an organized tree (sections such as Distillation, Summary, Notes, compression, or simply their own paraphrases). Your main job is to break that tree into atomic facts and express each as a note. Raw quotes, transcripts and first-pass notes are secondary: take specific concrete facts from them too, but do not card their narrative.
- Card: definitions of named terms; the one or two headline magnitudes of a topic; the causal mechanism ("why", "how") next to a fact; a source's central claim or key distinction; comparisons and contrasts; central actors with one salient attribute; surprising or counterintuitive facts; short how-tos (1 to 3 steps) and command-to-meaning pairs.
- Do not card: the user's own reflections, evaluations, plans, todos or journal entries (they are context, never content); the author's argument or rhetoric; narrative colour and illustrative examples; incidental numbers, over-precise figures, secondary names, dates that are not anchors; lists of names without meaning; procedures or exercises (no task cards: every card has an answer).
- Numbers: round to one or two significant figures and say "about" unless the exact value is the point.
- Ephemeral facts (news, current versions, prices) only if the user distilled them, and then date-stamped: "As of 2024, ...".
- Do not model what the user already knows; they remove those cards themselves.
- If a fact is worth carding but the source looks wrong, inconsistent or unverifiable, still write the card and append " [check: <reason>]" to the end of its text.
- Coverage: the distillation is already the user's selection of what matters, so express almost all of it: everything in it that can be meaningfully broken down into atomic facts and relationships should end up in cards. Do not filter it further for importance or interest. Be selective only with raw quotes, transcripts and first-pass notes, where you take just the specific concrete facts. There is no target number of cards.

HOW TO WRITE
- Concise above all: express each note in the minimum number of syllables that still contains every important part of the idea. Most prompts and most answers have fewer than 10 words. Cut articles, hedges, connectives, repeated context and words that only restate the question; answers are one short line, often a single word, number or phrase. A list becomes several back items, with a count cue in the prompt ("[two things]"). Examples (before -> after):
  "What is the purpose of node's 'watch mode' in node?" -> "What does node's 'watch mode' do?"
  "What is the objective of an 'upsert' operation? / The objective is to save data in the database, regardless if it already exists or not." -> "What does 'upsert' do? / Save data in the database, whether or not it already exists."
  "What action does Fetch perform?" -> "What does Fetch do?"
  "When was Hamas founded? / In 1987." -> "When was Hamas founded? / 1987"
  "How can a copy of an object be made in JavaScript? / By spreading that object inside a new object." -> "JavaScript: how do you copy an object? / Spread it inside a new object."
  "What do I do if I want to know the value of a given prop? / Look where the component is implemented / used." -> "How do I check the value of a prop? / Look where the component is used."
- The answer is only what the question asks for, and then it stops. Never append an explanation, reason, qualifier or related fact to it: no second clause after a semicolon, dash or "because", no second sentence. If the extra fact is worth knowing, it becomes a separate card of its own; otherwise it is dropped. The same holds for a cloze sentence: nothing after the fact being tested. Example: "Most common move for a Senate Republican chair who hits the six-year limit? / Chair a different committee where they have seniority; the clock is per committee." -> "What do term-limited Senate GOP chairs usually do? / Chair another committee." and, as its own card, "Senate GOP chair term limits count per {c1:committee}."
- Open-ended prompts, never yes/no. "Was the public enthusiastic about WWII?" -> "What was the attitude of the American public towards WWII? / Determined to do what was needed, without enthusiasm or patriotic fervor." "Were wages frozen during WWII? / Yes." -> "What happened to wages during WWII? / Frozen."
- Atomize: a complicated, multi-part fact usually becomes several separate cards. Each card must be complete and answerable on its own, with enough context in its prompt to stand alone; together the cards should cover all or most of the content of the distillation. Do not compress a compound idea into one card with a long answer.
- Several cards per fact when they are different recall operations: "Paris is the capital of {c1:France}." and "{c1:Paris} is the capital of France." train different memories. Wherever a reversible card would help, write two cards, one in each direction (term and definition, date and event, both polarities of a relationship such as "when X rises, Y {c1:falls}" / "when X falls, Y {c1:rises}"). A cloze and a question version of the same fact are also fine when both help. Never write two cards that test the identical recall.
- Unique answer, real recall. Choose what to ask (and what to delete in a cloze) so that exactly one answer is correct: not a blank that several different words would fill acceptably, and not a question with many defensible answers. At the same time the answer must not be guessable from the rest of the sentence or from the question's own wording; if the context gives it away, delete something else or add nothing that hints. Prefer deleting the specific term, name, number or outcome over deleting a generic word.
- Cloze cards: one declarative sentence with the context first and the deleted payload at the END of the sentence, so the whole context is read before guessing. Delete a one- or two-word term, name or number. Use one number for a set that should be revealed together. A cloze note that is a full sentence ends with a period, placed after the closing brace when the deletion comes last ("Water boils at {c1:100 C}."); a fragment or bare phrase takes none.
- Basic prompts: "What is X?" / "Why did X happen?"; a bare "Term:" prompt whose back is the definition; or a sentence stem ending in "..." whose back begins with "...".
- Open with a scope anchor when the fact is ambiguous out of context ("In 1900, ...", "JS:", "In RL, ...", "Kissinger claims ..."). Underline the word that distinguishes a card from its siblings ("How many people die of aging each __year__?").
- Last step, for every card, prompt and answer alike: try to say it in fewer syllables, and keep the shorter version whenever the fact and its one correct answer survive. Replace a descriptive phrase with the short word for it ("who hits the six-year limit" -> "term-limited", "a different" -> "another", "Republican" -> "GOP"), drop every detail the card is not testing ("where they have seniority"), and prefer a plain "What do X do?" to a noun-phrase prompt like "Most common move for X who ...?". A card is finished only when no word can be removed or shortened without losing the fact.
- Keep the user's wording where it is precise; otherwise rephrase into plain, compressed speech. Keep [[Page]] links that appear in the source. Attribute claims to their source when they are claims rather than facts.

MAINTENANCE
- Existing notes marked EDITABLE are yours: update them when the content changed, delete them when their fact is gone, keep them unchanged otherwise (return them with the same uid). Notes marked FROZEN were edited by the user: never return them, never duplicate their fact.
- Return "uid" for a note you are updating and null for a new note. List uids to remove in "delete" (EDITABLE uids only).
- When there are more than a few notes they are organised under labelled headings ("groups"); the exact size rules come with each request under RESPONSE STRUCTURE.
- "tags": lowercase topic tags for the home block, as many as genuinely apply. Do not add deck or option tags; the user sets decks.
- The EXAMPLES section (if present) lists, across the whole graph, notes the user edited (your version and theirs), notes they wrote themselves, and notes of yours they deleted. They are the strongest guide to what the user wants: imitate their edits in style, length, phrasing and level of detail, and do not write the kind of note they delete.`;

  /** The built-in prompt as blocks: one block per line, "- " lines nested under the line before. */
  function defaultPromptTrees() {
    const out = [];
    for (const para of SYSTEM.split(/\n\s*\n/)) {
      let parent = null, bullet = null;
      for (const line of para.split("\n")) {
        if (!line.trim()) continue;
        if (/^  \S/.test(line) && bullet) bullet.children.push({ text: line.trim(), children: [] }); // indented example line
        else if (/^- /.test(line) && parent) { bullet = { text: line.replace(/^- /, ""), children: [] }; parent.children.push(bullet); }
        else { parent = { text: line, children: [] }; bullet = null; out.push(parent); }
      }
    }
    return out;
  }

  /** The prompt page's blocks back into text (inverse of defaultPromptTrees). */
  function promptFromTrees(trees) {
    const lines = [];
    const walk = (t, depth) => {
      const text = norm(t.text);
      if (text) lines.push(depth === 0 ? text : depth === 1 ? "- " + text : "  ".repeat(depth - 1) + text);
      for (const c of t.children || []) walk(c, depth + 1);
    };
    for (const t of trees || []) { walk(t, 0); }
    return lines.join("\n").trim();
  }

  const NOTE_SCHEMA = {
    type: "object",
    properties: {
      uid: { type: ["string", "null"] },
      text: { type: "string" },
      back: { type: "array", items: { type: "string" } },
    },
    required: ["uid", "text", "back"],
    additionalProperties: false,
  };
  const NOTES_SCHEMA = { type: "array", items: NOTE_SCHEMA };
  const LEAF_GROUP_SCHEMA = {
    type: "object",
    properties: { uid: { type: ["string", "null"] }, title: { type: "string" }, notes: NOTES_SCHEMA },
    required: ["uid", "title", "notes"],
    additionalProperties: false,
  };
  const GROUP_SCHEMA = {
    type: "object",
    properties: { uid: { type: ["string", "null"] }, title: { type: "string" }, notes: NOTES_SCHEMA, groups: { type: "array", items: LEAF_GROUP_SCHEMA } },
    required: ["uid", "title", "notes", "groups"],
    additionalProperties: false,
  };
  const SCHEMA = {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
      notes: NOTES_SCHEMA,
      groups: { type: "array", items: GROUP_SCHEMA },
      delete: { type: "array", items: { type: "string" } },
    },
    required: ["tags", "notes", "groups", "delete"],
    additionalProperties: false,
  };

  const DEFAULT_GROUPING = { threshold: 6, min: 2, max: 6 };
  const groupingOf = (g) => Object.assign({}, DEFAULT_GROUPING, g || {});

  function groupingRules(grouping) {
    const g = groupingOf(grouping);
    return `RESPONSE STRUCTURE
- Count every note that will exist after your changes (yours plus FROZEN ones). If that is at most ${g.threshold}, return them all in the top-level "notes" and leave "groups" empty.
- If it is more than ${g.threshold}, every note goes into a group under a short labelled heading ("title": a noun phrase such as "Mechanisms", "Key figures" or "Definitions"). Each leaf group holds ${g.min} to ${g.max} notes. A group may instead hold subgroups (one level only, so headings never nest more than two deep); a group holds either notes or subgroups, not both. Group by topic, in a sensible reading order.
- Existing headings are listed as [GROUP] with a uid: return the uid to keep a heading (retitle it if a better title fits), null for a new one. Headings left with no notes are removed automatically.
- Any note, EDITABLE or FROZEN, is filed under a group simply by listing it there; return FROZEN notes with their uid and their current text (any text you give for them is ignored). A FROZEN note you do not list stays where it is.`;
  }

  function buildUserMessage({ pageTitle, parentText, contentTrees, notes, groups, state, homeTags, extraInstructions, grouping }) {
    const frozen = new Set(state.frozen);
    let msg = "";
    if (pageTitle) msg += `PAGE: ${pageTitle}\n\n`;
    // the block everything sits under: often the title of the section, and source material like the rest
    if (norm(parentText)) msg += "PARENT BLOCK (the block the content blocks sit under; read-only source material, usually their heading):\n" + norm(parentText) + "\n\n";
    msg += "CONTENT BLOCKS (read-only source material):\n" + (outline(contentTrees) || "(empty)\n") + "\n";
    msg += "EXISTING NOTES:\n";
    if (!notes.length) msg += "(none)\n";
    const pad = (d) => "  ".repeat(d);
    const noteLines = (n, d) => {
      const status = frozen.has(n.uid) ? "FROZEN" : "EDITABLE";
      let out = `${pad(d)}- [${status}] uid=${n.uid}\n${pad(d)}  text: ${norm(n.text).replace(/\n/g, "\n" + pad(d) + "        ")}\n`;
      for (const b of backTexts(n)) out += `${pad(d)}  back: ${b.replace(/\n/g, "\n" + pad(d) + "        ")}\n`;
      return out;
    };
    const groupLines = (g, d) => {
      let out = `${pad(d)}- [GROUP] uid=${g.uid} title: ${norm(g.text)}\n`;
      for (const n of g.notes) out += noteLines(n, d + 1);
      for (const sub of g.groups) out += groupLines(sub, d + 1);
      return out;
    };
    for (const n of notes) if (!n.groupUid) msg += noteLines(n, 0);
    for (const g of groups || []) msg += groupLines(g, 0);
    msg += `\nCURRENT TOPIC TAGS ON THE HOME BLOCK: ${(homeTags || []).join(", ") || "(none)"}\n`;
    msg += "\n" + groupingRules(grouping) + "\n";
    if (extraInstructions) msg += `\nADDITIONAL INSTRUCTIONS FROM THE USER:\n${extraInstructions}\n`;
    msg += "\nReturn the JSON object now.";
    return msg;
  }

  // ---------- Claude API (raw HTTP: this runs inside a browser tab / plugin iframe with no bundler) ----------
  /** Read a Messages API event stream into the shape of a non-streamed response; onText gets every text delta as it arrives. */
  async function readStream(res, onText) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", usage = null, stop_reason = null, stop_details = null, model = null;
    const blocks = new Map(); // index -> { type: "text", text } | { type: "tool_use", id, name, json }
    const handle = (ev) => {
      if (ev.type === "message_start" && ev.message) { usage = ev.message.usage || usage; model = ev.message.model || model; }
      else if (ev.type === "content_block_start" && ev.content_block) {
        const b = ev.content_block;
        blocks.set(ev.index, b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, json: "" } : { type: b.type, text: b.text || "" });
      } else if (ev.type === "content_block_delta" && ev.delta && blocks.has(ev.index)) {
        const b = blocks.get(ev.index);
        if (ev.delta.type === "text_delta" && b.type === "text") { b.text += ev.delta.text || ""; if (onText && ev.delta.text) onText(ev.delta.text); }
        else if (ev.delta.type === "input_json_delta" && b.type === "tool_use") b.json += ev.delta.partial_json || "";
      } else if (ev.type === "message_delta") {
        if (ev.usage) usage = Object.assign({}, usage, ev.usage);
        if (ev.delta && ev.delta.stop_reason) stop_reason = ev.delta.stop_reason;
        if (ev.delta && ev.delta.stop_details) stop_details = ev.delta.stop_details;
      } else if (ev.type === "error") throw new Error("Claude API stream error: " + JSON.stringify(ev.error || ev));
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let ev; try { ev = JSON.parse(data); } catch (e) { continue; }
          handle(ev);
        }
      }
    }
    const content = [];
    for (const b of blocks.values()) {
      if (b.type === "tool_use") { let input = {}; try { input = JSON.parse(b.json || "{}"); } catch (e) { input = { raw: b.json }; } content.push({ type: "tool_use", id: b.id, name: b.name, input }); }
      else content.push({ type: "text", text: b.text || "" });
    }
    return { content, usage, stop_reason, stop_details, model };
  }

  /**
   * Incremental scanner over the model's JSON answer as it streams in. Calls onNote(note, groups) the
   * moment an object inside a "notes" array is complete: note is that object parsed, with note.path
   * locating it in the finished answer (e.g. ["groups", 1, "notes", 0]); groups is the chain of
   * enclosing heading objects, outermost first, each {path, uid, title} as far as the text has got
   * (title/uid null when the heading's header has not streamed yet). Tolerates any chunking.
   */
  function jsonNoteScanner(onNote) {
    let buf = "", pos = 0, inStr = false, esc = false, strStart = -1;
    const stack = []; // { type: "obj"|"arr", start, key (in the parent), count (array elements before the current one), expectKey, curKey }
    const pathOf = (frames) => frames.map((f) => f.key).filter((k) => k !== undefined);
    const header = (f, upto) => { // a heading's own "uid" and "title": the part of its text before its "notes"/"groups" key
      let t = buf.slice(f.start, upto);
      const cut = t.search(/"(notes|groups)"\s*:/);
      if (cut >= 0) t = t.slice(0, cut);
      const tm = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t), um = /"uid"\s*:\s*(null|"(?:[^"\\]|\\.)*")/.exec(t);
      let title = null, uid = null;
      try { if (tm) title = JSON.parse('"' + tm[1] + '"'); if (um) uid = JSON.parse(um[1]); } catch (e) {}
      return { title, uid };
    };
    return {
      feed(chunk) {
        buf += chunk;
        for (; pos < buf.length; pos++) {
          const c = buf[pos];
          if (inStr) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') {
              inStr = false;
              const top = stack[stack.length - 1];
              if (top && top.type === "obj" && top.expectKey) { try { top.curKey = JSON.parse(buf.slice(strStart, pos + 1)); } catch (e) { top.curKey = undefined; } top.expectKey = false; }
            }
            continue;
          }
          if (c === '"') { inStr = true; esc = false; strStart = pos; continue; }
          const top = stack[stack.length - 1];
          if (c === "{" || c === "[") {
            const key = top ? (top.type === "obj" ? top.curKey : top.count) : undefined;
            stack.push({ type: c === "{" ? "obj" : "arr", start: pos, key, count: 0, expectKey: c === "{", curKey: undefined });
          } else if (c === "}" || c === "]") {
            const f = stack.pop();
            if (!f) continue;
            const parent = stack[stack.length - 1];
            if (f.type === "obj" && parent && parent.type === "arr" && parent.key === "notes") {
              let note = null;
              try { note = JSON.parse(buf.slice(f.start, pos + 1)); } catch (e) {}
              if (note && typeof note === "object") {
                const groups = [], seen = [];
                for (const fr of stack) {
                  seen.push(fr);
                  const under = seen[seen.length - 2];
                  if (fr.type === "obj" && under && under.type === "arr" && under.key === "groups") groups.push(Object.assign({ path: pathOf(seen) }, header(fr, f.start)));
                }
                note.path = pathOf([...stack, f]);
                onNote(note, groups);
              }
            }
          } else if (c === ",") { if (top) { if (top.type === "obj") top.expectKey = true; else top.count++; } }
        }
      },
      text: () => buf,
    };
  }

  /**
   * One call; the answer streams in and onText gets each piece of the model's text as it arrives. A contact_eli
   * call is first put to the model as one question (LlmContact.withConfirm; only models it lists, else the call
   * is sent unasked): if it says the call was a remark
   * about the task, the answer is asked for again (onRestart first, so the caller can drop what the first
   * attempt streamed) and what it had said is kept as unconfirmed; otherwise the caller stops as before.
   * A note_to_eli call never stops the run and is never the answer (LlmContact.withNotes, before the confirm
   * step): the note is recorded, the call answered, and the model asked again (onRestart first), at most 3
   * times. One exception to asking again: a response that leaves a note next to a complete JSON answer is
   * taken as the answer, because a second answer would replace the first, possibly with less.
   */
  async function callClaude({ apiKey, model, effort, system, user, fetchImpl, onText, onRestart }) {
    const f = fetchImpl || root.fetch.bind(root);
    const C = contact();
    const request = {
      model: model || "claude-opus-5-5",
      system: (Array.isArray(system) ? system : [system]).filter(Boolean),
      messages: [{ role: "user", content: user }],
      tools: C.CONTACT_TOOLS.slice(), // the preamble promises Claude a way to reach Eli: contact_eli (stops the run) and note_to_eli (does not)
    };
    const send = async (messages, decide) => {
      const body = {
        model: request.model,
        max_tokens: 16000,
        stream: true,
        system: request.system.map((t) => ({ type: "text", text: t, cache_control: { type: "ephemeral" } })),
        messages,
        tools: request.tools,
        output_config: { effort: effort || "high", format: { type: "json_schema", schema: SCHEMA } },
        fallbacks: "default",
      };
      // The confirm question (decide): same model, system and tools plus a forced choice. Short, so not streamed;
      // no JSON output format, no effort and no thinking, because a forced tool cannot be combined with thinking.
      if (decide) { Object.assign(body, C.decisionRequest(request.tools), { stream: false, thinking: { type: "disabled" } }); delete body.output_config; }
      const headers = {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
        "anthropic-dangerous-direct-browser-access": "true",
      };
      let res = await f("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
      if (res.status === 400) {
        // older models / accounts: retry without structured output and fallbacks
        const err = await res.text();
        console.warn("[auto-anki] 400, retrying without output format:", err.slice(0, 300));
        if (body.output_config) delete body.output_config.format;
        delete body.fallbacks; delete headers["anthropic-beta"];
        res = await f("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
      }
      if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 400)}`);
      let data;
      if (decide) data = await res.json();
      else if (res.body && typeof res.body.getReader === "function") data = await readStream(res, onText);
      else { data = await res.json(); if (onText) for (const b of data.content || []) if (b.type === "text" && b.text) onText(b.text); } // a plain JSON reply (tests)
      if (data.stop_reason === "refusal") throw new Error("Claude declined the request" + (data.stop_details?.explanation ? ": " + data.stop_details.explanation : ""));
      return data;
    };
    const first = await send(request.messages, false);
    const app = settings.app || "auto-anki";
    const textOf = (d) => (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const answered = (d) => { try { parseJson(textOf(d)); return true; } catch (e) { return false; } };
    const noted = await C.withNotes({ app, model: request.model, system: request.system, messages: request.messages, response: first, tools: request.tools, answered, call: async (m) => { if (onRestart) await onRestart(); return send(m, false); } });
    // any error or unclear answer in the confirm step hands back the response unchanged, so check() records it
    const confirmed = await C.withConfirm({ app, model: request.model, messages: noted.messages, response: noted.response, call: async (m, decide) => { if (!decide && onRestart) await onRestart(); return send(m, decide); } });
    const data = confirmed.response;
    request.messages = confirmed.messages;
    // Claude asked for Eli (contact_eli call or an "@ELI:" line): no result, the caller stops
    const rec = C.check({ app, model: request.model, system: request.system, messages: request.messages, response: data, tools: request.tools });
    if (rec) return { contact: rec, notes: noted.notes, usage: data.usage, model: data.model, request };
    return { result: parseJson(textOf(data)), notes: noted.notes, usage: data.usage, model: data.model, request };
  }

  /** Notes Claude left for Eli (note_to_eli), already recorded and answered: put each on the page "llm-inbox" and tell the user, quietly. The run carries on. */
  async function showNotes(adapter, notes) {
    const C = contact();
    const page = settings.inboxPage || C.INBOX_PAGE;
    for (const rec of notes) {
      const blocks = C.pageBlocks(rec);
      try {
        if (adapter.appendToPage) { const uid = await adapter.appendToPage(page, blocks.text); for (const c of blocks.children) await adapter.createBlock(uid, c, { last: true }); }
      } catch (e) { console.error("[auto-anki] could not write to the inbox page", e); }
      if (adapter.notify) { try { adapter.notify(`Claude left Eli a note (recorded on ${page}; the cards are still being written): ${rec.message.slice(0, 200)}`, "info"); } catch (e) {} }
    }
  }

  /** Record a contact in the graph (page "llm-inbox") and tell the user; the run stops after this. */
  async function recordContact(adapter, rec) {
    const C = contact();
    const page = settings.inboxPage || C.INBOX_PAGE;
    const blocks = C.pageBlocks(rec);
    try {
      if (adapter.appendToPage) { const uid = await adapter.appendToPage(page, blocks.text); for (const c of blocks.children) await adapter.createBlock(uid, c, { last: true }); }
    } catch (e) { console.error("[auto-anki] could not write to the inbox page", e); }
    if (adapter.notify) { try { adapter.notify(`Claude asked to reach Eli instead of writing cards: ${rec.message.slice(0, 200)} (recorded on ${page})`, "warning"); } catch (e) {} }
    console.warn("[auto-anki] contact recorded", rec.id, rec.message);
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) {}
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
    throw new Error("Claude did not return valid JSON");
  }

  /**
   * Turn the model's answer into concrete operations, honouring frozen notes (their text
   * and back are never changed and they are never deleted, but they can be moved).
   * Returns { creates:[{text, back, group}], updates:[{uid, text, back, group}], deletes:[uid],
   * moves:[{uid, group}], groups:[planned group tree], tags:[] }. "group" is a planned
   * group object ({uid|null, title, parent, notes, groups}) or null for the home block;
   * its uid is filled in when the heading is created.
   */
  function plan(result, notes, state, ankifyTag, groupIndex, tagCards) {
    const frozen = new Set(state.frozen);
    const byUid = new Map(notes.map((n) => [n.uid, n]));
    const known = groupIndex || new Map();
    const ops = { creates: [], updates: [], deletes: [], moves: [], groups: [], tags: [] };
    const seen = new Set(), seenGroups = new Set();
    const handleNote = (raw, group) => {
      let text = cardText(raw.text, ankifyTag, tagCards);
      // an existing card keeps the tag the user (or an earlier version) gave it
      if (raw.uid && byUid.has(raw.uid) && hasTag(byUid.get(raw.uid).text, ankifyTag)) text = ensureAnkifyTag(text, ankifyTag);
      const back = (raw.back || []).map((b) => normaliseCloze(String(b)).trim()).filter(Boolean);
      if (!norm(text)) return;
      if (raw.uid && byUid.has(raw.uid) && frozen.has(raw.uid)) {
        // frozen: the text is never touched, but the note may be filed under another heading
        if (seen.has(raw.uid)) return;
        seen.add(raw.uid);
        const cur = byUid.get(raw.uid);
        if ((cur.groupUid || null) !== (group ? group.uid : null) || (group && !group.uid)) ops.moves.push({ uid: raw.uid, group });
        return;
      }
      if (raw.uid && byUid.has(raw.uid) && !seen.has(raw.uid)) {
        seen.add(raw.uid);
        const cur = byUid.get(raw.uid);
        if (norm(cur.text) !== norm(text) || backTexts(cur).join("\n") !== back.map(norm).join("\n")) ops.updates.push({ uid: raw.uid, text, back, group });
        const targetUid = group ? group.uid : null; // null uid = new heading -> always a move
        if ((cur.groupUid || null) !== targetUid || (group && !group.uid)) ops.moves.push({ uid: raw.uid, group });
      } else if (!raw.uid || !byUid.has(raw.uid)) {
        ops.creates.push({ text, back, group });
      }
    };
    const handleGroup = (raw, parent, depth) => {
      const title = String(raw.title || "").trim();
      if (!title) { for (const n of raw.notes || []) handleNote(n, parent); return null; }
      let uid = raw.uid && known.has(raw.uid) && !seenGroups.has(raw.uid) ? raw.uid : null;
      if (uid) seenGroups.add(uid);
      const g = { uid, title, parent, notes: [], groups: [] };
      for (const n of raw.notes || []) handleNote(n, g);
      if (depth < 1) for (const sub of raw.groups || []) { const s = handleGroup(sub, g, depth + 1); if (s) g.groups.push(s); }
      return g;
    };
    for (const raw of result.notes || []) handleNote(raw, null);
    for (const raw of result.groups || []) { const g = handleGroup(raw, null, 0); if (g) ops.groups.push(g); }
    for (const uid of result.delete || []) if (byUid.has(uid) && !frozen.has(uid) && !seen.has(uid)) ops.deletes.push(uid);
    ops.tags = [...new Set((result.tags || []).map((t) => String(t).trim().toLowerCase().replace(/^#/, "")).filter(Boolean))];
    return ops;
  }

  // ---------- orchestration (adapter = platform read/write, see roam-adapter.js / logseq plugin) ----------
  const busy = new Set(); // home uids currently being written

  /** Re-read a home block, update the frozen set, persist state if it changed. */
  async function refresh(adapter, homeUid, { persist = true } = {}) {
    const home = await adapter.getBlock(homeUid);
    if (!home) return null;
    if (!(await isActive(adapter, home))) return { home, off: true, notes: [], state: emptyState(), stale: false, frozen: new Set() };
    const { notes, stateBlock } = splitChildren(home.children, settings.ankifyTag, homeUid);
    const state = parseState(stateBlock && stateBlock.text);
    const { changed, vanished } = reconcile(state, notes);
    let wrote = false;
    if (persist && !busy.has(homeUid)) {
      try { wrote = await recordExamples(adapter, home, notes, state, vanished, settings.ankifyTag); } catch (e) { console.error("[auto-anki] examples", e); }
      if (changed || wrote) await writeState(adapter, homeUid, stateBlock, state);
    }
    let stale = false;
    try {
      stale = state.contentHash !== contentHash(await adapter.getSiblingTrees(homeUid));
      // parentHash is absent in state written before the parent block was sent: those blocks are not stale for that reason
      if (!stale && state.parentHash != null) stale = state.parentHash !== hash(await parentTextOf(adapter, homeUid));
    } catch (e) {}
    return { home, notes, stateBlock, state, stale, frozen: new Set(state.frozen) };
  }

  async function parentTextOf(adapter, homeUid) {
    return adapter.getParentText ? norm((await adapter.getParentText(homeUid)) || "") : "";
  }

  async function writeState(adapter, homeUid, stateBlock, state) {
    const text = serializeState(state);
    if (stateBlock) { if (stateBlock.text !== text) await adapter.updateBlock(stateBlock.uid, text); return stateBlock.uid; }
    const uid = await adapter.createBlock(homeUid, text, { last: true });
    try { await adapter.collapse(uid); } catch (e) {}
    return uid;
  }

  /** The whole cycle: read, ask Claude, apply, record. Returns a summary. */
  async function runUpdate(adapter, homeUid, cfg) {
    if (busy.has(homeUid)) throw new Error("already updating this block");
    if (!cfg.apiKey) throw new Error("no API key set");
    // busy for the whole run, the API call included: refreshes do not persist meanwhile and a second
    // click or auto-update cannot start a second run (the call takes minutes; two runs made every card twice)
    busy.add(homeUid);
    try {
      const home = await adapter.getBlock(homeUid);
      if (!home) throw new Error("home block not found");
      if (!(await isActive(adapter, home))) throw new Error("this block is switched off (off tag or inside a template)");
      const { notes, stateBlock, groups, groupIndex } = splitChildren(home.children, cfg.ankifyTag, homeUid);
      const state = parseState(stateBlock && stateBlock.text);
      const { vanished } = reconcile(state, notes);
      try { await recordExamples(adapter, home, notes, state, vanished, cfg.ankifyTag); } catch (e) { console.error("[auto-anki] examples", e); }
      const contentTrees = await adapter.getSiblingTrees(homeUid);
      const parentText = await parentTextOf(adapter, homeUid);
      if (!outline(contentTrees).trim() && !parentText) throw new Error("no content blocks next to the home block");
      const hl = homeTagsLower();
      const homeTags = lowerTags(home.text).filter((t) => !hl.includes(t));
      const user = buildUserMessage({ pageTitle: home.pageTitle, parentText, contentTrees, notes, groups, state, homeTags, extraInstructions: cfg.extraInstructions, grouping: cfg.grouping });
      let system = SYSTEM;
      if (cfg.promptPage && adapter.readPageTrees) {
        try { const custom = promptFromTrees(await adapter.readPageTrees(cfg.promptPage)); if (custom) system = custom; } catch (e) { console.warn("[auto-anki] prompt page unreadable, using the built-in prompt", e); }
      }
      const examples = await examplesText(adapter);
      // the shared preamble always comes first, then the project's own (possibly user-edited) prompt
      const systemBlocks = [contact().systemPrompt(system), examples ? "EXAMPLES — the user's past edits, own notes and deletions, oldest first:\n" + examples : ""];
      // where a new block goes: under a heading, or under the home block just above the state block
      const placement = (parentUid) => (parentUid === homeUid && stateBlock ? { before: stateBlock.uid } : { last: true });

      // New notes (and the headings they sit under) are written the moment the model finishes each one,
      // so the cards fill in block by block instead of all at once after a minutes-long call. Everything
      // written this way is rolled back if the call fails or Claude asks for Eli. Existing notes (updates,
      // moves, deletions, retitled headings) wait for the complete answer and the planner below.
      const existing = new Map(notes.map((n) => [n.uid, n]));
      const live = { notes: new Map(), groups: new Map(), made: new Map(), created: [] }; // path -> uid; made: heading uid -> title; created: every uid written, in order
      const claimed = new Set();
      const pkey = (p) => p.join("/");
      let queue = Promise.resolve(), streamError = null;
      const liveHeading = async (chain) => { // the heading a streamed note goes under, made on the way; null = its title has not streamed yet (left to the planner)
        let parentUid = homeUid;
        for (const g of chain) {
          const k = pkey(g.path);
          let uid = live.groups.get(k);
          if (!uid) {
            if (g.uid && groupIndex.has(g.uid) && !claimed.has(g.uid)) { claimed.add(g.uid); uid = g.uid; }
            else {
              if (!g.title) return null;
              uid = await adapter.createBlock(parentUid, g.title, placement(parentUid));
              live.created.push(uid); live.made.set(uid, g.title);
            }
            live.groups.set(k, uid);
          }
          parentUid = uid;
        }
        return parentUid;
      };
      const onNote = (raw, chain) => {
        queue = queue.then(async () => {
          if (streamError || (raw.uid && existing.has(raw.uid))) return;
          const text = cardText(raw.text, cfg.ankifyTag, cfg.tagCards);
          const back = (raw.back || []).map((b) => normaliseCloze(String(b)).trim()).filter(Boolean);
          if (!norm(text)) return;
          const target = await liveHeading(chain);
          if (target === null) return;
          const uid = await adapter.createBlock(target, text, placement(target));
          live.created.push(uid);
          const children = [];
          for (const b of back) children.push({ uid: await adapter.createBlock(uid, b, { last: true }), text: b });
          live.notes.set(pkey(raw.path), { uid, text, children, groupUid: target === homeUid ? null : target });
          if (adapter.progress) { try { adapter.progress(homeUid, live.notes.size); } catch (e) {} }
        }).catch((e) => { streamError = streamError || e; });
      };
      const rollback = async () => { for (const uid of [...live.created].reverse()) { try { await adapter.deleteBlock(uid); } catch (e) { console.error("[auto-anki] rollback", e); } } live.created = []; };
      let scanner = jsonNoteScanner(onNote);
      // "it was a task remark, keep working": the answer is streamed afresh, so what the first attempt wrote goes
      const onRestart = async () => { await queue; await rollback(); live.notes.clear(); live.groups.clear(); live.made.clear(); claimed.clear(); scanner = jsonNoteScanner(onNote); };
      let call;
      try {
        call = await callClaude({ apiKey: cfg.apiKey, model: cfg.model, effort: cfg.effort, system: systemBlocks, user, fetchImpl: cfg.fetchImpl, onText: (t) => scanner.feed(t), onRestart });
        await queue;
        if (streamError) throw streamError;
      } catch (e) { await queue; await rollback(); throw e; }
      const { result, usage, contact: rec } = call;
      await showNotes(adapter, call.notes);
      if (rec) { await rollback(); await recordContact(adapter, rec); return { created: 0, updated: 0, deleted: 0, tags: [], usage, contact: rec }; }
      // what streamed in exists now: give the planner those uids so it leaves the blocks alone
      for (const [uid, title] of live.made) groupIndex.set(uid, { uid, text: title, notes: [], groups: [] });
      const adopt = (obj, path) => {
        (obj.notes || []).forEach((raw, i) => { const ln = live.notes.get(pkey([...path, "notes", i])); if (ln) { raw.uid = ln.uid; notes.push(ln); } });
        (obj.groups || []).forEach((g, i) => { const p = [...path, "groups", i]; const uid = live.groups.get(pkey(p)); if (uid) g.uid = uid; adopt(g, p); });
      };
      adopt(result, []);
      const ops = plan(result, notes, state, cfg.ankifyTag, groupIndex, cfg.tagCards);

      const byUid = new Map(notes.map((n) => [n.uid, n]));
      // headings first, so every note has a parent to go to
      const ensureGroup = async (g, parentUid) => {
        if (g.uid) {
          const cur = groupIndex.get(g.uid);
          if (cur && norm(cur.text) !== norm(g.title)) await adapter.updateBlock(g.uid, g.title);
        } else {
          g.uid = await adapter.createBlock(parentUid, g.title, placement(parentUid));
          state.groups[g.uid] = { text: g.title };
        }
        for (const sub of g.groups) await ensureGroup(sub, g.uid);
      };
      for (const g of ops.groups) await ensureGroup(g, homeUid);
      const targetOf = (group) => (group ? group.uid : homeUid);
      for (const u of ops.updates) {
        const cur = byUid.get(u.uid);
        if (norm(cur.text) !== norm(u.text)) await adapter.updateBlock(u.uid, u.text);
        await syncBack(adapter, cur, u.back);
        state.notes[u.uid] = { hash: fingerprint({ text: u.text, children: u.back.map((t) => ({ text: t })) }), text: stripTag(u.text, cfg.ankifyTag), back: u.back, at: Date.now() };
      }
      for (const m of ops.moves) {
        const target = targetOf(m.group);
        if ((byUid.get(m.uid).groupUid || homeUid) === target || !adapter.moveBlock) continue;
        await adapter.moveBlock(m.uid, target, placement(target));
      }
      for (const c of ops.creates) {
        const target = targetOf(c.group);
        const uid = await adapter.createBlock(target, c.text, placement(target));
        for (const b of c.back) await adapter.createBlock(uid, b, { last: true });
        state.notes[uid] = { hash: fingerprint({ text: c.text, children: c.back.map((t) => ({ text: t })) }), text: stripTag(c.text, cfg.ankifyTag), back: c.back, at: Date.now() };
      }
      for (const uid of ops.deletes) { await adapter.deleteBlock(uid); delete state.notes[uid]; }
      for (const ln of live.notes.values()) state.notes[ln.uid] = { hash: fingerprint(ln), text: stripTag(ln.text, cfg.ankifyTag), back: ln.children.map((c) => c.text), at: Date.now() };
      for (const [uid, title] of live.made) state.groups[uid] = { text: title };
      await pruneGroups(adapter, homeUid, state, cfg.ankifyTag);
      if (ops.tags.length || (state.llmTags || []).length) {
        const newText = homeTextWithTags(home.text, state.llmTags, ops.tags);
        if (newText !== home.text) await adapter.updateBlock(homeUid, newText);
        state.llmTags = ops.tags;
      }
      state.contentHash = contentHash(contentTrees);
      state.parentHash = hash(parentText);
      state.updatedAt = Date.now();
      await writeState(adapter, homeUid, stateBlock, state);
      return { created: ops.creates.length + live.notes.size, updated: ops.updates.length, deleted: ops.deletes.length, tags: ops.tags, usage };
    } finally {
      busy.delete(homeUid);
    }
  }

  /** Delete headings the LLM made that have nothing left below them; forget headings that are gone. */
  async function pruneGroups(adapter, homeUid, state, ankifyTag) {
    for (let pass = 0; pass < 3; pass++) {
      const home = await adapter.getBlock(homeUid);
      if (!home) return;
      const present = new Map();
      const walk = (kids) => { for (const c of kids || []) { present.set(c.uid, c); walk(c.children); } };
      walk(home.children);
      let removed = false;
      for (const uid of Object.keys(state.groups || {})) {
        const b = present.get(uid);
        if (!b) { delete state.groups[uid]; continue; }
        if (!isCard(b, ankifyTag, state) && !hasNoteBelow(b, ankifyTag, state) && !(b.children || []).some((c) => norm(c.text))) {
          await adapter.deleteBlock(uid); delete state.groups[uid]; removed = true;
        }
      }
      if (!removed) return;
    }
  }

  async function syncBack(adapter, note, back) {
    const kids = (note.children || []);
    for (let i = 0; i < Math.max(kids.length, back.length); i++) {
      if (i < kids.length && i < back.length) { if (norm(kids[i].text) !== norm(back[i])) await adapter.updateBlock(kids[i].uid, back[i]); }
      else if (i < back.length) await adapter.createBlock(note.uid, back[i], { last: true });
      else await adapter.deleteBlock(kids[i].uid);
    }
  }

  const isBusy = (uid) => busy.has(uid);

  root.AutoAnkiCore = {
    refresh, runUpdate, isBusy,
    settings, DEFAULT_HOME_TAGS, DEFAULT_OFF_TAGS, isOff, isActive, STATE_TAG, DEFAULT_ANKIFY_TAG, SYSTEM, SCHEMA,
    norm, hash, lowerTags, isHome, isStateBlock, emptyState, parseState, serializeState,
    splitChildren, reconcile, fingerprint, backTexts, outline, contentHash,
    ensureAnkifyTag, cardText, normaliseCloze, homeTextWithTags, slashTriggerAt, tagAsHome, buildUserMessage, groupingRules, DEFAULT_GROUPING, callClaude, readStream, jsonNoteScanner, recordContact, showNotes, plan, pruneGroups,
    defaultPromptTrees, promptFromTrees, recordExamples, examplesText,
  };
})(typeof window !== "undefined" ? window : globalThis);
