# Auto-collapse (Logseq plugin)

Two tags, applied when a page is opened and once at launch for the whole graph:

- `#auto-collapse-children`: the block's children are collapsed (the roam/js behavior).
- `#auto-collapse`: the block itself is collapsed.

The command "Auto-collapse: apply the auto-collapse tags on this page" runs it by hand.

Install: Settings → Advanced → Developer mode; Plugins → "Load unpacked plugin" → this folder.

**Gotcha (2026-11-20):** a database change triggers a run only when the changed block itself carries one of the tags (you just typed it). It used to run after every change anywhere, which folded a tagged block again 1.5 s after each edit inside it.
