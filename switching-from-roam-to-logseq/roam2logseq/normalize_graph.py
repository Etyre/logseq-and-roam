"""Normalize a freshly imported Logseq graph, with Logseq closed.

    python3 -m roam2logseq.normalize_graph GRAPH_DIR FIXED_ROAM.json \\
        [--map roam-uid-map.json] [--report report.md] [--dry-run] [--journal-format "MMMM do, yyyy"]

What it does (see ../import-issues.md §0 and ../reversibility.md):

1. Parses the graph as the Roam importer wrote it (ankify_logseq's parser reads that
   layout faithfully; Logseq itself does not).
2. Pairs every Logseq page/block with its Roam page/block from the fixed export, by
   page title and tree position, checking the text matches. Pages that do not line
   up are reported and left untouched.
3. Gives every block a persisted id derived from its Roam uid,
   `uuid5(NAMESPACE, roam_uid)`, and rewrites every `((uuid))` reference and embed the
   importer created so it points at the derived id.
4. Rewrites every file in Logseq's native layout (serialize.py) atomically.
5. Writes the sidecar map: for every block, roam uid, logseq uuid, page, tree path,
   and all Roam metadata the file cannot hold (timestamps, emails, heading, ...).
6. Sets `:journal/page-title-format` in logseq/config.edn.

Refuses to run while a Logseq process exists. After running, Logseq must
**Re-index** the graph (its cache predates the normalization).
"""
import argparse
import collections
import datetime
import json
import os
import re
import sys
import tempfile
import uuid as uuidlib

from ankify_logseq.logseq import LogseqGraph
from ankify_logseq.logseq.api import logseq_process_running
from roam2logseq.serialize import page_text

# Fixed namespace so derived ids are reproducible anywhere: uuid5 of a constant URL.
NAMESPACE = uuidlib.uuid5(uuidlib.NAMESPACE_URL, "https://github.com/Etyre/ankify_logseq/roam-uid")
ROAM_META_SKIP = {"string", "children", "uid", "_from_metadata"}   # the last is the converter's own scratch flag
RE_UUID = re.compile(r"\(\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)")
RE_ROAM_DATE = re.compile(r"^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(?:st|nd|rd|th), (\d{4})$")
RE_PROP_LINE = re.compile(r"^[A-Za-z0-9_.\-]+:: ?")
MARKER_WORDS = r"(?:TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)"
ROAM_ONLY_SYNTAX = re.compile(r"\(\(|\{\{\[\[|\{\{[\w\-/]+:")   # refs, {{[[x]]...}}, {{name: ...}}


def derived_uuid(roam_uid):
    return str(uuidlib.uuid5(NAMESPACE, roam_uid))


def norm_text(s):
    """Canonical form shared by Roam strings and Logseq block text, for pairing.

    Covers every transformation the Roam importer applies (and Logseq's reading):
    checkbox macros become task markers, `{{name: x}}` / `{{[[name]]: x}}` become
    `{{name x}}`, refs are rewritten to uuids, a newline is put before a closing
    code fence, BOMs are dropped, whitespace is collapsed.
    """
    s = s.replace("﻿", "")
    s = s.replace("[[ankify_logseq:", "[[ankify_roam:")                      # option-tag prefix renamed by the converter
    s = s.replace("Automated transcript from otter", "Automated transcirpt from otter").replace("[[Transcript]]", "[[Transcricpt]]").replace("Recording Metadata", "Recroding Metadata")  # spelling fixes (Otter pages)
    s = re.sub(r"\{\{\[\[(TODO|DONE)\]\]\}\}", r" \1 ", s)              # Roam checkbox -> marker word
    s = re.sub(r"\{\{renderer :cb,[^}]*\}\}", " ", s)                     # inline-checkbox macro (converter output)
    s = re.sub(r'\{\{\[\[roam/render\]\]:\s*[(<]{2,}[\w\-]+[)>]{2,}[^}]*"Block UID"[^}]*\}\}', " ANKIFY-ACTIVE ", s)  # Roam switch (verify_graph has <<uid>> refs)
    s = re.sub(r"\{\{renderer :ankify-active\}\}", " ANKIFY-ACTIVE ", s)   # its Logseq form (converter output)
    s = re.sub(r"\{\{renderer :rbutton, (\[\[[^{}]*?\]\]|[^{}]*?)\}\}", r"{{\1}}", s)  # Roam buttons (converter output)
    s = re.sub(r'\{\{roam/render\s+[(<]{2,}[\w\-]+[)>]{2,}[^}]*"Block UID"[^}]*\}\}', " ANKIFY-ACTIVE ", s)  # importer's form (staging graph)
    s = re.sub(MARKER_WORDS, " ", s)                                    # marker words dropped on both sides (also glued: TODORead, DONEDONE)
    s = re.sub(r"^\s*(collapsed|heading|id|button-refs|page-tags):: .*$", "", s, flags=re.M)  # Logseq bookkeeping properties are not content
    s = re.sub(r"^\s*Logseq link: logseq://\S*$", "", s, flags=re.M)     # Part III link lines added by the converter
    s = re.sub(r"(?m)^(\s*)Roam (web|desktop) link:", lambda m: m.group(1) + m.group(2).capitalize() + " link:", s)  # relabelled Roam lines
    s = re.sub(r"\{\{\[\[([^\]]+)\]\]:\s*", r"{{\1 ", s)               # {{[[embed]]: x}} -> {{embed x}}
    s = re.sub(r"\{\{([\w\-/]+):\s*", r"{{\1 ", s)                     # {{embed: x}} -> {{embed x}}
    s = re.sub(r"\(\(+[^()]+\)\)+", "((REF))", s)                       # refs/embeds: uid vs uuid
    s = re.sub(r"\s*```\s*", "```", s)                                  # whitespace around code fences
    s = re.sub(r"^\s*#+\s+", "", s)                                     # heading markers
    return re.sub(r"[\s ]+", " ", s).strip()


