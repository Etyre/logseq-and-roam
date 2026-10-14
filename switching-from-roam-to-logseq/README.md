# switching-from-roam-to-logseq

Tooling and notes for the migration described in `Spec for switching from Roam to
Logseq.md`. Background documents:

- `import-issues.md` — everything found so far that has to be handled on the way in,
  and the recommended pipeline (§0).
- `reversibility.md` — how the door back to Roam is kept open.
- `exports/` — fixed exports and their reports (large files, not for git).
- `fixtures/` — a small Roam export that exercises every known hazard, and its fixed
  version.

## roam2logseq (Python, reuses ../ankify_logseq's parser)

Run from this directory with `/usr/bin/python3` (3.9, has the dependencies).

| Step | Command | Notes |
|---|---|---|
| 1. Fix the export | `python3 -m roam2logseq.fix_export IN.json OUT.json --report r.md --title-map t.json` | never modifies the input; keeps every uid |
| 2. Import | Logseq OG → new graph folder → `…` → Import → Roam Research → OUT.json | |
| 3. Normalize | quit Logseq, then `python3 -m roam2logseq.normalize_graph GRAPH_DIR OUT.json --report n.md` | rewrites every file in native layout, derived `id::` on every block, writes `GRAPH_DIR/roam-uid-map.json.gz`, sets the journal title format; `--dry-run` only pairs and reports |
| 4. Verify | `python3 -m roam2logseq.verify_graph GRAPH_DIR OUT.json` | independent re-parse and comparison; exit 0 when clean |
| 5. Open in Logseq OG and **Re-index** | graph menu → Re-index | required: Logseq's cache predates the normalization |
| 6. Verify inside Logseq | `python3 -m roam2logseq.verify_in_logseq OUT.json` | needs the HTTP API server + token (`$LOGSEQ_API_TOKEN`) |
| 7. Load the Block IDs plugin (formerly Ankify IDs) | | imported blocks already have ids; the plugin is for new ones |

Tests: `python3 -m unittest discover tests`.

## Runbook A: direct conversion (the final import will use this)

No Logseq importer, no re-index, no cache to delete. About 90 s for 300k blocks.

1. On switch day, as the last thing done in Roam: `…` → Export All → JSON; unzip;
   put the JSON in this directory (decided 2026-09-05: a fresh export made that
   day, run together in a session).
2. From this directory:

       python3 -m roam2logseq.convert EXPORT.json ~/Documents/<new-graph-folder> --git

   The folder must not exist yet (or be empty). The command prints the fixer
   report, the convert report, and must end with `RESULT: OK` and `committed`.
   Reports and the fixed export land next to the folder in
   `<new-graph-folder>-convert-reports/`. Anything else = stop, nothing to fix by
   hand; the problem is in the converter.
