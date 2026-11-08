# logseq-and-roam

Everything Eli built around his notes graphs: the move from Roam Research to Logseq OG (a
one-shot, reversible converter for a 300k-block graph plus the hourly backup that protects
the result), the Anki sync that replaced ankify_roam, and two LLM features that run inside
the outliner, "Claude in Roam/Logseq" (ask Claude from a block, reply streams in as nested
blocks) and "Auto-anki" (Claude writes and maintains flashcards under a tagged block). Work
started 2026-09-04 (the migration spec and first converter), the Claude features and plugins
followed in September and October, first git commit 2026-10-14. Each sub-folder has its own
README with the detail; this file is the map and the operating manual.

## How it works

- **Migration** (`switching-from-roam-to-logseq/`): `roam2logseq.convert` reads a Roam JSON
  export, fixes what Logseq's importer mangles (colliding titles, surplus-paren embeds, dash
  escapes), writes `pages/` and `journals/` in Logseq's native layout with a deterministic
  `id::` on every block, and keeps every piece of Roam metadata in a gzipped sidecar so
  `export_roam` can produce a byte-faithful Roam export again. A hourly launchd job
  (`com.elityre.logseq-backup`) commits the graph folder, pushes it to a private GitHub repo
  and mirrors it outside iCloud.
- **Anki** (`ankify_logseq/`): a port of ankify_roam that parses the Logseq markdown files
  instead of a Roam export and syncs `#ankify` blocks through AnkiConnect, matching notes by a
  `logseq uid` field so a note can stay linked to both its Roam and its Logseq block. The
  companion Block IDs plugin persists `id::` the moment a block is tagged.
- **LLM features** (`claude-chat/`, `auto-anki/`): one platform-independent `core.js` each,
  working on plain `{uid, text, children}` trees, plus an adapter per platform: a Roam
  `roam/js` paste-in (`roam/*.js`, built by concatenation) and an unpacked Logseq plugin
  (`logseq-plugins/*/`, the core is copied in). They call the Anthropic Messages API directly
  from the browser (`fetch`, model `claude-opus-5`, server-side fallbacks); the API key is
  entered once per browser/plugin and never stored in the graph.
- **LLM inbox** (`llm-contact/`): every system prompt starts with the shared preamble from
  `~/Documents/agent-coding/shared/llm-system-prompt-preamble.md` and every call offers the
  `contact_eli` tool. Browser code cannot read files or run python, so `llm-contact/build.sh`
  bakes both into `llm-contact.js` (word for word; the tests fail when the copy is stale) and
  the two build scripts ship it with the Roam files and the plugins. When Claude calls the
  tool or writes an `@ELI:` line, the core stops that task (Auto-anki writes no cards; a chat
  turn gets no further processing), appends the message to the graph page `llm-inbox`, keeps
  the full record (system prompt, messages, response, tools) in the browser's localStorage,
  and shows a warning. "copy LLM inbox records" (command palette) copies those records as
  JSON lines for `shared/llm_contact.py report`, which puts them in the real inbox and
  notifies Eli (see Common tasks).
- **Small Logseq plugins** (`logseq-plugins/`): ten unpacked plugins that recreate Roam
  habits in Logseq (inline checkboxes, block ids, backwards embeds, random page, template
  tokens, …); `roam/` holds the Roam-side twins of two of them.

## Files

| Path | Purpose |
|---|---|
| `README.md` | This file: map, runtime locations, commands, gotchas for the whole folder. |
| `Claude-in-roam _ Claude-in-logseq.md` | Eli's original spec for the Claude-in-outliner feature. |
| `claude-chat/` | "Claude in Roam / Logseq": `core.js` (triggers, prompt, streaming SSE reader, outline writer, inbox check), `roam-adapter.js`, `build.sh`, `test_core.js`, `README.md`. |
| `auto-anki/` | "Auto-anki": `core.js` (state block, frozen notes, prompt, structured-output call, planner, inbox check), `roam-adapter.js`, `build.sh`, `test_core.js`, `card-principles.md`, `README.md`. |
| `llm-contact/` | `build.sh` generates `llm-contact.js` (preamble, `contact_eli` tool, `extract`/`check`, local record store) from `template.js` and the shared files. Both other build scripts call it. |
| `roam/` | Paste-in `roam/js` blocks: `claude-in-roam.js` and `auto-anki.js` (generated, do not edit), `backwards-embed.js`; `README.md` has the install steps. |
| `logseq-plugins/` | One folder per unpacked Logseq plugin; `README.md` lists them. `claude-in-logseq/` and `auto-anki/` receive `core.js` and `llm-contact.js` from the build scripts. |
| `ankify_logseq/` | Python package + tests; `README.md`, `DESIGN.md`, `CHANGELOG.md`. |
| `switching-from-roam-to-logseq/` | `roam2logseq/` converter, verifiers and reverse exporter; `backup/` (launchd plist, `logseq-backup.sh`, `install.sh`); `Spec…md`, `import-issues.md`, `reversibility.md`; `fixtures/` small test export; `exports/` reports (large JSON ignored). |
| `otter-import/` | Otter.ai transcript import: `logseq/otter2logseq.py` (shelved) and the ignored fork `roam-extension/` (its own git repo). |
| `patches/logseq-og-new-window.sh` | Patches Logseq OG 1.0.0's `electron.js` so File → New Window works; rerun after reinstalling the app. |
| `.gitignore` | Keeps exports, credentials, venvs, caches and media out of git. |

