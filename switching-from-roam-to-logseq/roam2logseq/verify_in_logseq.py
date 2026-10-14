"""Verify, through Logseq's own HTTP API, that the running Logseq holds every block of
the fixed Roam export with its derived id and in the right place.

    python3 -m roam2logseq.verify_in_logseq FIXED_ROAM.json [--token TOKEN] [--show N]

Requires Logseq OG to have the graph open with the HTTP API server running (after a
Re-index if the files were normalized while the graph was already known to Logseq).
Pages without blocks in Roam are skipped (the importer writes no file for them).
"""
import argparse
import json
import re
import sys

from ankify_logseq.logseq.api import LogseqApi
from roam2logseq.normalize_graph import derived_uuid, roam_title_date, RE_PROP_LINE


def lwalk(bs, p=()):
    for i, b in enumerate(bs or []):
        yield b, p + (i,)
        yield from lwalk(b.get("children"), p + (i,))


def rwalk(bs, p=()):
    for i, b in enumerate(bs):
        yield b, p + (i,)
        yield from rwalk(b.get("children", []), p + (i,))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("roam_json")
    ap.add_argument("--token", default=None)
    ap.add_argument("--show", type=int, default=20)
    ap.add_argument("--no-lift", action="store_true", help="the graph was converted with --no-lift-metadata")
    args = ap.parse_args(argv)
    api = LogseqApi(token=args.token)
    print("Logseq graph:", api.current_graph())
    with open(args.roam_json, encoding="utf-8") as f:
        roam = json.load(f)
    checked = 0; problems = []; became_props = 0; dissolved = 0
    from roam2logseq.convert import lift_metadata, referenced_uids
    referenced = referenced_uids(roam) if not args.no_lift else frozenset()
    for rp in roam:
        if not rp.get("children"):
            continue
        from roam2logseq.convert import rename_option_title
        title = rename_option_title(rp["title"])
        roam_children = rp["children"]
        if not args.no_lift:
            from roam2logseq.convert import relift_templates
            roam_children, props, lifted, meta_uid = lift_metadata(roam_children, referenced)
            roam_children = relift_templates(roam_children, referenced)
            if meta_uid:
                dissolved += 1
                page = api.call("logseq.Editor.getPage", title) or {}
                have = {k.lower() for k in (page.get("properties") or {})}
                for key, _v in props:
                    if key not in have and key.replace("-", "") not in {h.replace("-", "") for h in have}:
                        problems.append(f"{title!r}: lifted property {key!r} not on the page in Logseq")
        tree = api.page_blocks_tree(title)
        if not tree and roam_title_date(title):
            tree = api.page_blocks_tree(title)  # journal pages are looked up by title too
        if not tree:
            problems.append(f"no page in Logseq for {title!r}"); continue
        first = tree[0].get("content") or ""
        if tree[0].get("preBlock?") or first.startswith("---") or all(re.match(r"^[A-Za-z0-9_.\-]+:: ?", l) for l in first.split("\n") if l.strip()):
            tree = tree[1:]  # Logseq's page-properties pre-block (front matter or property-only first block)
        lb = list(lwalk(tree)); rb = list(rwalk(roam_children))
        # leading `key:: value` Roam blocks that Logseq turned into page properties
        while len(rb) > len(lb) and rb and len(rb[0][1]) == 1 and RE_PROP_LINE.match(rb[0][0].get("string", "")) and not rb[0][0].get("children"):
            key = rb[0][0]["string"].split("::", 1)[0].strip().lower()
            page = api.call("logseq.Editor.getPage", title) or {}
            props = {k.lower() for k in (page.get("properties") or {})}
            if key not in props and key.replace(" ", "-") not in props:
                break
            rb.pop(0); rb = [(r, (pth[0] - 1,) + pth[1:]) for r, pth in rb]; became_props += 1
        if len(lb) != len(rb):
            problems.append(f"{title!r}: Logseq has {len(lb)} blocks, Roam {len(rb)}")
        for (b, lp), (r, rp_) in zip(lb, rb):
            checked += 1
            want = derived_uuid(r["uid"])
            if b.get("uuid") != want or (b.get("properties") or {}).get("id") != want:
                problems.append(f"{title!r} {lp}: uuid {b.get('uuid')} != derived {want} ({r.get('string', '')[:40]!r})")
            elif lp != rp_:
                problems.append(f"{title!r}: nesting {lp} vs Roam {rp_}")
    print(f"blocks checked: {checked}; became page properties: {became_props}; metadata blocks dissolved: {dissolved}; problems: {len(problems)}")
    for p in problems[:args.show]:
        print("  ", p)
    if len(problems) > args.show:
        print(f"   ... and {len(problems) - args.show} more")
    print("RESULT:", "OK" if not problems else "PROBLEMS")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
