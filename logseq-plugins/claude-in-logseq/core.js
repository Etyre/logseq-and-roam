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
