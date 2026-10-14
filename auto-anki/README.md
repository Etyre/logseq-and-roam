# auto-anki

Shared implementation of the "Auto-anki blocks" feature for Roam and Logseq.

- `core.js` — platform-independent logic: state block format, edit detection (frozen
  notes), prompt, Claude call (raw HTTP, structured JSON output), planning and applying
  the model's answer through an adapter.
- `roam-adapter.js` — Roam side (roamAlphaAPI reads/writes, styling, pull watches,
  command palette). `build.sh` concatenates core + adapter into `../roam/auto-anki.js`.
- `../logseq-plugins/auto-anki/` — Logseq plugin; `build.sh` copies `core.js` there.
- `test_core.js` — `node auto-anki/test_core.js` runs the core against a fake graph and
  a fake Claude.

Edit `core.js` / `roam-adapter.js`, run `./build.sh`, then re-paste the Roam file and
reload the Logseq plugin.

## How it behaves

| | |
|---|---|
| Home block | any block carrying a home tag (setting) |
| Content blocks | the home block's siblings and all their descendants; other home blocks and their subtrees are excluded |
| Notes | under the home block; `{c1:…}` / `{c1:…::hint}` cloze or question + child-block answers; `#ankify` appended automatically |
| Headings | with more than 6 notes (setting) the model files every note under a labelled heading block; each leaf heading holds 2 to 6 notes (settings), and a heading may hold sub-headings instead of notes (two levels at most). A heading is any tagless block under the home block with notes below it. The model keeps, retitles or adds headings and may move any note between them (frozen notes move but keep their text). Headings the model made are deleted once nothing is left under them. |
| Home block tags | the model adds topic tags after the home tag; it replaces only the tags it wrote last time |
| Frozen | a note whose text (or answer children) differ from what the model last wrote, or that the model never wrote. Detected live (pull watch / DB change) and again before every run. Permanent. The model is told which notes are frozen and its edits/deletes of them are discarded even if it tries. |
| State | last child of the home block: `#auto-anki-state {json}` with per-note hashes, the frozen list, the content hash and the model's tags. Hidden by CSS; survives the Roam→Logseq conversion as an ordinary block. |
| Examples | graph-wide page `auto-anki/examples` (setting). Every note that freezes gets an entry: `EDITED · date · page` with "LLM wrote: …" and "User's version: …" (kept current as the user keeps editing), `WRITTEN BY THE USER · …`, or `DELETED BY THE USER · …` with the LLM's text; deleting an edited note relabels its entry "…, THEN DELETED". The whole page is sent as a second (cached) system block with every request, so the model learns the user's taste over time. The user may prune or edit the page. |
| Prompt | page `auto-anki/prompt` (setting); "Auto-anki: edit prompt" seeds it from the built-in text; empty/missing = built-in |
| Off | a home block carrying an off tag (setting, default `auto-anki off`) or sitting inside a template definition (Roam: ancestor tagged `#roam/templates` or `#SmartBlock`; Logseq: ancestor with `template::`) is inactive: dashed grey border, no button, no tracking; commands refuse it. Blocks created from the template are active. |
| Stale dot | amber when the content hash differs from the last run |
| Card count | the bar on the home block shows "N cards", plus "· k edited" when some notes are frozen; refreshed with the status |
| Auto-update | off by default; when on, a run starts after the content has been quiet for N minutes |