def collapse_ws(title):
    return re.sub(r"\s+", " ", title).strip()


ROAM_MACROS_WITH_COLON = ("embed", "embed-path", "embed-children", "iframe", "alias", "query", "youtube",
                          "video", "pdf", "mentions", "or", "attr-table", "roam/render", "calc", "count")
RE_ROAM_REF = re.compile(r"\(\(([\w\-]{9,40})\)\)")   # exactly two parens each side: a stray third `)` is text (fixer already reduced ((((x)))) embeds)


RE_INLINE_CODE_SPAN = re.compile(r"(?<!`)`[^`\n]+`(?!`)")


def outside_code(s, fn):
    """Apply fn to the parts of s that are outside fenced code blocks and inline code
    spans; code is left byte-for-byte as Roam had it."""
    fenced = s.split("```")
    for i in range(0, len(fenced), 2):
        pieces, pos = [], 0
        for m in RE_INLINE_CODE_SPAN.finditer(fenced[i]):
            pieces.append(fn(fenced[i][pos:m.start()])); pieces.append(m.group(0)); pos = m.end()
        pieces.append(fn(fenced[i][pos:]))
        fenced[i] = "".join(pieces)
    return "```".join(fenced)


def roam_to_logseq_text(s, uuid_for_uid):
    """What the Roam importer would produce for a block string, done deliberately and
    only outside code: checkbox macros -> marker words, `{{[[name]]: x}}` and known
    `{{name: x}}` -> `{{name x}}`, `((uid))` -> `((uuid))`, BOM dropped.
    Returns (marker, text)."""
    s = s.replace("\ufeff", "")
    def conv(t):
        t = re.sub(r"\{\{\[\[(TODO|DONE)\]\]\}\}(?=\S)", r"\1 ", t)   # glued `{{[[TODO]]}}Read`: a marker needs the space
        t = re.sub(r"\{\{\[\[(TODO|DONE)\]\]\}\}", r"\1", t)
        t = re.sub(r"\{\{\[\[([^\]]+)\]\]:\s*", r"{{\1 ", t)
        t = re.sub(r"\{\{(" + "|".join(re.escape(m) for m in ROAM_MACROS_WITH_COLON) + r"):\s*", r"{{\1 ", t)
        return RE_ROAM_REF.sub(lambda m: "((" + uuid_for_uid(m.group(1)) + "))", t)
    s = outside_code(s, conv)
    # Logseq trims block content (leading whitespace and blank lines, trailing
    # whitespace); do the same so the file equals what Logseq would write back
    s = s.lstrip(" \t\n\r").rstrip()
    marker = None
    m = re.match(r"^(TODO|DONE)(?:\s+|$)", s)
    if m:
        marker, s = m.group(1), s[m.end():]
    return marker, s


