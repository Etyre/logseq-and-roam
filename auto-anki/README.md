# auto-anki

Shared implementation of the "Auto-anki blocks" feature for Roam and Logseq.

- `core.js` — platform-independent logic: state block format, edit detection (frozen
  notes), prompt, Claude call (raw HTTP, streamed, structured JSON output), an incremental
  JSON scanner that writes each new note as it arrives, planning and applying the rest of
  the model's answer through an adapter.
- `roam-adapter.js` — Roam side (roamAlphaAPI reads/writes, styling, pull watches,
  command palette). `build.sh` concatenates core + adapter into `../roam/auto-anki.js`.
- `../logseq-plugins/auto-anki/` — Logseq plugin; `build.sh` copies `core.js` there.
- `test_core.js` — `node auto-anki/test_core.js` runs the core against a fake graph and
  a fake Claude (including a `contact_eli` call and an `@ELI:` line, which must write no cards, and
  the confirm step: keep working, send, and a failing question call).
- `../llm-contact/llm-contact.js` — the shared LLM-inbox preamble and `contact_eli` tool, baked in
  by `build.sh`; the preamble precedes the prompt (built-in or from `auto-anki/prompt`) on every
  call. When Claude uses either channel the run stops without touching the cards, the message goes
  to the graph page `llm-inbox` and the full record to localStorage ("Auto-anki: copy LLM inbox
  records" exports it; see the top-level README). For a model on the shared confirm list (today only
  `claude-haiku-4-5`; not the default `claude-opus-5-5`, whose calls are sent unasked) a `contact_eli`
  call is first put to the model as one question (confirm step, top-level README): if it answers that it was a remark about the task,
  the cards its first attempt streamed are removed, it is asked for the JSON answer again, and the
  remark is kept in localStorage `llm-inbox:unconfirmed` ("Auto-anki: copy unconfirmed LLM
  messages"); anything else stops the run as described.

Edit `core.js` / `roam-adapter.js`, run `./build.sh`, then re-paste the Roam file and
reload the Logseq plugin.

## How it behaves

| | |
|---|---|
| Home block | any block carrying a home tag (setting) |
| Make cards here | added 2026-11-19: type `/cards` in any block (Roam: `CONFIG.slashTriggers`; Logseq: the slash command "cards"), or run "Auto-anki: make cards here" from the command palette or the block's right-click menu. The trigger text is removed, the first home tag is appended to whatever else the block holds, and the run starts at once; from then on it is an ordinary home block. Inside an existing card section the command just updates that section. |
| Content blocks | the text of the home block's parent block (sent as PARENT BLOCK; nothing when the parent is the page, whose title is sent anyway), and the home block's siblings and all their descendants; other home blocks and their subtrees are excluded. Nothing else on the page is read. |
| Notes | under the home block; `{c1:…}` / `{c1:…::hint}` cloze or question + child-block answers. Since 2026-11-20 they are written **without** `#ankify`: a card reaches Anki only once you tag it yourself. Tagging or untagging is not an edit (the card is not frozen, no example is recorded), and a later run that rewrites a tagged card keeps its tag. Cards made before the change keep their tags. Setting `tagNewCards` (Roam `CONFIG`, Logseq plugin settings) brings back tagging at creation. |
| Headings | with more than 6 notes (setting) the model files every note under a labelled heading block; each leaf heading holds 2 to 6 notes (settings), and a heading may hold sub-headings instead of notes (two levels at most). A heading is any block under the home block that is not a card and has cards below it; a card is a block with the ankify tag or one the state block records as written by the model. The model keeps, retitles or adds headings and may move any note between them (frozen notes move but keep their text). Headings the model made are deleted once nothing is left under them. |
| Home block tags | the model adds topic tags after the home tag; it replaces only the tags it wrote last time |
| Frozen | a note whose text (or answer children) differ from what the model last wrote, or that the model never wrote. Detected live (pull watch / DB change) and again before every run. Permanent. The model is told which notes are frozen and its edits/deletes of them are discarded even if it tries. |
| State | last child of the home block: `#auto-anki-state {json}` with per-note hashes, the frozen list, the content hash and the model's tags. Hidden by CSS; survives the Roam→Logseq conversion as an ordinary block. |
| Examples | graph-wide page `auto-anki/examples` (setting). Every note that freezes gets an entry: `EDITED · date · page` with "LLM wrote: …" and "User's version: …" (kept current as the user keeps editing), `WRITTEN BY THE USER · …`, or `DELETED BY THE USER · …` with the LLM's text; deleting an edited note relabels its entry "…, THEN DELETED". The whole page is sent as a second (cached) system block with every request, so the model learns the user's taste over time. The user may prune or edit the page. |
| Prompt | page `auto-anki/prompt` (setting); "Auto-anki: edit prompt" seeds it from the built-in text; empty/missing = built-in |
| Off | a home block carrying an off tag (setting, default `auto-anki off`) or sitting inside a template definition (Roam: ancestor tagged `#roam/templates` or `#SmartBlock`; Logseq: ancestor with `template::`) is inactive: dashed grey border, no button, no tracking; commands refuse it. Blocks created from the template are active. |
| Streaming | the answer streams in and every new note (and the heading it sits under) is written the moment the model finishes it, so the cards fill in block by block; the bar counts "N written…" meanwhile. Updates, moves and deletions of existing notes and heading retitles wait for the complete answer. If the call fails half way or Claude asks for Eli, the blocks written so far are deleted again, so a run is still all or nothing |
| Stale dot | amber when the content hash, or the parent block's text, differs from the last run (sections last run before 2026-11-19 have no parent hash and do not turn amber for that reason) |
| Card count | the bar on the home block shows "N cards", plus "· k edited" when some notes are frozen; refreshed with the status |
| Auto-update | off by default; when on, a run starts after the content has been quiet for N minutes |
