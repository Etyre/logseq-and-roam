/**
 * Claude in Logseq (file graphs). Counterpart of roam/claude-in-roam.js; shares core.js.
 *
 * Type /claude in a block (a slash command), or reference [[claude in logseq]] or [[cl:]] in
 * it, and the block becomes "[[claude in logseq]]: <what you wrote>" with a "=>" child that fills
 * with Claude's reply as it streams in. To continue, add a sibling of "=>" with your next
 * message and press Enter: the reply appears as its children.
 */

const SETTINGS = [
  { key: "apiKey", type: "string", title: "Anthropic API key", description: "Stored in the plugin settings, not in the graph.", default: "" },
  { key: "triggerPage", type: "string", title: "Trigger pages", description: "Comma-separated. Referencing one of these pages in a block starts a conversation; the first heads every conversation block.", default: "claude in logseq, cl:" },
  { key: "model", type: "string", title: "Model", description: "", default: "claude-opus-5" },
  { key: "effort", type: "enum", title: "Effort", enumChoices: ["low", "medium", "high", "xhigh", "max"], enumPicker: "select", description: "", default: "low" },
  { key: "webSearch", type: "boolean", title: "Allow web search", description: "", default: true },
  { key: "contextMode", type: "enum", title: "What Claude sees besides the conversation", enumChoices: ["parents", "parents+siblings", "page"], enumPicker: "select", description: "parents: the chain of parent blocks above the conversation. parents+siblings: also the other blocks under the closest parent. page: also every block on the page.", default: "parents" },
  { key: "lockReplies", type: "boolean", title: "Lock finished turns", description: "Claude's reply blocks, and your follow-ups once they have a reply, are read-only: the cursor can move through them and Enter starts a new follow-up. Turn off to edit them.", default: true },
  { key: "focusAfterReply", type: "boolean", title: "Cursor at the end of the reply", description: "Once a reply has arrived, put the cursor at the end of it.", default: true },
  { key: "marker", type: "string", title: "Reply marker", description: "Text of the block that holds the first reply.", default: "=>" },
];
const S = () => Object.fromEntries(SETTINGS.map((s) => [s.key, logseq.settings?.[s.key] ?? s.default]));
const core = globalThis.ClaudeChatCore;
const opts = () => { const c = S(); return { triggerPages: String(c.triggerPage || "claude in logseq, cl:").split(",").map((t) => t.trim()).filter(Boolean), slashTriggers: ["/claude"], marker: c.marker || "=>" }; };
const cfg = () => Object.assign({ apiKey: S().apiKey, model: S().model, effort: S().effort, webSearch: !!S().webSearch, contextMode: S().contextMode, thinkingText: "…", focusAfterReply: S().focusAfterReply !== false }, opts());

// ---------- adapter ----------
const PROP_RE = /^[\w-]+::\s/;
const splitProps = (content) => {
  const lines = String(content || "").split("\n");
  return { body: lines.filter((l) => !PROP_RE.test(l)).join("\n").replace(/\s+$/, ""), props: lines.filter((l) => PROP_RE.test(l)) };
};
const toTree = (b) => ({ uid: b.uuid, text: splitProps(b.content).body, children: (b.children || []).filter((c) => c && c.uuid).map(toTree) });

