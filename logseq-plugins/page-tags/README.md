# Page tags inheritance (Logseq plugin)

Roam-style behaviour: every block on a page tagged `tags:: [[source]]` counts as tagged
`source` in block queries and linked references. Logseq does not do that itself (checked
2026-09-05), but blocks inherit their ancestors' references, so this plugin keeps a hidden
`page-tags::` property on every top-level block equal to the page's `tags::`. The converter
writes the same property for the imported graph; `config.edn` hides it
(`:block-hidden-properties #{:page-tags}`); the reverse exporter drops it.

Command "Page tags: sync the hidden page-tags property on this page" forces an update.

Install: Settings, Advanced, Developer mode; Plugins, "Load unpacked plugin", this folder.
