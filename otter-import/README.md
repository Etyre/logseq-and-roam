# Otter import (spec Part VIII), for Roam and Logseq

Everything about getting Otter.ai transcripts into the graph lives here.

| Folder | What |
|---|---|
| `roam-extension/` | Eli's fork of RoamJS/otter (github.com/Etyre/otter-import), the Roam Depot extension. It does not talk to Otter itself: it sends the credentials to a SamePage backend (`api.samepage.network/extensions/otter/speeches`) which talks to Otter. Branch `fix-typos` = PR #1 (spelling fixes in the block templates). Why the auto-import stopped in 2025 is not yet diagnosed: the backend still answers (401 "encrypt your password first" to an unencrypted probe), so the break is inside it or in the credential handshake; the error text from "Import Otter" in Roam's console will tell. |
| `logseq/otter2logseq.py` | The Logseq replacement: talks to Otter's API directly from this machine (no third party), writes one block tree per recording onto the page for its Otter folder, in the Roam extension's exact layout with the spelling fixed, deterministic block ids (uuid5 of the Otter id), state in `~/.otter2logseq/state.json`, credentials in `~/.otter-credentials` (email line 1, password line 2, chmod 600). Meant to run daily from launchd once tested. |

## Folders → pages (from the Roam extension)

| Otter folder id | Page |
|---|---|
| 1072467 (walking journal) | Otter auto-import walking journal transcripts, title tagged `#[[Walking Journal]]` |
| 961073 (audio notes) | Otter auto-imported audio notes transcripts, label tagged `#[[transcribed verbal notes]]`, extra `source::` |
| none | Otter auto-imported transcripts (no folder) |

## The spelling fix, in four places at once (decided 2026-09-05)

The extension wrote `[[Automated transcirpt from otter]]`, `Recroding Metadata` and
`[[Transcricpt]]` on every import, so the misspellings are page names.

1. **Roam**: rename the pages by hand (renaming a page in Roam rewrites every reference):
   "Automated transcirpt from otter" → "Automated transcript from otter", "Transcricpt" → "Transcript".
   "Recroding Metadata" is plain block text; leave it, or fix with Roam's find-and-replace.
2. **Logseq**: the converter applies the same renames to titles and references and fixes
   the block text (`roam2logseq/convert.py`, `PAGE_SPELLING_FIXES`, `TEXT_SPELLING_FIXES`);
   the verifier and the reverse exporter know about them.
3. **Logseq importer**: writes the corrected names by default (`--roam-spelling` for the old ones).
4. **Roam extension**: PR #1 on the fork; rebuild and reload the extension after merging.

## Status: shelved 2026-09-05 (Eli: "not now")

Next steps when picked up again, in order:

1. Put Otter credentials in `~/.otter-credentials` (email, newline, password; `chmod 600`);
   an account that signs in through Google needs an Otter password set on otter.ai.
2. `python3 otter-import/logseq/otter2logseq.py ~/Documents/main-logseq-graph --list` to see
   whether Otter's unofficial API still accepts the login and what the folder ids are now
   (the two folder ids above come from the 2024 Roam extension and may have changed).
3. `--dry-run`, then a real run; check the three pages in Logseq; then a launchd job
   (copy the pattern of `switching-from-roam-to-logseq/backup/`) running it daily.
4. The Roam side, only if Roam is still in use: merge PR #1 on github.com/Etyre/otter-import,
   rebuild, and find out why the SamePage-backed import stopped (run "Import Otter" in Roam
   with the console open; the error text says whether Otter rejects the login or the
   backend is gone).
5. The spelling fix in Roam (two page renames by hand) can wait until then too; the
   converter already applies it on the Logseq side.
