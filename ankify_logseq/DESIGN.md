# ankify_logseq: design

Status: draft for review, 2026-09-04. Nothing has been built yet.

ankify_logseq is a port of ankify_roam that reads a Logseq **file graph**
(markdown under `pages/` and `journals/`) instead of a Roam JSON export, and
syncs ankified blocks to Anki through AnkiConnect. It must reproduce
ankify_roam's behavior exactly, plus one feature: every note records the
Logseq UID of its block **and** of the block's parent.

This document covers three deliverables:

1. `ankify_logseq` — the Python sync tool (this directory).
2. `logseq-ankify-ids` — a small Logseq plugin that persists block IDs the
   moment a block is tagged `#ankify` (subdirectory `plugin/`).
3. The fallback path the sync tool uses when the plugin missed a block.

---

## 1. Facts the design rests on

Established by reading the code and the live data on this machine.

### ankify_roam as it runs today

- Source of truth for behavior: `~/Documents/agent-coding/ankify_roam`
  (your fork, version 0.2.2, one commit ahead of upstream: the `[[::]]hint`
  cloze fix).
- The daily launchd job (`com.elityre.roam-anki-autoimport`) runs the
  **pip-installed 0.2.1**, not the fork, with
  `--deck="Daily review::Roam sync"` against `eli.json` cloned from
  `Etyre/roam-backup-JSON-only`. Today's run: 11 added, 13 updated, 6977
  unchanged, 45 failed (AnkiConnect duplicate errors).
- Pipeline: `RoamGraph.from_path` → tree of `Page`/`Block` →
  `RoamGraphAnkifier.ankify` selects blocks whose *own* tags include `ankify`
  (and whose inherited tags do not include `dont-ankify`) →
  `BlockAnkifier.ankify` turns each into an AnkiConnect note dict → notes are
  matched to existing ones by `findNotes "uid:<roam uid>"` → added, updated
  (fields only), or left alone; then suspended/unsuspended per the
  `suspend=` option (`suspend=False` cards also get a purple flag).
- Per-block options come from tags of the form
  `#[[ankify_roam: key=value]]` (keys: deck, note, suspend, num-parents,
  include-page, max-depth, pageref-cloze, download-imgs).
- HTML output uses Roam-flavoured class names (`rm-page-ref`,
  `rm-page-ref-tag`, `front-side`, `back-side`, `parent`, `page-title`...).
  The Roam Basic / Roam Cloze note types' CSS depends on these.

### Anki, as of today

| | |
|---|---|
| Roam Basic notes | 4,737 |
| Roam Cloze notes | 2,323 |
| Roam Basic fields | Front, Back, Extra, uid, parent uid, logseq uid, logseq parent uid |
| Roam Cloze fields | Text, Back Extra, uid, parent uid, logseq uid, logseq parent uid |
| Notes with `parent uid` filled | 0 |
| Notes with `logseq uid` filled | 0 |

The Roam Basic card template's back already contains links built from
`{{uid}}` (web and `roam://`). Part III will want the same for Logseq.

### The Roam graph, from this morning's backup (`eli.json`, 2026-09-04 11:19 UTC)

The backup lags live Roam by up to a day. It is fine as a development
fixture. The real import (and Part II) will use a fresh manual export
requested from you at that time.

| | |
|---|---|
| Pages | 7,226 |
| Blocks | 301,506 |
| Blocks tagged `#ankify` | 7,049 |
| ...on distinct pages | 1,269 |
| ...that are top-level (parent is the page) | 5 |
| ...containing newlines | 1,602 |
| ...containing `{{[[roam/render]]:...}}` | 912 |
| ...containing a real block ref `((...))` | ~0 outside the render macro |
| ...containing images | 199 |
| ...containing `__italic__` | 187 |
| ...containing cloze hints | 82 |
| ...containing `$$latex$$` | 55 |
| Embeds with `((((` (Part IV) | 289 blocks |

### Logseq, as installed

- `/Applications/Logseq.app` is **2.0.1 = the DB-version beta** (released
  2026-07-13). This is the SQLite-backed app. You want the file version,
  which now lives in its own repo as **Logseq OG**, latest 1.0.0
  (2026-04-15), with macOS arm64 and x64 builds:
  https://github.com/logseq/og/releases . The design below assumes Logseq OG.
