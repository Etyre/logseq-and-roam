/**
 * Backwards embed (Logseq file graphs). Counterpart of roam/backwards-embed.js.
 *
 * Trigger "/Backwards embed" (or the command palette / Mod+Shift+E) while editing a
 * block, pick a page from the filtered list, and the plugin creates a new block on that
 * page (appended at the top level, or nested under the first block matching one of
 * the "Parent block names" setting, tried in order), inserts {{embed ((uuid))}} into the block you
 * triggered it from, and puts the cursor in the new block.
 */

const SETTINGS = [
  {
    key: "parentBlockNames",
    type: "string",
    inputAs: "textarea",
    title: "Parent block names",
    description:
      'One per line (or separated by ";"), tried in order: the new block is nested under the first block on the target page whose text equals one of these (case-insensitive; "[[x]]", "#x" and a trailing colon also match). Empty = always append at the top level of the page.',
    default: "Global notes:\nGeneral notes:\nNotes:",
  },
  {
    key: "createParentIfMissing",
    type: "boolean",
    title: "Create the parent block if missing",
    description: "If the target page has none of those blocks, create the first name (on) or append at the top level (off).",
    default: false,
  },
  {
    key: "embedParentWithChildren",
    type: "boolean",
    title: "Embed the parent block with its children",
    description: "On: embed the parent block itself, so its whole subtree shows in one embed; a new child is only created when the parent has none. Off: always create a new block under the parent and embed just that block.",
    default: false,
  },
  {
    key: "newBlockText",
    type: "string",
    title: "Initial text of the new block",
    description: "Leave empty to start with an empty block.",
    default: "",
  },
  {
    key: "includeJournalPages",
    type: "boolean",
    title: "Show journal pages in the picker",
    description: "",
    default: true,
  },
];

const crumbCache = new Map(); // uuid -> crumb info | null
const MARK = "backembed"; // property on blocks created by this command (hide it via :block-hidden-properties)

const S = () => Object.fromEntries(SETTINGS.map((s) => [s.key, logseq.settings?.[s.key] ?? s.default]));

// ---------- helpers ----------
function normaliseName(s) {
  return String(s || "")
    .split("\n")[0]
    .trim()
    .replace(/^#/, "")
    .replace(/^\[\[(.*)\]\]$/, "$1")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();
}

function findParent(blocks, wanted) {
  for (const b of blocks || []) {
    if (normaliseName(b.content) === wanted) return b;
    const inner = findParent(b.children, wanted);
    if (inner) return inner;
  }
  return null;
}

// The "Parent block names" setting as a list; falls back to the old single-name key.
function parentNames(cfg) {
  let raw = cfg.parentBlockNames;
  const saved = logseq.settings || {};
  if (saved.parentBlockNames === undefined && saved.parentBlockName) raw = saved.parentBlockName;
  return String(raw || "")
    .split(/[\n;]/)
    .map((n) => n.trim())
    .filter((n) => normaliseName(n));
}

async function getOrCreatePage(name) {
  let page = await logseq.Editor.getPage(name);
  if (page) return page;
  page = await logseq.Editor.createPage(name, {}, { redirect: false, createFirstBlock: false, journal: false });
  if (!page) throw new Error(`could not create page "${name}"`);
  return page;
}

async function markEmbedded(block) {
  // Make the uuid durable in the file so the embed survives a re-index, and mark the
  // block so only embeds of backwards-embedded blocks get the source breadcrumb.
  await logseq.Editor.upsertBlockProperty(block.uuid, "id", block.uuid);
  await logseq.Editor.upsertBlockProperty(block.uuid, MARK, true);
  crumbCache.delete(block.uuid);
}

async function newChild(parent, text) {
  const kids = (parent.children || []).filter((c) => c && c.uuid);
  const block = kids.length
    ? await logseq.Editor.insertBlock(kids[kids.length - 1].uuid, text, { sibling: true, focus: false })
    : await logseq.Editor.insertBlock(parent.uuid, text, { sibling: false, focus: false });
  if (!block) throw new Error("block creation failed");
  return block;
}

// Returns { embed, focus, focusAtEnd } (blocks).
async function resolveOnPage(pageName) {
  const cfg = S();
  const page = await getOrCreatePage(pageName);
  const names = parentNames(cfg);
  let parent = null;
  if (names.length) {
    const tree = await logseq.Editor.getPageBlocksTree(page.name);
    for (const name of names) {
      parent = findParent(tree, normaliseName(name));
      if (parent) break;
    }
    if (!parent && cfg.createParentIfMissing) {
      parent = await logseq.Editor.appendBlockInPage(page.uuid, names[0], { focus: false });
      if (!parent) throw new Error("could not create the parent block");
      parent.children = [];
    }
  }
  let embed, focus, focusAtEnd = false;
  if (parent && cfg.embedParentWithChildren) {
    const kids = (parent.children || []).filter((c) => c && c.uuid);
    embed = parent;
    if (kids.length) { focus = kids[kids.length - 1]; focusAtEnd = true; }
    else focus = await newChild(parent, cfg.newBlockText);
  } else if (parent) {
    embed = focus = await newChild(parent, cfg.newBlockText);
  } else {
    embed = focus = await logseq.Editor.appendBlockInPage(page.uuid, cfg.newBlockText, { focus: false });
    if (!embed) throw new Error("block creation failed");
  }
  await markEmbedded(embed);
  if (focus !== embed) await logseq.Editor.upsertBlockProperty(focus.uuid, "id", focus.uuid);
  return { embed, focus, focusAtEnd };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function editorTextarea() {
  const doc = top.document;
  return doc.querySelector('textarea[id^="edit-block-"]') || doc.querySelector(".editor-wrapper textarea") || null;
}

// Logseq's exitEditingMode only acts when the editor textarea is the window's active
// element; after our popup had focus it is not, so refocus it first. Fall back to an
// Escape keypress and then a click outside the block.
async function leaveEditing() {
  const ta = editorTextarea();
  if (ta) ta.focus();
  try { await logseq.Editor.exitEditingMode(false); } catch (e) {}
  await sleep(60);
  if (!(await logseq.Editor.checkEditing())) return;
  if (ta && ta.isConnected) {
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    await sleep(60);
    if (!(await logseq.Editor.checkEditing())) return;
  }
  const outside = top.document.querySelector("#main-content-container") || top.document.body;
  for (const type of ["mousedown", "mouseup", "click"]) {
    outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: top }));
  }
  await sleep(60);
}