def build_blocks_from_roam(blocks, uuid_for_uid, graph=None):
    """ankify_logseq Block tree for a Roam block list (used when the importer's file is
    missing or unusable)."""
    from ankify_logseq.logseq import Block, BlockContent
    out = []
    for r in blocks:
        marker, text = roam_to_logseq_text(r.get("string", ""), uuid_for_uid)
        b = Block(content=BlockContent.from_string(text, graph=graph), uid=derived_uuid(r["uid"]), marker=marker, graph=graph)
        b.children.extend(build_blocks_from_roam(r.get("children", []), uuid_for_uid, graph))
        for c in b.children:
            c.parent = b
        out.append(b)
    return out


def title_to_filename(title):
    """Logseq's triple-lowbar file name for a page title (frontend.util.fs)."""
    t = collapse_ws(title)
    t = re.sub(r"(?i)%[0-9a-f]{2}", lambda m: "%25" + m.group(0)[1:], t)
    t = re.sub(r'[:\\*?"<>|#]', lambda m: "%%%02X" % ord(m.group(0)), t)
    if t.startswith("."):
        t = "%2E" + t[1:]
    t = t.replace("___", "%5F%5F%5F").replace("_/", "%5F/").replace("/_", "/%5F").replace("/", "___")
    return t + ".md"


def code_fences(s):
    """Contents of fenced code blocks, exact except trailing whitespace per line."""
    parts = s.split("```")
    return ["\n".join(l.rstrip() for l in p.split("\n")).strip("\n") for p in parts[1::2]]


RE_INLINE_CODE = re.compile(r"(?<!`)`([^`\n]+)`(?!`)")


def inline_code(s):
    """Contents of inline code spans (outside fenced blocks)."""
    return [m.group(1) for part in s.split("```")[0::2] for m in RE_INLINE_CODE.finditer(part)]


def repair_inline_code_from_roam(logseq_text, roam_text):
    """Same as repair_code_from_roam, for `inline code`: the importer rewrites
    macros inside it too. Returns the repaired text or None if spans don't line up."""
    lp, rp = logseq_text.split("```"), roam_text.split("```")
    if len(lp) != len(rp):
        return None
    for i in range(0, len(lp), 2):
        lspans = list(RE_INLINE_CODE.finditer(lp[i])); rspans = list(RE_INLINE_CODE.finditer(rp[i]))
        if len(lspans) != len(rspans):
            return None
        out, pos = [], 0
        for lm, rm in zip(lspans, rspans):
            out.append(lp[i][pos:lm.start()]); out.append("`" + rm.group(1) + "`"); pos = lm.end()
        out.append(lp[i][pos:]); lp[i] = "".join(out)
    return "```".join(lp)


def repair_code_from_roam(logseq_text, roam_text):
    """The Roam importer rewrites `{{name: x}}` macros even inside fenced code, which
    damages source code. Put Roam's fence contents back, keeping Logseq's text
    outside the fences. Returns the repaired text, or None if the fences don't line up."""
    lp, rp = logseq_text.split("```"), roam_text.split("```")
    if len(lp) != len(rp) or len(lp) < 3:
        return None
    for i in range(1, len(lp), 2):
        seg = rp[i]
        if not seg.endswith("\n"):
            seg += "\n"  # Logseq needs the closing fence on its own line
        lp[i] = seg
    return "```".join(lp)


def roam_walk(blocks, path=()):
    for i, b in enumerate(blocks):
        p = path + (i,)
        yield b, p
        yield from roam_walk(b.get("children", []), p)


def logseq_walk(blocks, path=()):
    for i, b in enumerate(blocks):
        p = path + (i,)
        yield b, p
        yield from logseq_walk(b.children, p)


def roam_title_date(title):
    m = RE_ROAM_DATE.match(title.strip())
    if not m:
        return None
    try:
        return datetime.datetime.strptime(f"{m.group(1)} {int(m.group(2))} {m.group(3)}", "%B %d %Y").date()
    except ValueError:
        return None


def journal_date_from_path(path):
    body = os.path.splitext(os.path.basename(path))[0]
    try:
        return datetime.datetime.strptime(body, "%Y_%m_%d").date()
    except ValueError:
        return None


def leading_property_blocks(page, rb, lb):
    """Roam blocks at the top of a page of the form `key:: value` (no children) that
    Logseq turned into page properties, so they exist as no block. Returns
    (consumed_roam_blocks, remaining rb with paths shifted)."""
    consumed = []
    while len(rb) > len(lb) and rb and len(rb[0][1]) == 1:
        r = rb[0][0]
        s = r.get("string", "")
        if not RE_PROP_LINE.match(s) or r.get("children") or s.split("::", 1)[0] not in page.properties:
            break
        consumed.append(rb.pop(0)[0])
        rb = [(x, (pth[0] - 1,) + pth[1:]) for x, pth in rb]
    return consumed, rb