- `~/Documents/Testing LogSeq` is a file graph imported from Roam with an
  older Logseq. Useful as a parser fixture, but it is stale (predates the
  placeholder-card pattern) and was produced by an older importer.

### How the Logseq Roam importer writes markdown (from the test graph)

- One file per page, `pages/<title>.md`, title in front matter
  (`---\ntitle: X\n---`). Newer Logseq writes `title:: X` instead; the reader
  must accept both, plus decoding of the filename
  (`:file/name-format :triple-lowbar`, `___` → `/`, percent-encoding).
- Bullets are `<tabs> - <content>`. Continuation lines of a multi-line block
  are written **at column 0** with no indentation. Blank lines appear between
  blocks. Logseq's own parser treats any non-bullet line as part of the
  preceding block, so this is legal, and the reader must do the same.
- `id:: <uuid>` lines are also written at column 0. Only referenced blocks
  have one (504 of ~156k in the test graph).
- Roam UIDs are **not** preserved. Block refs `((abc123XYZ))` were rewritten
  to `((<uuid>))` pointing at the new IDs. Embeds became `{{embed ((uuid))}}`,
  and the quadruple-paren ones became `{{embed ((((uuid))))}}`.
- Checkboxes `{{[[TODO]]}}` became `TODO ` block markers. `^^highlight^^`
  and `__italic__` were left as-is (Logseq renders `==` and `_`/`*`; the
  card HTML must handle the Roam forms because that is what the text will
  contain).
- The `{{[[roam/render]]:...}}` macro does not appear in the test graph,
  but that graph predates the pattern. Its fate under the OG importer will
  be checked on the real import; ankify_logseq will render it the same way
  ankify_roam does (a button-styled placeholder) if it survives.
- Journals: `journals/2019_08_13.md`. Title comes from
  `:journal/page-title-format` in `config.edn` (default `MMM do, yyyy`).
  Roam titles are `August 13th, 2019`; setting the format to
  `MMMM do, yyyy` on the real graph keeps page titles, and therefore
  inherited page tags, identical.

---

## 2. Python package: `ankify_logseq`

Mirror ankify_roam's layout so the two stay diffable:

```
ankify_logseq/
  ankify_logseq/
    __init__.py, _version.py
    cli.py              # `ankify_logseq add <graph_dir>` + `init-models`
    anki.py             # copied from ankify_roam; note lookup key changes
    ankifiers.py        # copied; small changes listed below
    default_models.py   # copied; adds the four uid fields
    util.py
    logseq/
      __init__.py
      graph.py          # LogseqGraph: walk pages/ + journals/, build tree
      parser.py         # markdown outline → Page/Block, properties, ids
      content.py        # block-content grammar (Logseq flavour)
      persist.py        # write id:: to blocks (HTTP API or file), see §4
  plugin/               # Logseq plugin, see §3
  tests/
    unit/  integration/  fixtures/graph/
  css/ README.md CHANGELOG.md setup.py
```

### 2.1 Graph reader (`logseq/graph.py`, `logseq/parser.py`)

Produces the same object model ankify_roam's ankifier consumes:
`Page(title, children)` and `Block(content, children, uid, parent)` with
`parents`, `parent_page`, `get_tags(inherit, from_attr)`, `get_attribute`,
`num_descendants`, `query_many`, `query_by_uid`.

Per file:

1. Read the file. Strip front matter or leading `key:: value` page
   properties; take the title from `title` if present, else from the decoded
   filename.
2. Split into blocks: a line matching `^\s*- ` starts a block at depth =
   count of leading tabs (Logseq OG also accepts 2-space indentation; handle
   both, tabs first). Any other line (including column-0 lines and blank
   lines) is appended to the current block's raw text.
3. Within a block's raw text, pull out property lines `^\s*key:: value$`
   that follow the first line. `id` becomes `block.uid` (persisted) and is
   removed from content. `collapsed`, `card-*`, and other Logseq bookkeeping
   properties are removed from content too. Roam-style attribute lines that
   are the *first* line (`Author(s):: [[x]]`) stay as content, exactly as
   ankify_roam treats `Attribute`.
4. Leading task markers (`TODO `, `DONE `, `NOW `, `LATER `, ...) become a
   `Checkbox`-equivalent object so `get_tags` still yields `TODO`/`DONE`.
5. Strip the trailing blank line the importer leaves inside multi-line
   blocks so it does not become a `<br>` on the card.