const adapter = {
  async getBlock(uid) {
    const b = await logseq.Editor.getBlock(uid, { includeChildren: true });
    if (!b) return null;
    const t = toTree(b);
    const parentIsPage = !b.parent || b.parent.id === (b.page && b.page.id);
    if (!parentIsPage) { const p = await logseq.Editor.getBlock(b.parent.id); t.parentUid = p && p.uuid; } else t.parentUid = null;
    try { const p = await logseq.Editor.getPage(b.page.id); t.pageTitle = p && (p.originalName || p.name); t.pageName = p && p.name; } catch (e) {}
    return t;
  },
  async getAncestors(uid) {
    const out = [];
    let b = await logseq.Editor.getBlock(uid), guard = 0;
    while (b && b.parent && b.parent.id !== (b.page && b.page.id) && guard++ < 100) {
      b = await logseq.Editor.getBlock(b.parent.id);
      if (b) out.unshift({ uid: b.uuid, text: splitProps(b.content).body });
    }
    return out;
  },
  async getSiblingTrees(uid) {
    const b = await logseq.Editor.getBlock(uid);
    if (!b) return [];
    let kids;
    if (!b.parent || b.parent.id === (b.page && b.page.id)) { const p = await logseq.Editor.getPage(b.page.id); kids = await logseq.Editor.getPageBlocksTree(p.name); }
    else { const p = await logseq.Editor.getBlock(b.parent.id, { includeChildren: true }); kids = (p && p.children) || []; }
    return (kids || []).filter((k) => k && k.uuid && !k["preBlock?"]).map(toTree).filter((t) => t.uid !== uid);
  },
  async getPageTrees(uid) {
    const b = await logseq.Editor.getBlock(uid);
    if (!b) return [];
    const p = await logseq.Editor.getPage(b.page.id);
    const tree = await logseq.Editor.getPageBlocksTree(p.name);
    return (tree || []).filter((k) => k && k.uuid && !k["preBlock?"]).map(toTree);
  },
  async createBlock(parentUid, text) {
    const p = await logseq.Editor.getBlock(parentUid, { includeChildren: true });
    const kids = ((p && p.children) || []).filter((c) => c && c.uuid);
    const block = kids.length
      ? await logseq.Editor.insertBlock(kids[kids.length - 1].uuid, text, { sibling: true, focus: false })
      : await logseq.Editor.insertBlock(parentUid, text, { sibling: false, focus: false });
    if (!block) throw new Error("block creation failed");
    return block.uuid;
  },
  async updateBlock(uid, text) {
    const cur = await logseq.Editor.getBlock(uid);
    const props = cur ? splitProps(cur.content).props : [];
    await logseq.Editor.updateBlock(uid, props.length ? text + "\n" + props.join("\n") : text);
  },
  async focusBlock(uid, atEnd) {
    const cur = await logseq.Editor.getCurrentBlock();
    if (cur && cur.uuid !== uid && (await logseq.Editor.checkEditing()) && !(editing && editing.locked)) return; // the user is typing somewhere else
    const b = await logseq.Editor.getBlock(uid);
    const len = b ? splitProps(b.content).body.length : 0;
    await logseq.Editor.editBlock(uid, atEnd ? { pos: len } : undefined);
  },
};

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = () => top.document;
const editorTextarea = () => doc().querySelector('textarea[id^="edit-block-"]') || doc().querySelector(".editor-wrapper textarea") || null;

async function leaveEditing() {
  const ta = editorTextarea();
  if (ta) ta.focus();
  try { await logseq.Editor.exitEditingMode(false); } catch (e) {}
  await sleep(80);
  if (!(await logseq.Editor.checkEditing())) return;
  if (ta && ta.isConnected) {
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    await sleep(80);
  }
}

async function run(label, fn) {
  if (!S().apiKey) { logseq.UI.showMsg("Claude in Logseq: set the API key in the plugin settings first", "warning"); return; }
  try { await fn(); }
  catch (e) { console.error("[claude-in-logseq]", e); logseq.UI.showMsg(`Claude in Logseq ${label} failed: ${e.message}`, "error", { timeout: 8000 }); }
}

const handled = new Map();
const recentlyHandled = (uid) => { const t = handled.get(uid); if (t && Date.now() - t < 5000) return true; handled.set(uid, Date.now()); return false; };

/** Turn a block into a conversation: save what the editor holds, rewrite the header, ask. */
async function startConversation(uuid, text) {
  if (recentlyHandled(uuid) || core.isBusy(uuid)) return;
  const o = opts();
  const head = core.header(core.stripTrigger(text, o), o);
  const cur = await logseq.Editor.getCurrentBlock();
  if (cur && cur.uuid === uuid && (await logseq.Editor.checkEditing())) { await leaveEditing(); await sleep(120); }
  await adapter.updateBlock(uuid, head);
  await run("", () => core.start(adapter, cfg(), { uuid, uid: uuid, text: head }));
}