class Normalizer:
    def __init__(self, graph_dir, roam_pages, dry_run=False):
        self.graph_dir = graph_dir
        self.roam_pages = roam_pages
        self.dry_run = dry_run
        self.counts = collections.Counter()
        self.problems = []
        self.map = []          # sidecar entries
        self.notes = []
        self.uuid_rewrite = {} # importer uuid -> derived uuid
        self.assigned = {}     # id(block) -> derived uuid
        self.ref_targets = {}  # importer uuid -> Roam uid, learned from refs (incl. dangling ones)
        self.rebuilt = []      # pages (re)built from the Roam export

    # -------------------------------------------------------------- pairing

    def index_roam(self):
        by_title = {}
        by_date = {}
        for p in self.roam_pages:
            t = p.get("title", "")
            by_title[t] = p
            by_title.setdefault(t.lower(), p)
            by_title.setdefault(("collapsed", collapse_ws(t).lower()), p)
            if "\n" in t:
                by_title.setdefault(t.split("\n", 1)[0].strip(), p)  # what the importer used as the title
            d = roam_title_date(t)
            if d:
                by_date[d] = p
        return by_title, by_date

    def pair_page(self, page, by_title, by_date):
        if page.is_journal:
            d = journal_date_from_path(page.path)
            rp = by_date.get(d) if d else None
            if rp is None:
                rp = by_title.get(page.title) or by_title.get(page.title.lower())
        else:
            title = page.properties.get("title", page.title)
            rp = by_title.get(title) or by_title.get(title.lower()) \
                or by_title.get(("collapsed", collapse_ws(title).lower()))
        return rp

    def pair_blocks(self, page, roam_page):
        """Return [(block_or_None, roam_block, path)] or raise ValueError on mismatch.
        block is None for Roam blocks that became page properties."""
        lb = list(logseq_walk(page.children))
        rb = list(roam_walk(roam_page.get("children", [])))
        consumed, rb = leading_property_blocks(page, rb, lb)
        if len(lb) != len(rb):
            raise ValueError(f"{len(lb)} blocks in Logseq vs {len(rb)} in Roam")
        pairs = [(None, r, ("page-properties",)) for r in consumed]
        from ankify_logseq.logseq import BlockContent
        for (b, pth), (r, rpth) in zip(lb, rb):
            # learn which importer uuid stands for which Roam uid (also for refs to
            # blocks that no longer exist, which the map of persisted ids cannot tell)
            lrefs = RE_UUID.findall(b.to_string()); rrefs = RE_ROAM_REF.findall(r.get("string", ""))
            if len(lrefs) == len(rrefs):
                for u, ru in zip(lrefs, rrefs):
                    self.ref_targets.setdefault(u, ru)
            if pth != rpth:
                raise ValueError(f"tree shape differs at {pth} vs {rpth}")
            ltext, rtext = b.to_string(), r.get("string", "")
            if "```" in rtext and code_fences(ltext) != code_fences(rtext):
                repaired = repair_code_from_roam(ltext, rtext)
                if repaired is not None and norm_text(repaired) == norm_text(rtext):
                    b.content = BlockContent.from_string(repaired, graph=b.graph)
                    ltext = repaired
                    self.counts["code blocks repaired from Roam"] += 1
            if "`" in rtext and inline_code(ltext) != inline_code(rtext):
                repaired = repair_inline_code_from_roam(ltext, rtext)
                if repaired is not None:
                    b.content = BlockContent.from_string(repaired, graph=b.graph)
                    ltext = repaired
                    self.counts["inline code spans repaired from Roam"] += 1
            if norm_text(ltext) != norm_text(rtext):
                # The importer also strips the colon of any `{{x: y}}`-looking text (e.g. a
                # Go template `{{- $x := 1 -}}`). If colons are the only difference and the
                # Roam text has no Roam-only syntax to translate, restore it verbatim.
                if norm_text(ltext).replace(":", "") == norm_text(rtext).replace(":", "") and not ROAM_ONLY_SYNTAX.search(rtext):
                    b.content = BlockContent.from_string(rtext, graph=b.graph)
                    ltext = rtext
                    self.counts["blocks restored verbatim from Roam"] += 1
                else:
                    raise ValueError(f"text differs at {pth}: {ltext[:60]!r} vs {rtext[:60]!r}")
            pairs.append((b, r, pth))
        return pairs

    # -------------------------------------------------------------- main

    def run(self):
        if logseq_process_running():
            raise SystemExit("Refusing to run while a Logseq process is running. Quit Logseq first.")
        graph = LogseqGraph.from_path(self.graph_dir)
        by_title, by_date = self.index_roam()
        seen_uids = collections.Counter(b["uid"] for rp in self.roam_pages for b, _ in roam_walk(rp.get("children", [])))
        dups = [u for u, n in seen_uids.items() if n > 1]
        if dups:
            self.counts["duplicate Roam uids"] = len(dups)
            self.problems.append(f"duplicate Roam uids in the export (Logseq keeps only one id per uuid): {dups[:10]}")
        plan = []
        matched_roam = set()
        for page in graph.pages:
            if os.path.basename(page.path) == "contents.md" and not any(b.to_string().strip() for b in page.children):
                continue  # Logseq's own Contents page, created empty by the importer
            rp = self.pair_page(page, by_title, by_date)
            if rp is None:
                self.problems.append(f"no Roam page for {os.path.relpath(page.path, self.graph_dir)} (title {page.title!r})")
                self.counts["pages without a Roam match"] += 1
                continue
            if id(rp) in matched_roam:
                # a second file for the same Roam page (e.g. a title differing only in
                # unusual whitespace): the Roam page is the source of truth, one file is enough
                self.counts["duplicate page files removed"] += 1
                self.notes.append(f"removed duplicate file {os.path.relpath(page.path, self.graph_dir)} (same page as another file)")
                if not self.dry_run:
                    os.remove(page.path)
                continue
            matched_roam.add(id(rp))
            try:
                pairs = self.pair_blocks(page, rp)
            except ValueError as e:
                self.counts["pages rebuilt from Roam (importer output unusable)"] += 1
                self.rebuilt.append((page.path, rp, f"{os.path.relpath(page.path, self.graph_dir)}: {e}", page))
                continue
            plan.append((page, rp, pairs))
        for rp in self.roam_pages:
            if id(rp) not in matched_roam and rp.get("children"):
                self.counts["pages rebuilt from Roam (no Logseq file)"] += 1
                d = roam_title_date(rp.get("title", ""))
                path = os.path.join(self.graph_dir, "journals", d.strftime("%Y_%m_%d") + ".md") if d else \
                    os.path.join(self.graph_dir, "pages", title_to_filename(rp.get("title", "")))
                self.rebuilt.append((path, rp, None, None))
        for path, rp, why, page in self.rebuilt:
            from ankify_logseq.logseq import Page
            if why:
                self.notes.append(f"rebuilt from Roam: {why}")
            newpage = Page(title=collapse_ws(rp.get("title", "")), path=path, is_journal=path.startswith(os.path.join(self.graph_dir, "journals")))
            newpage.front_matter = not newpage.is_journal
            if not newpage.is_journal:
                newpage.properties["title"] = newpage.title
            newpage.children.extend(build_blocks_from_roam(rp.get("children", []), lambda uid: derived_uuid(uid), graph))
            newpage.propagate_parents()
            pairs = [(b, r, pth) for (b, pth), (r, _) in zip(logseq_walk(newpage.children), roam_walk(rp.get("children", [])))]
            plan.append((newpage, rp, pairs))

        # assign derived uuids, remember importer uuids to rewrite
        for page, rp, pairs in plan:
            collapsed = collapse_ws(rp.get("title", ""))
            if not page.is_journal and page.properties.get("title", page.title) != collapsed:
                page.properties["title"] = collapsed  # a title the importer truncated at a newline
                self.counts["page titles repaired"] += 1
            for b, r, pth in pairs:
                if b is None:
                    self.map.append({"roam_uid": r["uid"], "logseq_uuid": None, "page": rp.get("title"),
                                     "path": ["page-properties"],
                                     "roam": {k: v for k, v in r.items() if k not in ROAM_META_SKIP}})
                    self.counts["blocks that became page properties"] += 1
                    continue
                new = derived_uuid(r["uid"])
                self.assigned[id(b)] = new
                if b.uid and b.uid != new:
                    self.uuid_rewrite[b.uid] = new
                entry = {"roam_uid": r["uid"], "logseq_uuid": new, "page": rp.get("title"), "path": list(pth)}
                if re.match(r"^(TODO|DOING|DONE|LATER|NOW)(\s|$)", r.get("string", "")):
                    entry["literal_marker"] = True  # plain text in Roam, a task marker in Logseq
                meta = {k: v for k, v in r.items() if k not in ROAM_META_SKIP}
                if meta:
                    entry["roam"] = meta
                self.map.append(entry)
        # refs whose target is not a block in the export (deleted in Roam): give them the
        # derived id of the Roam uid too, so they stay stable and reversible
        dangling = {}
        known = set(self.assigned.values())
        for u, ru in self.ref_targets.items():
            if u not in self.uuid_rewrite:
                self.uuid_rewrite[u] = derived_uuid(ru)
                if derived_uuid(ru) not in known:
                    dangling[derived_uuid(ru)] = ru
        self.dangling = dangling
        self.counts["dangling refs mapped"] = len(dangling)
        self.counts["blocks mapped"] = len(self.map)
        self.counts["importer uuids rewritten"] = len(self.uuid_rewrite)

        # rewrite refs/embeds in every block's content, then serialize
        for page, rp, pairs in plan:
            for b, r, pth in pairs:
                if b is not None:
                    self._rewrite_refs(b)
            text = page_text(page, uuid_for=lambda blk: self.assigned.get(id(blk), blk.uid))
            try:
                with open(page.path, encoding="utf-8") as f:
                    unchanged = f.read() == text
            except OSError:
                unchanged = False
            if unchanged:
                self.counts["pages already normalized"] += 1
                continue
            if not self.dry_run:
                _atomic_write(page.path, text)
            self.counts["pages rewritten"] += 1
        return graph

    def _rewrite_refs(self, block):
        from ankify_logseq.logseq import BlockContent
        s = block.to_string()
        new = RE_UUID.sub(lambda m: "((" + self.uuid_rewrite.get(m.group(1), m.group(1)) + "))", s)
        if new != s:
            block.content = BlockContent.from_string(new, graph=block.graph)
            self.counts["blocks with rewritten refs"] += 1

    def report(self):
        lines = ["# normalize_graph report", ""]
        for k, v in sorted(self.counts.items()):
            lines.append(f"- {k}: {v}")
        if self.notes:
            lines += ["", "## Notes"] + [f"- {n}" for n in self.notes]
        if self.problems:
            lines += ["", "## Problems (pages left untouched)"] + [f"- {p}" for p in self.problems]
        return "\n".join(lines) + "\n"