function embeddedBlockElement(uuid) {
  const els = [...top.document.querySelectorAll(`.ls-block[blockid="${uuid}"]`)];
  const inEmbed = els.filter((el) => el.closest(".embed-block"));
  const pick = inEmbed.length ? inEmbed : els;
  return pick.length ? pick[pick.length - 1] : null;
}

async function isEditing(uuid) {
  try {
    const b = await logseq.Editor.getCurrentBlock();
    return !!(b && b.uuid === uuid) && !!(await logseq.Editor.checkEditing());
  } catch (e) { return false; }
}

function clickInto(el) {
  const target = el.querySelector(".block-content") || el;
  for (const type of ["mousedown", "mouseup", "click"]) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: top }));
  }
}

async function focusEmbeddedBlock(uuid, atEnd) {
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    const el = embeddedBlockElement(uuid);
    if (!el) continue;
    try { await logseq.Editor.editBlock(uuid, atEnd ? {} : { pos: 0 }); } catch (e) {}
    await sleep(100);
    if (await isEditing(uuid)) return true;
    clickInto(el);
    await sleep(150);
    if (await isEditing(uuid)) return true;
  }
  return false;
}

async function doBackwardsEmbed(target, pageName) {
  pageName = pageName.trim();
  if (!pageName) return;
  const { embed: embedBlock, focus, focusAtEnd } = await resolveOnPage(pageName);
  const embed = `{{embed ((${embedBlock.uuid}))}}`;
  const text = target.content || "";
  let next;
  if (!text.trim()) next = embed;
  else {
    const pos = Math.min(Math.max(target.pos ?? text.length, 0), text.length);
    const before = text.slice(0, pos), after = text.slice(pos);
    const sep1 = before && !/\s$/.test(before) ? " " : "";
    const sep2 = after && !/^\s/.test(after) ? " " : "";
    next = before + sep1 + embed + sep2 + after;
  }
  // While the source block is being edited, updateBlock only rewrites the editor text;
  // leaving edit mode then saves it. Verify, and save directly if it did not stick.
  await logseq.Editor.updateBlock(target.uuid, next);
  await leaveEditing();
  const saved = await logseq.Editor.getBlock(target.uuid);
  if (!saved || !(saved.content || "").includes(embedBlock.uuid)) {
    await logseq.Editor.updateBlock(target.uuid, next);
  }
  // Put the cursor in the right block once the embed has rendered.
  focusEmbeddedBlock(focus.uuid, focusAtEnd).catch(() => {});
}

