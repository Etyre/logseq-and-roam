/**
 * Page tags inheritance (Logseq file graphs). Logseq does not let blocks inherit the
 * page's `tags::` in block queries; blocks do inherit their ancestors' references.
 * So every top-level block carries a hidden `page-tags::` property equal to the page's
 * `tags::` (the converter writes it for the imported graph; this plugin keeps it right
 * as you add blocks or change a page's tags). Hidden through :block-hidden-properties
 * #{:page-tags} in config.edn.
 */

const PROP = "page-tags";
const pending = new Map();

async function pageTagsValue(pageId) {
  const page = await logseq.Editor.getPage(pageId);
  if (!page) return null;
  const tree = await logseq.Editor.getPageBlocksTree(page.name);
  const first = tree && tree[0];
  // the page's properties live in the first block (pre-block) or the front matter
  const raw = first && first["preBlock?"] ? (first.content || "") : "";
  const m = raw.match(/^tags::[ \t]*(.*)$/m);
  if (m) return m[1].trim();
  const props = page.properties || {};
  if (Array.isArray(props.tags) && props.tags.length) return props.tags.map((t) => `[[${t}]]`).join(", ");
  if (typeof props.tags === "string" && props.tags.trim()) return props.tags.trim();
  return null;
}

/** The tag names in a tags value, however it is spelled ("[[a]], [[b]]", "#a #b", "a, b", or Logseq's parsed array), sorted. */
function tagNames(v) {
  if (Array.isArray(v)) return v.map((t) => String(t).trim().toLowerCase()).filter(Boolean).sort().join("\n");
  const s = String(v || "");
  const out = [];
  const rest = s.replace(/#?\[\[([^\]]+)\]\]/g, (m, t) => { out.push(t); return ","; }).replace(/#([^\s,#]+)/g, (m, t) => { out.push(t); return ","; });
  for (const t of rest.split(",")) if (t.trim()) out.push(t);
  return out.map((t) => t.trim().toLowerCase()).sort().join("\n");
}

async function syncPage(pageId) {
  const page = await logseq.Editor.getPage(pageId);
  if (!page || page["journal?"] === undefined) return;
  const value = await pageTagsValue(pageId);
  const tree = await logseq.Editor.getPageBlocksTree(page.name);
  const editingNow = await logseq.Editor.checkEditing();
  // the page's tags are being typed: wait, or every half-typed tag is copied onto every block
  if (editingNow && tree && tree[0] && tree[0]["preBlock?"] && tree[0].uuid === editingNow) { schedule(pageId, 3000); return; }
  let n = 0;
  for (const b of tree || []) {
    if (b["preBlock?"]) continue;
    const cur = b.properties && (b.properties.pageTags || b.properties["page-tags"]);
    // Compared as sets of tag names. Comparing the raw tags:: line with a re-serialised property never
    // matched for "#a", "[[a]],[[b]]" or a different order, and the block was rewritten every 1.5 s for ever.
    const own = (b.content || "").match(/^page-tags::[ \t]*(.*)$/m);
    const same = cur !== undefined && (tagNames(cur) === tagNames(value) || (own && tagNames(own[1]) === tagNames(value)));
    if (value && !same) {
      const editing = await logseq.Editor.checkEditing();
      if (editing && editing === b.uuid) { schedule(pageId, 3000); continue; }
      await logseq.Editor.upsertBlockProperty(b.uuid, PROP, value); n++;
    } else if (!value && cur !== undefined) {
      await logseq.Editor.removeBlockProperty(b.uuid, PROP); n++;
    }
  }
  if (n) console.log(`[page-tags] ${page.name}: ${n} top-level block(s) updated`);
}

function schedule(pageId, delay = 1500) {
  clearTimeout(pending.get(pageId));
  pending.set(pageId, setTimeout(() => { pending.delete(pageId); syncPage(pageId).catch((e) => console.error("[page-tags]", e)); }, delay));
}

function main() {
  logseq.DB.onChanged(({ blocks }) => {
    for (const b of blocks || []) {
      if (!b || !b.page) continue;
      // only top-level blocks (parent is the page) and the pre-block matter
      if (b.parent && b.page && b.parent.id === b.page.id) schedule(b.page.id);
    }
  });
  logseq.App.registerCommandPalette(
    { key: "page-tags-sync-current", label: "Page tags: sync the hidden page-tags property on this page" },
    async () => { const p = await logseq.Editor.getCurrentPage(); if (p) await syncPage(p.id); }
  );
  console.log("[page-tags] loaded");
}

logseq.ready(main).catch(console.error);
