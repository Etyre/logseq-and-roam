/**
 * Auto-anki (Logseq file graphs). Counterpart of roam/auto-anki.js; shares core.js.
 *
 * Tag a block with one of the home tags (setting), or use the slash command /cards in it
 * (also "Auto-anki: make cards here" in the command palette and the block menu), which adds
 * the tag and runs at once. The block's parent and its siblings with their descendants
 * are the source material; its children are the Anki notes the LLM writes in
 * ankify_logseq format. Update with the small button on the block, the command palette
 * or the block context menu. Notes you edit change colour and are never touched again.
 *
 * Config: the plugin settings (Logseq → Plugins → Auto-anki → settings; stored in
 * ~/.logseq/settings/logseq-auto-anki.json), including the API key; the prompt and the
 * examples are graph pages. Logs: the Logseq developer console, prefixed "[auto-anki]".
 * LLM inbox: see core.js / llm-contact.js.
 */

const SETTINGS = [
  { key: "apiKey", type: "string", title: "Anthropic API key", description: "Stored in the plugin settings, not in the graph.", default: "" },
  { key: "homeTags", type: "string", title: "Home tags", description: "Comma-separated page names whose tag marks a home block.", default: "auto-generate cards, LLM-generated cards" },
  { key: "offTags", type: "string", title: "Off tags", description: "Comma-separated page names; a home block carrying one of these tags is switched off. Home blocks inside a template definition (an ancestor with template::) are off automatically.", default: "auto-anki off" },
  { key: "ankifyTag", type: "string", title: "Ankify tag", description: "The tag that sends a block to Anki. You add it to the cards you want to keep (or switch on the next setting).", default: "ankify" },
  { key: "tagNewCards", type: "boolean", title: "Tag new cards", description: "Off: cards are written without the ankify tag and reach Anki only once you tag them. On: every new card is tagged as it is written.", default: false },
  { key: "model", type: "string", title: "Model", description: "", default: "claude-opus-5-5" },
  { key: "effort", type: "enum", title: "Effort", enumChoices: ["low", "medium", "high", "xhigh", "max"], enumPicker: "select", description: "", default: "high" },
  { key: "extraInstructions", type: "string", title: "Extra instructions", description: "Free text sent with every request (deck, style, language…).", default: "" },
  { key: "groupThreshold", type: "number", title: "Group notes when more than", description: "With more notes than this, the notes are organised under labelled heading blocks (at most two levels deep).", default: 6 },
  { key: "groupMin", type: "number", title: "Smallest group", description: "Fewest notes under one heading.", default: 2 },
  { key: "groupMax", type: "number", title: "Largest group", description: "Most notes under one heading.", default: 6 },
  { key: "autoUpdate", type: "boolean", title: "Update automatically", description: "Regenerate once the content next to a home block has been quiet for the number of minutes below.", default: false },
  { key: "quietMinutes", type: "number", title: "Quiet minutes before an automatic update", description: "", default: 3 },
  { key: "promptPage", type: "string", title: "Prompt page", description: "Page holding the instructions to the model (command \"Auto-anki: edit prompt\" creates it). Empty or missing page = built-in prompt.", default: "auto-anki/prompt" },
  { key: "examplesPage", type: "string", title: "Examples page", description: "Page where your edits, own notes and deletions are collected as examples sent with every request.", default: "auto-anki/examples" },
  { key: "showStateBlock", type: "boolean", title: "Show the bookkeeping block", description: "Shows the hidden #auto-anki-state child block.", default: false },
];
const S = () => Object.fromEntries(SETTINGS.map((s) => [s.key, logseq.settings?.[s.key] ?? s.default]));
const core = window.AutoAnkiCore;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const homeTagList = () => S().homeTags.split(",").map((t) => t.trim()).filter(Boolean);

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
    t.parentUid = b.parent && b.parent.id;
    t.pageId = b.page && b.page.id;
    t.parentIsPage = t.parentUid === t.pageId;
    try { const p = await logseq.Editor.getPage(t.pageId); t.pageTitle = p && (p.originalName || p.name); } catch (e) {}
    return t;
  },
  async getSiblingTrees(uid) {
    const home = await this.getBlock(uid);
    if (!home) return [];
    let kids;
    if (home.parentIsPage) kids = await logseq.Editor.getPageBlocksTree(home.pageTitle || home.pageId);
    else { const p = await logseq.Editor.getBlock(home.parentUid, { includeChildren: true }); kids = (p && p.children) || []; }
    return (kids || []).filter((b) => b && b.uuid).map(toTree).filter((t) => t.uid !== uid && !t["preBlock?"] && !core.isHome(t.text));
  },
  async getParentText(uid) {
    // a top-level block's parent is the page: the page title is sent separately
    const home = await this.getBlock(uid);
    if (!home || !home.parentUid || home.parentIsPage) return "";
    const p = await logseq.Editor.getBlock(home.parentUid);
    return p ? splitProps(p.content).body : "";
  },
  async createBlock(parentUid, text, where) {
    let block;
    if (where && where.before) block = await logseq.Editor.insertBlock(where.before, text, { sibling: true, before: true, focus: false });
    else {
      const p = await logseq.Editor.getBlock(parentUid, { includeChildren: true });
      const kids = ((p && p.children) || []).filter((c) => c && c.uuid);
      block = kids.length
        ? await logseq.Editor.insertBlock(kids[kids.length - 1].uuid, text, { sibling: true, focus: false })
        : await logseq.Editor.insertBlock(parentUid, text, { sibling: false, focus: false });
    }
    if (!block) throw new Error("block creation failed");
    await logseq.Editor.upsertBlockProperty(block.uuid, "id", block.uuid);
    return block.uuid;
  },
  async updateBlock(uid, text) {
    const cur = await logseq.Editor.getBlock(uid);
    const props = cur ? splitProps(cur.content).props : [];
    await logseq.Editor.updateBlock(uid, props.length ? text + "\n" + props.join("\n") : text);
  },
  async deleteBlock(uid) { await logseq.Editor.removeBlock(uid); },
  async moveBlock(uid, parentUid, where) {
    if (where && where.before) { await logseq.Editor.moveBlock(uid, where.before, { before: true, children: false }); return; }
    const p = await logseq.Editor.getBlock(parentUid, { includeChildren: true });
    const kids = ((p && p.children) || []).filter((c) => c && c.uuid && c.uuid !== uid);
    if (kids.length) await logseq.Editor.moveBlock(uid, kids[kids.length - 1].uuid, { before: false, children: false });
    else await logseq.Editor.moveBlock(uid, parentUid, { before: false, children: true });
  },
  async collapse(uid) { await logseq.Editor.setBlockCollapsed(uid, true); },
  async readPageTrees(title) {
    const page = await logseq.Editor.getPage(title);
    if (!page) return null;
    const tree = await logseq.Editor.getPageBlocksTree(page.name);
    return (tree || []).filter((b) => b && b.uuid && !b["preBlock?"]).map(toTree);
  },
  async writePageTrees(title, trees) {
    let page = await logseq.Editor.getPage(title);
    if (!page) page = await logseq.Editor.createPage(title, {}, { redirect: false, createFirstBlock: false, journal: false });
    if (!page) throw new Error("could not create the prompt page");
    const put = async (parentUid, nodes, top) => {
      for (const n of nodes) {
        const b = top ? await logseq.Editor.appendBlockInPage(page.uuid, n.text, { focus: false }) : null;
        const uid = top ? b.uuid : await this.createBlock(parentUid, n.text, { last: true });
        await put(uid, n.children || [], false);
      }
    };
    await put(page.uuid, trees, true);
  },
  async openPage(title) { logseq.App.pushState("page", { name: title }); },
  async isInTemplate(uid) {
    let b = await logseq.Editor.getBlock(uid), guard = 0;
    while (b && b.parent && b.parent.id !== (b.page && b.page.id) && guard++ < 50) {
      b = await logseq.Editor.getBlock(b.parent.id);
      if (b && (/^template::\s/m.test(b.content || "") || (b.properties && b.properties.template !== undefined))) return true;
    }
    return false;
  },
  async appendToPage(title, text) {
    let page = await logseq.Editor.getPage(title);
    if (!page) page = await logseq.Editor.createPage(title, {}, { redirect: false, createFirstBlock: false, journal: false });
    if (!page) throw new Error("could not create page " + title);
    const b = await logseq.Editor.appendBlockInPage(page.uuid, text, { focus: false });
    if (!b) throw new Error("block creation failed");
    await logseq.Editor.upsertBlockProperty(b.uuid, "id", b.uuid);
    return b.uuid;
  },
  notify(msg, kind) { logseq.UI.showMsg(msg, kind || "info", { timeout: 10000 }); },
  progress(homeUid, n) { // cards written so far while the answer streams in
    const el = homeElements().find((x) => x.getAttribute("blockid") === homeUid);
    const span = el && el.querySelector(":scope > .auto-anki-bar .auto-anki-count");
    if (span) span.textContent = `${n} written…`;
  },
};

