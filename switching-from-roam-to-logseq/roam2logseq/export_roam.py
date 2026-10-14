"""Reverse direction: a Logseq file graph back to a Roam JSON export (reversibility.md).

    python3 -m roam2logseq.export_roam GRAPH_DIR OUT.json [--map GRAPH_DIR/roam-uid-map.json]
                                       [--report DIR] [--graph-name NAME]

Every conversion the forward converter applies is undone here, using the sidecar
map written by `roam2logseq.convert` (block uids, Roam metadata, dissolved metadata
blocks, renamed keys, template sources) where it exists and deterministic rules
where it does not:

- ids: `id::` -> the block's Roam uid from the map; a block made in Logseq gets
  `base64url(sha256(uuid))[:9]` (collision-checked); `((uuid))` refs likewise.
- text: task markers -> `{{[[TODO]]}}`/`{{[[DONE]]}}` (DOING/NOW/LATER -> TODO),
  `{{renderer :cb, …}}` -> checkboxes, `{{renderer :rbutton, …}}` -> `{{[[X]]}}`,
  `{{renderer :ankify-active}}` -> the roam/render switch, `{{renderer
  :template-button, C, T}}` -> `{{C:SmartBlock:T}}`, `ankify_logseq:` -> `ankify_roam:`,
  `{{embed x}}` -> `{{[[embed]]: x}}`, `{{name x}}` -> `{{name: x}}` for Roam macros,
  the `Logseq link:` line dropped, `Roam web link:` -> `Web link:`, renamed property
  keys restored, `\\-`/`\\#` escapes removed, `# ` headings -> `"heading"`,
  `logseq.order-list-type:: number` -> `:children/view-type :numbered`,
  `collapsed:: true` -> `"open": false`, template tokens `{%X%}` -> `<%X%>` (exact
  Roam text restored where the block was not edited).
- structure: page properties -> the Roam "metadata" block with its attribute
  children in the original order (from the map; new pages get a fresh one);
  journals -> Roam date titles; option pages renamed back.
- Roam metadata (create-time, edit-time, users, …) restored from the map.

Flagged for hand work (in the report): SCHEDULED/DEADLINE/LOGBOOK, Logseq queries,
local assets, `{{renderer …}}` macros this tool does not know.
"""
import argparse
import base64
import collections
import datetime
import hashlib
import json
import os
import re
import sys

from ankify_logseq.logseq import LogseqGraph
from roam2logseq.convert import (
    ACTIVE_MACRO, OPTION_PREFIX_LOGSEQ, OPTION_PREFIX_ROAM, PROPERTY_KEY_MAP, RE_SMARTBLOCK_TAG,
)
from roam2logseq.normalize_graph import ROAM_MACROS_WITH_COLON, RE_UUID, journal_date_from_path, outside_code

RE_UUID_REF = re.compile(r"\(\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\)")
RE_CB = re.compile(r"\{\{renderer :cb,\s*(todo|done)(?:,\s*[^}]*)?\}\}", re.I)
RE_RBUTTON = re.compile(r"\{\{renderer :rbutton, (.*?)\}\}")   # exactly one space: the label keeps its own
RE_TBUTTON = re.compile(r"\{\{renderer :template-button,\s*([^,}]*),\s*([^}]*)\}\}")
RE_LOGSEQ_LINK_LINE = re.compile(r"(?m)^[ \t]*Logseq link: logseq://\S*[ \t]*\n?")
RE_ROAM_LINK_LABEL = re.compile(r"(?m)^([ \t]*)Roam (web|desktop) link:")
RE_HEADING = re.compile(r"^(#{1,6}) (.*)$", re.S)
RE_ESCAPED_LINE = re.compile(r"(?m)^([ \t]*)\\([-#])")
BOOKKEEPING = {"id", "button-refs", "page-tags", "collapsed", "heading", "template", "template-including-parent", "logseq.order-list-type"}
ROAM_RENDER_SWITCH = '{{[[roam/render]]:((nU1XMzhKA)) "Block UID" }}'
FLAG_PATTERNS = [
    ("SCHEDULED/DEADLINE", re.compile(r"(?m)^\s*(SCHEDULED|DEADLINE):")),
    ("LOGBOOK drawer", re.compile(r":LOGBOOK:")),
    ("Logseq query", re.compile(r"\{\{query\b|#\+BEGIN_QUERY")),
    ("local asset", re.compile(r"\.\./assets/|\(assets/|^assets/")),
    ("unknown renderer macro", re.compile(r"\{\{renderer (?!:cb,|:rbutton,|:ankify-active|:template-button,)")),
]


def roam_uid_for_uuid(uuid, known):
    """Deterministic 9-char Roam uid for a Logseq-born block (reversibility.md §2)."""
    return base64.urlsafe_b64encode(hashlib.sha256(uuid.encode()).digest()).decode()[:9]


