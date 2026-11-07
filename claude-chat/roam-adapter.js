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
  Object.assign(core.settings, { triggerPages: CONFIG.triggerPages, slashTriggers: CONFIG.slashTriggers, marker: CONFIG.marker, platform: "Roam Research", markup: CONFIG.markup, app: "claude-in-roam" });

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
    // the LLM inbox page: where a contact_eli call or an "@ELI:" line is recorded
    async appendToPage(title, text) {
      let p = api.pull("[:block/uid]", [":node/title", title]);
      if (!p) { const uid = api.util.generateUID(); await api.data.page.create({ page: { title, uid } }); p = { ":block/uid": uid }; }
      return this.createBlock(p[":block/uid"], text);
    },
    notify(msg, kind) { toast(msg, kind); },
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
  // records kept in this browser when Claude asked for Eli; paste into `llm_contact.py report` (README)
  api.ui.commandPalette.addCommand({ label: "Claude in Roam: copy LLM inbox records", callback: async () => {
    const r = await window.LlmContact.copyRecords();
    toast(r.count ? `${r.count} LLM inbox record(s) ${r.copied ? "copied as JSON lines" : "printed to the console (clipboard unavailable)"}` : "No LLM inbox records in this browser", "info");
  } });
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