// ---------- DOM decoration ----------
const statusCache = new Map();
const doc = () => top.document;
const tagSelector = () => homeTagList().map((t) => `a.tag[data-ref="${t.toLowerCase().replace(/"/g, '\\"')}"]`).join(", ");

function homeElements() {
  const sel = tagSelector();
  if (!sel) return [];
  const out = new Set();
  for (const a of doc().querySelectorAll(sel)) {
    const block = a.closest(".ls-block");
    if (!block) continue;
    // only when the tag is in this block's own content, not a descendant's
    if (a.closest(".ls-block") === block && a.closest(".block-main-container")?.parentElement === block) out.add(block);
  }
  return [...out];
}

// "12 cards", or "12 cards · 3 edited" when some are frozen; blank until the first status read
const countLabel = (st) => (st && typeof st.count === "number" ? `${st.count} card${st.count === 1 ? "" : "s"}${st.frozen && st.frozen.size ? ` · ${st.frozen.size} edited` : ""}` : "");

function decorate() {
  for (const el of homeElements()) {
    const uid = el.getAttribute("blockid");
    if (!uid) continue;
    const st = statusCache.get(uid);
    if (st && st.off) { el.setAttribute("data-auto-anki", "off"); el.querySelector(":scope > .auto-anki-bar")?.remove(); continue; }
    el.setAttribute("data-auto-anki", "home");
    let bar = el.querySelector(":scope > .auto-anki-bar");
    if (!bar) {
      bar = doc().createElement("div");
      bar.className = "auto-anki-bar";
      bar.innerHTML = `<span class="auto-anki-count"></span><span class="auto-anki-dot"></span><button type="button" title="Update cards">↻</button>`;
      bar.querySelector("button").addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); update(uid); });
      el.appendChild(bar);
    }
    bar.querySelector(".auto-anki-count").textContent = countLabel(st);
    bar.querySelector(".auto-anki-dot").className = "auto-anki-dot" + (core.isBusy(uid) ? " busy" : st && st.stale ? " stale" : "");
    const frozen = (st && st.frozen) || new Set();
    for (const child of el.querySelectorAll(":scope > .block-children-container .ls-block")) {
      const cu = child.getAttribute("blockid");
      const isState = core.isStateBlock(child.querySelector(":scope > .block-main-container .block-content")?.textContent || "");
      if (isState) child.setAttribute("data-auto-anki", "state");
      else if (cu && frozen.has(cu)) child.setAttribute("data-auto-anki", "frozen");
      else child.removeAttribute("data-auto-anki");
    }
    if (!st) refreshStatus(uid);
  }
}