6. Blocks with no persisted `id::` get `uid = None`. That is a valid state
   for the reader; only the ankifier cares (see §4).

Each block also records `(file, first_line, last_line)` so the fallback
writer can edit precisely, and each page records the file's content hash so
per-page change detection can be added later without touching the parser.

### 2.2 Content grammar (`logseq/content.py`)

Start from a copy of ankify_roam's `content.py` and change only what Logseq
changes. The object types and their `to_html` output stay identical so the
Anki CSS and existing card HTML are preserved.

| Object | Roam form (ankify_roam) | Logseq form (added/changed) |
|---|---|---|
| BlockRef | `((9 chars))` | `((uuid))`, 36 chars |
| Embed | `{{[[embed]]: ((uid))}}` `{{embed: ((uid))}}` | `{{embed ((uuid))}}`, `{{embed [[page]]}}`, tolerate `((((uuid))))` |
| Checkbox | `{{[[TODO]]}}` | leading `TODO `/`DONE ` marker |
| Highlight | `^^x^^` → `roam-highlight` | also `==x==` |
| Italic | `__x__` | also `_x_` and `*x*`? **No.** `*x*` conflicts with nothing in Roam data but `_x_` collides with snake_case words. Keep Roam's `__x__` only, add `==x==`. Revisit if the OG importer converts emphasis. |
| Cloze | `{x}`, `{c1:x}`, `[[{]]x[[}]]`, hints | unchanged |
| PageRef / PageTag | `[[x]]`, `#x`, `#[[x y]]` | unchanged |
| Alias | `[t]([[p]])`, `[t](((uid)))`, `[t](url)` | uuid-length block refs |
| Attribute | `key::` | unchanged; property lines handled by parser |
| Button / View | `{{name}}`, `{{query: ...}}` | also Logseq macros `{{name arg}}` (space-separated, no colon), e.g. `{{[[roam/render]]:((uuid)) "Block UID" }}` if it survives import |
| Url, Image, CodeBlock, CodeInline, BlockQuote | | unchanged |
| LaTeX `$$x$$` | passed through as text | same (ankify_roam has no LaTeX support; matching that is the spec) |

`PageRef.to_html` and friends keep emitting `rm-*` class names. This is
deliberate: it keeps the Roam Basic / Roam Cloze CSS working and minimizes
diffs when Part II switches a note from Roam-generated to Logseq-generated
fields.

### 2.3 Ankifier changes (`ankifiers.py`)

Copied from ankify_roam with these edits:

- **Note identity.** Look up existing notes with
  `findNotes "logseq uid:<uuid>"` instead of `uid:`. The `uid` (Roam) field
  is never written by ankify_logseq. `check_conn_and_params` requires the
  fields `logseq uid` and `logseq parent uid` on both note types.
- **Parent UID.** `fields["logseq parent uid"]` = the parent block's uid.
  For the 5 top-level blocks the parent is the page, and the field holds
  the page title (decided 2026-09-04).