// ---------- picker (runs inside the plugin's main UI iframe) ----------
let pickerState = null; // { target, titles, exact, items, selected }

function rank(titles, query) {
  const q = query.trim().toLowerCase();
  if (!q) return titles.slice(0, 40);
  const starts = [], contains = [];
  for (const t of titles) {
    const l = t.toLowerCase();
    if (l.startsWith(q)) starts.push(t);
    else if (l.includes(q)) contains.push(t);
  }
  const byLen = (a, b) => a.length - b.length;
  return starts.sort(byLen).concat(contains.sort(byLen)).slice(0, 40);
}

function renderList() {
  const st = pickerState;
  if (!st) return;
  const q = document.getElementById("q").value;
  st.items = rank(st.titles, q);
  const trimmed = q.trim();
  if (trimmed && !st.exact.has(trimmed.toLowerCase())) st.items.push({ create: trimmed });
  if (st.selected >= st.items.length) st.selected = Math.max(0, st.items.length - 1);
  const list = document.getElementById("list");
  list.innerHTML = "";
  st.items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "row" + (i === st.selected ? " sel" : "") + (typeof it !== "string" ? " create" : "");
    row.textContent = typeof it === "string" ? it : `Create page "${it.create}"`;
    row.addEventListener("mousemove", () => { if (st.selected !== i) { st.selected = i; renderList(); } });
    row.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
    list.append(row);
  });
  list.children[st.selected]?.scrollIntoView({ block: "nearest" });
}

function closePicker(restore) {
  pickerState = null;
  logseq.hideMainUI({ restoreEditingCursor: !!restore });
}

// Drafts are never lost: the query is saved as you type and comes back (selected, so typing
// replaces it) the next time the picker opens; it is cleared only when a page is chosen.
const DRAFT_KEY = "backwards-embed:query";
const draft = {
  get: () => { try { return localStorage.getItem(DRAFT_KEY) || ""; } catch (e) { return ""; } },
  set: (v) => { try { if (v) localStorage.setItem(DRAFT_KEY, v); else localStorage.removeItem(DRAFT_KEY); } catch (e) {} },
};

function choose(i) {
  const st = pickerState;
  const it = st?.items[i];
  if (it === undefined) return;
  const target = st.target;
  draft.set(""); // submitted: the draft has done its job
  closePicker(false);
  const name = typeof it === "string" ? it : it.create;
  doBackwardsEmbed(target, name).catch((e) => {
    console.error("[backwards-embed]", e);
    logseq.UI.showMsg("Backwards embed failed: " + e.message, "error");
  });
}