const refreshing = new Set();
async function refreshStatus(uid) {
  if (refreshing.has(uid) || core.isBusy(uid)) return;
  refreshing.add(uid);
  try {
    const r = await core.refresh(adapter, uid);
    if (r) { statusCache.set(uid, { stale: r.stale, frozen: r.frozen, off: !!r.off, count: r.notes.length }); if (S().autoUpdate && r.stale && !r.off) scheduleAuto(uid); }
  } catch (e) { console.error("[auto-anki] refresh", e); }
  finally { refreshing.delete(uid); decorate(); }
}

const autoTimers = new Map();
function scheduleAuto(uid) {
  clearTimeout(autoTimers.get(uid));
  autoTimers.set(uid, setTimeout(() => { const st = statusCache.get(uid); if (st && st.stale && !core.isBusy(uid)) update(uid, true); }, Math.max(0.5, Number(S().quietMinutes) || 3) * 60000));
}

// ---------- update ----------
async function update(uid, quiet) {
  const cfg = S();
  if (!cfg.apiKey) { logseq.UI.showMsg("Auto-anki: set the API key in the plugin settings first", "warning"); return; }
  if (core.isBusy(uid)) return;
  decorate();
  try {
    const run = core.runUpdate(adapter, uid, { apiKey: cfg.apiKey, model: cfg.model, effort: cfg.effort, ankifyTag: cfg.ankifyTag, tagCards: cfg.tagNewCards, extraInstructions: cfg.extraInstructions, promptPage: cfg.promptPage, grouping: { threshold: cfg.groupThreshold, min: cfg.groupMin, max: cfg.groupMax } });
    decorate(); // the core marked the block busy: show the pulsing dot while Claude works
    const r = await run;
    statusCache.delete(uid);
    if (r.contact) return; // Claude asked for Eli: the core recorded it and said so; nothing was written
    if (!quiet) logseq.UI.showMsg(`Auto-anki: ${r.created} new, ${r.updated} updated, ${r.deleted} removed`, "success");
  } catch (e) {
    console.error("[auto-anki]", e);
    logseq.UI.showMsg("Auto-anki failed: " + e.message, "error", { timeout: 8000 });
  } finally { refreshStatus(uid); }
}

