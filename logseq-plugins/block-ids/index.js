/**
 * Ankify IDs — Logseq plugin (file graphs).
 *
 * When a block gains the ankify tag, persist its uuid as an `id::` property, and do
 * the same for its parent block. Logseq only writes `id::` to the file when something
 * references the block; without it the uuid is regenerated on re-index, and an Anki
 * note pointing at it would break. Persisting the id is exactly what Logseq does
 * itself when you reference a block; the uuid does not change.
 *
 * Also provides a command palette entry that does this for every tagged block in the
 * graph at once (for the initial import, or as a manual fallback).
 *
 * The plugin never removes anything and never touches a block that already has an id.
 */

const SETTINGS = [
  {
    key: "tag",
    type: "string",
    default: "ankify",
    title: "Ankify tag",
    description: "Blocks carrying this tag (as #tag, #[[tag]] or [[tag]]) get a persisted id, and so do their parents.",
  },
  {
    key: "persistParent",
    type: "boolean",
    default: true,
    title: "Also persist the parent block's id",
    description: "ankify_logseq stores the parent's uuid on each Anki note so a card can open the block that holds all its siblings.",
  },
  {
    key: "allBlocks",
    type: "boolean",
    default: true,
    title: "Persist an id on every block",
    description: "Decided 2026-09-05: give every block an id:: once it has content and you have left it, not only tagged ones. Then any window re-parsing the file gets the same ids, which makes opening new windows without a fresh persist safe.",
  },
  {
    key: "debounceMs",
    type: "number",
    default: 1500,
    title: "Debounce (ms)",
    description: "How long after the last edit to a block before its id is persisted.",
  },
  {
    key: "bulkPageDelayMs",
    type: "number",
    default: 400,
    title: "Bulk command: pause between pages (ms)",
    description: "The bulk command persists one page's ids, then waits this long so Logseq's file watcher sees the write before the next one. Too fast and Logseq shows 'file has been modified on the disk' dialogs.",
  },
];

