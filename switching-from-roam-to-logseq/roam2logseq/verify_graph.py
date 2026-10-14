"""Verify a (normalized) Logseq graph against the fixed Roam export, independently
of the normalizer: re-parse every file, pair pages and blocks, compare text
(whitespace-insensitive, refs mapped back to Roam uids through the sidecar),
nesting, task markers, and check that every block's persisted id is the derived one.

    python3 -m roam2logseq.verify_graph GRAPH_DIR FIXED_ROAM.json [--map roam-uid-map.json]

Exit status 0 when nothing unexplained differs.
"""
import argparse
import collections
import json
import os
import re
import sys

from ankify_logseq.logseq import LogseqGraph
from roam2logseq.normalize_graph import (
    Normalizer, RE_UUID, derived_uuid, logseq_walk, roam_walk, norm_text, leading_property_blocks, code_fences,
)


def norm_roam(s):
    """Canonical form, but refs keep their (Roam) uid so wrong ref targets are caught.
    Attribute keys the converter renames are renamed here too (intentional change)."""
    from roam2logseq.convert import rename_property_keys
    s = rename_property_keys(s)[0]
    s = re.sub(r"\(\(+([\w\-]{9,40})\)\)+", r"<<\1>>", s)
    return norm_text(s)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("graph_dir")
    ap.add_argument("roam_json")
    ap.add_argument("--map", default=None)
    ap.add_argument("--show", type=int, default=15, help="how many differences to print")
    ap.add_argument("--no-lift", action="store_true", help="the graph was converted with --no-lift-metadata")
    args = ap.parse_args(argv)
    with open(args.roam_json, encoding="utf-8") as f:
        roam_pages = json.load(f)
    from roam2logseq.sidecar import sidecar_path, load_sidecar
    map_path = sidecar_path(args.graph_dir, args.map)
    uuid_to_roam = {}
    if os.path.exists(map_path):
        m = load_sidecar(map_path)
        if True:
            for e in m["blocks"]:
                if e.get("logseq_uuid"):
                    uuid_to_roam[e["logseq_uuid"]] = e["roam_uid"]
            uuid_to_roam.update(m.get("dangling_refs", {}))

    graph = LogseqGraph.from_path(args.graph_dir)
    n = Normalizer(args.graph_dir, roam_pages)
    by_title, by_date = n.index_roam()
    from roam2logseq.convert import rename_option_title
    for rp in roam_pages:
        nt = rename_option_title(rp.get("title", ""))
        if nt != rp.get("title", ""):
            by_title[nt] = rp; by_title[nt.lower()] = rp
    counts = collections.Counter()
    diffs = []
    seen_roam = set()
    referenced = None
    for page in graph.pages:
        if os.path.basename(page.path) == "contents.md" and not any(b.to_string().strip() for b in page.children):
            continue  # Logseq's own Contents page
        rp = n.pair_page(page, by_title, by_date)
        rel = os.path.relpath(page.path, args.graph_dir)
        if rp is None:
            diffs.append(f"{rel}: no Roam page"); counts["pages without Roam match"] += 1
            continue
        seen_roam.add(id(rp))
        roam_children = rp.get("children", [])
        if not args.no_lift:
            from roam2logseq.convert import lift_metadata, referenced_uids
            if referenced is None:
                referenced = referenced_uids(roam_pages)
            roam_children, props, lifted, meta_uid = lift_metadata(roam_children, referenced)
            counts["metadata blocks dissolved"] += bool(meta_uid)
            for key, _value in props:
                if key not in page.properties:
                    diffs.append(f"{rel}: lifted property {key!r} missing from page properties"); counts["lifted properties missing"] += 1
            counts["blocks lifted to page properties"] += len(lifted)
        lb = list(logseq_walk(page.children)); rb = list(roam_walk(roam_children))
        template_paths = set()
        for r, rpth in rb:
            if re.search(r"#\[?\[?SmartBlock\]?\]?", r.get("string", ""), re.I):
                template_paths.add(rpth)
        if template_paths and not args.no_lift:
            from roam2logseq.convert import relift_templates
            rb = list(roam_walk(relift_templates(roam_children, referenced)))
        consumed, rb = leading_property_blocks(page, rb, lb)
        counts["blocks that became page properties"] += len(consumed)
        counts["blocks compared"] += min(len(lb), len(rb))
        if len(lb) != len(rb):
            diffs.append(f"{rel}: {len(lb)} blocks vs {len(rb)} in Roam"); counts["pages with block-count mismatch"] += 1
        for (b, pth), (r, rpth) in zip(lb, rb):
            in_template = any(pth[:len(tp)] == tp for tp in template_paths)
            if pth != rpth:
                diffs.append(f"{rel}: nesting differs at {pth} vs Roam {rpth}"); counts["nesting mismatches"] += 1
                break
            # text: map uuids back to Roam uids, strip marker, compare with Roam string minus checkbox
            text = RE_UUID.sub(lambda m: "((" + uuid_to_roam.get(m.group(1), m.group(1)) + "))", b.to_string())
            rs = r.get("string", "")
            if in_template:
                counts["template blocks (text not compared)"] += 1
            elif norm_roam(text) != norm_roam(rs):
                diffs.append(f"{rel} {pth}: {text[:70]!r} != Roam {rs[:70]!r}"); counts["text mismatches"] += 1
            elif code_fences(text) != code_fences(rs):
                diffs.append(f"{rel} {pth}: code block differs: {code_fences(text)[:1]} != Roam {code_fences(rs)[:1]}"); counts["code block mismatches"] += 1
            want = derived_uuid(r["uid"])
            if b.uid != want:
                diffs.append(f"{rel} {pth}: id {b.uid} != derived {want}"); counts["id mismatches"] += 1
            if b.marker and not re.match(r"(\{\{\[\[(TODO|DONE)\]\]\}\}|TODO|DOING|DONE|LATER|NOW)", rs.lstrip("\ufeff \t\n\u00a0")):
                diffs.append(f"{rel} {pth}: marker {b.marker} but Roam has none"); counts["marker mismatches"] += 1
    for rp in roam_pages:
        if id(rp) not in seen_roam and rp.get("children"):
            diffs.append(f"Roam page {rp.get('title')!r} has no Logseq file"); counts["Roam pages missing"] += 1

    print("# verify_graph")
    print(f"pages in graph: {len(graph.pages)}; Roam pages: {len(roam_pages)}")
    for k, v in sorted(counts.items()):
        print(f"- {k}: {v}")
    for d in diffs[:args.show]:
        print("  ", d)
    if len(diffs) > args.show:
        print(f"   ... and {len(diffs) - args.show} more")
    bad = sum(v for k, v in counts.items() if k not in ("blocks compared", "blocks that became page properties", "blocks lifted to page properties", "metadata blocks dissolved", "template blocks (text not compared)"))
    print("RESULT:", "OK" if bad == 0 else f"{bad} problem(s)")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
