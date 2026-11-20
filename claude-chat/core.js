/**
 * Claude-in-outliner core: platform-independent logic shared by the Roam roam/js block
 * ("Claude in Roam") and the Logseq plugin ("Claude in Logseq"). Works on plain trees
 * {uid, text, children} supplied by an adapter; the adapter reads and writes the graph.
 *
 * Shape of a conversation (all blocks):
 *   [[cl:]] optional request                  <- conversation block (was the trigger block)
 *     =>                                        <- marker; its children are the first reply
 *       reply bullet
 *         nested reply bullet
 *     user follow-up                            <- typed by the user; Enter asks again
 *       reply bullet                            <- its children are the reply
 *
 * Config: Roam keeps the API key in this browser's localStorage ("claude-in-roam:apiKey",
 * falling back to "auto-anki:apiKey") and the rest in the CONFIG object of roam-adapter.js;
 * Logseq keeps everything in the plugin settings (~/.logseq/settings/logseq-claude-in-logseq.json).
 * Logs: the browser / Logseq developer console, prefixed "[claude-in-roam]" or "[claude-in-logseq]";
 * errors are also written into the graph where the reply would have gone. Every system prompt
 * starts with the shared preamble and every call carries the contact_eli and note_to_eli tools
 * (llm-contact.js, loaded before this file). When Claude calls contact_eli or writes an "@ELI:" line,
 * the turn stops and the message is written to
 * the graph page "llm-inbox" and kept in localStorage ("llm-inbox:records"). A contact_eli call
 * is first put to the model as one question (send, or it was a remark about the task and keep
 * working: LlmContact.withConfirm); what it chooses not to send is kept in "llm-inbox:unconfirmed".
 * A note_to_eli call stops nothing: the note is kept in the same two places, marked as a note, the
 * call is acknowledged and Claude is asked again, so the reply carries on (LlmContact.withNotes).
 */