function settings() {
  const s = logseq.settings || {};
  return {
    tag: (s.tag || "ankify").trim(),
    persistParent: s.persistParent !== false,
    allBlocks: s.allBlocks !== false,
    debounceMs: Number(s.debounceMs) > 0 ? Number(s.debounceMs) : 1500,
    bulkPageDelayMs: Number(s.bulkPageDelayMs) >= 0 ? Number(s.bulkPageDelayMs) : 400,
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this block content carry the tag? Mirrors ankify_roam: #tag, #[[tag]] and [[tag]] all count. */
function hasTag(content, tag) {
  if (!content) return false;
  const t = escapeRe(tag);
  const re = new RegExp(`(^|[^\\w#\\[])#${t}(?![\\w\\-/])|#\\[\\[${t}\\]\\]|(^|[^#])\\[\\[${t}\\]\\]`, "i");
  return re.test(content);
}

function hasPersistedId(block) {
  const p = block && block.properties;
  return !!(p && (p.id || p["id"]));
}

async function persistId(block) {
  if (!block || hasPersistedId(block)) return false;
  await logseq.Editor.upsertBlockProperty(block.uuid, "id", block.uuid);
  return true;
}

async function getParentBlock(block) {
  if (!block || !block.parent || !block.page) return null;
  if (block.parent.id === block.page.id) return null; // parent is the page
  return await logseq.Editor.getBlock(block.parent.id);
}

/** Persist ids for one block (and its parent). Returns how many ids were written. */
async function processBlock(block) {
  const { persistParent } = settings();
  let n = 0;
  if (await persistId(block)) n++;
  if (persistParent) {
    const parent = await getParentBlock(block);
    if (await persistId(parent)) n++;
  }
  return n;
}

// ---------------------------------------------------------------- live trigger

const pending = new Map(); // uuid -> timeout handle

function schedule(uuid) {
  const { debounceMs } = settings();
  if (pending.has(uuid)) clearTimeout(pending.get(uuid));
  pending.set(uuid, setTimeout(() => fire(uuid), debounceMs));
}

async function fire(uuid) {
  pending.delete(uuid);
  try {
    // Don't write into a block the user is still editing; try again later.
    const editing = await logseq.Editor.checkEditing();
    if (editing && editing === uuid) {
      schedule(uuid);
      return;
    }
    const block = await logseq.Editor.getBlock(uuid);
    if (!block) return;
    const { tag, allBlocks } = settings();
    const tagged = hasTag(block.content, tag);
    if (!tagged && !allBlocks) return;
    if (!tagged) {
      // every-block mode: just this block, once it has content (empty blocks come and go)
      if (block["preBlock?"] || !(block.content || "").replace(/^\s*[\w.\-]+::.*$/gm, "").trim()) return;
      if (await persistId(block)) console.log(`[block-ids] persisted id for block ${uuid}`);
      return;
    }
    const n = await processBlock(block);
    if (n > 0) console.log(`[block-ids] persisted ${n} id(s) for block ${uuid}`);
  } catch (e) {
    console.error("[block-ids] failed", uuid, e);
  }
}

function onChanged({ blocks, txMeta }) {
  if (!blocks) return;
  const { tag, allBlocks } = settings();
  for (const b of blocks) {
    if (!b || !b.uuid) continue;
    if (!hasTag(b.content, tag)) {
      if (allBlocks && !hasPersistedId(b) && !b["preBlock?"] && (b.content || "").trim()) schedule(b.uuid);
      continue;
    }
    if (hasPersistedId(b)) {
      // Block already persisted; only the parent might still be missing.
      if (!settings().persistParent) continue;
    }
    schedule(b.uuid);
  }
}

// ---------------------------------------------------------------- bulk command

async function persistAll() {
  const { tag } = settings();
  const name = tag.toLowerCase();
  logseq.UI.showMsg(`Block IDs: scanning for blocks tagged #${tag}…`, "info");
  let rows;
  try {
    rows = await logseq.DB.datascriptQuery(
      `[:find (pull ?b [*]) :where [?b :block/refs ?p] [?p :block/name "${name}"]]`
    );
  } catch (e) {
    console.error("[block-ids] query failed", e);
    logseq.UI.showMsg("Block IDs: query failed, see console", "error");
    return;
  }
  const blocks = (rows || []).map((r) => r[0]).filter((b) => b && b.uuid && hasTag(b.content, tag));
  // Group by page: Logseq writes one file per page, and rapid successive writes to the
  // same file make its watcher report a phantom "modified on disk" conflict. So finish
  // one page, pause, then move on.
  const byPage = new Map();
  for (const b of blocks) {
    const pid = b.page && b.page.id;
    if (!byPage.has(pid)) byPage.set(pid, []);
    byPage.get(pid).push(b);
  }
  const { bulkPageDelayMs } = settings();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let written = 0, seen = 0, failed = 0, pagesTouched = 0;
  for (const [, pageBlocks] of byPage) {
    let wroteOnPage = 0;
    for (const b of pageBlocks) {
      seen++;
      try {
        const fresh = await logseq.Editor.getBlock(b.uuid);
        wroteOnPage += await processBlock(fresh || b);
      } catch (e) {
        failed++;
        console.error("[block-ids] failed on", b.uuid, e);
      }
      if (seen % 200 === 0) logseq.UI.showMsg(`Block IDs: ${seen}/${blocks.length} blocks, ${written + wroteOnPage} ids written…`, "info");
    }
    written += wroteOnPage;
    if (wroteOnPage > 0) {
      pagesTouched++;
      await sleep(bulkPageDelayMs);
    }
  }
  const msg = `Block IDs: ${blocks.length} tagged blocks scanned, ${written} ids persisted on ${pagesTouched} pages, ${failed} failed`;
  console.log("[block-ids] " + msg);
  logseq.UI.showMsg(msg, failed ? "warning" : "success", { timeout: 8000 });
}

// ---------------------------------------------------------------- Active switch
//
// {{renderer :ankify-active}} replaces the Roam component {{[[roam/render]]:((nU1XMzhKA)) "Block UID"}}
// (page "Code for all my roam/render components"): a switch that shows whether the
// card is active (no `suspend=True` tag) and flips `#[[ankify_logseq: suspend=True]]`
// <-> `#[[ankify_logseq: suspend=False]]` in the block's text when clicked.

const SUSPEND_TRUE = "#[[ankify_logseq: suspend=True]]";
const SUSPEND_FALSE = "#[[ankify_logseq: suspend=False]]";
// blocks not yet converted may still carry the Roam-era prefix; read both, write the new one
const RE_SUSPEND_TRUE = /#\[\[ankify_(?:roam|logseq): suspend=True\]\]/;
const RE_SUSPEND_FALSE = /#\[\[ankify_(?:roam|logseq): suspend=False\]\]/;

function activeSwitchHtml(uuid, content) {
  const suspended = RE_SUSPEND_TRUE.test(content);
  const missing = !suspended && !RE_SUSPEND_FALSE.test(content);
  const cls = "ankify-switch" + (suspended ? "" : " ankify-switch-on") + (missing ? " ankify-switch-missing" : "");
  const title = missing ? "no suspend tag on this block; click to add suspend=False"
    : suspended ? "suspended — click to activate" : "active — click to suspend";
  return `<a class="${cls}" title="${title}" data-on-click="toggleActive" data-uuid="${uuid}"><span class="ankify-switch-knob"></span><span class="ankify-switch-label">${suspended ? "Suspended" : "Active"}</span></a>`;
}

function installActiveSwitch() {
  logseq.provideStyle(`
    .ankify-switch { display: inline-flex; align-items: center; gap: 0.35em; cursor: pointer; vertical-align: middle;
      border-radius: 1em; padding: 0.1em 0.5em 0.1em 0.15em; background: #b8b8b8; color: #fff; font-size: 0.8em; user-select: none; }
    .ankify-switch-on { background: #2f9e44; }
    .ankify-switch-missing { background: #d9a400; }
    .ankify-switch-knob { width: 1em; height: 1em; border-radius: 50%; background: #fff; display: inline-block; }
    .ankify-switch-on .ankify-switch-knob { order: 2; }
    .ankify-switch:hover { filter: brightness(1.1); }
  `);
  logseq.provideModel({
    async toggleActive(e) {
      const uuid = e.dataset.uuid;
      const block = await logseq.Editor.getBlock(uuid);
      if (!block) return;
      let content;
      if (RE_SUSPEND_TRUE.test(block.content)) content = block.content.replace(RE_SUSPEND_TRUE, SUSPEND_FALSE);
      else if (RE_SUSPEND_FALSE.test(block.content)) content = block.content.replace(RE_SUSPEND_FALSE, SUSPEND_TRUE);
      else content = block.content.replace(/\{\{renderer\s+:ankify-active\s*\}\}/, "{{renderer :ankify-active}} " + SUSPEND_FALSE);
      await logseq.Editor.updateBlock(uuid, content);
    },
  });
  logseq.App.onMacroRendererSlotted(async ({ slot, payload }) => {
    const args = payload.arguments || [];
    if ((args[0] || "").trim() !== ":ankify-active") return;
    const block = await logseq.Editor.getBlock(payload.uuid);
    if (!block) return;
    logseq.provideUI({ key: `ankify-active-${slot}`, slot, reset: true, template: activeSwitchHtml(payload.uuid, block.content) });
  });
  logseq.Editor.registerSlashCommand("ankify active switch", async () => {
    await logseq.Editor.insertAtEditingCursor("{{renderer :ankify-active}} " + SUSPEND_FALSE);
  });
}

// ---------------------------------------------------------------- main

function main() {
  logseq.useSettingsSchema(SETTINGS);
  installActiveSwitch();
  logseq.DB.onChanged(onChanged);
  logseq.App.registerCommandPalette(
    { key: "block-ids-persist-all", label: "Block IDs: persist ids for all tagged blocks (and parents)" },
    persistAll
  );
  console.log("[block-ids] loaded; tag =", settings().tag);
}

logseq.ready(main).catch(console.error);