async function onSlash() {
  const block = await logseq.Editor.getCurrentBlock();
  if (!block) return;
  let content = await logseq.Editor.getEditingBlockContent();
  if (content == null) content = block.content || "";
  await startConversation(block.uuid, splitProps(content).body);
}

// ---------- follow-ups: Enter in a child of a conversation block ----------
let editing = null; // { uuid, candidate, locked, convUuid } for the block being edited, refreshed as the user types
async function refreshEditing() {
  try {
    const b = await logseq.Editor.getCurrentBlock();
    if (!b) { editing = null; return; }
    const o = opts();
    const kids = (await logseq.Editor.getBlock(b.uuid, { includeChildren: true }))?.children || [];
    const anc = await adapter.getAncestors(b.uuid);
    const parent = anc[anc.length - 1];
    const candidate = !!parent && core.isFollowUpCandidate({ text: "x", children: kids }, parent.text, o);
    const locked = !!S().lockReplies && core.isLockedBlock({ text: splitProps(b.content).body, children: kids }, anc, o);
    const convAnc = [...anc].reverse().find((a) => core.isConversation(a.text, o));
    editing = { uuid: b.uuid, candidate, locked, convUuid: convAnc ? convAnc.uid : null };
  } catch (e) { editing = null; }
}
let lastLockToast = 0;
const lockToast = () => { if (Date.now() - lastLockToast > 4000) { lastLockToast = Date.now(); logseq.UI.showMsg("This conversation turn is locked: press Enter for a new follow-up (plugin setting)", "info"); } };

function wireEditor() {
  const d = doc();
  const isEditor = (t) => t && t.tagName === "TEXTAREA" && /^edit-block-/.test(t.id || "");
  d.addEventListener("focusin", (e) => { if (isEditor(e.target)) refreshEditing(); }, true);
  d.addEventListener("input", (e) => { if (isEditor(e.target)) refreshEditing(); }, true);
  d.addEventListener("click", (e) => { if (e.target && e.target.closest && e.target.closest(".ls-block")) setTimeout(refreshEditing, 50); }, true);
  // locked turns: typing, pasting, cutting and deleting are refused; the cursor still moves
  d.addEventListener("beforeinput", (e) => {
    if (!isEditor(e.target) || !editing || !editing.locked) return;
    e.preventDefault(); e.stopPropagation(); lockToast();
  }, true);
  d.addEventListener("keydown", (e) => {
    const ta = e.target;
    if (!isEditor(ta) || !editing || !editing.locked) return;
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const convUuid = editing.convUuid;
      if (!convUuid) return;
      (async () => {
        await leaveEditing();
        const nu = await adapter.createBlock(convUuid, "");
        await logseq.Editor.editBlock(nu);
      })().catch((err) => console.error("[claude-in-logseq]", err));
      return;
    }
    const structural = e.key === "Backspace" || e.key === "Delete" || e.key === "Tab" || (/^Arrow/.test(e.key) && e.shiftKey && (e.metaKey || e.altKey || e.ctrlKey));
    if (structural) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); lockToast(); }
  }, true);
  d.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const ta = e.target;
    if (!isEditor(ta)) return;
    const popup = [...d.querySelectorAll(".ui__ac, .ui__ac-inner")].some((el) => !el.contains(ta) && el.getBoundingClientRect().height > 4);
    const before = ta.value.slice(0, ta.selectionStart);
    if (popup || /(\[\[|\(\()[^\]\)]*$/.test(before) || /(^|\s)\/\S*$/.test(before)) return;
    const text = splitProps(ta.value).body;
    if (!editing || !editing.candidate || !core.norm(text) || core.isMarker(text, opts())) return;
    const uuid = editing.uuid;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    (async () => {
      await leaveEditing();
      await sleep(120);
      await run("follow-up", () => core.followUp(adapter, cfg(), { uid: uuid, text }));
    })();
  }, true);
}