## Runtime locations

- **Logseq graph**: `~/Documents/main-logseq-graph` (its own git repo, remote `github.com/Etyre/main-logseq-graph`, private). Sidecar `roam-uid-map.json.gz` inside it.
- **Backup agent**: `~/Library/LaunchAgents/com.elityre.logseq-backup.plist` runs the copy at `~/Library/Scripts/logseq-backup.sh` hourly. Optional config `~/Library/Application Support/LogseqBackup/config.env` (`GRAPH=`, `BACKUPS=`). Log `~/Library/Logs/logseq-backup.log` (timestamped); launchd stdout/stderr `~/Library/Logs/logseq-backup.launchd.log`. Mirrors in `~/Backups/logseq/`.
- **Logseq plugins**: loaded unpacked from this folder (Logseq remembers the path); per-plugin settings, including the Anthropic API key, in `~/.logseq/settings/<plugin-id>.json` (`logseq-claude-in-logseq`, `logseq-auto-anki`, …). Logs: Logseq developer console (`[claude-in-logseq]`, `[auto-anki]`, …).
- **Roam**: the code lives in the graph as `{{[[roam/js]]}}` blocks (pasted by hand); the API key in the browser's localStorage (`claude-in-roam:apiKey`, `auto-anki:apiKey`). Logs: the browser console.
- **In-graph pages written by the features**: `auto-anki/prompt`, `auto-anki/examples`, `llm-inbox`.
- **LLM inbox records in the browser**: localStorage key `llm-inbox:records` (last 50). The shared inbox itself is `~/Library/Application Support/LLMInbox/messages.jsonl` (see `../shared/README.md`).
- **Anki**: AnkiConnect on `localhost:8765`; the integration test uses the throwaway profile `ankify_test`. The daily Roam→Anki job `com.elityre.roam-anki-autoimport` is *not* from this folder (source: `~/Documents/Programming/Incremental_Reading_in_Roam/`), it only shares the Anki note types.
- **Otter**: credentials `~/.otter-credentials`, state `~/.otter2logseq/state.json` (both outside the repo).

## Common tasks

```sh
cd ~/Documents/agent-coding/logseq-and-roam

# LLM features: build (regenerates llm-contact.js, assembles roam/*.js, copies into the plugins, runs the tests)
auto-anki/build.sh
claude-chat/build.sh
# then re-paste roam/auto-anki.js / roam/claude-in-roam.js into their roam/js blocks and reload Roam,
# and in Logseq: Plugins → the plugin → reload (or toggle it off and on)

# Tests without any API key or running app
node auto-anki/test_core.js          # fake graph + fake Claude, incl. a contact_eli call and an @ELI: line
node claude-chat/test_core.js        # fake streaming Claude, incl. a streamed contact_eli call
cd ankify_logseq && /usr/bin/python3 -m unittest discover tests/unit && cd ..       # 46 tests, no Anki
cd switching-from-roam-to-logseq && /usr/bin/python3 -m unittest discover tests && cd ..   # converter round trip
cd ankify_logseq && /usr/bin/python3 -m unittest tests.integration.test_anki   # end to end in the Anki profile "ankify_test" (Anki open)

# Dry runs against the real things
switching-from-roam-to-logseq/backup/logseq-backup.sh --dry-run   # what the hourly backup would do, changes nothing
switching-from-roam-to-logseq/backup/install.sh --status           # agent loaded? installed copy current? last log lines
cd ankify_logseq && /usr/bin/python3 -m ankify_logseq.cli add ~/Documents/main-logseq-graph --dry-run
cd switching-from-roam-to-logseq && python3 -m roam2logseq.pair_anki ~/Documents/main-logseq-graph   # dry run; --apply to write

# Backup agent: install or reinstall after editing backup/logseq-backup.sh or the plist (bootout + bootstrap, never pkill)
switching-from-roam-to-logseq/backup/install.sh
tail -f ~/Library/Logs/logseq-backup.log
launchctl bootout gui/$(id -u)/com.elityre.logseq-backup     # stop

# LLM inbox: forward records that Roam/Logseq kept in the browser to the shared inbox
# (command palette → "… copy LLM inbox records" copies JSON lines to the clipboard first)
pbpaste | while IFS= read -r line; do printf '%s' "$line" | python3 ~/Documents/agent-coding/shared/llm_contact.py report; done
llm-inbox list

# Migration (Runbook A in switching-from-roam-to-logseq/README.md)
cd switching-from-roam-to-logseq && python3 -m roam2logseq.convert EXPORT.json ~/Documents/<new-graph> --git
```

