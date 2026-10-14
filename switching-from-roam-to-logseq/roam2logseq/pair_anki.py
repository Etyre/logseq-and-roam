"""Part II: give every Anki note made by ankify_roam its Logseq ids.

    python3 -m roam2logseq.pair_anki GRAPH_DIR [--apply] [--profile NAME]

For each note of the Roam note types that has a Roam `uid` and an empty
`logseq uid`, compute the derived Logseq id (`uuid5(NAMESPACE, roam uid)`), check
that a block with that id exists in the graph, and fill `logseq uid` and
`logseq parent uid` (the parent block's id, or the page title for a top-level
block). Only those two fields are ever written. Without `--apply` nothing is
written and the plan is printed. Notes whose block is not in the graph (deleted in
Roam since the export) are reported and left untouched.

Idempotent: notes that already carry the right ids are skipped; notes carrying a
different `logseq uid` are reported, never overwritten.
"""
import argparse
import collections
import re
import sys

from ankify_logseq import anki
from ankify_logseq.logseq import LogseqGraph
from roam2logseq.normalize_graph import derived_uuid

NOTE_TYPES = ("Roam Basic", "Roam Cloze")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("graph_dir")
    ap.add_argument("--apply", action="store_true", help="write the fields (default: dry run)")
    ap.add_argument("--profile", default=None, help="Anki profile to switch to first (and back after)")
    ap.add_argument("--note-types", default=",".join(NOTE_TYPES))
    ap.add_argument("--show", type=int, default=10)
    args = ap.parse_args(argv)

    if not anki.connection_open():
        raise SystemExit("Anki/AnkiConnect not reachable")
    previous = anki._invoke("getActiveProfile")
    if args.profile and previous != args.profile:
        anki.load_profile(args.profile)
        import time
        for _ in range(30):
            if anki._invoke("getActiveProfile") == args.profile:
                break
            time.sleep(0.5)
    try:
        return run(args)
    finally:
        if args.profile and previous != args.profile:
            anki.load_profile(previous)


def run(args):
    print("Loading graph...")
    graph = LogseqGraph.from_path(args.graph_dir)
    by_uid = {}
    for b in graph.all_blocks():
        if b.uid:
            by_uid[b.uid] = b
    print(f"  {len(by_uid)} blocks with ids")

    types = [t.strip() for t in args.note_types.split(",")]
    query = " OR ".join(f'note:"{t}"' for t in types)
    note_ids = anki.find_notes(f"({query})")
    print(f"Anki notes of {types}: {len(note_ids)}")
    counts = collections.Counter()
    plan = []      # (note_id, fields to write)
    problems = []
    for i in range(0, len(note_ids), 500):
        for n in anki.get_notes(note_ids[i:i + 500]):
            f = {k: v["value"] for k, v in n["fields"].items()}
            roam_uid = re.sub(r"<[^>]+>", "", f.get("uid", "")).strip()  # a few uids got wrapped in <div> by Anki's editor
            if not roam_uid:
                counts["notes without a Roam uid"] += 1
                continue
            want = derived_uuid(roam_uid)
            block = by_uid.get(want)
            have = f.get("logseq uid", "").strip()
            if have == want:
                counts["already paired"] += 1
                if block is not None and f.get("logseq parent uid", "").strip() != (block.parent_uid or ""):
                    plan.append((n["noteId"], {"logseq parent uid": block.parent_uid or ""}))
                    counts["parent uid to fix"] += 1
                continue
            if have:
                counts["carry a different logseq uid (left alone)"] += 1
                problems.append(f"note {n['noteId']} uid {roam_uid}: has logseq uid {have}, derived is {want}")
                continue
            if block is None:
                counts["block not in graph (deleted in Roam?)"] += 1
                problems.append(f"note {n['noteId']} uid {roam_uid}: no block {want} in the graph ({f.get(list(f)[0], '')[:50]!r})")
                continue
            plan.append((n["noteId"], {"logseq uid": want, "logseq parent uid": block.parent_uid or ""}))
            counts["to pair"] += 1

    for k, v in sorted(counts.items()):
        print(f"- {k}: {v}")
    for p in problems[:args.show]:
        print("  ", p)
    if len(problems) > args.show:
        print(f"   ... and {len(problems) - args.show} more")

    if not args.apply:
        print(f"\nDRY RUN: {len(plan)} note(s) would be written. Re-run with --apply.")
        return 0
    written = 0
    for note_id, fields in plan:
        anki.update_fields(note_id, fields)
        written += 1
        if written % 500 == 0:
            print(f"  written {written}/{len(plan)}")
    print(f"\nWrote {written} note(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