async function askHere(ctx) {
  const b = ctx && ctx.uuid ? await logseq.Editor.getBlock(ctx.uuid) : await logseq.Editor.getCurrentBlock();
  if (!b) { logseq.UI.showMsg("Claude in Logseq: put the cursor in a block first", "warning"); return; }
  let content = (await logseq.Editor.checkEditing()) ? await logseq.Editor.getEditingBlockContent() : null;
  if (content == null) content = b.content || "";
  const text = splitProps(content).body;
  const o = opts();
  const parent = b.parent && b.parent.id !== (b.page && b.page.id) ? await logseq.Editor.getBlock(b.parent.id) : null;
  const kids = (await logseq.Editor.getBlock(b.uuid, { includeChildren: true }))?.children || [];
  if (parent && core.isFollowUpCandidate({ text, children: kids }, splitProps(parent.content).body, o)) {
    await leaveEditing(); await sleep(120);
    await run("follow-up", () => core.followUp(adapter, cfg(), { uid: b.uuid, text }));
  } else if (core.isConversation(text, o)) {
    logseq.UI.showMsg("Claude in Logseq: add a child block with your next message and press Enter", "info");
  } else {
    await startConversation(b.uuid, text);
  }
}

function main() {
  logseq.useSettingsSchema(SETTINGS);
  const applySettings = () => { const c = S(); Object.assign(core.settings, opts(), { platform: "Logseq", markup: "**bold**, *italics*, `code` and [[Page]] links (only to pages the notes already mention)" }); };
  applySettings();
  logseq.onSettingsChanged(applySettings);

  const conv = () => opts().triggerPages.map((p) => p.toLowerCase().replace(/"/g, '\\"')).map((p) => `.ls-block:has(> .block-main-container a[data-ref="${p}" i]), .ls-block[data-refs-self*="${p}" i]`).join(", ");
  const replyBox = () => conv().split(", ").map((c) => `${c} > .block-children-container > .ls-block > .block-children-container`).join(", ");
  const rows = () => replyBox().split(", ").map((b) => `${b} .ls-block > .block-main-container`).join(", ");
  const claudeText = () => rows().split(", ").map((r) => `${r} .block-content`).join(", ");
  const userRows = () => conv().split(", ").map((c) => `${c} > .block-main-container .block-content, ${c} > .block-children-container > .ls-block:not([data-claude-marker]) > .block-main-container .block-content`).join(", ");
  logseq.provideStyle(`
    ${replyBox()} { border-left: 3px solid rgba(217, 119, 87, 0.6) !important; background: rgba(217, 119, 87, 0.06); border-radius: 0 4px 4px 0; }
    ${claudeText()} { font-weight: normal; }
    ${userRows()} { font-weight: 600; }
  `);

  logseq.Editor.registerSlashCommand("claude", onSlash);
  logseq.App.registerCommandPalette({ key: "claude-in-logseq-ask", label: "Claude in Logseq: ask here" }, () => askHere(null));
  logseq.Editor.registerBlockContextMenuItem("Claude in Logseq: ask here", (ctx) => askHere(ctx));

  // [[cl:]] typed into a block (saved by Logseq as you type); a block that already has
  // children is an existing conversation, not a trigger
  logseq.DB.onChanged(({ blocks }) => {
    for (const b of blocks || []) {
      if (!b || !b.uuid || typeof b.content !== "string") continue;
      const body = splitProps(b.content).body;
      if (!core.pageTriggerIn(body, opts())) continue;
      logseq.Editor.getBlock(b.uuid, { includeChildren: true }).then((full) => {
        if (full && !(full.children || []).length) startConversation(b.uuid, body);
      });
    }
  });
  wireEditor();

  // tag the "=>" marker rows so the bold rule can skip them (CSS cannot match on text)
  const tagMarkers = () => {
    for (const c of doc().querySelectorAll(conv())) {
      for (const child of c.querySelectorAll(":scope > .block-children-container > .ls-block")) {
        const el = child.querySelector(":scope > .block-main-container .block-content");
        if (core.isMarker(el ? el.textContent : "", opts())) child.setAttribute("data-claude-marker", ""); else child.removeAttribute("data-claude-marker");
      }
    }
  };
  let markerTimer = null;
  new MutationObserver(() => { clearTimeout(markerTimer); markerTimer = setTimeout(tagMarkers, 150); }).observe(doc().body, { childList: true, subtree: true });
  setTimeout(tagMarkers, 500);
  console.log("[claude-in-logseq] loaded");
}

logseq.ready(main).catch(console.error);
