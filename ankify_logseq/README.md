# ankify_logseq

A port of [ankify_roam](https://github.com/taylormitchell/ankify_roam) that reads a
Logseq **file graph** (markdown) instead of a Roam JSON export and syncs blocks tagged
`#ankify` to Anki through AnkiConnect.

Same behavior and options as ankify_roam, with these differences:

- Notes are matched to blocks by the `logseq uid` field. The Roam `uid` field is never
  written, so a note can stay linked to both its Roam block and its Logseq block.
- Every note also gets `logseq parent uid`: the parent block's uid, or the page title for
  a top-level block.
- Only the fields the tool generates are written or compared (the content fields and the
  two logseq id fields). `Extra`, `uid`, `parent uid` and anything else are left alone.
- A block can only be ankified once it has a persisted Logseq id (`id::` property). Blocks
  without one are reported and skipped. The companion Logseq plugin persists ids when a
  block is tagged; the sync tool will get a fallback for blocks the plugin missed.
- Decks named by option tags are created if missing, so a new deck can be started
  from Logseq alone (`--no-create-decks` to disable).
- `--dry-run` reports the sync plan without writing anything; `check` inspects a graph
  without Anki at all.
- The existing `#[[ankify_roam: deck="..."]]` option tags keep working. With
  `--options-from-properties`, options can also be Logseq block properties
  (`deck:: My Deck`, `suspend:: true`, ...), and `deck::` is inherited from parent blocks.
- `suspend=False` (tag or property) unsuspends a block's cards and gives them a purple
  flag in Anki (search `flag:7`). The flag is not removed when the option is removed.

Status: under construction. See `DESIGN.md` for the design and build plan, and
`CHANGELOG.md` for what exists so far.

## Usage

```
ankify_logseq check  /path/to/graph                     # what would a sync see?
ankify_logseq add    /path/to/graph --deck "My deck" --dry-run
ankify_logseq add    /path/to/graph --deck "My deck"
ankify_logseq init-models                               # create note types if missing
```

## Development

```
cd ankify_logseq
/usr/bin/python3 -m unittest discover tests/unit          # 39 unit tests, no Anki needed
/usr/bin/python3 -m unittest tests.integration.test_anki   # end to end, in the Anki profile "ankify_test"
/usr/bin/python3 -m ankify_logseq.cli check "/path/to/graph"
```

The integration test only ever touches the throwaway Anki profile named
`ankify_test` (create it once in Anki: File → Switch Profile → Add) and switches
back to the previous profile when done.