def set_journal_format(graph_dir, fmt):
    path = os.path.join(graph_dir, "logseq", "config.edn")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    # drop every existing (uncommented) occurrence, then insert one after the opening brace
    text = re.sub(r'(?m)^[ \t]*:journal/page-title-format\s+"[^"]*"[ \t]*\n', "", text)
    text = re.sub(r'\{[ \t]*:journal/page-title-format\s+"[^"]*"[ \t]*\n', "{", text)
    text = text.replace("{", "{:journal/page-title-format \"%s\"\n " % fmt, 1)
    _atomic_write(path, text)


def _atomic_write(path, text):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".norm_", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("graph_dir")
    ap.add_argument("roam_json", help="the FIXED Roam export that was imported")
    ap.add_argument("--map", default=None, help="sidecar uid map output (default: GRAPH_DIR/roam-uid-map.json.gz)")
    ap.add_argument("--report", default=None)
    ap.add_argument("--dry-run", action="store_true", help="pair and report, write nothing")
    ap.add_argument("--journal-format", default="MMMM do, yyyy")
    args = ap.parse_args(argv)
    with open(args.roam_json, encoding="utf-8") as f:
        roam_pages = json.load(f)
    n = Normalizer(os.path.abspath(args.graph_dir), roam_pages, dry_run=args.dry_run)
    n.run()
    if not args.dry_run:
        # the .gz name every reader prefers (sidecar.sidecar_path); the plain name left a stale .gz in charge
        from roam2logseq import sidecar
        map_path = args.map or os.path.join(args.graph_dir, sidecar.NAME)
        sidecar.save_sidecar(map_path, {"namespace": str(NAMESPACE), "blocks": n.map, "dangling_refs": n.dangling})
        set_journal_format(args.graph_dir, args.journal_format)
    rep = n.report()
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            f.write(rep)
    sys.stdout.write(rep)
    return 1 if n.problems else 0


if __name__ == "__main__":
    sys.exit(main())
