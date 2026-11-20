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
  from the browser (`fetch`, model `claude-opus-5-5`, server-side fallbacks); the API key is
  entered once per browser/plugin and never stored in the graph.
- **LLM inbox** (`llm-contact/`): every system prompt starts with the shared preamble from
  `~/Documents/agent-coding/shared/llm-system-prompt-preamble.md` and every call offers the
  `contact_eli` tool (stops the task) and, since 2026-11-20, the `note_to_eli` tool (does not; next
  bullet). Browser code cannot read files or run python, so `llm-contact/build.sh`
  bakes the preamble and both tools into `llm-contact.js` (word for word; the tests fail when the copy is stale) and
  the two build scripts ship it with the Roam files and the plugins. When Claude calls
  `contact_eli` or writes an `@ELI:` line, the core stops that task (Auto-anki writes no cards; a chat
  turn gets no further processing), appends the message to the graph page `llm-inbox`, keeps
  the full record (system prompt, messages, response, tools) in the browser's localStorage,
  and shows a warning. "copy LLM inbox records" (command palette) copies those records as
  JSON lines for `shared/llm_contact.py report`, which puts them in the real inbox and
  notifies Eli (see Common tasks).
- **Notes** (added 2026-11-20; `withNotes` in `llm-contact/template.js`, a port of `with_notes` in
  `shared/llm_contact.py`): a `note_to_eli` call leaves Eli a message and the task carries on. Neither
  feature has a tool loop of its own (web search runs on Anthropic's side), so the core records the
  note, appends Claude's turn plus a `tool_result` carrying the shared acknowledgement
  (`NOTE_RESULT_TEXT`, baked in by the build) and asks again, at most 3 times; the chat reply goes on
  in the same blocks, Auto-anki drops whatever cards had streamed and takes the new answer. One
  exception in Auto-anki: a response that holds a complete JSON answer next to the note is used as
  the answer without asking again, because a second answer would replace the first. A note is never
  read as the answer and never stops anything. It travels the same route as a stop: an entry on the
  graph page `llm-inbox` (header ends "via note (task carried on)"), an info notice instead of a
  warning, and a full record in localStorage `llm-inbox:records` marked `via: "note", halts: false`.
  `llm_contact.py report` reads that flag: it files the record as a note (normal priority, "left you
  a note (task carried on)") and exits 0. Each note is recorded once (per response; `check()` records
  any note `withNotes` did not see, as a safety net). A response with a note and a `contact_eli` call
  or `@ELI:` line records both and stops. Like the confirm step, it only runs once the rebuilt files
  are re-pasted and the plugins reloaded.
- **Confirm step** (added 2026-11-10; `withConfirm` in `llm-contact/template.js`, a port of
  `with_confirm` in `shared/llm_contact.py`): small models call `contact_eli` for routine remarks
  about the task, so for a model in the shared `CONFIRM_MODELS` list (prefixes baked in as
  `CONFIRM.confirm_models`; today only `claude-haiku-4-5`) a `contact_eli` call is first followed
  by one forced-choice question
  (`contact_eli_decision`: `send_to_eli_and_stop` or `task_remark_keep_working`), asked of the same
  model with the same system prompt and tools, without thinking, effort or output format. Only an
  explicit "keep working" continues: the model is asked for its answer again (Auto-anki drops any
  cards the first attempt streamed and writes the new ones; the chat continues the same reply) and
  what it had said is kept in localStorage `llm-inbox:unconfirmed`, with no notice and nothing on
  the `llm-inbox` page. Send, an unclear answer, or any error in the question call: the original
  response is recorded exactly as before. An `@ELI:` line is never questioned. For every model not
  on that list no question is asked and a `contact_eli` call is sent as before. Both features default
  to `claude-opus-5-5` (Roam: `CONFIG.model`; Logseq: the plugin's Model setting), so here the confirm
  step is inactive unless the model is set to Haiku 4.5. The question and
  the decision tool are baked in by `llm-contact/build.sh` from
  `llm_contact.py confirm-constants`, never retyped; so is the model list. It only runs once the rebuilt `roam/*.js`
  files are re-pasted into their `roam/js` blocks and the two Logseq plugins are reloaded
  (Common tasks); the same goes for a change to the shared model list.
- **Small Logseq plugins** (`logseq-plugins/`): ten unpacked plugins that recreate Roam
  habits in Logseq (inline checkboxes, block ids, backwards embeds, random page, template
  tokens, …); `roam/` holds the Roam-side twins of two of them.

## Files

| Path | Purpose |
|---|---|
| `README.md` | This file: map, runtime locations, commands, gotchas for the whole folder. |
| `Claude-in-roam _ Claude-in-logseq.md` | Eli's original spec for the Claude-in-outliner feature. |
| `claude-chat/` | "Claude in Roam / Logseq": `core.js` (triggers, prompt, streaming SSE reader, outline writer, inbox check), `roam-adapter.js`, `build.sh`, `test_core.js`, `README.md`. |
| `auto-anki/` | "Auto-anki": `core.js` (state block, frozen notes, prompt, streamed structured-output call that writes each card as it arrives, planner, inbox check), `roam-adapter.js`, `build.sh`, `test_core.js`, `card-principles.md`, `README.md`. |
| `llm-contact/` | `build.sh` generates `llm-contact.js` (preamble, `contact_eli` and `note_to_eli` tools, `extract`/`check`, `withNotes`, the confirm step, local record stores) from `template.js` and the shared files, then runs `test.js` (confirm step and note tool against stubbed model calls). Both other build scripts call it. |
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
- **LLM inbox records in the browser**: localStorage key `llm-inbox:records` (last 50); messages the model chose not to send in the confirm step: `llm-inbox:unconfirmed` (last 50, never notified). The shared inbox itself is `~/Library/Application Support/LLMInbox/messages.jsonl` (see `../shared/README.md`).
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
node auto-anki/test_core.js          # fake graph + fake Claude, incl. a contact_eli call, an @ELI: line and note_to_eli calls
node claude-chat/test_core.js        # fake streaming Claude, incl. streamed contact_eli and note_to_eli calls
node llm-contact/test.js             # the confirm step (keep / send / unclear / failing question call) and withNotes alone
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
# (command palette → "… copy LLM inbox records" copies JSON lines to the clipboard first; stops and notes
# alike: a note line carries "halts": false, is filed as a note and makes `report` exit 0, a stop exits 3)
pbpaste | while IFS= read -r line; do printf '%s' "$line" | python3 ~/Documents/agent-coding/shared/llm_contact.py report; done
llm-inbox list
# audit what the confirm step did not send (command palette → "… copy unconfirmed LLM messages");
# read it, or add it to the shared unconfirmed.jsonl:
pbpaste | while IFS= read -r line; do printf '%s' "$line" | python3 ~/Documents/agent-coding/shared/llm_contact.py unconfirmed; done

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
- The Roam graph has had an `auto-anki/prompt` page since 2026-11-20 (seeded from that day's built-in prompt). It replaces the built-in prompt in Roam, so a change to `SYSTEM` in `auto-anki/core.js` no longer reaches Roam: edit the page too. The Logseq graph has no such page and still uses the built-in text.
- Since 2026-11-20 Auto-anki cards are untagged until the user tags them, so the hidden `#auto-anki-state` block is the only record of which blocks the model wrote. Delete or damage it and every untagged card under that home block reads as user-written (frozen) and its headings read as question cards.
- A block under an Auto-anki home block that is neither tagged nor recorded in the state block counts as a user-written note (frozen). Anything the features need to write for themselves goes on its own page (`auto-anki/examples`, `llm-inbox`), never under the home block.
- Auto-anki leaves other card sections out of its source material: a home block deeper in the content (a sub-section with its own cards) is dropped with its cards and state block (`withoutHomes` in `core.js`, 2026-11-20). Before that, running `/cards` one level up sent the sub-section's cards as content and got duplicate cards back.
- Auto-anki records only the topic tags the model itself added to a home block (`state.llmTags`). Before 2026-11-20 it recorded every tag the model returned, so a tag you had typed yourself was removed on a later run that did not return it; a home, off, ankify or state tag from the model is now ignored.
- With `autoUpdate` on, a block whose run failed or ended with `contact_eli` gets no further automatic runs until you update it by hand (`autoHold` in both adapters). Without it a stale block was retried every `quietMinutes` for ever, including straight past a message to Eli.
- If an Auto-anki run fails after the answer arrived (a write error half-way through applying it), the cards already written stay and are recorded in the state block; the block stays stale, so run it again. They are not rolled back, on purpose: by then existing cards may already have been changed.
- In Roam a block whose first line is `Key:: value` is an attribute and is sent to the model as content; only later lines of that shape (Logseq property lines) are dropped (`norm` in `auto-anki/core.js`).
- Streaming replies: the `=>` marker is created before the first token, so an error or a stop always has a block to land in; errors are written into the graph, not just the console.
- ankify_roam fills *every* field of a note on update; once `logseq uid` is populated, an unpatched ankify_roam run would blank it on all 7,000 notes. Patch it before Part II writes anything (DESIGN.md §2.3).
- The Logseq plugin iframe has its own localStorage: Claude-in-Logseq and Auto-anki records may sit in different stores, so "copy LLM inbox records" exists in both plugins (and in both Roam scripts, which share the Roam origin).
- Logseq OG 1.0.0: File → New Window is broken (`$isFocused$` mangling) and new windows re-persist the whole graph cache (~5 s, and a stale window can overwrite a newer page). `patches/logseq-og-new-window.sh --safe` fixes the first without the second.
- `llm-contact/build.sh` needs python >= 3.10 for `llm_contact.py confirm-constants` (`/usr/bin/python3` is 3.9 and fails on its type hints); it tries `/opt/homebrew/bin/python3` first and stops with an error, leaving the old `llm-contact.js` in place, when none is found.
- The confirm step is limited to models it was measured on and passed (`CONFIRM_MODELS` in `shared/llm_contact.py`; see the shared README's Gotchas for the numbers): Haiku 5.5 and Opus 5 dropped real "I want to stop" messages when asked, Sonnet 5 dropped some, and Sonnet 5.5 / Opus 5.5 / Fable 5.2 reject a forced `tool_choice`. To change the list, edit it there and rebuild here. With the default `claude-opus-5-5` nothing is ever questioned.
- The question call forces a tool and turns thinking off for that one call; if the API rejects it, the call fails and the original message is sent (console: "confirm step FAILED"). The browser-side question call has not been tried against the live API (2026-11-10), and neither has running these two features on `claude-haiku-4-5` at all: they send `output_config.effort` and (chat) the `web_search_20260209` tool, which that model may not accept.
- The stores for unconfirmed messages are per origin like the records: one for Roam, one per Logseq plugin. Read them now and then (the shared README explains why: a real request phrased as a question about the task can land there).
- `note_to_eli` has only been run against fake responses (2026-11-20, built at night with the API blocked). Not yet seen with a real model: whether the API accepts the continued request (the assistant turn is rebuilt from the stream; Auto-anki's `readStream` has kept thinking blocks with their signatures since 2026-11-20 and drops empty text blocks, which the API rejects, but this has still only been run against fake streams), what Claude writes after the acknowledgement in a chat reply that was already complete (it may add a line), and whether a real objection ever goes to the note tool instead of `contact_eli` (the shared README's Gotchas ask for that to be measured).
- When a note round runs out (3 notes in a row) or a note arrives in the answer given after a confirm-step "keep working", the note is still recorded but its call is not answered; the response is then used as it is (Auto-anki fails with "did not return valid JSON" if it holds no answer).
- The stored LLM inbox records are never marked forwarded or removed, so "copy LLM inbox records" copies all of the last 50 every time and forwarding twice files them twice.
- The shared helper `python3 shared/llm_contact.py check` exits 3 when a message was recorded; the browser-side `LlmContact.check()` returns the record instead. Both mean the same: stop the task, do not retry.