3. Logseq OG: add the folder as a new graph (left sidebar → graph name → "Add new
   graph"), let the parse finish (~10 min at 100% CPU). Never point Logseq at a
   folder it has opened before under the same name (§0 step 5 of import-issues.md).
   Expect **two journal pages for today** after this first open ("Sep 5th, 2026"
   in Logseq's default title format, created before the config was read, and
   "September 5th, 2026" in ours). Do not type in either. Quit and relaunch once
   the parse is done; the file-less default-format page disappears (§8b of
   import-issues.md).
   **Deep links** (`logseq://graph/<name>?page=…`, the "Logseq link" lines on cards)
   Also apply `../patches/logseq-og-new-window.sh` once per Logseq OG install (File > New Window bug, import-issues §12).
   fail with "Cannot match graph identifier" until Logseq has written the graph's
   cache file (`~/.logseq/graphs/…transit`), which it does on quit. So: quit and
   relaunch once after the first parse; verified working 2026-09-05.
4. Optional check inside Logseq: start the API server (Settings → Advanced →
   Developer mode; `…` → API server → Start), then
   `python3 -m roam2logseq.verify_in_logseq <reports>/export.fixed.json --token …`
   → `RESULT: OK` (the import day's journal is the known exception, §8).
5. Plugins are per app: the Block IDs plugin (formerly Ankify IDs) and the Roam-style checkbox, Random page and Auto-collapse children plugins
   (`../logseq-plugins/*/`) are active as soon as they are loaded once.
6. Part II: `python3 -m roam2logseq.pair_anki <folder>` (dry run) then `--apply`
   after backing up the Anki collection. Idempotent, so re-running it after a
   rebuilt graph only touches notes ankified since the previous pairing.
7. Proof: `cd ../ankify_logseq && python3 -m ankify_logseq.cli add <folder> --dry-run`
   must report the paired notes as unchanged/updated, not added.

What the converter does beyond the importer: headings from Roam's `heading`,
numbered children (`logseq.order-list-type:: number`), Roam-style inline checkboxes
(`{{renderer :cb, todo|done, N}}`) for blocks with several checkboxes or one not at
the start, Roam `{{[[X]]}}` buttons as `{{renderer :rbutton, [[X]]}}` (Expand button plugin),
`#SmartBlock` definitions as Logseq templates (`template::`; Roam tokens mapped to Logseq
variables or to the Template commands plugin's tokens, Part VII), a `Logseq link: logseq://graph/<name>?page=…|block-id=…` line above every
Roam `Web link:` line (Part III; the Roam lines stay), attribute keys Logseq cannot use renamed (`Author(s)`→`Author`, spaced
keys hyphenated; recorded per block in the sidecar), closing code fences put on
their own line, block content trimmed the way Logseq trims it, every block carries
`id::`, code blocks kept verbatim, all Roam metadata in `roam-uid-map.json.gz`.
Checked against the importer path on the 2026-09-04 export: 277,935 of 301,526
blocks byte-identical, the rest explained by exactly those differences (trailing
whitespace the importer kept, `{{embed  ((` double space, a BOM inside 25 blocks).

## Runbook R: back to Roam (reverse direction)

    python3 -m roam2logseq.export_roam ~/Documents/main-logseq-graph OUT.json --report DIR
    python3 -m roam2logseq.verify_roundtrip OUT.json <reports>/export.fixed.json   # only meaningful right after a conversion

`export_roam` reads the graph and its sidecar `roam-uid-map.json.gz` and writes a Roam
JSON export: every block gets its Roam uid back (Logseq-born blocks a derived one),
every Logseq-specific form is undone (see reversibility.md §3), dissolved metadata
blocks are rebuilt with the current property values, Roam metadata (times, users,
heading, view type) is restored, and a report lists what needs hand work
(queries, local assets, drawers). Proven 2026-09-05 on the full export: convert →
export → compare = 280,346 strings identical, 21,180 differing only in trailing
whitespace, 0 other differences; uids, nesting and metadata identical. Import the
JSON into Roam with Import → JSON. Confirmed 2026-09-05 on a throwaway Roam graph: Roam keeps the `uid`s supplied in
the JSON (`exports/mini-roundtrip.json` was the test file).

## Backups (Part V, in place since 2026-09-05)

- The graph folder is its own git repository (the converter runs `git init`).
- Hourly launchd job `com.elityre.logseq-backup` runs `~/Library/Scripts/logseq-backup.sh`
  (source: `backup/logseq-backup.sh`; plist in `backup/`): commits any change, pushes to the
  private repo **github.com/Etyre/main-logseq-graph**, refreshes a bare mirror
  `~/Backups/logseq/main-logseq-graph.git` and a plain file copy `~/Backups/logseq/main-logseq-graph/`
  (both outside iCloud), and deletes iCloud conflict copies (`name 2.md`) in the graph.
  Log: `~/Library/Logs/logseq-backup.log`. Needs Full Disk Access for `/bin/bash`
  (System Settings → Privacy & Security), granted 2026-09-05.
- The sidecar map is stored gzipped (`roam-uid-map.json.gz`, 16 MB) because GitHub
  refuses files over 100 MB.
- After the final import (a new folder): `git init` is done by the converter; add the
  remote (`git remote add origin https://github.com/Etyre/main-logseq-graph.git`) and
  force-push the new history (`git push -f origin main`), or use a new repo.
- Optional: Logseq's own "Enable Git auto commit" (Settings → Version control) for finer history.

## Runbook B: via Logseq's importer, as executed on 2026-09-04 (staging graph)

1. `fix_export` on the fresh export → `exports/` (fixed JSON, report, title map).
2. Logseq OG: add new graph folder `~/Documents/main-logseq-graph`; `…` → Import →
   Roam Research → the fixed JSON. ~10 min at 100% CPU with no visible progress,
   then files appear. Wait for the renderer to go idle. **Quit Logseq.**
3. `git init` the graph folder and commit (baseline = raw import).
4. `normalize_graph` (~40 s); `verify_graph` must say `RESULT: OK`. Commit.
5. **Delete Logseq's cache for this graph** (`~/.logseq/graphs/logseq_local_++…++main-logseq-graph.transit`
   and `~/Library/Application Support/Logseq OG/search/…main-logseq-graph`), so
   the next open is a full parse from the files. (A "Re-index" from the menu did
   not rebuild the journals; deleting the cache did.)
6. Open the graph in Logseq OG (full parse, ~10 min), start the API server,
   run `verify_in_logseq` → `RESULT: OK` except the import day's journal (§8 of
   import-issues.md).
7. The Block IDs plugin (formerly Ankify IDs) is per app, so it is already active once loaded once.
8. Part II: `python3 -m roam2logseq.pair_anki GRAPH_DIR` (dry run), then `--apply`
   after backing up the Anki collection. Fills `logseq uid` / `logseq parent uid`
   on every ankify_roam note whose block exists in the graph. Idempotent.
   Done on 2026-09-05: 7,027 notes; 33 point at blocks since deleted in Roam.
9. Proof: `ankify_logseq add GRAPH_DIR --dry-run` must report the paired notes
   as unchanged/updated, not added.

## Status (2026-09-05)

- Direct converter (`roam2logseq.convert`) done and verified on the full export;
  Runbook A is the plan for the final import. Inline-checkbox plugin written
  (`../logseq-plugins/inline-checkbox/`), awaiting a test in Logseq.

- Steps 1, 3, 4 implemented; 1 run on the 2026-09-04 export (`exports/`): 31 pages
  merged, 77 renamed, 31 refs rewritten, 429 embeds fixed, 66 + 5 dashes escaped.
- Full export imported, normalized and verified in `~/Documents/main-logseq-graph`
  (2026-09-04 late evening): 301,526 blocks, every one with its derived id; in-Logseq
  verification clean except the import day's journal (16 blocks, see §8), to be
  re-checked on the next day's first launch.
- Reverse direction (`reversibility.md`): not started.