- **Field ownership.** ankify_logseq writes only the fields it owns:
  the content fields (Front/Back or Text), `logseq uid`, and
  `logseq parent uid`. It never sends `uid`, `parent uid`, `Extra`, or
  `Back Extra` to AnkiConnect, so nothing another tool or you wrote in
  Anki is blanked. The no-change comparison likewise looks only at owned
  fields. (This follows logseq-anki-sync's "user-controlled fields are
  never overwritten" rule, §8.)

  **Warning about ankify_roam.** ankify_roam does *not* do this. Its
  `_block_to_fields` fills every field of the note type, setting the ones
  it does not generate to the empty string, and `update_note` sends all
  of them. Today that is harmless because the extra fields are all empty.
  But once Part II fills `logseq uid`, ankify_roam will see every note as
  changed and, on its next daily run, **blank `logseq uid` and
  `logseq parent uid` on all 7,060 notes**. ankify_roam must be patched to
  send only the fields it owns before Part II writes anything. This is
  deferred, per your instruction not to change ankify_roam now, but it is
  a hard prerequisite for Part II.
- **Blocks without a persisted uid** are routed to the persist step (§4)
  before conversion; if persisting is disabled or fails, the block is
  reported and skipped, never added without a uid.
- **Option sources.** The existing `#[[ankify_roam: key=value]]` tags keep
  working unchanged, so every current block stays readable by both tools.
  In addition, because the current deck tags are unwieldy, ankify_logseq
  reads options from a small ordered list of sources, closest to the
  block winning (the rule ankify_roam already uses):

  1. `#[[ankify_roam: key=value]]` and `#[[ankify: key=value]]` tags on
     the block (unchanged).
  2. Logseq block properties on the block: `deck:: Spaced Learning
     Projects::z-Sources`, `suspend:: true`, `num-parents:: 2`, and so on
     (one property per option, names as in the CLI).
  3. **Short deck aliases** defined once in a config file
     (`~/.ankify_logseq/config.toml`), e.g.
     `sources = "Spaced Learning Projects::z-Sources"`, usable as a tag
     `#deck/sources` or a property `deck:: sources`.
  4. Inherited `deck::` from parent blocks and from the page's properties,
     so a source page can set its deck once instead of on every card.
     Only `deck` inherits; `suspend` and the rest stay block-local as in
     ankify_roam.

  Which of 2–4 to enable is a config setting; all are off by default
  except 1, so behavior is identical to ankify_roam until you opt in.
  Blocks written with 2–4 are not understood by ankify_roam; that is
  acceptable for cards created after the switch, and a
  `ankify_logseq rewrite-tags` command can convert old tags to the new
  form in bulk if you later want uniformity (it edits graph files, so it
  runs only with Logseq closed).
- **Tag export.** `ankify_tags` unchanged (page title and inherited tags
  become Anki tags with spaces → underscores). Journals therefore need the
  Roam-style title format noted above.

Everything else (parent breadcrumbs, `#ankify-root`, `max-depth`,
cloze-id assignment, image download, suspend handling, the
add/update/no-change/failed accounting) is unchanged.

### 2.4 CLI (`cli.py`)

```
ankify_logseq add <graph_dir> [same options as ankify_roam add]
    --graph-name NAME          # for logseq://graph/NAME?block-id= links (Part III)
    --persist-ids {auto,api,file,never}   # default auto, see §4
    --dry-run                  # parse + convert + report; no Anki writes, no id writes
ankify_logseq init-models [--overwrite]   # creates/updates Roam Basic / Roam Cloze
                                          # with all four uid fields (never deletes fields)
ankify_logseq check <graph_dir>           # parse the graph, list ankify blocks
                                          # lacking ids, report parse errors
```

`--dry-run` and `check` exist so every phase can be tested against the real
graph and the real Anki profile without writing anything.

### 2.5 Reserved for later: change detection

Two layers, neither built in Part I, both kept possible by the Part I
structure:

- **Per-page skip.** `LogseqGraph` records `sha256(file bytes)` per page.
  A future `~/.ankify_logseq/state.json` maps file → hash and lets the
  reader skip unchanged pages. Nothing in the pipeline assumes all pages
  are loaded, except `query_by_uid` for block refs and embeds, which will
  load the referenced page on demand.
- **Per-note skip without an AnkiConnect round trip.** ankify_roam decides
  "unchanged" by fetching every existing note (`notesInfo`, ~7,000 calls)
  and comparing rendered HTML. logseq-anki-sync instead stores a
  *dependency hash* on the note (hash of the block, every block/page it
  references or embeds, its parents if shown, the deck, tags, settings,
  and tool version) and skips notes whose hash is unchanged. We can do
  the same with one bulk `findNotes` + `notesInfo` at startup and a hash
  kept either in a local state file keyed by `logseq uid`, or in a new
  hidden note field. Decide when building it.

### 2.6 Orphan report

ankify_roam never deletes; neither will ankify_logseq. But it will be able
to *report* Anki notes of the Roam note types whose `logseq uid` no longer
matches any ankified block (`ankify_logseq orphans`), the way
logseq-anki-sync lists to-be-deleted notes for confirmation. Report only.

---

## 3. Logseq plugin: `logseq-ankify-ids`

Purpose: make Logseq persist `id::` on any block tagged `#ankify` and on its
parent, at the moment the tag is added. This keeps the sync tool read-only in
the normal case (single writer on the graph files).

- TypeScript, built with `@logseq/libs`, loaded as an unpacked plugin from
  `logseq-plugins/block-ids/` (Settings → Plugins → Load unpacked plugin;
  developer mode). No marketplace publishing needed.
- On `logseq.DB.onChanged({blocks})`: for each changed block whose content
  matches `#ankify` or `#[[ankify]]` (configurable), call
  `ensurePersisted(block)`; then fetch `block.parent` and, if it is a block
  (not the page), `ensurePersisted(parent)`.
- `ensurePersisted(b)`: `getBlockProperties(b.uuid)`; if `id` is absent,
  `upsertBlockProperty(b.uuid, "id", b.uuid)`. Setting the `id` property to
  the block's existing uuid is how Logseq itself persists it; the uuid does
  not change.
- Debounce per uuid so typing in a block does not fire repeatedly.
- Command palette entry **"Ankify: persist IDs for all tagged blocks"** runs
  `datascriptQuery` for blocks referencing the `ankify` page and persists
  each block and parent. This is the bulk step to run once right after the
  import (7,049 blocks), and the manual fallback any time.
- Never touches blocks that already have an `id`. Never removes anything.

Testing: load into Logseq OG against a **copy** of a graph; tag a block,
confirm `id::` appears on it and its parent in the file; run the bulk
command on the test-graph copy and confirm 2,363 blocks gain ids and nothing
else in the files changes (git diff on the copy).

---

## 4. Fallback: persisting ids from the sync tool (`logseq/persist.py`)

Runs only for ankified blocks whose file has no `id::` for them. Strategy
chosen by `--persist-ids`:

- `auto` (default): if Logseq is running → `api`; else → `file`.
- `api`: Logseq OG's built-in HTTP API server (Settings → Features → HTTP
  APIs server, with an auth token). POST
  `{"method":"logseq.Editor.upsertBlockProperty","args":[uuid,"id",uuid]}`.
  Problem: a block with no persisted id has no uuid the tool can name. So
  the api path first locates the block through Logseq itself:
  `logseq.Editor.getPageBlocksTree(pageName)` returns every block with its
  in-memory uuid, matched to our parsed block by position in the outline.
  Then upsert. Logseq writes the file; we re-read it.
