# Roam-style checkboxes (Logseq plugin)

Roam's `{{[[TODO]]}}` is an inline widget: a block can hold several, anywhere in
the text. Logseq's task marker is one word at the start of a block. This plugin adds
an inline checkbox that behaves like Roam's:

    {{renderer :cb, todo, k7f2}}   → ○  (click → done)
    {{renderer :cb, done, k7f2}}   → ●✓ (click → todo)

The last argument is a short id so several checkboxes in one block can be told
apart; a macro written without one gets an id assigned on first render. It looks
deliberately different from Logseq's built-in TODO (a rounded-square box, no marker word).

- Slash command **checkbox** (type `/checkbox`) inserts one at the cursor.
- The migration converts Roam blocks with several checkboxes, or a checkbox not at
  the start, to these macros (`roam2logseq.convert`); ankify_logseq renders them on
  cards exactly like Roam's checkboxes; the reverse conversion is one-to-one.

Install: Logseq → `…` → Plugins → Load unpacked plugin → this folder (Developer
mode must be on).