async function openPicker() {
  const block = await logseq.Editor.getCurrentBlock();
  if (!block) {
    logseq.UI.showMsg("Backwards embed: put the cursor in a block first.", "warning");
    return;
  }
  let content = await logseq.Editor.getEditingBlockContent();
  if (content == null) content = block.content || "";
  const cur = await logseq.Editor.getEditingCursorPosition();
  const target = { uuid: block.uuid, content, pos: cur ? cur.pos : content.length };

  const cfg = S();
  const pages = (await logseq.Editor.getAllPages()) || [];
  const titles = pages
    .filter((p) => p && p.originalName && (cfg.includeJournalPages || !p["journal?"]))
    .map((p) => p.originalName)
    .sort((a, b) => a.localeCompare(b));
  pickerState = { target, titles, exact: new Set(titles.map((t) => t.toLowerCase())), items: [], selected: 0 };

  const cfgs = await logseq.App.getUserConfigs();
  document.body.classList.toggle("dark", cfgs?.preferredThemeMode === "dark");
  const input = document.getElementById("q");
  input.value = draft.get();
  renderList();
  logseq.showMainUI({ autoFocus: true });
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function wireUI() {
  const input = document.getElementById("q");
  input.addEventListener("input", () => { draft.set(input.value); if (pickerState) { pickerState.selected = 0; renderList(); } });
  input.addEventListener("keydown", (e) => {
    const st = pickerState;
    if (!st) return;
    if (e.key === "ArrowDown") { e.preventDefault(); st.selected = Math.min(st.selected + 1, st.items.length - 1); renderList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); st.selected = Math.max(st.selected - 1, 0); renderList(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(st.selected); }
    else if (e.key === "Escape") { e.preventDefault(); closePicker(true); }
  });
  document.body.addEventListener("mousedown", (e) => { if (e.target === document.body) closePicker(true); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicker(true); });
}

// ---------- breadcrumb on embeds of backwards-embedded blocks ----------

function firstLine(content) {
  const line = (content || "").split("\n").find((l) => l.trim() && !/^[\w-]+::/.test(l));
  return (line || "").trim();
}

async function crumbsFor(uuid) {
  if (crumbCache.has(uuid)) return crumbCache.get(uuid);
  let info = null;
  try {
    const block = await logseq.Editor.getBlock(uuid);
    const marked = block && block.properties && block.properties[MARK] !== undefined && block.properties[MARK] !== false;
    if (marked) {
      const page = await logseq.Editor.getPage(block.page.id);
      info = { pageName: page ? page.name : null, pageLabel: page ? page.originalName || page.name : "?", parentUuid: null, parentText: null };
      if (block.parent && block.parent.id !== block.page.id) {
        const parent = await logseq.Editor.getBlock(block.parent.id);
        if (parent) { info.parentUuid = parent.uuid; info.parentText = firstLine(parent.content); }
      }
    }
  } catch (e) { console.error("[backwards-embed] crumbs", e); }
  crumbCache.set(uuid, info);
  return info;
}

function decorateEmbeds() {
  const doc = top.document;
  const embeds = doc.querySelectorAll(".embed-block:not([data-backembed])");
  embeds.forEach(async (el) => {
    const inner = el.querySelector(".ls-block[blockid]");
    if (!inner) return;
    const uuid = inner.getAttribute("blockid");
    el.setAttribute("data-backembed", "checking");
    const info = await crumbsFor(uuid);
    if (!info || !el.isConnected) { el.setAttribute("data-backembed", "no"); return; }
    el.setAttribute("data-backembed", "yes");
    const bar = doc.createElement("div");
    bar.className = "backembed-crumbs";
    const pageLink = doc.createElement("a");
    pageLink.textContent = info.pageLabel;
    pageLink.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (info.pageName) logseq.App.pushState("page", { name: info.pageName }); });
    bar.append(pageLink);
    if (info.parentText) {
      const sep = doc.createElement("span"); sep.className = "backembed-sep"; sep.textContent = "›";
      const parentLink = doc.createElement("a");
      parentLink.textContent = info.parentText;
      parentLink.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); logseq.App.pushState("page", { name: info.parentUuid }); });
      bar.append(sep, parentLink);
    }
    el.prepend(bar);
  });
}

function watchEmbeds() {
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(decorateEmbeds, 150); };
  new MutationObserver(schedule).observe(top.document.body, { childList: true, subtree: true });
  logseq.DB.onChanged(({ blocks }) => { (blocks || []).forEach((b) => b && b.uuid && crumbCache.delete(b.uuid)); schedule(); });
  schedule();
}

function main() {
  logseq.useSettingsSchema(SETTINGS);
  logseq.provideStyle(`
    .embed-block .backembed-crumbs { font-size: 0.8em; opacity: 0.7; padding: 2px 8px 0 8px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .embed-block .backembed-crumbs a { cursor: pointer; }
    .embed-block .backembed-crumbs a:hover { text-decoration: underline; opacity: 1; }
    .embed-block .backembed-crumbs .backembed-sep { opacity: 0.6; }
    /* fallback in case :block-hidden-properties does not include ${MARK} */
    .block-properties .property:has([data-ref="${MARK}"]), .block-properties > div:has(> [data-ref="${MARK}"]) { display: none; }
  `);
  watchEmbeds();
  logseq.setMainUIInlineStyle({ zIndex: 99 });
  wireUI();
  logseq.Editor.registerSlashCommand("Backwards embed", openPicker);
  logseq.App.registerCommandPalette(
    { key: "backwards-embed", label: "Backwards embed", keybinding: { binding: "mod+shift+e", mode: "editing" } },
    openPicker
  );
  console.log("[backwards-embed] loaded");
}

logseq.ready(main).catch(console.error);
