# Changelog

## Unreleased

### Purple flag for suspend=False (2026-09-12)

- `anki.flag_note` sets a card flag through AnkiConnect's `setSpecificValueOfCard`
  (`FLAG_PURPLE = 7`), skipping cards that already carry it (`-flag:7` in the search),
  so repeated syncs don't touch them. The sync calls it for every `suspend=False` note
  after unsuspending; `SyncReport.flagged` counts them. Dry runs don't flag.
- Integration test: flips the fixture's `suspend=True` to `suspend=False` and checks the
  cards are unsuspended and flagged purple, and that a second sync leaves them alone. Its
  ankifier now runs with `skip_unchanged=False` and a cache dir inside the temp dir: the
  "second sync changes nothing" step had been failing since page-hash skipping (Part IX)
  became the default, because every block was skipped instead of reported unchanged.

### Deck creation (2026-09-04)

- A deck named by a block's option tag that does not exist in Anki is created
  (logged and listed in the report; dry runs only report). `--no-create-decks`
  restores ankify_roam's behaviour of failing on a missing deck.

### Step 5: end-to-end Anki test (2026-09-04)

- `tests/integration/test_anki.py`: switches AnkiConnect to the throwaway profile
  `ankify_test` (skips if absent), creates the note types with all four id fields
  and the decks, syncs the fixture graph, and checks: every ankified block added
  once; `logseq uid` / `logseq parent uid` filled and `uid` / `parent uid` / `Extra`
  untouched; cloze blocks become Roam Cloze with Anki cloze markup; children land
  on the back; the deck named by an option tag wins over the default deck (and is
  never created implicitly, as in ankify_roam); `suspend=True` suspends the cards;
  inherited page tags; a second sync changes nothing; a block edit updates only the
  owned fields and leaves user data in `Extra` and `uid` intact; a dry run reports
  the update and writes nothing. Deletes everything it made and switches back.
  Run: `/usr/bin/python3 -m unittest tests.integration.test_anki -v`.

### Step 4: id persistence fallback in the sync tool (2026-09-04)

- `logseq/api.py`: client for Logseq's HTTP API server (token from `--logseq-token`,
  `$LOGSEQ_API_TOKEN`, or `~/.ankify_logseq/logseq_api_token`).
- `logseq/persist.py`: for ankified blocks (and parents) without a persisted id,
  `--persist-ids auto|api|file|never`. `api` matches each block to Logseq's view of
  the page by tree position and text, asks Logseq to persist the id, waits for the
  file, reloads the page; refuses if Logseq has a different graph open. `file`
  inserts a correctly indented `id::` line atomically and refuses while any Logseq
  process runs. `auto` picks api when Logseq is running. Dry run never writes.
- Wired into `LogseqGraphAnkifier.ankify` before conversion; the report counts
  persisted ids; `LogseqGraph.reload_page` re-parses one file in place.
- Tests: file mode on a temp copy of the fixture graph (ids added, nothing else
  changed), api mode against a fake API, refusals, never/dry-run. 39 tests.
- Live: api mode on the mini-import graph open in Logseq OG persisted 10/10 ids.

### Step 3: Logseq plugin "Ankify IDs" (2026-09-04)

- `plugin/`: unpacked Logseq plugin (no build step; SDK vendored). On every block
  change, blocks carrying the ankify tag get their uuid persisted as `id::`, and so
  does their parent; edits in progress are deferred; a command palette entry
  persists ids for every tagged block in the graph, page by page with a pause so
  Logseq's file watcher does not raise phantom "modified on disk" conflicts.
- Live trigger verified through the HTTP API on a scratch copy of the test graph:
  tagging a block wrote `id::` on it and its parent within 2 s, correctly indented;
  an untagged sibling was untouched.
- Bulk command verified on the same graph: 3,852 ids added on 513 files, 0 ids
  lost. Every content difference found afterwards traces to Logseq's own reading of
  the old importer's layout, which it bakes in when it rewrites a file for the first
  time (see `switching-from-roam-to-logseq/import-issues.md` §3 and §4b). The
  unpaced first version of the command also triggered conflict dialogs, and the
  page that was resolved through the dialog lost its pending ids; hence the pacing.
- Parser fix found by this test: continuation lines are un-indented only by the
  exact Logseq prefix, so code-block indentation survives in both layouts;
  `build_page` now propagates parents.

### Step 2: ankifier, AnkiConnect client, CLI (2026-09-04)

- `ankify_logseq.ankifiers`: ankify_roam's ankifier with notes matched by the
  `logseq uid` field, `logseq parent uid` filled (page title for top-level blocks),
  only owned fields written or compared, blocks without a persisted id reported
  and skipped, `dry_run` producing a `SyncReport` without writes, optional
  per-block options from Logseq properties (`deck::` inherits from parents), and
  graph-relative images (`../assets/...`) read from disk.
- `ankify_logseq.anki`: AnkiConnect client with note lookup by a configurable field.
- `ankify_logseq.default_models`: Roam Basic / Roam Cloze definitions carrying all
  four id fields; `init-models --overwrite` still only touches templates and CSS.
- `ankify_logseq.cli`: `add` (with `--dry-run`, `--graph-name`, `--uid-field`,
  `--parent-uid-field`, `--options-from-properties`), `check` (no Anki needed),
  `init-models`.
- Tests: ankify_roam's ankifier tests ported unchanged in expectations except for
  the two new id fields, plus tests for id fields, option tags, property options,
  dry-run (asserts no write call), and asset images. 32 tests.
- Verified: `check` and a `--dry-run add` against the live Anki profile on the
  "Testing LogSeq" graph (32 would add, 2,320 skipped for missing id, 0 failed,
  0 writes). HTML parity with ankify_roam on 1,609 blocks present in both the
  Roam export and the Logseq import: 1,524 byte-identical; 43 differ because the
  test graph's text is stale; 42 differ only in whitespace that the Logseq files
  lack (a trailing `<br>`, a leading space, a doubled space).

### Step 1: graph reader and content grammar (2026-09-04)

- `ankify_logseq.logseq.parser`: parses a Logseq file graph (`pages/`, `journals/`,
  `logseq/config.edn`) into `LogseqGraph` / `Page` / `Block` objects with the same
  API ankify_roam's ankifier uses. Handles Roam-importer layout (column-0
  continuation and `id::` lines, `<tab> - ` bullets) and native Logseq layout
  (indented continuation lines, task markers, priorities, SCHEDULED/DEADLINE and
  LOGBOOK lines, properties). Page titles from front matter, `title::`, or the
  file name (triple-lowbar and legacy formats); journal titles from
  `:journal/page-title-format`. Each page records a content hash and each block its
  file and line span for later change detection and id persistence.
- `ankify_logseq.logseq.content`: ankify_roam's grammar, unchanged in output, with
  uuid block refs, Logseq embeds (`{{embed ((uuid))}}`, `{{embed [[page]]}}`,
  tolerant of `((((uuid))))`), Logseq macros, and `==highlight==`.
- Verified against the "Testing LogSeq" graph: 2,591 pages, 156,452 blocks, no
  parse errors; 2,352 ankified blocks, identical to what ankify_roam's parser
  tags on the same text; all 504 persisted ids attached to the right blocks.