(function (root) {
  const contact = () => { if (!root.LlmContact) throw new Error("llm-contact.js is not loaded (rebuild: claude-chat/build.sh)"); return root.LlmContact; };
  const settings = {
    triggerPages: ["claude in roam", "cl:"], // [[page]] references that start a conversation; the first heads the block
    slashTriggers: ["/claude"], // typed text that starts a conversation
    marker: "=>", // block holding the first reply
    platform: "Roam Research",
    markup: "**bold**, __italics__, `code` and [[Page]] links",
    app: "claude-in-roam", // name recorded in the LLM inbox
  };

  // ---------- text helpers ----------
  // Never write three backticks literally in this file: Roam would end the roam/js code block there.
  const FENCE = "\x60\x60\x60";
  // Logseq property lines ("id:: ...") follow a block's first line and are dropped; a FIRST line of that shape
  // is a Roam attribute ("Question:: why ..."), which is content. Runs of spaces are collapsed inside a line
  // only: indentation at the start of a line is code and is kept.
  const norm = (s) => String(s || "").replace(/\r/g, "").split("\n").filter((l, i) => i === 0 || !/^[\w-]+::\s/.test(l)).join("\n").replace(/(\S)[ \t]+/g, "$1 ").trim();
  // Blocks the feature itself leaves under a turn when the call failed. They are not Claude's words: they are
  // never sent back as an assistant turn, and a follow-up holding only these can be asked again. (The
  // "Claude asked to reach Eli" notice is different: that is what Claude did, so it stays in the transcript.)
  const isStatus = (text) => /^(Error: |\(no reply\)$)/.test(norm(text));
  const replyKids = (b) => (b.children || []).filter((c) => !isStatus(c.text));
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function outline(trees, depth = 0) {
    let out = "";
    for (const t of trees || []) {
      const text = norm(t.text);
      if (text) out += "  ".repeat(depth) + "- " + text.replace(/\n/g, "\n" + "  ".repeat(depth) + "  ") + "\n";
      out += outline(t.children, depth + 1);
    }
    return out;
  }

  /** Drop the node with this uid wherever it sits. */
  function prune(trees, uid) {
    return (trees || []).filter((t) => t.uid !== uid).map((t) => Object.assign({}, t, { children: prune(t.children, uid) }));
  }

  // ---------- triggers ----------
  const refRe = (page) => new RegExp(`(?:#\\[\\[|\\[\\[)${esc(page)}\\]\\]|#${esc(page)}(?![\\w-])`, "i");
  const pages = (o) => ((o && o.triggerPages) || settings.triggerPages).filter(Boolean);
  const slashes = (o) => ((o && o.slashTriggers) || settings.slashTriggers).filter(Boolean);

  // A page name ending in ":" needs no second colon in the header: "[[cl:]] request".
  const colonAfter = (p) => (p.endsWith(":") ? "(?=\\s|$)" : ":");

  /** True for a block whose text heads a conversation: "[[cl:]] ..." (or "[[page]]: ..."). */
  function isConversation(text, o) {
    const t = String(text || "").trim();
    return pages(o).some((p) => new RegExp(`^(?:#?\\[\\[${esc(p)}\\]\\]|#${esc(p)})${colonAfter(p)}`, "i").test(t));
  }

  /** Length of a slash trigger ending `before` (text up to the cursor), else 0. */
  function slashTriggerAt(before, o) {
    const lower = String(before || "").toLowerCase();
    for (const raw of slashes(o)) {
      const t = raw.toLowerCase();
      if (!lower.endsWith(t)) continue;
      const start = lower.length - t.length;
      if (start === 0 || /\s/.test(lower[start - 1])) return t.length;
    }
    return 0;
  }

  /**
   * A page-reference trigger in a block that is not yet a conversation. A conversation
   * block has children (the marker), so callers pass hasChildren when they know it; a
   * header-shaped text without children still counts as a trigger.
   */
  function pageTriggerIn(text, o, hasChildren) {
    if (hasChildren) return null;
    for (const p of pages(o)) { const m = refRe(p).exec(text || ""); if (m) return { page: p, match: m[0], index: m.index }; }
    return null;
  }

  /** Remove trigger text from the block, leaving what the user wrote around it. */
  function stripTrigger(text, o) {
    let t = String(text || "");
    for (const p of pages(o)) t = t.replace(new RegExp(`\\s*(?:#\\[\\[|\\[\\[)${esc(p)}\\]\\]:?|\\s*#${esc(p)}(?![\\w-]):?`, "ig"), " ");
    for (const s of slashes(o)) t = t.replace(new RegExp(`(^|\\s)${esc(s)}(?=\\s|$)`, "ig"), "$1");
    return t.replace(/[ \t]+/g, " ").trim();
  }

  const header = (rest, o) => { const p = pages(o)[0]; return `[[${p}]]${p.endsWith(":") ? "" : ":"}` + (rest ? " " + rest : ""); };
  const isMarker = (text, o) => norm(text) === ((o && o.marker) || settings.marker);

  // ---------- prompt ----------
  const system = (o) => `You are Claude, answering inside the user's ${settings.platform} notes. The user's notes around the request are given as CONTEXT, outermost first; the deepest items are the most relevant, and the REQUEST (if any) is what to answer. When there is no explicit request, respond to the deepest context items as if they were the message.

Answer what was asked and stop there. The user is thinking in their own notes and wants answers, not coaching: do not add advice, recommendations, next steps, things to try, things to track or write down, or offers of further help that the request did not ask for. When the request itself asks for suggestions or advice, give them. When there is no explicit request, respond to the content of the deepest items (explain, assess, or add relevant facts), still without telling the user what to do.

The notes may carry Anki-related tags (ankify, auto-anki, deck names, cloze markup). Ignore them: they belong to a later, separate step. Do not mention flashcards, do not suggest what to ankify, and do not shape or frame your answer for cards unless the request itself asks for that.

FORMAT (strict, the reply is written into outliner blocks):
- Write a bullet outline. Every line is a bullet: "- " at the top level, sub-points indented by two spaces per level, at most three levels deep.
- One point per bullet, one to three sentences. Short bullets over long paragraphs. No headings, tables or horizontal rules.
- Plain text by default. Markup available when it genuinely helps: ${settings.markup}. Do not bold a lead-in label on every bullet; reserve bold for a key term or an answer the reader should spot. Do not use other markdown.
- Code goes in a fenced code block that starts on its own bullet line: "- ${FENCE}lang", the code lines, then "${FENCE}" at the same indentation as the bullet.
- When you used web search, mention the source (site or title) in the bullet that relies on it.
- Match the depth of the request: a quick question gets a few bullets, a research question a fuller outline.`;

  function contextMessage({ pageTitle, ancestors, contextTrees, request, pageTrees, under }) {
    let msg = "";
    if (pageTitle) msg += `PAGE: ${pageTitle}\n`;
    msg += "CONTEXT (the user's notes around the request, outermost first):\n";
    const chain = ancestors || [];
    let depth = 0;
    for (const a of chain) { const t = norm(a.text); if (t) { msg += "  ".repeat(depth) + "- " + t.replace(/\n/g, "\n" + "  ".repeat(depth) + "  ") + "\n"; depth++; } }
    const rest = outline(contextTrees, depth);
    if (!chain.length && !rest.trim()) msg += "(none)\n";
    msg += rest;
    // the whole page (contextMode "page") is reference material at its real depth, apart from the context chain:
    // nested under the deepest ancestor it repeated the chain and made an unrelated block "the deepest item"
    if (pageTrees && outline(pageTrees).trim()) msg += "\nREST OF THE PAGE (for reference; less relevant than the context above):\n" + outline(pageTrees, 0);
    msg += "\nREQUEST: " + (request || "(none: respond to the deepest context items above)") + "\n";
    // blocks that were already under the request block when the conversation started: the user's notes, part of the request
    if (under && under.trim()) msg += "\nBLOCKS UNDER THE REQUEST (the user's own notes that the request is about):\n" + under;
    return msg;
  }

  /**
   * Conversation block -> API messages. The first user message carries the context and
   * the request written after the header; then the marker's children (assistant),
   * follow-up blocks (user) and their children (assistant). `pending` is the uid of the
   * block whose reply is being generated: it ends the message list as the last user turn
   * (or, for the marker, is skipped).
   */
  function buildMessages({ conv, pageTitle, ancestors, contextTrees, pageTrees, pending, o }) {
    const request = stripTrigger(conv.text, o);
    // Children above the marker were there before the conversation started (/claude typed in a block that
    // already had sub-blocks): they are the user's notes, not turns. Read as turns, their own children
    // were attributed to Claude.
    const all = conv.children || [];
    const mi = all.findIndex((c) => isMarker(c.text, o));
    const before = mi > 0 ? all.slice(0, mi) : [];
    const turns = mi > 0 ? all.slice(mi) : all;
    const msgs = [{ role: "user", content: contextMessage({ pageTitle, ancestors, contextTrees, request, pageTrees, under: outline(before) }) }];
    const push = (role, content) => {
      if (!content) return;
      const last = msgs[msgs.length - 1];
      if (last && last.role === role) last.content += "\n\n" + content; else msgs.push({ role, content });
    };
    for (const c of turns) {
      if (isMarker(c.text, o)) { push("assistant", outline(replyKids(c)).trim()); continue; }
      const text = norm(c.text);
      if (!text) continue;
      push("user", text);
      if (c.uid !== pending) push("assistant", outline(replyKids(c)).trim());
    }
    if (msgs[msgs.length - 1].role === "assistant") push("user", "Continue.");
    return msgs;
  }

  // ---------- Claude API (raw HTTP + SSE; runs in a browser tab / plugin iframe) ----------
  async function streamClaude({ apiKey, model, effort, systemText, messages, webSearch, maxTokens, fetchImpl, onText, signal, decide }) {
    const f = fetchImpl || root.fetch.bind(root);
    const body = {
      model: model || "claude-opus-5-5",
      max_tokens: maxTokens || 16000,
      stream: true,
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      messages,
      output_config: { effort: effort || "low" },
      fallbacks: "default",
    };
    body.tools = [];
    if (webSearch) body.tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
    body.tools.push(...contact().CONTACT_TOOLS); // the preamble promises Claude a way to reach Eli: contact_eli (stops the turn) and note_to_eli (does not)
    const request = { model: body.model, system: systemText, messages, tools: body.tools };
    // The confirm question (decide): same model, system and tools plus a forced choice. Short, so not
    // streamed; no effort and no thinking, because a forced tool cannot be combined with thinking.
    if (decide) { Object.assign(body, contact().decisionRequest(body.tools), { stream: false, thinking: { type: "disabled" } }); delete body.output_config; }
    const headers = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    let res = await f("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body), signal });
    if (res.status === 400) {
      const err = await res.text();
      console.warn("[claude-chat] 400, retrying without fallbacks:", err.slice(0, 300));
      delete body.fallbacks; delete headers["anthropic-beta"];
      res = await f("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body), signal });
    }
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 400)}`);
    if (decide) return res.json();
    const r = await readSse(res, onText);
    r.request = request;
    return r;
  }

  /**
   * Read the SSE stream. Returns { text, usage, stop, content }: text is every text block
   * joined (streamed to onText as it arrives); content is the text plus any client tool calls
   * (only contact_eli and note_to_eli are offered), rebuilt from their input_json_delta pieces.
   */
  async function readSse(res, onText) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "", usage = null, stop = null, textBlocks = new Set(), afterTool = false;
    const toolBlocks = new Map(); // index -> { type: "tool_use", id, name, json }
    const handle = (ev) => {
      if (ev.type === "content_block_start") {
        if (ev.content_block && ev.content_block.type === "text") {
          textBlocks.add(ev.index);
          // text resuming after a tool block (a web search) starts a new line; text blocks split only by
          // citations follow each other directly and still join without a break
          if (afterTool && text && !text.endsWith("\n")) { text += "\n"; if (onText) onText("\n"); }
          afterTool = false;
        } else if (ev.content_block) afterTool = true;
        if (ev.content_block && ev.content_block.type === "tool_use") toolBlocks.set(ev.index, { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, json: "" });
      }
      else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && textBlocks.has(ev.index)) { text += ev.delta.text; if (onText) onText(ev.delta.text); }
      else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "input_json_delta" && toolBlocks.has(ev.index)) { toolBlocks.get(ev.index).json += ev.delta.partial_json || ""; }
      else if (ev.type === "message_delta") { if (ev.usage) usage = ev.usage; if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; if (ev.delta && ev.delta.stop_reason === "refusal") throw new Error("Claude declined the request" + (ev.delta.stop_details && ev.delta.stop_details.explanation ? ": " + ev.delta.stop_details.explanation : "")); }
      else if (ev.type === "error") throw new Error("Claude API stream error: " + JSON.stringify(ev.error || ev));
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
    const content = [{ type: "text", text }];
    for (const t of toolBlocks.values()) { let input = {}; try { input = JSON.parse(t.json || "{}"); } catch (e) { input = { raw: t.json }; } content.push({ type: "tool_use", id: t.id, name: t.name, input }); }
    return { text, usage, stop, content };
  }

  /**
   * After a reply: did Claude ask for Eli? If so, record it (localStorage + the graph page
   * "llm-inbox"), make it visible under the reply, tell the user, and return the record so the
   * caller stops the task (no retry, no further turns). Returns null otherwise.
   */
  async function afterResponse(adapter, cfg, r, replyUnder) {
    const C = contact();
    const rec = C.check({ app: cfg.app || settings.app, model: r.request.model, system: r.request.system, messages: r.request.messages, response: { content: r.content, stop_reason: r.stop, usage: r.usage }, tools: r.request.tools });
    if (!rec) return null;
    const page = C.pageBlocks(rec);
    try {
      if (adapter.appendToPage) { const uid = await adapter.appendToPage(cfg.inboxPage || C.INBOX_PAGE, page.text); for (const c of page.children) await adapter.createBlock(uid, c, { last: true }); }
    } catch (e) { console.error("[claude-chat] could not write to the inbox page", e); }
    try { await adapter.createBlock(replyUnder, `**Claude asked to reach Eli** (recorded on [[${cfg.inboxPage || C.INBOX_PAGE}]]; this turn stops here): ${rec.message}`, { last: true }); } catch (e) {}
    if (adapter.notify) { try { adapter.notify(`Claude asked to reach Eli: ${rec.message.slice(0, 200)} (recorded on ${cfg.inboxPage || C.INBOX_PAGE})`, "warning"); } catch (e) {} }
    console.warn("[claude-chat] contact recorded", rec.id, rec.message);
    return rec;
  }

  /**
   * Notes Claude left for Eli (note_to_eli). LlmContact.withNotes has already recorded and answered them and
   * the turn carries on; this puts each one on the graph page "llm-inbox" and tells the user, quietly.
   */
  async function showNotes(adapter, cfg, notes) {
    const C = contact(), inbox = cfg.inboxPage || C.INBOX_PAGE;
    for (const rec of notes) {
      const page = C.pageBlocks(rec);
      try {
        if (adapter.appendToPage) { const uid = await adapter.appendToPage(inbox, page.text); for (const c of page.children) await adapter.createBlock(uid, c, { last: true }); }
      } catch (e) { console.error("[claude-chat] could not write to the inbox page", e); }
      if (adapter.notify) { try { adapter.notify(`Claude left Eli a note (recorded on ${inbox}; the reply carries on): ${rec.message.slice(0, 200)}`, "info"); } catch (e) {} }
    }
  }

  // ---------- outline writer: streamed markdown -> blocks, as the lines arrive ----------
  /** Parse one outline line into { depth, text } (depth in bullet levels), or null for blank. */
  function parseLine(line) {
    if (!line.trim()) return null;
    const m = /^([ \t]*)(?:([-*+•]|\d{1,2}[.)])\s+)?(.*)$/.exec(line); // "1984. was a year" is not a list item
    const indent = m[1].replace(/\t/g, "  ").length;
    const bullet = !!m[2];
    let text = m[3].trimEnd();
    const h = bullet ? null : /^#{1,6}\s+(.*)$/.exec(text); // "- # of items is 5" is a bullet, not a heading
    if (h) text = h[1].trim();
    return { depth: Math.round(indent / 2), bullet, text };
  }

  /**
   * makeWriter(adapter, parentUid, { placeholderUid }) -> { push(chunk), finish() }.
   * Completed lines become blocks (nested by indentation); the line being streamed is
   * created as soon as it has content and updated as it grows; code fences are kept in
   * one block. finish() returns { uids, count }.
   */
  function makeWriter(adapter, parentUid, opts = {}) {
    let buf = "", queue = Promise.resolve(), placeholder = opts.placeholderUid || null;
    const parents = []; // parents[depth] = uid of the last block written at that depth
    const uids = [];
    let live = null; // { uid, depth, text } block for the line still being streamed
    let fence = null; // { uid, depth, text } while inside a code block
    let lastText = null; // last committed text of a block (for continuation lines)
    let updateTimer = null;
    const throttleMs = opts.throttleMs === undefined ? 150 : opts.throttleMs;

    const enqueue = (fn) => { queue = queue.then(fn).catch((e) => { console.error("[claude-chat] write", e); }); return queue; };
    const create = (depth, text) => {
      const d = Math.min(depth, parents.length);
      const parentRec = d === 0 ? null : parents[d - 1]; // its uid is set by the time our turn in the queue comes
      const rec = { uid: null, depth: d, text };
      enqueue(async () => {
        const under = parentRec ? parentRec.uid : parentUid;
        if (placeholder && !parentRec) { rec.uid = placeholder; placeholder = null; await adapter.updateBlock(rec.uid, rec.text); }
        else rec.uid = await adapter.createBlock(under, rec.text, { last: true });
        uids.push(rec.uid);
      });
      parents.length = d; parents[d] = rec;
      return rec;
    };
    const update = (rec, text) => { rec.text = text; rec.shown = text; enqueue(async () => { if (rec.uid) await adapter.updateBlock(rec.uid, text); }); };
    // Show interim text (a line still streaming) without committing it to rec.text.
    const scheduleUpdate = (rec, shown) => {
      rec.shown = shown;
      if (updateTimer) return;
      updateTimer = setTimeout(() => { updateTimer = null; enqueue(async () => { if (rec.uid && rec.shown !== undefined) await adapter.updateBlock(rec.uid, rec.shown); }); }, throttleMs);
    };
    const dedent = (line, n) => { let i = 0; while (i < n && i < line.length && line[i] === " ") i++; return line.slice(i); };

    const commitLine = (line) => {
      if (fence) {
        fence.text += "\n" + dedent(line, fence.strip);
        if (line.trim() === FENCE) { update(fence, fence.text); lastText = fence; fence = null; }
        else scheduleUpdate(fence, fence.text);
        return;
      }
      const p = parseLine(line);
      if (!p) return;
      if (p.text.startsWith(FENCE) && p.text.indexOf(FENCE, 3) < 0) { // opened and closed on one line is not a block to stay inside
        const rec = live && live.depth === p.depth ? live : create(p.depth, p.text);
        rec.text = p.text; rec.strip = p.depth * 2 + (p.bullet ? 2 : 0); fence = rec; live = null; return;
      }
      if (!p.bullet && p.depth > 0 && lastText) { // wrapped continuation of the previous block
        update(lastText, lastText.text + "\n" + p.text); live = null; return;
      }
      if (live) { update(live, p.text); lastText = live; live = null; }
      else { lastText = create(p.depth, p.text); }
    };

    const streamPartial = (partial) => {
      if (fence) { scheduleUpdate(fence, fence.text + "\n" + dedent(partial, fence.strip)); return; }
      const p = parseLine(partial);
      if (!p || !p.text || p.text.startsWith(FENCE)) return;
      if (!p.bullet && p.depth > 0 && lastText) return; // wait for the full continuation line
      if (!live) live = create(p.depth, p.text);
      else { live.text = p.text; scheduleUpdate(live, p.text); }
    };

    return {
      push(chunk) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); commitLine(line); }
        if (buf) streamPartial(buf);
      },
      async finish() {
        if (buf.trim()) commitLine(buf); buf = "";
        if (fence) { update(fence, fence.text); fence = null; }
        if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
        if (live) { update(live, live.text); live = null; }
        if (placeholder) { const uid = placeholder; placeholder = null; enqueue(() => adapter.updateBlock(uid, "(no reply)")); }
        await queue;
        return { uids, count: uids.length };
      },
      async fail(message) {
        // a pending throttled update would fire after this and write the half-streamed line back over the error
        if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }
        await queue;
        // the error takes the placeholder if nothing was written yet; otherwise it gets a block of its own
        // and the partial reply stays readable above it
        const uid = placeholder; placeholder = null;
        if (uid) await adapter.updateBlock(uid, "Error: " + message);
        else await adapter.createBlock(parentUid, "Error: " + message, { last: true });
      },
    };
  }

  // ---------- orchestration ----------
  const busy = new Set();

  /** Everything the prompt needs about where a conversation sits. */
  async function surroundings(adapter, convUid, cfg) {
    const conv = await adapter.getBlock(convUid);
    if (!conv) throw new Error("conversation block not found");
    const ancestors = (await adapter.getAncestors(convUid)) || [];
    // "parents": the chain of parent blocks only; "parents+siblings": plus the other blocks
    // under the closest parent; "page": plus every block on the page
    const mode = cfg.contextMode || "parents";
    let contextTrees = [], pageTrees = null;
    if (mode === "parents+siblings" || mode === "parent") contextTrees = await adapter.getSiblingTrees(convUid);
    else if (mode === "page") pageTrees = prune(await adapter.getPageTrees(convUid), convUid);
    contextTrees = prune(contextTrees, convUid);
    return { conv, ancestors, contextTrees, pageTrees, pageTitle: conv.pageTitle };
  }

  /**
   * Generate the reply for one turn: replyUnder = the block whose children receive it
   * (the marker for the first turn, a follow-up block afterwards).
   */
  async function respond(adapter, cfg, { convUid, replyUnder }) {
    if (!cfg.apiKey) throw new Error("no API key set");
    if (busy.has(convUid)) throw new Error("already answering in this conversation");
    busy.add(convUid);
    let writer = null;
    try {
      const s = await surroundings(adapter, convUid, cfg);
      const messages = buildMessages({ conv: s.conv, pageTitle: s.pageTitle, ancestors: s.ancestors, contextTrees: s.contextTrees, pageTrees: s.pageTrees, pending: replyUnder, o: cfg });
      const placeholderUid = await adapter.createBlock(replyUnder, cfg.thinkingText || "…", { last: true });
      writer = makeWriter(adapter, replyUnder, { placeholderUid, throttleMs: cfg.throttleMs });
      if (adapter.onBusy) adapter.onBusy(convUid, true);
      // the shared preamble always comes first, then the project's own instructions
      const systemText = contact().systemPrompt(cfg.systemText || system(cfg));
      const call = (m, decide) => streamClaude({ apiKey: cfg.apiKey, model: cfg.model, effort: cfg.effort, systemText, messages: m, webSearch: cfg.webSearch !== false, maxTokens: cfg.maxTokens, fetchImpl: cfg.fetchImpl, onText: (t) => writer.push(t), decide });
      const first = await call(messages, false);
      // A note_to_eli call does not stop the turn: the note is recorded, the call is answered and Claude is
      // asked again (at most 3 times); what it says next streams into the same reply (after ending any
      // half-written line). A reply that also asks for Eli comes back untouched and stops below.
      const noted = await contact().withNotes({ app: cfg.app || settings.app, model: first.request.model, system: systemText, messages, response: first, tools: first.request.tools, call: (m) => { writer.push("\n"); return call(m, false); } });
      await showNotes(adapter, cfg, noted.notes);
      // A contact_eli call is put to Claude as one question before anything is recorded (only for the
      // models LlmContact.confirmApplies lists; otherwise the response comes straight back). "Keep working":
      // the answer streams into the same reply (after ending any half-written line). Anything else,
      // errors included, hands back the response unchanged and afterResponse records it.
      const r = (await contact().withConfirm({ app: cfg.app || settings.app, model: first.request.model, messages: noted.messages, response: noted.response, call: (m, decide) => { if (!decide) writer.push("\n"); return call(m, decide); } })).response;
      const w = await writer.finish();
      const rec = await afterResponse(adapter, cfg, r, replyUnder);
      // leave the cursor at the end of the reply (the adapter may decline, e.g. if the user is typing elsewhere)
      if (!rec && cfg.focusAfterReply !== false && adapter.focusBlock && w.uids.length) { try { await adapter.focusBlock(w.uids[w.uids.length - 1], true); } catch (e) { console.warn("[claude-chat] focus", e); } }
      return { blocks: w.count, usage: r.usage, stop: r.stop, text: r.text, lastUid: w.uids[w.uids.length - 1] || null, contact: rec, notes: noted.notes };
    } catch (e) {
      // leave the error where the reply would have been, so a failure is never silent
      try { if (writer) await writer.fail(e.message); else await adapter.createBlock(replyUnder, "Error: " + e.message, { last: true }); } catch (e2) {}
      throw e;
    } finally {
      busy.delete(convUid);
      if (adapter.onBusy) adapter.onBusy(convUid, false);
    }
  }

  /** A trigger block becomes a conversation block: rewrite its text, add the marker, answer. */
  async function start(adapter, cfg, { uid, text }) {
    const rest = stripTrigger(text, cfg);
    const head = header(rest, cfg);
    await adapter.updateBlock(uid, head);
    const marker = await adapter.createBlock(uid, cfg.marker || settings.marker, { last: true });
    return respond(adapter, cfg, { convUid: uid, replyUnder: marker });
  }

  /** A follow-up block (child of a conversation block) gets its reply. */
  async function followUp(adapter, cfg, { uid, text }) {
    const b = await adapter.getBlock(uid);
    if (!b || !b.parentUid) throw new Error("follow-up block not found");
    if (text !== undefined && norm(text) !== norm(b.text)) await adapter.updateBlock(uid, text);
    return respond(adapter, cfg, { convUid: b.parentUid, replyUnder: uid });
  }

  /**
   * Is a block one of Claude's reply blocks? True when the nearest conversation block
   * above it is not its direct parent (direct children are the marker and the user's
   * follow-ups; everything below those is Claude's). Only the nearest conversation
   * counts, so a conversation nested inside another one behaves normally.
   */
  function isLockedReply(ancestors, o) {
    const chain = ancestors || [];
    let nearest = -1;
    for (let i = chain.length - 1; i >= 0; i--) if (isConversation(chain[i].text, o)) { nearest = i; break; }
    return nearest >= 0 && nearest < chain.length - 1;
  }

  /**
   * Is a block part of the finished transcript? Claude's reply blocks, the marker, and
   * the user's follow-ups that already have a reply. A follow-up without a reply yet is
   * where the user types, so it stays editable; so does the conversation block itself.
   */
  function isLockedBlock(block, ancestors, o) {
    if (isLockedReply(ancestors, o)) return true;
    const parent = (ancestors || [])[(ancestors || []).length - 1];
    if (!parent || !isConversation(parent.text, o)) return false;
    return isMarker(block.text, o) || replyKids(block).length > 0;
  }

  /** Could this block take a follow-up? (parent is a conversation, it is not the marker, it has no reply yet) */
  function isFollowUpCandidate(block, parentText, o) {
    return !!block && isConversation(parentText, o) && !isMarker(block.text, o) && !replyKids(block).length && !!norm(block.text);
  }

  root.ClaudeChatCore = {
    settings, norm, outline, prune, isConversation, slashTriggerAt, pageTriggerIn, stripTrigger, header, isMarker,
    system, contextMessage, buildMessages, streamClaude, readSse, afterResponse, showNotes, parseLine, makeWriter,
    surroundings, respond, start, followUp, isFollowUpCandidate, isLockedReply, isLockedBlock, isBusy: (uid) => busy.has(uid),
  };
})(typeof window !== "undefined" ? window : globalThis);
