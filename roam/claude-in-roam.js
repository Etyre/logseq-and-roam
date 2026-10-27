// Claude in Roam — built from claude-chat/core.js + claude-chat/roam-adapter.js (2026-10-26). Edit those, then run claude-chat/build.sh.
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
 */
(function (root) {
  const settings = {
    triggerPages: ["claude in roam", "cl:"], // [[page]] references that start a conversation; the first heads the block
    slashTriggers: ["/claude"], // typed text that starts a conversation
    marker: "=>", // block holding the first reply
    platform: "Roam Research",
    markup: "**bold**, __italics__, `code` and [[Page]] links",
  };

  // ---------- text helpers ----------
  // Never write three backticks literally in this file: Roam would end the roam/js code block there.
  const FENCE = "\x60\x60\x60";
  const norm = (s) => String(s || "").replace(/\r/g, "").split("\n").filter((l) => !/^[\w-]+::\s/.test(l)).join("\n").replace(/[ \t]+/g, " ").trim();
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

The notes may carry Anki-related tags (ankify, auto-anki, deck names, cloze markup). Ignore them: they belong to a later, separate step. Do not mention flashcards, do not suggest what to ankify, and do not shape or frame your answer for cards unless the request itself asks for that.

FORMAT (strict, the reply is written into outliner blocks):
- Write a bullet outline. Every line is a bullet: "- " at the top level, sub-points indented by two spaces per level, at most three levels deep.
- One point per bullet, one to three sentences. Short bullets over long paragraphs. No headings, tables or horizontal rules.
- Plain text by default. Markup available when it genuinely helps: ${settings.markup}. Do not bold a lead-in label on every bullet; reserve bold for a key term or an answer the reader should spot. Do not use other markdown.
- Code goes in a fenced code block that starts on its own bullet line: "- ${FENCE}lang", the code lines, then "${FENCE}" at the same indentation as the bullet.
- When you used web search, mention the source (site or title) in the bullet that relies on it.
- Match the depth of the request: a quick question gets a few bullets, a research question a fuller outline.`;

  function contextMessage({ pageTitle, ancestors, contextTrees, request }) {
    let msg = "";
    if (pageTitle) msg += `PAGE: ${pageTitle}\n`;
    msg += "CONTEXT (the user's notes around the request, outermost first):\n";
    const chain = ancestors || [];
    let depth = 0;
    for (const a of chain) { const t = norm(a.text); if (t) { msg += "  ".repeat(depth) + "- " + t.replace(/\n/g, "\n" + "  ".repeat(depth) + "  ") + "\n"; depth++; } }
    const rest = outline(contextTrees, depth);
    if (!chain.length && !rest.trim()) msg += "(none)\n";
    msg += rest;
    msg += "\nREQUEST: " + (request || "(none: respond to the deepest context items above)") + "\n";
    return msg;
  }

  /**
   * Conversation block -> API messages. The first user message carries the context and
   * the request written after the header; then the marker's children (assistant),
   * follow-up blocks (user) and their children (assistant). `pending` is the uid of the
   * block whose reply is being generated: it ends the message list as the last user turn
   * (or, for the marker, is skipped).
   */
  function buildMessages({ conv, pageTitle, ancestors, contextTrees, pending, o }) {
    const request = stripTrigger(conv.text, o);
    const msgs = [{ role: "user", content: contextMessage({ pageTitle, ancestors, contextTrees, request }) }];
    const push = (role, content) => {
      if (!content) return;
      const last = msgs[msgs.length - 1];
      if (last && last.role === role) last.content += "\n\n" + content; else msgs.push({ role, content });
    };
    for (const c of conv.children || []) {
      if (isMarker(c.text, o)) { push("assistant", outline(c.children).trim()); continue; }
      const text = norm(c.text);
      if (!text) continue;
      push("user", text);
      if (c.uid !== pending) push("assistant", outline(c.children).trim());
    }
    if (msgs[msgs.length - 1].role === "assistant") push("user", "Continue.");
    return msgs;
  }

  // ---------- Claude API (raw HTTP + SSE; runs in a browser tab / plugin iframe) ----------
  async function streamClaude({ apiKey, model, effort, systemText, messages, webSearch, maxTokens, fetchImpl, onText, signal }) {
    const f = fetchImpl || root.fetch.bind(root);
    const body = {
      model: model || "claude-opus-5",
      max_tokens: maxTokens || 16000,
      stream: true,
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      messages,
      output_config: { effort: effort || "low" },
      fallbacks: "default",
    };
    if (webSearch) body.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }];
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
    return readSse(res, onText);
  }

  async function readSse(res, onText) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "", usage = null, stop = null, textBlocks = new Set();
    const handle = (ev) => {
      if (ev.type === "content_block_start") { if (ev.content_block && ev.content_block.type === "text") textBlocks.add(ev.index); }
      else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && textBlocks.has(ev.index)) { text += ev.delta.text; if (onText) onText(ev.delta.text); }
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
    return { text, usage, stop };
  }

  // ---------- outline writer: streamed markdown -> blocks, as the lines arrive ----------
  /** Parse one outline line into { depth, text } (depth in bullet levels), or null for blank. */
  function parseLine(line) {
    if (!line.trim()) return null;
    const m = /^([ \t]*)(?:([-*+•]|\d+[.)])\s+)?(.*)$/.exec(line);
    const indent = m[1].replace(/\t/g, "  ").length;
    const bullet = !!m[2];
    let text = m[3].trimEnd();
    const h = /^#{1,6}\s+(.*)$/.exec(text);
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
      if (p.text.startsWith(FENCE)) {
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
        const uid = placeholder || (live && live.uid) || null;
        placeholder = null;
        await queue;
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
    let contextTrees = [];
    if (mode === "parents+siblings" || mode === "parent") contextTrees = await adapter.getSiblingTrees(convUid);
    else if (mode === "page") contextTrees = await adapter.getPageTrees(convUid);
    contextTrees = prune(contextTrees, convUid);
    return { conv, ancestors, contextTrees, pageTitle: conv.pageTitle };
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
      const messages = buildMessages({ conv: s.conv, pageTitle: s.pageTitle, ancestors: s.ancestors, contextTrees: s.contextTrees, pending: replyUnder, o: cfg });
      const placeholderUid = await adapter.createBlock(replyUnder, cfg.thinkingText || "…", { last: true });
      writer = makeWriter(adapter, replyUnder, { placeholderUid, throttleMs: cfg.throttleMs });
      if (adapter.onBusy) adapter.onBusy(convUid, true);
      const r = await streamClaude({ apiKey: cfg.apiKey, model: cfg.model, effort: cfg.effort, systemText: cfg.systemText || system(cfg), messages, webSearch: cfg.webSearch !== false, maxTokens: cfg.maxTokens, fetchImpl: cfg.fetchImpl, onText: (t) => writer.push(t) });
      const w = await writer.finish();
      // leave the cursor at the end of the reply (the adapter may decline, e.g. if the user is typing elsewhere)
      if (cfg.focusAfterReply !== false && adapter.focusBlock && w.uids.length) { try { await adapter.focusBlock(w.uids[w.uids.length - 1], true); } catch (e) { console.warn("[claude-chat] focus", e); } }
      return { blocks: w.count, usage: r.usage, stop: r.stop, text: r.text, lastUid: w.uids[w.uids.length - 1] || null };
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
    return isMarker(block.text, o) || (block.children || []).length > 0;
  }

  /** Could this block take a follow-up? (parent is a conversation, it is not the marker, it has no reply yet) */
  function isFollowUpCandidate(block, parentText, o) {
    return !!block && isConversation(parentText, o) && !isMarker(block.text, o) && !(block.children || []).length && !!norm(block.text);
  }

  root.ClaudeChatCore = {
    settings, norm, outline, prune, isConversation, slashTriggerAt, pageTriggerIn, stripTrigger, header, isMarker,
    system, contextMessage, buildMessages, streamClaude, readSse, parseLine, makeWriter,
    surroundings, respond, start, followUp, isFollowUpCandidate, isLockedReply, isLockedBlock, isBusy: (uid) => busy.has(uid),
  };
})(typeof window !== "undefined" ? window : globalThis);

/**
 * Claude in Roam (roam/js). Requires core.js above it in the same file
 * (roam/claude-in-roam.js is built from both by claude-chat/build.sh).
 *
 * Type /claude in a block, or reference [[claude in roam]] or [[cl:]] in it, and the block
 * turns into "[[claude in roam]]: <what you wrote>" with a "=>" child that fills with
 * Claude's reply as it streams in, one block per bullet. To continue, add a sibling
 * of "=>" with your next message and press Enter: the reply appears as its children.
 * The context sent to Claude is the chain of parent blocks above the conversation
 * (CONFIG.contextMode can widen that to the sibling blocks or the whole page). Claude's reply blocks are locked against
 * editing (CONFIG.lockReplies).
 *
 * First run "Claude in Roam: set API key" from the command palette (the key is kept in
 * this browser's localStorage, never in the graph; the Auto-anki key is reused if set).
 */
(function () {
  const CONFIG = {
    triggerPages: ["claude in roam", "cl:"], // [[page]] references that start a conversation; the first is used for the header
    slashTriggers: ["/claude"],
    marker: "=>",
    model: "claude-opus-5",
    effort: "low", // low | medium | high | xhigh | max
    webSearch: true,
    // What Claude sees besides the conversation itself:
    //   "parents"          the chain of parent blocks above the conversation (default)
    //   "parents+siblings" the parents plus the other blocks under the closest parent
    //   "page"             the parents plus every block on the page
    contextMode: "parents",
    lockReplies: true, // finished turns (Claude's replies, answered follow-ups, the marker) are read-only: the cursor can move through them, Enter starts a new follow-up; "Claude in Roam: toggle reply lock" to change
    focusAfterReply: true, // put the cursor at the end of the reply once it has arrived
    maxTokens: 16000,
    thinkingText: "…", // shown while waiting for the first words
    debug: false, // log trigger and Enter decisions to the console
    markup: "**bold**, __italics__, `code` and [[Page]] links (only to pages the notes already mention)",
  };

  const api = window.roamAlphaAPI;
  const core = window.ClaudeChatCore;
  if (!api || !core) return;
  if (window.__claudeInRoamLoaded) return;
  window.__claudeInRoamLoaded = true;
  Object.assign(core.settings, { triggerPages: CONFIG.triggerPages, slashTriggers: CONFIG.slashTriggers, marker: CONFIG.marker, platform: "Roam Research", markup: CONFIG.markup });

  const KEY_STORAGE = "claude-in-roam:apiKey";
  const apiKey = () => localStorage.getItem(KEY_STORAGE) || localStorage.getItem("auto-anki:apiKey") || "";
  const toast = (msg, kind) => { if (window.iziToast) iziToast[kind || "info"]({ message: msg, timeout: 6000 }); else { console.log("[claude-in-roam]", msg); if (kind === "error" || kind === "warning") alert(msg); } };
  const cfg = () => Object.assign({ apiKey: apiKey() }, CONFIG);

  // ---------- adapter: graph read/write through roamAlphaAPI ----------
  const TREE = "[:block/uid :block/string :block/order {:block/children ...}]";
  const sortKids = (b) => [...((b && b[":block/children"]) || [])].sort((x, y) => (x[":block/order"] || 0) - (y[":block/order"] || 0));
  const toTree = (b) => ({ uid: b[":block/uid"], text: b[":block/string"] || "", children: sortKids(b).map(toTree) });
  const parentOf = (uid) => {
    const b = api.pull("[{:block/_children [:block/uid :block/string :node/title]}]", [":block/uid", uid]);
    const p = b && b[":block/_children"] && b[":block/_children"][0];
    return p ? { uid: p[":block/uid"], text: p[":block/string"] || "", isPage: p[":node/title"] !== undefined } : null;
  };

  const adapter = {
    async getBlock(uid) {
      const b = api.pull(`[:block/uid :block/string :block/order {:block/children ${TREE}} {:block/page [:node/title]}]`, [":block/uid", uid]);
      if (!b) return null;
      const t = toTree(b);
      t.pageTitle = b[":block/page"] && b[":block/page"][":node/title"];
      const p = parentOf(uid);
      t.parentUid = p && !p.isPage ? p.uid : null;
      return t;
    },
    async getAncestors(uid) {
      const out = [];
      let p = parentOf(uid), guard = 0;
      while (p && !p.isPage && guard++ < 100) { out.unshift({ uid: p.uid, text: p.text }); p = parentOf(p.uid); }
      return out;
    },
    async getSiblingTrees(uid) {
      const p = parentOf(uid);
      if (!p) return [];
      const parent = api.pull(`[:block/uid {:block/children ${TREE}}]`, [":block/uid", p.uid]);
      return sortKids(parent).map(toTree).filter((t) => t.uid !== uid);
    },
    async getPageTrees(uid) {
      const b = api.pull("[{:block/page [:block/uid]}]", [":block/uid", uid]);
      const pageUid = b && b[":block/page"] && b[":block/page"][":block/uid"];
      if (!pageUid) return [];
      const page = api.pull(`[:block/uid {:block/children ${TREE}}]`, [":block/uid", pageUid]);
      return sortKids(page).map(toTree);
    },
    async createBlock(parentUid, text) {
      const uid = api.util.generateUID();
      await api.data.block.create({ location: { "parent-uid": parentUid, order: "last" }, block: { string: text, uid } });
      return uid;
    },
    async updateBlock(uid, text) { await api.data.block.update({ block: { uid, string: text } }); },
    async focusBlock(uid, atEnd) {
      const active = document.activeElement;
      if (isBlockTextarea(active) && uidFromTextareaId(active.id) !== uid && !lockedUid(uidFromTextareaId(active.id))) return; // the user is typing somewhere else
      for (let i = 0; i < 20; i++) {
        const el = document.querySelector(`[id^="block-input-"][id$="-${uid}"]`);
        if (el) { await focusInWindow(uid, el.id.slice("block-input-".length, -(uid.length + 1)), atEnd); return; }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };

  async function focusInWindow(uid, windowId, atEnd) {
    // wait until Roam has rendered the block in that window, or focusing lands somewhere else
    for (let i = 0; i < 30 && !document.querySelector(`#block-input-${CSS.escape(windowId)}-${uid}`); i++) await new Promise((r) => setTimeout(r, 100));
    if (!document.querySelector(`#block-input-${CSS.escape(windowId)}-${uid}`)) { debug("block", uid, "never appeared in window", windowId); return; }
    const arg = { location: { "block-uid": uid, "window-id": windowId } };
    if (atEnd) { const b = api.pull("[:block/string]", [":block/uid", uid]); const len = ((b && b[":block/string"]) || "").length; arg.selection = { start: len, end: len }; }
    await api.ui.setBlockFocusAndSelection(arg);
  }

  /** Nearest conversation block above uid (or uid itself), else null. */
  function conversationUidFor(uid) {
    const b = api.pull("[:block/string]", [":block/uid", uid]);
    if (b && core.isConversation(b[":block/string"], CONFIG)) return uid;
    let p = parentOf(uid), guard = 0;
    while (p && !p.isPage && guard++ < 100) { if (core.isConversation(p.text, CONFIG)) return p.uid; p = parentOf(p.uid); }
    return null;
  }

  /** Synchronous lock check for the block being edited. */
  function lockedUid(uid) {
    if (!uid) return false;
    const anc = [];
    let p = parentOf(uid), guard = 0;
    while (p && !p.isPage && guard++ < 100) { anc.unshift({ uid: p.uid, text: p.text }); p = parentOf(p.uid); }
    const b = api.pull("[:block/string {:block/children [:block/uid]}]", [":block/uid", uid]);
    return core.isLockedBlock({ text: (b && b[":block/string"]) || "", children: (b && b[":block/children"]) || [] }, anc, CONFIG);
  }

  // ---------- editing helpers ----------
  const uidFromTextareaId = (id) => (id && id.length > 9 ? id.slice(-9) : null);
  const isBlockTextarea = (t) => t && t.tagName === "TEXTAREA" && t.classList.contains("rm-block-input");

  // Set a React-controlled textarea's value so Roam picks the change up.
  function setTextareaValue(ta, value, cursor) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.setSelectionRange(cursor, cursor);
  }

  // Escape ends editing (Roam saves the textarea); a click outside is the fallback.
  function exitEditMode(textarea) {
    const ta = textarea && textarea.isConnected ? textarea : document.querySelector("textarea.rm-block-input");
    if (ta) {
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    }
    setTimeout(() => {
      if (!document.querySelector("textarea.rm-block-input")) return;
      const outside = document.querySelector(".roam-article") || document.body;
      for (const type of ["mousedown", "mouseup", "click"]) outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }, 80);
  }

  const hasChildren = (uid) => { const b = api.pull("[{:block/children [:block/uid]}]", [":block/uid", uid]); return !!(b && b[":block/children"] && b[":block/children"].length); };
  // Is one of Roam's popups (page/block search, slash menu) taking the Enter key? Look for a
  // popup that is actually visible, and at the text before the cursor for an unfinished [[, (( , ;; or /command.
  // Roam wraps the editing textarea itself in .rm-autocomplete__wrapper, so only a results
  // list with real height counts, and never an element that contains the textarea.
  const autocompleteOpen = (ta) => {
    const visible = [...document.querySelectorAll(".rm-autocomplete__results")].some((el) => !el.contains(ta) && el.getBoundingClientRect().height > 4);
    if (visible) return true;
    const before = ta ? ta.value.slice(0, ta.selectionStart) : "";
    return /(\[\[|\(\(|;;)[^\]\)]*$/.test(before) || /(^|\s)\/\S*$/.test(before);
  };
  const debug = (...a) => { if (CONFIG.debug) console.log("[claude-in-roam]", ...a); };
  const trace = (...a) => console.log("[claude-in-roam]", ...a); // Enter decisions inside conversations, always logged

  async function run(label, fn) {
    if (!apiKey()) { toast("Claude in Roam: set the API key first (command palette → Claude in Roam: set API key)", "warning"); return; }
    try { await fn(); }
    catch (e) { console.error("[claude-in-roam]", e); toast(`Claude in Roam ${label} failed: ${e.message}`, "error"); }
  }

  // ---------- triggers while typing ----------
  const handled = new Map(); // uid -> time, so a trigger fires once
  const recentlyHandled = (uid) => { const t = handled.get(uid); if (t && Date.now() - t < 5000) return true; handled.set(uid, Date.now()); return false; };

  function startFromEditor(uid, ta, text) {
    if (recentlyHandled(uid) || core.isBusy(uid)) return;
    const head = core.header(core.stripTrigger(text, CONFIG), CONFIG);
    setTimeout(() => {
      setTextareaValue(ta, head, head.length);
      exitEditMode(ta);
      setTimeout(() => run("", () => core.start(adapter, cfg(), { uid, text: head })), 200);
    }, 0);
  }

  document.addEventListener("input", (e) => {
    const ta = e.target;
    if (!isBlockTextarea(ta)) return;
    const uid = uidFromTextareaId(ta.id);
    if (!uid) return;
    const value = ta.value, cursor = ta.selectionStart;
    const len = core.slashTriggerAt(value.slice(0, cursor), CONFIG);
    if (len) { startFromEditor(uid, ta, value.slice(0, cursor - len) + value.slice(cursor)); return; }
    if (core.pageTriggerIn(value, CONFIG, hasChildren(uid))) startFromEditor(uid, ta, value);
  }, true);

  // Enter in a follow-up block (a child of a conversation block with no reply yet) asks Claude.
  // Listening on window in the capture phase runs before any of Roam's own key handlers.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const ta = e.target;
    if (!isBlockTextarea(ta) || ta.dataset.claudeLocked) return;
    const uid = uidFromTextareaId(ta.id);
    const text = ta.value;
    if (!uid || !text.trim()) return;
    const b = api.pull("[{:block/children [:block/uid]} {:block/_children [:block/string]}]", [":block/uid", uid]);
    const parentText = b && b[":block/_children"] && b[":block/_children"][0] && b[":block/_children"][0][":block/string"];
    if (!core.isConversation(parentText, CONFIG)) return; // not inside a conversation: nothing to do, nothing to log
    if (autocompleteOpen(ta)) { trace("Enter in", uid, "left to Roam: a popup or an unfinished [[ / (( / command is open"); return; }
    const candidate = core.isFollowUpCandidate({ text, children: (b && b[":block/children"]) || [] }, parentText, CONFIG);
    trace("Enter in", uid, candidate ? "asks Claude" : "left to Roam: the block is the marker or already has a reply");
    if (!candidate) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    exitEditMode(ta);
    setTimeout(() => run("follow-up", () => core.followUp(adapter, cfg(), { uid, text })), 200);
  }, true);

  // ---------- reply lock: finished turns are read-only but the cursor can move through them ----------
  let lockEnabled = CONFIG.lockReplies;
  let lastLockToast = 0;
  const lockToast = () => { if (Date.now() - lastLockToast > 4000) { lastLockToast = Date.now(); toast("This conversation turn is locked: press Enter for a new follow-up (Claude in Roam: toggle reply lock)", "info"); } };
  document.addEventListener("focusin", (e) => {
    const ta = e.target;
    if (!isBlockTextarea(ta)) return;
    const uid = uidFromTextareaId(ta.id);
    if (lockEnabled && uid && lockedUid(uid)) ta.dataset.claudeLocked = "1"; else delete ta.dataset.claudeLocked;
  }, true);
  // typing, pasting, cutting and deleting are refused in a locked block
  window.addEventListener("beforeinput", (e) => {
    const ta = e.target;
    if (!isBlockTextarea(ta) || !ta.dataset.claudeLocked) return;
    e.preventDefault(); e.stopPropagation(); lockToast();
  }, true);
  window.addEventListener("keydown", (e) => {
    const ta = e.target;
    if (!isBlockTextarea(ta) || !ta.dataset.claudeLocked) return;
    const uid = uidFromTextareaId(ta.id);
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      // a new follow-up block at the end of the conversation, ready to type into
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const convUid = conversationUidFor(uid);
      if (!convUid) return;
      const windowId = ta.id.slice("block-input-".length, -(uid.length + 1));
      adapter.createBlock(convUid, "").then((nu) => focusInWindow(nu, windowId, false)).catch((err) => console.error("[claude-in-roam]", err));
      return;
    }
    const structural = e.key === "Backspace" || e.key === "Delete" || e.key === "Tab" || (/^Arrow/.test(e.key) && e.shiftKey && (e.metaKey || e.altKey || e.ctrlKey));
    if (structural) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); lockToast(); }
  }, true);

  // ---------- commands ----------
  function askHere() {
    const f = api.ui.getFocusedBlock && api.ui.getFocusedBlock();
    const uid = f && f["block-uid"];
    if (!uid) { toast("Claude in Roam: put the cursor in a block first", "warning"); return; }
    const ta = document.activeElement && isBlockTextarea(document.activeElement) ? document.activeElement : null;
    const b = api.pull("[:block/string {:block/children [:block/uid]} {:block/_children [:block/string]}]", [":block/uid", uid]);
    const text = ta ? ta.value : (b && b[":block/string"]) || "";
    const parentText = b && b[":block/_children"] && b[":block/_children"][0] && b[":block/_children"][0][":block/string"];
    if (core.isFollowUpCandidate({ text, children: (b && b[":block/children"]) || [] }, parentText, CONFIG)) {
      exitEditMode(ta);
      setTimeout(() => run("follow-up", () => core.followUp(adapter, cfg(), { uid, text })), 200);
    } else if (core.isConversation(text, CONFIG)) {
      toast("Claude in Roam: add a child block with your next message and press Enter", "info");
    } else if (ta) {
      startFromEditor(uid, ta, text);
    } else {
      run("", () => core.start(adapter, cfg(), { uid, text }));
    }
  }

  function askKey() {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;";
    overlay.innerHTML = `<div style="background:#fff;padding:16px;border-radius:6px;min-width:420px;box-shadow:0 8px 40px rgba(0,0,0,0.35);font-size:14px;">
      <div style="margin-bottom:8px;">Anthropic API key (kept in this browser only)</div>
      <input type="password" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:4px;" placeholder="sk-ant-…" />
      <div style="margin-top:10px;text-align:right;"><button class="c">Cancel</button> <button class="s" style="margin-left:6px;">Save</button></div></div>`;
    const input = overlay.querySelector("input");
    input.value = apiKey();
    const close = () => overlay.remove();
    overlay.querySelector(".c").onclick = close;
    overlay.querySelector(".s").onclick = () => { const v = input.value.trim(); if (v) localStorage.setItem(KEY_STORAGE, v); else localStorage.removeItem(KEY_STORAGE); close(); toast("Claude in Roam: key saved", "success"); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") overlay.querySelector(".s").click(); if (e.key === "Escape") close(); e.stopPropagation(); });
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 0);
  }

  api.ui.commandPalette.addCommand({ label: "Claude in Roam: ask here", callback: askHere });
  api.ui.commandPalette.addCommand({ label: "Claude in Roam: set API key", callback: askKey });
  api.ui.commandPalette.addCommand({ label: "Claude in Roam: toggle reply lock", callback: () => { lockEnabled = !lockEnabled; toast(`Claude in Roam: replies ${lockEnabled ? "locked" : "unlocked"}`, "info"); } });
  if (api.ui.blockContextMenu) api.ui.blockContextMenu.addCommand({ label: "Claude in Roam: ask here", callback: (ctx) => {
    const uid = ctx && ctx["block-uid"];
    if (!uid) return;
    const b = api.pull("[:block/string {:block/children [:block/uid]} {:block/_children [:block/string]}]", [":block/uid", uid]);
    const text = (b && b[":block/string"]) || "";
    const parentText = b && b[":block/_children"] && b[":block/_children"][0] && b[":block/_children"][0][":block/string"];
    if (core.isFollowUpCandidate({ text, children: (b && b[":block/children"]) || [] }, parentText, CONFIG)) run("follow-up", () => core.followUp(adapter, cfg(), { uid, text }));
    else if (!core.isConversation(text, CONFIG)) run("", () => core.start(adapter, cfg(), { uid, text }));
  } });

  // ---------- styling: Claude's blocks (grandchildren and deeper of a conversation block) ----------
  const convSel = CONFIG.triggerPages.map((p) => `.roam-block-container[data-page-links*="${p.replace(/"/g, '\\"')}" i]`).join(", ");
  // the container holding a whole reply (children of the marker or of a follow-up): one bar down its left edge
  const replyBox = CONFIG.triggerPages.map((p) => `.roam-block-container[data-page-links*="${p.replace(/"/g, '\\"')}" i] > .rm-block-children > .roam-block-container > .rm-block-children`).join(", ");
  const claudeRows = replyBox.split(", ").map((b) => `${b} .roam-block-container > .rm-block-main`).join(", ");
  // the header and the user's follow-ups (not the "=>" marker, which is never sent to Claude); one entry per trigger page
  const userRows = convSel.split(", ").map((c) => `${c} > .rm-block-main .rm-block-text, ${c} > .rm-block-children > .roam-block-container:not([data-claude-marker]) > .rm-block-main .rm-block-text`).join(", ");
  const style = document.createElement("style");
  style.textContent = `
    ${replyBox} { border-left: 3px solid rgba(217, 119, 87, 0.6); background: rgba(217, 119, 87, 0.06); border-radius: 0 4px 4px 0; }
    textarea.rm-block-input[data-claude-locked] { background: rgba(217, 119, 87, 0.07); caret-color: #d97757; }
    ${claudeRows} .rm-block-text { font-weight: normal; }
    ${userRows} { font-weight: 600; }
  `;
  document.head.appendChild(style);

  // tag the marker rows so the bold rule can skip them (CSS cannot match on text)
  const tagMarkers = () => {
    for (const c of document.querySelectorAll(convSel)) {
      for (const child of c.querySelectorAll(":scope > .rm-block-children > .roam-block-container")) {
        const ta = child.querySelector(":scope > .rm-block-main textarea");
        const el = child.querySelector(":scope > .rm-block-main .rm-block-text");
        const text = ta ? ta.value : el ? el.textContent : "";
        if (core.isMarker(text, CONFIG)) child.setAttribute("data-claude-marker", ""); else child.removeAttribute("data-claude-marker");
      }
    }
  };
  let markerTimer = null;
  new MutationObserver(() => { clearTimeout(markerTimer); markerTimer = setTimeout(tagMarkers, 150); }).observe(document.body, { childList: true, subtree: true });
  setTimeout(tagMarkers, 500);

  window.claudeInRoam = { config: CONFIG, adapter, core, askHere };
  console.log("[claude-in-roam] loaded");
})();