- `file`: refuse if a Logseq process is running. Otherwise generate a
  uuid4, insert `\n<indent>  id:: <uuid>` after the block's first line
  (indented to match the block, unlike the importer's column-0 lines),
  write the file atomically (temp file + rename), re-parse the page.
- `never`: report and skip.

Every persist is logged with file, line, and uuid, so a run can be audited.

---

## 5. Testing and verification plan

1. **Parser unit tests** on fixture files exercising each syntax row in
   §2.2, plus front matter vs `title::`, column-0 continuation lines,
   column-0 `id::`, task markers, properties, journals, filename decoding.
2. **Whole-graph parse** of `Testing LogSeq` (1,352 pages): zero parse
   errors, exactly 2,363 ankify blocks found, all 504 persisted ids
   recovered and attached to the right blocks (spot-checked against
   `grep -B1 id::`).
3. **HTML parity check.** For blocks that exist in both `eli.json` and a
   fresh OG import, render with ankify_roam and ankify_logseq and diff the
   field HTML. Goal: identical except where the source text differs
   (block ref ids, embed syntax). This is what protects Part II from
   mass-updating 7,060 notes with cosmetically different HTML.
   *Result on the stale test graph (2026-09-04): 1,609 matched, 1,524
   identical, 43 stale-text, 42 whitespace-only (trailing newline, leading
   or doubled space absent from the Logseq file). Expect roughly 2–3% of
   notes to get a one-time whitespace-only update in Part II; re-measure on
   the real import.*
4. **Ankifier unit tests** ported from `test_ankifiers.py`.
5. **Anki integration** against a **throwaway Anki profile** (AnkiConnect
   `loadProfile`), never `User 1`: add, update, no-change, suspend,
   cloze ids, images, and the `logseq uid` lookup.
6. **Plugin test** as in §3.
7. **End to end on the real graph, dry-run first**, then a real run into a
   dedicated test deck, then inspection in Anki.

---

## 6. Decisions (2026-09-04)

1. **Parent uid for top-level blocks**: store the page title in
   `logseq parent uid`; link generation uses `?page=` for those.
2. **ankify_roam is not modified now.** The `parent uid` field stays empty
   on the Roam side. The field-blanking fix in §2.3 is required before
   Part II and will be raised again then.
3. **Option tags**: `#[[ankify_roam: ...]]` keeps working everywhere.
   Shorter forms (block properties, deck aliases, inherited page-level
   `deck::`) are added as opt-in alternatives, see §2.3 "Option sources".
4. **Journal title format**: set `:journal/page-title-format
   "MMMM do, yyyy"` on the new graph.
5. **Logseq OG 1.0.0** is the target app. The 2.0.1 DB beta has been
   removed.
6. **Roam export freshness**: the backup repo is a development fixture
   only; a fresh manual export is requested for the real import and for
   Part II.

---

## 7. Build order for Part I

| Step | Deliverable | Verified by |
|---|---|---|
| 1 | Graph reader + content grammar | §5.1, §5.2 |
| 2 | Ankifier, CLI, `--dry-run`, `check` | §5.3, §5.4 |
| 3 | Plugin | §5.6 |
| 4 | persist.py fallback | file mode on a graph copy; api mode against OG |
| 5 | Anki integration on throwaway profile | §5.5 |
| 6 | Real-graph dry run and review | §5.7 |

Each step ends with a check-in before the next begins.

---

## 8. Prior art: existing Logseq ↔ Anki integrations

Surveyed 2026-09-04 on GitHub. There is one serious project and a few
small ones.

### logseq-anki-sync (debanjandhar12, 586 stars, active 2026-08)

A Logseq plugin that syncs to Anki over AnkiConnect. Read its source, not
just its docs. What it does and what we take from it:

| Their design | Our take |
|---|---|
| Persists block ids with `upsertBlockProperty(uuid, "id", uuid)` on every synced block that lacks an `id` property, "to prevent uuid from changing on re-index". Skipped on DB graphs. | Exactly our plugin's mechanism (§3), independently validated. They do it at sync time from inside Logseq; we do it at tag time plus a bulk command, and keep the sync tool's fallback for blocks the plugin missed. |
| Note identity is the field `uuid-type` = `<block uuid>-<note type>`, plus separate `Logseq Block UUID` and `Logseq Page Id` fields. | We use `logseq uid` as identity, matching ankify_roam's `uid`. The page id is not needed; we have `logseq parent uid`. |
| A `Config` field on the note holds JSON (assets, dependency hash). Change detection hashes the block, its references/embeds/parents, deck, tags, plugin settings and version, and asset mtimes. Unchanged hash → skip rendering and upload. | Adopted as the model for §2.5. Their hash is finer-grained than page-file hashing and handles embeds and refs to other pages correctly. |
| User-controlled fields (Extra, custom sides) and CSS are never overwritten; content, deck, and tags always are. | Adopted (§2.3, field ownership). This is also what exposed the ankify_roam blanking risk. |
| Sync plan shown as a dialog: N to create, N to update, N to delete, with checkboxes, before anything is written. Orphaned Anki notes (uuid no longer in Logseq) are offered for deletion. | `--dry-run` prints the same plan. Orphans are reported, never deleted (§2.6). |
| Deck from a `deck::` property with precedence block > parent > page > namespace > page name. Tags accumulate across levels. | ankify_roam's closest-tag-wins `deck=` option is equivalent for our data; no change. Page-level defaults could be added later. |
| Links back: `logseq://graph/<name>?block-id=<uuid>` and `?page=<name>`; the card JS builds the block link from the page link. | Confirms the URL forms for `logseq parent uid` (page title case) and Part III. |
| Renders with mldoc, Logseq's own parser, so cards look like Logseq. | Not adopted. We keep ankify_roam's HTML and `rm-*` classes so the existing note-type CSS and 7,060 existing notes stay consistent. |
| Card types beyond ours: image occlusion, incremental cards, card direction, PDF annotation occlusion. | Out of scope; not Roam functionality. |

### Others

- **konclave/logseq2anki**: scans journal files for `#card #deutsch`,
  writes straight into `collection.anki2` with Anki closed. Direct DB
  writes are more fragile than AnkiConnect; not adopted.
- **ObsidianToAnki/Obsidian_to_Anki** (Obsidian, but the same file-scanning
  shape as ours): stores the *Anki note id* back into the source file as an
  `<!--ID: n-->` comment. The Logseq equivalent would be an `anki-id::`
  block property. It gives a two-way link but adds a second kind of write
  to the graph. Not adopted; `logseq uid` in Anki is sufficient and keeps
  the graph the single writer's domain.
- **lugenx/anki-to-logseq**: opposite direction, irrelevant.
- **logseqtoanki.com**: web tool exporting CSV; irrelevant.
- Nothing else with more than zero stars.