def roam_date_title(d):
    day = d.day
    suffix = "th" if 11 <= day % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
    return f"{d.strftime('%B')} {day}{suffix}, {d.year}"


class Exporter:
    def __init__(self, graph, sidecar, graph_name=None):
        self.graph = graph
        self.sidecar = sidecar or {}
        self.graph_name = graph_name
        self.by_uuid = {}
        for e in self.sidecar.get("blocks", []):
            if e.get("logseq_uuid"):
                self.by_uuid[e["logseq_uuid"]] = e
        self.dangling = self.sidecar.get("dangling_refs", {})
        self.page_meta = {p["title"]: p for p in self.sidecar.get("pages", [])}
        self.page_meta_by_logseq = {p["logseq_title"]: p for p in self.sidecar.get("pages", []) if p.get("logseq_title")}
        self.uids_in_use = {e["roam_uid"] for e in self.sidecar.get("blocks", [])}
        self.new_uids = {}
        self.counts = collections.Counter()
        self.flags = []

    # ---------------------------------------------------------------- uids
    def uid_for(self, uuid):
        e = self.by_uuid.get(uuid)
        if e:
            return e["roam_uid"]
        if uuid in self.dangling:
            return self.dangling[uuid]
        if uuid in self.new_uids:
            return self.new_uids[uuid]
        uid = roam_uid_for_uuid(uuid, self.uids_in_use)
        n = 0
        while uid in self.uids_in_use:
            n += 1
            uid = roam_uid_for_uuid(uuid + f"#{n}", self.uids_in_use)
            self.counts["uid collisions resolved"] += 1
        self.uids_in_use.add(uid)
        self.new_uids[uuid] = uid
        self.counts["new blocks (Logseq-born)"] += 1
        return uid

    # ---------------------------------------------------------------- text
    def back_text(self, text, entry):
        """Roam string for a Logseq block's text (properties already removed)."""
        for key, value in (entry or {}).get("renamed_keys", []) or []:
            text = re.sub(r"(?m)^" + re.escape(value) + "::", key + "::", text, count=1)

        ra = (entry or {}).get("roam_render_active")
        sources_holder = ra if isinstance(ra, list) else []
        def conv(t):
            t = RE_CB.sub(lambda m: "{{[[%s]]}}" % m.group(1).upper(), t)
            t = RE_RBUTTON.sub(lambda m: "{{%s}}" % m.group(1), t)
            sources = list(sources_holder)
            while ACTIVE_MACRO in t:
                t = t.replace(ACTIVE_MACRO, sources.pop(0) if sources else ROAM_RENDER_SWITCH, 1)
            t = RE_TBUTTON.sub(lambda m: "{{%s:SmartBlock:%s}}" % (m.group(1).strip(), m.group(2).strip()), t)
            t = t.replace("[[" + OPTION_PREFIX_LOGSEQ, "[[" + OPTION_PREFIX_ROAM)
            bracketed = set((entry or {}).get("bracket_macros") or ([] if entry else ["embed"]))
            def macro_back(m):
                name = m.group(1)
                return ("{{[[%s]]: " if name in bracketed else "{{%s: ") % name
            t = re.sub(r"\{\{(" + "|".join(re.escape(m) for m in ROAM_MACROS_WITH_COLON) + r")\s+", macro_back, t)
            t = RE_UUID_REF.sub(lambda m: "((" + self.uid_for(m.group(1)) + "))", t)
            t = re.sub(r"\{%([A-Z]+)((?::(?:(?!\{%|%\}).)*)?)%\}", r"<%\1\2%>", t, flags=re.S)
            t = t.replace("<% current page %>", "<%CURRENTPAGENAME%>").replace("<% today %>", "<%DATE%>")
            return t
        text = outside_code(text, conv)
        text = RE_LOGSEQ_LINK_LINE.sub("", text)
        text = RE_ROAM_LINK_LABEL.sub(lambda m: m.group(1) + m.group(2).capitalize() + " link:", text)
        text = RE_ESCAPED_LINE.sub(r"\1\2", text)
        return text

    def flag(self, page_title, text, uid):
        for label, pat in FLAG_PATTERNS:
            if pat.search(text):
                self.flags.append(f"{label}: page {page_title!r} block {uid}: {text[:60]!r}")
                self.counts["flagged: " + label] += 1

    # ---------------------------------------------------------------- blocks
    def export_block(self, b, page_title, numbered_children=False):
        entry = self.by_uuid.get(b.uid) if b.uid else None
        uid = self.uid_for(b.uid) if b.uid else self.uid_for("noid-" + page_title + "-" + b.to_string()[:40])
        text = b.content.to_string() if b.content else ""
        present = {l.split("::", 1)[0].strip().lower() for l in text.split("\n") if "::" in l}
        marker = b.marker
        # a `# ` prefix the converter added for Roam's heading level (or a heading made
        # in Logseq) becomes "heading"; a literal `#` line from Roam (meta heading 0) stays
        heading = None
        m = RE_HEADING.match(text)
        if m and ((entry or {}).get("roam", {}).get("heading") or not entry):
            heading = len(m.group(1)); text = m.group(2)
        if marker in ("TODO", "DONE"):
            text = "{{[[%s]]}} %s" % (marker, text)
        elif marker in ("DOING", "NOW", "LATER", "WAITING", "IN-PROGRESS"):
            text = "{{[[TODO]]}} " + text
        elif marker == "CANCELED" or marker == "CANCELLED":
            text = "{{[[cancled]]}} " + text
        if entry and entry.get("template_source") is not None and (b.content.to_string() if b.content else "") == entry.get("template_text"):
            text = entry["template_source"]      # template block untouched since conversion: exact Roam text
            self.counts["template blocks restored verbatim"] += 1
        else:
            text = self.back_text(text, entry)
        # properties that are Roam attributes in spirit stay as text lines
        extra = []
        for k, v in b.properties.items():
            if k in BOOKKEEPING or k.lower() in present:
                continue  # a `key:: value` first line stays in the content; do not repeat it
            extra.append(f"{k}:: {v}")
        if extra and not (entry and entry.get("template_property_block")):
            text = (text + "\n" if text else "") + "\n".join(extra)
        if entry and entry.get("template_property_block"):
            return None   # handled by the template root (template_metadata), see below
        self.flag(page_title, text, uid)
        out = {"string": text, "uid": uid}
        if entry:
            for k, v in (entry.get("roam") or {}).items():
                out[k] = v          # Roam's own metadata, verbatim (heading, view-type, open, times, users)
        if heading and out.get("heading", 0) != heading:
            out["heading"] = heading
        if entry and entry.get("literal_property_line") and not text.strip():
            text = entry["literal_property_line"]; out["string"] = text   # a Roam block that *was* `collapsed:: true` as text
        collapsed = str(b.properties.get("collapsed", "")).lower() == "true" and not (entry and entry.get("literal_property_line"))
        if collapsed and out.get("open", True) is not False:
            out["open"] = False
        elif not collapsed and out.get("open") is False and entry:
            out["open"] = True   # was collapsed in Roam, opened in Logseq
        tm = (entry or {}).get("template_metadata")
        if tm:
            # a template root whose metadata block was dissolved: rebuild it from the
            # record, with the property block's values and the moved children
            prop_block = next((c for c in b.children if self.by_uuid.get(c.uid, {}).get("template_property_block")), None)
            rest = [c for c in b.children if c is not prop_block]
            saved = getattr(self, "_used_top", set())
            meta = self.rebuild_metadata_from_record(tm, prop_block, page_title, rest)
            used = self._used_top
            self._used_top = saved
            kids = [meta] + [self.export_block(c, page_title) for c in rest if not (c.uid and self.uid_for(c.uid) in used)]
        else:
            kids = [k for k in (self.export_block(c, page_title) for c in b.children) if k is not None]
        numbered = bool(b.children) and all(str(c.properties.get("logseq.order-list-type", "")) == "number" for c in b.children)
        if numbered and out.get(":children/view-type") != ":numbered":
            out[":children/view-type"] = ":numbered"
        elif not numbered and out.get(":children/view-type") == ":numbered" and b.children:
            out.pop(":children/view-type", None)
        if kids:
            out["children"] = kids
        self.counts["blocks"] += 1
        return out

    def rebuild_metadata_from_record(self, rec, prop_block, page_title, top_blocks=None):
        """The Roam "metadata" block from a sidecar record: lifted attributes back as
        child blocks (current property values win over the recorded ones), children
        that had been moved up re-nested where they were."""
        lifted = {r["roam_uid"]: r for r in rec.get("lifted", [])}
        moved = {}
        if top_blocks is not None:
            by_uid = {self.uid_for(t.uid): t for t in top_blocks if t.uid}
            moved = by_uid
        children = []
        used = set()
        if prop_block is not None and not hasattr(prop_block, "properties"):
            prop_block = None
        for uid in rec.get("children_in_order", []):
            r = lifted.get(uid)
            if r:
                key = r["key"]
                orig = (r.get("roam") or {}).get("string", "")
                cur = prop_block.properties.get(key) if prop_block is not None else None
                om = re.match(r"^(.*?)(::?)[ \t]*(.*)$", orig, re.S)
                orig_key, sep, orig_val = (om.group(1), om.group(2), om.group(3).strip()) if om else (key, "::", "")
                if cur is not None and str(cur) != "" and str(cur) != orig_val:
                    string = f"{orig_key}{sep} {self.back_text(str(cur), None)}"
                    self.counts["metadata values updated from Logseq"] += 1
                else:
                    string = orig
                blk = {"string": string, "uid": uid}
                for k, v in (r.get("roam") or {}).items():
                    if k not in ("string", "uid"):
                        blk[k] = v
                kids = []
                for cu in r.get("children", []):
                    t = moved.get(cu)
                    if t is not None:
                        kids.append(self.export_block(t, page_title)); used.add(cu)
                if kids:
                    blk["children"] = kids
                children.append(blk)
                self.counts["blocks"] += 1
            else:
                t = moved.get(uid)
                if t is not None:
                    children.append(self.export_block(t, page_title)); used.add(uid)
        meta = {"string": (rec.get("roam") or {}).get("string", "metadata"), "uid": rec["roam_uid"]}
        for k, v in (rec.get("roam") or {}).items():
            if k not in ("string", "uid"):
                meta[k] = v
        if children:
            meta["children"] = children
        self.counts["metadata blocks rebuilt"] += 1
        self._used_top = used
        return meta

    # ---------------------------------------------------------------- pages
    def export_page(self, page):
        if page.is_journal:
            d = journal_date_from_path(page.path)
            title = roam_date_title(d) if d else page.title
        else:
            title = page.properties.get("title", page.title)
        pm = self.page_meta_by_logseq.get(title) or self.page_meta.get(title)
        if pm and pm.get("logseq_title") == title:
            title = pm["title"]
        out = {"title": title}
        if pm:
            for k, v in pm.items():
                if k not in ("title", "logseq_title", "metadata", "lifted", "dropped_metadata_block"):
                    out[k] = v
        page_props = {k: v for k, v in page.properties.items() if k not in ("title",) and k not in BOOKKEEPING}
        children = []
        self._used_top = set()
        rec = pm.get("metadata") if pm else None
        if rec:
            fake = type("P", (), {"properties": page_props})()
            children.append(self.rebuild_metadata_from_record(rec, fake, title, page.children))
        elif page_props:
            # a page made in Logseq: its properties become a Roam metadata block
            kids = [{"string": f"{k}:: {self.back_text(str(v), None)}", "uid": self.uid_for("prop-" + title + "-" + k)} for k, v in page_props.items()]
            children.append({"string": "metadata", "uid": self.uid_for("meta-" + title), "children": kids})
            self.counts["metadata blocks created for Logseq-born pages"] += 1
        for b in page.children:
            if b.uid and self.uid_for(b.uid) in self._used_top:
                continue
            children.append(self.export_block(b, title))
        if children:
            out["children"] = children
        self.counts["pages"] += 1
        return out

    def run(self):
        pages = []
        for page in self.graph.pages:
            if os.path.basename(page.path) == "contents.md" and not any(b.to_string().strip() for b in page.children):
                continue
            pages.append(self.export_page(page))
        # Roam pages that had no blocks (no file in Logseq) come back from the map
        have = {p["title"] for p in pages}
        for pm in self.sidecar.get("pages", []):
            if pm["title"] not in have and pm.get("uid"):
                pages.append({k: v for k, v in pm.items() if k not in ("logseq_title", "metadata")})
                self.counts["pages restored from the map (no file)"] += 1
        return pages

    def report(self):
        lines = ["# export_roam report", ""] + [f"- {k}: {v}" for k, v in sorted(self.counts.items())]
        if self.flags:
            lines += ["", "## Flagged for hand work"] + [f"- {f}" for f in self.flags]
        return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("graph_dir")
    ap.add_argument("out_json")
    ap.add_argument("--map", default=None)
    ap.add_argument("--report", default=None)
    ap.add_argument("--graph-name", default=None)
    args = ap.parse_args(argv)
    graph = LogseqGraph.from_path(args.graph_dir)
    from roam2logseq.sidecar import sidecar_path, load_sidecar
    map_path = sidecar_path(args.graph_dir, args.map)
    sidecar = {}
    if os.path.exists(map_path):
        sidecar = load_sidecar(map_path)
    else:
        print(f"WARNING: no sidecar map at {map_path}; every block gets a derived uid and no Roam metadata")
    ex = Exporter(graph, sidecar, graph_name=args.graph_name)
    pages = ex.run()
    with open(args.out_json, "w", encoding="utf-8") as f:
        json.dump(pages, f, ensure_ascii=False)
    rep = ex.report()
    print(rep)
    rep_dir = args.report or os.path.dirname(os.path.abspath(args.out_json))
    os.makedirs(rep_dir, exist_ok=True)
    with open(os.path.join(rep_dir, "export-roam-report.md"), "w", encoding="utf-8") as f:
        f.write(rep)
    print(f"Wrote {len(pages)} pages to {args.out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
