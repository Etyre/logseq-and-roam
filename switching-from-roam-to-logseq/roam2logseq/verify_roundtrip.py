"""Compare a Roam JSON produced by export_roam with the (fixed) Roam JSON the graph
was converted from: same pages, same block tree (uids, order), same strings.

    python3 -m roam2logseq.verify_roundtrip EXPORTED.json ORIGINAL_FIXED.json [--show N]

Exact string equality is the goal; the few differences the forward trip does not
undo (a newline before a closing code fence, trimmed whitespace) are compared
after whitespace normalisation and counted separately.
"""
import argparse
import collections
import json
import re
import sys


def walk(bs, path=()):
    for i, b in enumerate(bs):
        yield b, path + (i,)
        yield from walk(b.get("children", []), path + (i,))


def loose(s):
    s = s.replace("﻿", "")
    s = re.sub(r"(\{\{\[\[(?:TODO|DONE)\]\]\}\})\s+", r"\1", s)   # the space the converter adds after a glued checkbox
    s = re.sub(r"\s*```\s*", "```", s)
    return re.sub(r"\s+", " ", s).strip()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("exported")
    ap.add_argument("original")
    ap.add_argument("--show", type=int, default=20)
    args = ap.parse_args(argv)
    with open(args.exported, encoding="utf-8") as f:
        exp = json.load(f)
    with open(args.original, encoding="utf-8") as f:
        orig = json.load(f)
    eby = {p["title"]: p for p in exp}
    counts = collections.Counter()
    diffs = []
    for op in orig:
        t = op["title"]
        ep = eby.get(t)
        if ep is None:
            if op.get("children"):
                diffs.append(f"page missing in export: {t!r}"); counts["pages missing"] += 1
            else:
                counts["empty pages"] += 1
            continue
        counts["pages"] += 1
        ob = list(walk(op.get("children", []))); eb = list(walk(ep.get("children", [])))
        if len(ob) != len(eb):
            diffs.append(f"{t!r}: {len(eb)} blocks vs {len(ob)} original"); counts["pages with block-count mismatch"] += 1
        for (o, opth), (e, epth) in zip(ob, eb):
            if opth != epth:
                diffs.append(f"{t!r}: nesting differs at {epth} vs {opth}"); counts["nesting mismatches"] += 1
                break
            if o["uid"] != e.get("uid"):
                diffs.append(f"{t!r} {opth}: uid {e.get('uid')} != {o['uid']}"); counts["uid mismatches"] += 1
            os_, es = o.get("string", ""), e.get("string", "")
            # the fixer's escapes (`\-`, `\#` on continuation lines) are for Logseq only
            os_ = re.sub(r"(?m)^([ \t]*)\\([-#])", r"\1\2", os_)
            if os_ == es:
                counts["strings identical"] += 1
            elif loose(os_) == loose(es):
                counts["strings equal modulo whitespace"] += 1
            else:
                diffs.append(f"{t!r} {opth}: {es[:80]!r} != {os_[:80]!r}"); counts["string mismatches"] += 1
            for k in ("create-time", "edit-time", "heading", ":children/view-type", "open"):
                if (k in o) != (k in e) or (k in o and o[k] != e[k]):
                    counts[f"metadata differs: {k}"] += 1
                    if counts[f"metadata differs: {k}"] <= 3:
                        diffs.append(f"{t!r} {opth}: {k} {e.get(k)!r} != {o.get(k)!r}")
    extra = set(eby) - {p["title"] for p in orig}
    if extra:
        counts["pages only in export"] = len(extra)
        for t in sorted(extra)[:5]:
            diffs.append(f"page only in export: {t!r}")
    print("# verify_roundtrip")
    for k, v in sorted(counts.items()):
        print(f"- {k}: {v}")
    for d in diffs[:args.show]:
        print("  ", d)
    if len(diffs) > args.show:
        print(f"   ... and {len(diffs) - args.show} more")
    bad = sum(v for k, v in counts.items() if k not in ("pages", "empty pages", "strings identical", "strings equal modulo whitespace"))
    print("RESULT:", "OK" if bad == 0 else f"{bad} problem(s)")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
