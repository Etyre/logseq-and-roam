# Page tags inheritance (Logseq plugin)

Roam-style behaviour: every block on a page tagged `tags:: [[source]]` counts as tagged
`source` in block queries and linked references. Logseq does not do that itself (checked
2026-09-05), but blocks inherit their ancestors' references, so this plugin keeps a hidden
`page-tags::` property on every top-level block equal to the page's `tags::`. The converter
writes the same property for the imported graph; `config.edn` hides it
(`:block-hidden-properties #{:page-tags}`); the reverse exporter drops it.

Command "Page tags: sync the hidden page-tags property on this page" forces an update.

Install: Settings, Advanced, Developer mode; Plugins, "Load unpacked plugin", this folder.

**Gotcha (2026-11-20):** the "already in sync" test compares tag names as a set. It used to compare the raw `tags::` line with the property Logseq hands back, which never matched for `tags:: #a`, `[[a]],[[b]]` or a different order, so every top-level block was rewritten every 1.5 s for as long as the page was loaded. The sync also waits while the page-properties block is being edited.
