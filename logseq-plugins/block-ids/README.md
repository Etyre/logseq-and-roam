# Block IDs (Logseq plugin)

Persists a block's uuid as an `id::` property the moment the block is tagged
`#ankify`, and does the same for the block's parent. This gives ankify_logseq a
stable id to store on the Anki note. It is the same thing Logseq does itself when
you reference a block; nothing else in the file changes.

Also adds a command palette entry, **Block IDs: persist ids for all tagged blocks
(and parents)**, which does it for every tagged block in the graph at once. Run it
once after importing a graph, and any time you suspect the live trigger missed
something (blocks tagged on mobile, with the plugin disabled, etc).

The plugin never deletes anything and never changes a block that already has an id.

## Install (unpacked, no build step)

1. Logseq → Settings → Advanced → turn on **Developer mode**.
2. `…` menu → **Plugins** → **Load unpacked plugin** → choose this `plugin/` directory.
3. The plugin appears as **Block IDs**. Its settings (tag name, whether to persist
   the parent, debounce) are under the plugin's gear icon.

## Files

- `index.html`, `index.js`: the plugin.
- `lsplugin.user.min.js`: the Logseq plugin SDK (`@logseq/libs`), vendored so the
  plugin loads without network access.
- `package.json`: plugin manifest.