## Settings that matter

- **Logseq OG** (not the 2.0 DB version): Settings → Advanced → Developer mode, then Plugins → "Load unpacked plugin" for each folder in `logseq-plugins/`. Plugins are per app, not per graph. `:journal/page-title-format "MMMM do, yyyy"` in the graph's `config.edn` keeps Roam's journal titles (and therefore Anki tags) identical.
- **Logseq HTTP API server** (Settings → Advanced → Developer mode; `…` → API server → Start) with a token in `$LOGSEQ_API_TOKEN` for `verify_in_logseq`.
- **Roam**: each `roam/*.js` file is pasted into a `{{[[roam/js]]}}` block and needs the "Yes I know what I'm doing" click; then command palette → "… set API key".
- **macOS Full Disk Access for `/bin/bash`** (System Settings → Privacy & Security), granted 2026-09-05, so the launchd backup can read `~/Documents`.
- **Anki** must be open with the AnkiConnect add-on for `ankify_logseq add` and the integration test; the test needs a profile named `ankify_test`.
- **Python**: `/usr/bin/python3` (3.9) has the dependencies for `ankify_logseq` and `roam2logseq`; the Homebrew `python3` (3.15) does not.

## Gotchas learned

- A `roam/js` code block ends at the first three backticks, so the generated Roam files must never contain them literally (the build scripts check; `core.js` uses `"\x60\x60\x60"`).
- launchd jobs cannot read `~/Documents` (TCC) without Full Disk Access; that is why the backup runs from a copy in `~/Library/Scripts` and why `install.sh` copies it there. Edits in the repo do nothing until `install.sh` is rerun (`install.sh --status` says when the copies differ).
- `logseq-backup.launchd.log` filling with "You have not agreed to the Xcode license agreements" means `git` resolved to the Xcode stub; the script puts `/usr/local/bin:/opt/homebrew/bin` first on PATH for that reason. If it comes back, run `sudo xcodebuild -license` once.
- iCloud makes "name 2.md" conflict copies inside the graph; the backup deletes them when the original exists, otherwise they would multiply in git.
- Roam's `roam-backup-JSON-only` repo uses git LFS; a failed LFS download leaves a 134-byte pointer file that looks like `eli.json`. (Hit by the Anki autoimport job, which checks the file size.)
- After `normalize_graph`, Logseq's cache predates the files: delete `~/.logseq/graphs/…transit` and the search index (Re-index alone did not rebuild the journals). The direct converter (Runbook A) avoids this entirely. Never point Logseq at a folder it opened before under the same name.
- Deep links (`logseq://graph/<name>?page=…`) fail with "Cannot match graph identifier" until Logseq has written the graph's cache on quit: quit and relaunch once after the first parse.
- The copy of `roam/auto-anki.js` (or `claude-in-roam.js`) that actually runs is the one pasted into the graph, and it goes stale silently: search Roam for "auto-anki for Roam" (or "built from") and compare the build date in that snippet with the first line of the repo file. On 2026-11-07 the graph still ran the 2026-10-25 build, which predates the LLM-inbox preamble and the busy fix.
- The Auto-anki state block must never contain `#ankify` inside its JSON, or ankify_roam/ankify_logseq turn the bookkeeping block into a card (note text is stored without the tag).
- A tagless block under an Auto-anki home block counts as a user-written note (frozen). Anything the features need to write for themselves goes on its own page (`auto-anki/examples`, `llm-inbox`), never under the home block.
- Streaming replies: the `=>` marker is created before the first token, so an error or a stop always has a block to land in; errors are written into the graph, not just the console.
- ankify_roam fills *every* field of a note on update; once `logseq uid` is populated, an unpatched ankify_roam run would blank it on all 7,000 notes. Patch it before Part II writes anything (DESIGN.md §2.3).
- The Logseq plugin iframe has its own localStorage: Claude-in-Logseq and Auto-anki records may sit in different stores, so "copy LLM inbox records" exists in both plugins (and in both Roam scripts, which share the Roam origin).
- Logseq OG 1.0.0: File → New Window is broken (`$isFocused$` mangling) and new windows re-persist the whole graph cache (~5 s, and a stale window can overwrite a newer page). `patches/logseq-og-new-window.sh --safe` fixes the first without the second.
- The shared helper `python3 shared/llm_contact.py check` exits 3 when a message was recorded; the browser-side `LlmContact.check()` returns the record instead. Both mean the same: stop the task, do not retry.
