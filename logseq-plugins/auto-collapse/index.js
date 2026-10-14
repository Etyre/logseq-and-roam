/**
 * Auto-collapse (Logseq file graphs). Two tags, checked on launch and whenever a
 * page is opened:
 *
 *   #auto-collapse-children  the block's children are collapsed (each child hides
 *                            its own children), as the roam/js script did.
 *   #auto-collapse       the block itself is collapsed (hides its children).
 *
 * Logseq persists both as `collapsed:: true` on the affected blocks.
 */

const CHILDREN_TAG = "auto-collapse-children";
const SELF_TAG = "auto-collapse";

async function taggedBlocks(tag, pageName) {
  const pageClause = pageName ? `[?b :block/page ?pg] [?pg :block/name "${pageName.toLowerCase().replace(/"/g, '\\"')}"]` : "";
  try {
    const rows = await logseq.DB.datascriptQuery(
      `[:find (pull ?b [:block/uuid]) :where [?b :block/refs ?t] [?t :block/name "${tag}"] ${pageClause}]`
    );
    return (rows || []).map((r) => r[0]).filter((b) => b && b.uuid);
  } catch (e) {
    console.error("[auto-collapse] query failed", e);
    return [];
  }
}

async function collapse(uuid) {
  const b = await logseq.Editor.getBlock(uuid);
  if (b && b.children && b.children.length && !b["collapsed?"]) {
    await logseq.Editor.setBlockCollapsed(uuid, true);
  }
}

async function run(pageName) {
  for (const b of await taggedBlocks(SELF_TAG, pageName)) {
    await collapse(b.uuid);
  }
  for (const b of await taggedBlocks(CHILDREN_TAG, pageName)) {
    const block = await logseq.Editor.getBlock(b.uuid, { includeChildren: true });
    for (const child of (block && block.children) || []) {
      const uuid = child.uuid || child[1];
      if (uuid) await collapse(uuid);
    }
  }
}

let timer = null;
function schedule(delayMs) {
  // one run for the whole graph (the tagged set is small); coalesce bursts
  clearTimeout(timer);
  timer = setTimeout(() => run(null).catch((e) => console.error("[auto-collapse]", e)), delayMs);
}

function main() {
  logseq.App.registerCommandPalette(
    { key: "auto-collapse-now", label: "Auto-collapse: apply the auto-collapse tags now" },
    () => run(null)
  );
  // journals view, page view, any navigation
  logseq.App.onRouteChanged(() => schedule(300));
  // the tag was just typed (or the graph just finished loading)
  logseq.DB.onChanged(() => schedule(1500));
  logseq.App.onCurrentGraphChanged(() => schedule(3000));
  schedule(3000);
  setTimeout(() => schedule(0), 30000);
  console.log("[auto-collapse] loaded");
}

logseq.ready(main).catch(console.error);