async function homeFromUid(uid) {
  let cur = uid, guard = 0;
  while (cur && guard++ < 50) {
    const b = await logseq.Editor.getBlock(cur);
    if (!b) return null;
    if (core.isHome(splitProps(b.content).body)) return b.uuid;
    if (!b.parent || b.parent.id === b.page.id) return null;
    const p = await logseq.Editor.getBlock(b.parent.id);
    cur = p && p.uuid;
  }
  return null;
}

async function runCommand(ctx) {
  let uid = null;
  if (ctx && ctx.uuid) uid = await homeFromUid(ctx.uuid);
  if (!uid) { const b = await logseq.Editor.getCurrentBlock(); if (b) uid = await homeFromUid(b.uuid); }
  if (!uid) { const hs = homeElements().map((e) => e.getAttribute("blockid")).filter(Boolean); if (hs.length === 1) uid = hs[0]; }
  if (!uid) { logseq.UI.showMsg("Auto-anki: put the cursor in a tagged block (or its cards) first", "warning"); return; }
  update(uid);
}

// "make cards here": tag the block as a home block and run at once (slash command, palette, right-click)
async function makeCardsHere(ctx) {
  try {
    const cur = await logseq.Editor.getCurrentBlock();
    const uuid = (ctx && ctx.uuid) || (cur && cur.uuid);
    if (!uuid) { logseq.UI.showMsg("Auto-anki: put the cursor in a block first", "warning"); return; }
    const home = await homeFromUid(uuid);
    if (home) { update(home); return; } // already inside a card section: same as "update cards"
    if (core.isBusy(uuid)) return;
    let content = null;
    if (cur && cur.uuid === uuid && (await logseq.Editor.checkEditing())) {
      content = await logseq.Editor.getEditingBlockContent();
      // leave the editor first, or what it holds would overwrite the tag when it saves
      try { await logseq.Editor.exitEditingMode(false); } catch (e) {}
      await sleep(150);
    }
    if (content == null) { const b = await logseq.Editor.getBlock(uuid); content = (b && b.content) || ""; }
    const body = splitProps(content).body.replace(/(^|\s)\/cards?\s*$/i, "$1"); // in case Logseq left the typed command behind
    await adapter.updateBlock(uuid, core.tagAsHome(body));
    decorate();
    update(uuid);
  } catch (e) { console.error("[auto-anki]", e); logseq.UI.showMsg("Auto-anki failed: " + e.message, "error", { timeout: 8000 }); }
}

