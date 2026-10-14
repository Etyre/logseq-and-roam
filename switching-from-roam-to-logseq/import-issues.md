# Issues to handle when doing the real Roam → Logseq import

Running list, started 2026-09-04 while testing on the old "Testing LogSeq" import
and confirmed on 2026-09-04 with Logseq OG 1.0.0's importer (`fixtures/mini-roam-export.json`
imported into `~/Documents/logseq-mini-import`). Each item should be resolved (or
consciously accepted) before the canonical graph is created.

## 0. What the Logseq OG 1.0.0 importer produces, and the recommended pipeline

The OG importer writes the **same layout as the old importer**: front-matter title,
`<tab> - ` bullets, continuation lines and `id::` lines at column 0, blank lines
between blocks, `{{embed  ((((uuid))))}}` kept verbatim, `{{[[roam/render]]:...}}`
turned into the Logseq macro `{{roam/render ((uuid)) ...}}`, `{{[[TODO]]}}` turned
into a `TODO` marker. Logseq reads that layout imperfectly (§3, §4b) and bakes its
reading into each file the first time it writes it.

So the pipeline should be:

1. **Fix the export JSON** (script, Logseq closed): trailing-space page titles (§1),
   `((((` embeds (§2), `$$…$$ - ` and dash-continuation lines (§4b, escape with `\-`,
   verified 2026-09-04: `\-` keeps the block whole; an en dash also works).
2. **Import** with Logseq OG into a fresh folder; set `:journal/page-title-format`
   (§4) first.
3. **Close Logseq and normalize every file** into Logseq's native layout with
   ankify_logseq's parser (which reads the importer layout faithfully) plus a
   serializer: `<tab>- ` bullets, continuation and `id::` lines indented
   `<tabs> + two spaces`, no blank separator lines, blank lines inside blocks kept.
   Native layout is read correctly by Logseq (leading whitespace, code indentation,
   cloze-hint-at-start all survive; verified). This also gives clean git history
   for Part V.
4. **Verify** the normalized graph against the Roam JSON, block by block
   (text, nesting, markers, exact code blocks, derived ids). Zero unexplained
   differences before going on.
5. **Open in Logseq OG and Re-index** (graph menu → Re-index). Logseq had already
   cached the graph at import time; without a re-index its incremental reload
   attaches the new `id::` lines to the wrong blocks. It may also drop backup
   copies into `logseq/bak/`; the files themselves stay as normalized.
6. **Verify inside Logseq** (`roam2logseq.verify_in_logseq`, through the HTTP API):
   every block present with its derived id, at the right position. Note that a
   page with front matter has an invisible first "pre-block" holding the page
   properties; the checker skips it.
7. Install the Block IDs plugin (formerly Ankify IDs) (only needed for blocks created from now on).
8. Only then Part II.

Validated end to end on `fixtures/mini-roam-export.fixed.json` on 2026-09-04
(36 blocks, 0 problems offline and inside Logseq).

## 1. Page titles with trailing spaces collide with journal pages

Roam allows a page titled `December 16th, 2019 ` (trailing space) alongside the
daily-notes page `December 16th, 2019`. Logseq trims titles, sees two files for one
page, and **skips the page file entirely** with the warning "Page already exists with
another file". The skipped file has real content (66 lines, "Key things to do today").

- In the old test graph: 64 page files end in a space; 1 of them is a date collision.
- **Confirmed worse with the OG importer (2026-09-04):** both `December 16th, 2019`
  and `December 16th, 2019 ` were written to `journals/2019_12_16.md`, and the real
  daily page's content was **silently overwritten** by the trailing-space page's.
- Fix: on the export, strip trailing spaces from page titles and from `[[refs]]`;
  when the stripped title already exists, append the page's blocks to the existing
  page (under a marker block such as `Merged from "<title> "`). Re-check on the
  fresh export.

## 2. Quadruple-parenthesis embeds (spec Part IV)

`{{[[embed]]: ((((uid))))}}` — 289 blocks in the 2026-09-04 export. Logseq's
importer keeps the extra parentheses and then can't render them. Fix on the export.

## 3. Logseq rewrites a whole file in its own format on first edit

