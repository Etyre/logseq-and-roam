/**
 * Expand button (Logseq file graphs). Roam renders {{[[Some label]]}} as a button
 * (cosmetic in Eli's graph: Focusing checklist, yes / no, nap checklist, ...). The
 * converter turns those into {{renderer :rbutton, [[Some label]]}} (or
 * {{renderer :rbutton, Some label}} when the Roam form had no page ref). This plugin
 * renders them as a button and, when clicked, expands the block the button is in
 * one level: the children become visible, each child that has children of its own
 * is collapsed (decided 2026-09-05).
 */

const KEY = "rbutton";

function labelOf(args) {
  const raw = args.slice(1).join(",").trim();
  const m = raw.match(/^\[\[(.*)\]\]$/);
  return { label: m ? m[1] : raw, page: m ? m[1] : null };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function main() {
  logseq.provideStyle(`
    .rbutton { display: inline-block; padding: 0.05em 0.6em; margin: 0 0.15em; border-radius: 0.35em;
      border: 1px solid var(--ls-border-color, #ccc); background: var(--ls-secondary-background-color, #f2f2f2);
      color: var(--ls-primary-text-color, #333); font-size: 0.9em; line-height: 1.5; cursor: pointer; user-select: none; }
    .rbutton:hover { filter: brightness(0.95); }
  `);
  logseq.provideModel({
    async expandOneLevel(e) {
      const uuid = e.dataset.uuid;
      const block = await logseq.Editor.getBlock(uuid, { includeChildren: true });
      if (!block) return;
      await logseq.Editor.setBlockCollapsed(uuid, false);
      for (const child of block.children || []) {
        const cu = child.uuid || child[1];
        if (!cu) continue;
        const c = await logseq.Editor.getBlock(cu);
        if (c && c.children && c.children.length) await logseq.Editor.setBlockCollapsed(cu, true);
      }
    },
  });
  logseq.App.onMacroRendererSlotted(({ slot, payload }) => {
    const args = payload.arguments || [];
    if ((args[0] || "").trim() !== ":" + KEY) return;
    const { label, page } = labelOf(args);
    logseq.provideUI({
      key: `${KEY}-${slot}`,
      slot,
      reset: true,
      template: `<a class="rbutton" data-on-click="expandOneLevel" data-uuid="${payload.uuid}" title="${page ? "expand one level (button label links to page " + esc(page) + ")" : "expand one level"}">${esc(label)}</a>`,
    });
  });
  logseq.Editor.registerSlashCommand("button", async () => {
    await logseq.Editor.insertAtEditingCursor("{{renderer :rbutton, [[label]]}} ");
  });
  console.log("[expand-button] loaded");
}

logseq.ready(main).catch(console.error);