function main() {
  logseq.useSettingsSchema(SETTINGS);
  const applySettings = () => { const c = S(); core.settings.homeTags = homeTagList(); core.settings.offTags = String(c.offTags || "").split(",").map((t) => t.trim()).filter(Boolean); core.settings.examplesPage = c.examplesPage; core.settings.ankifyTag = c.ankifyTag; };
  applySettings();
  logseq.onSettingsChanged(() => { applySettings(); statusCache.clear(); decorate(); });
  logseq.provideStyle(`
    .ls-block[data-auto-anki="home"] { border: 2px solid #8e7cc3; border-radius: 6px; background: rgba(142,124,195,0.07); margin: 6px 0; padding: 4px 4px 4px 0; position: relative; }
    .ls-block[data-auto-anki="home"] > .block-main-container { padding-right: 150px; }
    .ls-block[data-auto-anki="off"] { border: 1px dashed #b8b8b8; border-radius: 6px; margin: 6px 0; padding: 4px 4px 4px 0; }
    .ls-block[data-auto-anki="frozen"] > .block-main-container { border-left: 3px solid #e0a030; margin-left: -5px; padding-left: 2px; background: rgba(224,160,48,0.10); border-radius: 3px; }
    .ls-block[data-auto-anki="state"] { display: ${S().showStateBlock ? "block" : "none"} !important; }
    .auto-anki-bar { position: absolute; top: 4px; right: 6px; display: flex; align-items: center; gap: 6px; z-index: 5; }
    .auto-anki-bar .auto-anki-count { font-size: 11px; line-height: 16px; color: #8e7cc3; white-space: nowrap; }
    .auto-anki-bar .auto-anki-dot { width: 8px; height: 8px; border-radius: 50%; background: #b8b8b8; }
    .auto-anki-bar .auto-anki-dot.stale { background: #e0a030; }
    .auto-anki-bar .auto-anki-dot.busy { background: #8e7cc3; animation: auto-anki-pulse 1s infinite alternate; }
    .auto-anki-bar button { font-size: 11px; line-height: 16px; padding: 0 6px; border: 1px solid #8e7cc3; border-radius: 3px; background: var(--ls-primary-background-color, #fff); color: #8e7cc3; cursor: pointer; }
    .auto-anki-bar button:hover { background: #8e7cc3; color: #fff; }
    @keyframes auto-anki-pulse { from { opacity: 0.4 } to { opacity: 1 } }
  `);

  let domTimer = null;
  new MutationObserver(() => { clearTimeout(domTimer); domTimer = setTimeout(decorate, 300); }).observe(top.document.body, { childList: true, subtree: true });
  let dbTimer = null;
  logseq.DB.onChanged(() => { clearTimeout(dbTimer); dbTimer = setTimeout(() => { statusCache.clear(); decorate(); }, 1500); });
  setTimeout(decorate, 1000);

  logseq.App.registerCommandPalette({ key: "auto-anki-update", label: "Auto-anki: update cards" }, () => runCommand(null));
  logseq.Editor.registerBlockContextMenuItem("Auto-anki: update cards", (ctx) => runCommand(ctx));
  logseq.Editor.registerSlashCommand("cards", () => makeCardsHere(null));
  logseq.App.registerCommandPalette({ key: "auto-anki-make-here", label: "Auto-anki: make cards here" }, () => makeCardsHere(null));
  logseq.Editor.registerBlockContextMenuItem("Auto-anki: make cards here", (ctx) => makeCardsHere(ctx));
  logseq.App.registerCommandPalette({ key: "auto-anki-open-examples", label: "Auto-anki: open examples" }, () => adapter.openPage(S().examplesPage || "auto-anki/examples"));
  // records kept in this plugin's storage when Claude asked for Eli or left him a note (note_to_eli; marked halts: false); paste into `llm_contact.py report` (README)
  logseq.App.registerCommandPalette({ key: "auto-anki-copy-inbox", label: "Auto-anki: copy LLM inbox records" }, async () => {
    const r = await globalThis.LlmContact.copyRecords();
    logseq.UI.showMsg(r.count ? `${r.count} LLM inbox record(s) ${r.copied ? "copied as JSON lines" : "printed to the console (clipboard unavailable)"}` : "No LLM inbox records in this plugin", "info");
  });
  // contact_eli messages Claude said were task remarks (confirm step): never sent, kept so they can be audited (README)
  logseq.App.registerCommandPalette({ key: "auto-anki-copy-unconfirmed", label: "Auto-anki: copy unconfirmed LLM messages" }, async () => {
    const r = await globalThis.LlmContact.copyUnconfirmed();
    logseq.UI.showMsg(r.count ? `${r.count} unconfirmed message(s) ${r.copied ? "copied as JSON lines" : "printed to the console (clipboard unavailable)"}` : "No unconfirmed LLM messages in this plugin", "info");
  });
  logseq.App.registerCommandPalette({ key: "auto-anki-edit-prompt", label: "Auto-anki: edit prompt" }, async () => {
    const title = S().promptPage || "auto-anki/prompt";
    try {
      const existing = await adapter.readPageTrees(title);
      if (!existing || !core.promptFromTrees(existing)) await adapter.writePageTrees(title, core.defaultPromptTrees());
      await adapter.openPage(title);
    } catch (e) { console.error("[auto-anki]", e); logseq.UI.showMsg("Auto-anki: could not open the prompt page: " + e.message, "error"); }
  });
  console.log("[auto-anki] loaded");
}

logseq.ready(main).catch(console.error);