Observed 2026-09-04 while the plugin persisted ids on the scratch graph: the first
time Logseq writes to a Roam-imported file (any edit, including adding `id::`), it
re-serializes the entire file: `<tab> - ` bullets become `<tab>- `, blank lines
between blocks are dropped, column-0 continuation and `id::` lines get indented
under their block. Content is preserved; only layout changes.

Consequences:
- Git diffs of the graph (Part V backups) will be noisy for months as files get
  touched one by one. Consider normalizing every file once, right after import,
  so later diffs are only real edits. (Opening the graph and running the plugin's
  bulk command touches ~500 files; a full normalization would need a script or
  Logseq's re-index + re-save.)
- ankify_logseq's parser handles both layouts, verified on before/after files.

## 4. Journal title format

Set `:journal/page-title-format "MMMM do, yyyy"` in the new graph's `config.edn`
before (or right after) import, so journal titles match Roam's and inherited Anki
tags don't change.

## 4b. Block text that Logseq's parser reads as structure (confirmed 2026-09-04)

Tested by writing native-layout files and reading back what Logseq parsed:

| Pattern | What Logseq does | Blocks in the 2026-09-04 export |
|---|---|---|
| `$$...$$ - text` on the first line | splits into a block `$$...$$` with a child `text`; the original children move under the child | 5 (all in "Calculus for the Forgetful") |
| a continuation line that starts with `- ` | becomes a child block | 32 (9 ankified) |
| `{cloze::hint}` at the very start of a block | fine in native layout; **but** in the old importer's layout it was read as a property and the text was lost on rewrite | 1 (Boundless, GABA) |
| leading whitespace on continuation lines in the old column-0 layout | trimmed on load (code blocks lose their indentation) | many; check whether the OG importer still writes column-0 continuation lines |
| deep indentation jumps (child 4 levels below its parent) in the old layout | Logseq's nesting differs from the obvious reading; one journal lost a level | unknown; the old importer produced them |

Fix the first two on the export before import (e.g. put a space before the `-`, or
move the text to a child block deliberately). Whether the other three matter depends
on the OG importer's output format; test with `fixtures/mini-roam-export.json`.

## 4c. Verifying the import

`ankify_logseq`'s parser plus the Roam JSON give a way to diff the imported graph
against Roam semantically (block text, nesting, markers), whitespace-insensitive.
The checker used on the scratch graph lives in the session scratchpad
(`verify_bulk.py`); turn it into a proper `switching-from-roam-to-logseq` script
for the real import.

## 5. `{{[[roam/render]]:...}}` and other Roam macros

912 ankified blocks contain the roam/render "Block UID" macro (spec Part III/VI).
Check what the OG importer turns it into; ankify_logseq renders any `{{...}}` it
does not understand as a button placeholder, like ankify_roam.

## 6. Inline checkboxes: Roam's `{{[[TODO]]}}` is not Logseq's `TODO` (spec Part VI/IX)

In Roam a checkbox is an inline widget: a block can hold several, and they can sit
anywhere in the text. In Logseq a task marker is one word at the start of a block.
The importer turns every `{{[[TODO]]}}`/`{{[[DONE]]}}` into the bare word, so a block
like `{{[[DONE]]}}{{[[DONE]]}}{{[[TODO]]}}` becomes the text `DONEDONETODO` and loses
its meaning (only a marker at the very start becomes a real task).

Counts in the 2026-09-04 export: 31,752 blocks carry a checkbox; 112 carry two or
more; 154 have one that is not at the start of the block. Only the last two groups
(266 blocks) lose meaning in Logseq today; the rest became proper Logseq tasks.

Decided 2026-09-05 (user): build an inline checkbox element for Logseq that
behaves exactly like Roam's — clickable, checking it turns it into DONE, several
per block, anywhere in the block — and visibly distinct from Logseq's own TODO.
Then the pipeline converts, in Roam blocks that have more than one checkbox or a
checkbox not at the start, every `{{[[TODO]]}}`/`{{[[DONE]]}}` into the new element;
blocks with a single leading checkbox keep becoming native Logseq tasks.

Design: a plugin using Logseq's renderer-macro hook (`onMacroRendererSlotted`)
draws `{{renderer :cb, todo}}` / `{{renderer :cb, done}}` as a styled checkbox and,
on click, rewrites that token in the block's content. Text-level, deterministic,
and trivially reversible (`{{renderer :cb, todo}}` ↔ `{{[[TODO]]}}`), so it goes
into the fixer/converter and into the reverse exporter's table. Exact macro
spelling to be settled when the plugin is written.

## 7. Requirement: a pipeline that needs no debugging (2026-09-04)

The whole Roam → Logseq conversion must work the first time from a written
runbook. Manual steps (clicking Import in Logseq, re-indexing, starting the API
server) are acceptable if the checklist captures them exactly; what is not
acceptable is a process that needs investigation to get through.

Two consequences:

1. The runbook in `README.md` is the deliverable, with every step, its exact
   command or click, and the check that proves it worked before moving on.
2. Reduce the surface that caused debugging today by dropping Logseq's built-in
   importer where it is not needed. Everything it did is
now reimplemented and better understood (`roam2logseq.normalize_graph`:
`roam_to_logseq_text`, `build_blocks_from_roam`, `title_to_filename`, the
serializer, derived ids, the sidecar). The target is

    roam2logseq convert EXPORT.json GRAPH_DIR

= fix the export in memory → write pages/, journals/, logseq/config.edn, the
sidecar → re-parse the output and verify against the JSON → exit non-zero on any
difference. Logseq then opens GRAPH_DIR as a *new* graph (never a folder it has
cached before; see §0 step 5 for what a stale cache does).

**Done 2026-09-05** (`roam2logseq/convert.py`, README Runbook A).

The importer-based path (§0) stays as a test oracle: importing the same export
with Logseq and pairing the result against the converter's output is how the
converter's conversion rules are checked.

## 4d. Heading lines inside a block (found 2026-09-04 on the real graph)

A continuation line starting with `# ` (a markdown heading, e.g. a YAML comment
quoted in a block) makes Logseq start a new block there. Same treatment as `- `:
the fixer escapes it as `\#` outside code fences (renders as `#`; verified). One
block in the 2026-09-04 export; 26 more have such lines only inside code fences,
where Logseq does not split.

## 8. Today's journal page is special on the day of the import (2026-09-04)

On every launch Logseq makes sure today's journal page exists. When the graph was
imported and normalized on the same day, each subsequent launch re-created that
day's blocks in Logseq's database with fresh uuids and no `id::` properties, even
though the file on disk was intact and unchanged (verified: every other page of the
301,526 blocks was correct; only the 16 blocks of the import day's journal were
off). Editing that page in Logseq would then write the file back without the ids.

Runbook consequences:
- Do the import/normalization before writing anything in that day's journal, and
  don't edit that day's page in Logseq until the next day's first launch has
  re-verified it (`verify_in_logseq`).
- If its ids are lost anyway, re-normalize that one page from the export (the
  sidecar and the fixed export hold everything needed).

Follow-up 2026-09-05: on the next day's launch Logseq still held the stale copy of
that page, and changing the file's content did not make it re-read it either. Only a
full parse (delete the graph cache) rebuilds it. It is harmless in practice: the file
keeps its ids, ankify_logseq reads files, and no note or embed points at those
blocks. Left as is; the next from-scratch build of the graph fixes it for free.

## 9. Plan: the final graph comes from a later export (2026-09-05)

Roam stays in use while the tooling is built. At the end, a fresh export goes
through the pipeline into a brand-new folder, and that graph is the one used from
then on. Because every id is `uuid5(NAMESPACE, roam_uid)` and the fixer's other
decisions are deterministic hashes, Anki notes paired in Part II stay valid across
exports. Consequences:

- `main-logseq-graph` as built on 2026-09-04 is a staging graph: do not edit it in
  Logseq; nothing done in it survives the final build.
- Part II (pairing) and Part III (links) can be done now; their results carry over.
- The final build uses the direct converter (§7), into a new folder, on a day
  before any journal entry is written in Logseq (§8).
- Blocks deleted in Roam in the meantime leave orphaned notes; reported, never
  deleted.

## 8b. Two journal pages for today on the first open of a converted graph (2026-09-05)

Opening the converter's output for the first time, Logseq showed "Sep 5th, 2026"
and "September 5th, 2026" on the Journals view. Neither has a file: Logseq creates
today's journal page at launch before it has read `logseq/config.edn` (default
format `MMM do, yyyy`), then again with the configured format. Runbook A now says:
do not type in either, quit and relaunch after the parse; the default-format page
has no file and is not re-created. **Update:** it survived a quit and relaunch (kept in
Logseq's cache). Deferred by the user to the end of the project; likely fix is a
manual "Delete page" once, to be confirmed on the final graph. (Runbook B did not show this because the graph
was first opened as an empty folder, so the config was already known when the
import ran.)

## 4e. Closing code fence not on its own line (found 2026-09-05, converter path)

Roam renders `code```` (closing fence glued to the last code line) and
`` ``` #ankify`` (text after the closing fence) as proper code blocks; Logseq only
closes a fence that starts a line and has nothing after it. 134 + 3 blocks in the
2026-09-04 export. Unclosed, the fence swallows the `id::` line and every
following block of the page (2,597 verifier problems on 16 code-heavy pages). The
importer path never showed this because Logseq's importer inserts the newlines
itself. `convert.fix_fences` now inserts them; Roam renders the result identically,
so nothing to undo on the way back.

## 10. Part IX list: functionality to build in Logseq (collected 2026-09-05)

- **Page-tag inheritance for blocks**: Logseq does not include a page's `tags::` in
  its blocks' path refs (checked via the API), so block queries for `[[source]]` do
  not match the cards on a page tagged `source`. The Roam layout got this by
  nesting cards under the `tags::` line. Wanted: every block on a page inherits the
  page's tags. ankify_logseq already adds page tags to the Anki tags.
- **Collapsible page-property table**: the property block at the top of a page has
  no collapse toggle (no children). Wanted: collapsible. Candidates: CSS fold,
  `:block-hidden-properties` in config, or a small plugin toggle.
- Metadata layout decisions (2026-09-05): metadata blocks dissolved into page
  properties (`convert.lift_metadata`), `Subtitle:` becomes `subtitle::`, blank
  values kept, leftovers become top-level blocks; sidecar `pages[].metadata` holds
  what is needed to rebuild the Roam layout.

## 11. `~/Documents` is iCloud Drive (found 2026-09-05)

`~/Documents` is synced by iCloud ("Desktop & Documents Folders"; file-provider
xattrs on the folder, `brctl status` shows the CloudDocs container). Renaming and
deleting graph folders quickly made iCloud produce conflict copies named
`main-logseq-graph 2` / `main-logseq-graph 3` (full copies of superseded builds),
which looked like user-made folders. Hazards for a Logseq graph in iCloud: conflict
copies of pages under rapid writes, "Optimize Mac Storage" evicting files, sync
churn on every 300k-block rebuild. Part V backups make iCloud redundant.
Recommendation was to put the final graph outside iCloud. Decision (user, 2026-09-05):
keep it in `~/Documents` for now. Consequence for the tooling: expect iCloud conflict
copies (`<name> 2`) after rapid folder swaps; delete them, and never swap a graph
folder while iCloud is mid-sync (check `brctl status` shows caught-up).

## 12. Logseq OG 1.0.0: File > New Window does nothing on macOS (fixed 2026-09-05)

A hard requirement for Eli (windows on several desktops). Cause, found by reading
the app's compiled `electron.js`: the New Window handler first looks up the focused
window through `get-active-window-graph-path`, whose compiled form calls
`.$isFocused$()` (mangled by the build) instead of `.isFocused()`; the call throws
and the promise chain swallows it, so nothing happens and nothing is logged. The
graph-switcher's own "Open a new window" item is hidden on macOS by design, so no
built-in path was left. Fix: `patches/logseq-og-new-window.sh` (one `sed` on
`Resources/app/electron.js`, original kept as `electron.js.orig-*`). macOS did not
object to the modified bundle. Result: second window in ~10 s (5 s to open, 5 s to
load from the cache). Re-apply after any reinstall of Logseq OG.

Related: a new window loads the graph from the cache file
(`~/.logseq/graphs/…transit`, ~300 MB for this graph); with no cache it re-parses
every file (~10 min). The cache is written on quit and by the persist step that New
Window runs first, so after our cache-clearing swaps the first New Window only
works after one quit/relaunch.
