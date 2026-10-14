"""Convert a Roam JSON export straight into a Logseq file graph. No Logseq importer,
no re-index, no cache to delete: Logseq just opens the folder as a new graph.

    python3 -m roam2logseq.convert EXPORT.json GRAPH_DIR [--journal-format "MMMM do, yyyy"]
                                   [--git] [--force] [--no-verify] [--report DIR]

Steps (all deterministic; see ../import-issues.md §7 and ../reversibility.md):

1. Fix the export in memory (fix_export.Fixer): colliding/odd titles, surplus-paren
   embeds, dash and heading escapes, duplicate block uids, empty titles.
2. For every Roam page with blocks, build the Logseq page: text converted the way
   the importer would (checkbox macros, `{{name: x}}` macros, refs to derived ids),
   plus what the importer dropped: headings (`# `), numbered children
   (`logseq.order-list-type:: number`), and Roam-style inline checkboxes where a
   block has several or one not at the start (`{{renderer :cb, todo|done, N}}`,
   rendered by the inline-checkbox plugin). Every block gets `id:: uuid5(ns, uid)`.
3. Write pages/ and journals/ in Logseq's native layout, logseq/config.edn from the
   bundled template with the journal title format set, and the sidecar
   `roam-uid-map.json.gz` (every block's Roam uid, Logseq uuid, page, path, and all
   Roam metadata; page metadata; title and uid maps from the fixer).
4. Re-parse the output and verify it against the fixed export (verify_graph).

Refuses to write into a non-empty directory unless --force.
"""
import argparse
import collections
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse

from ankify_logseq.logseq import Block, BlockContent, Page
from roam2logseq.fix_export import Fixer
from roam2logseq.normalize_graph import (
    NAMESPACE, ROAM_META_SKIP, RE_PROP_LINE, collapse_ws, derived_uuid, roam_title_date, roam_to_logseq_text,
    title_to_filename, _atomic_write, outside_code,
)
from roam2logseq.serialize import page_text

HERE = os.path.dirname(os.path.abspath(__file__))
RE_CHECKBOX = re.compile(r"\{\{\[\[(TODO|DONE)\]\]\}\}")
# Roam attribute names that are not valid Logseq property names, and what to call
# them in Logseq (matched case-insensitively at the start of a line, outside code).
# Every rename is recorded per block in the sidecar (`renamed_keys`) so the reverse
# conversion restores the original spelling (decided 2026-09-05).
PROPERTY_KEY_MAP = {
    "author(s)": "Author",
    "source(s)": "Source",
}
RE_ATTR_LINE = re.compile(r"(?m)^([^\n:]+?)::(?=\s|$)")
# what Logseq accepts as a property name (its own error message spells this out)
RE_VALID_KEY = re.compile(r"[A-Za-z\u00c0-\uffff][\w\u00c0-\uffff.*+!\-?$%&=<>]*")


def rename_property_keys(string, key_map=PROPERTY_KEY_MAP):
    """(string, [(old, new), ...]) with attribute keys renamed: per key_map first, then
    keys that are valid apart from containing spaces get hyphenated (`Start time::` →
    `start-time::`, decided 2026-09-05) so they are real, queryable Logseq properties
    instead of plain text. Keys with other invalid characters are left alone."""
    renamed = []
    def sub(m):
        key = m.group(1)
        new = key_map.get(key.strip().lower())
        if not new:
            words = key.split()
            if len(words) > 1 and all(RE_VALID_KEY.fullmatch(w) for w in words):
                new = "-".join(w.lower() for w in words)
        if not new or new == key:
            return m.group(0)
        renamed.append((key, new))
        return new + "::"
    return outside_code(string, lambda t: RE_ATTR_LINE.sub(sub, t)), renamed


RE_ROAM_LINK_LABELS = re.compile(r"(?m)^([ \t]*)(Web|Desktop) link:(?=\s*(?:\S*roamresearch\.com/|roam://))")
RE_WEB_LINK = re.compile(r"(?m)^([ \t]*)Web link: ?\S*?roamresearch\.com/#/app/[^/\s]+/page/([\w\-]+)")


def add_logseq_link(string, graph_name, page_uids, block_uids, own_uuid):
    """Spec Part III: a block that carries a Roam `Web link:` line gets a
    `Logseq link:` line right above it (the Roam lines stay). The link opens the same
    thing in Logseq: the page if the Roam uid is a page's, the block (by derived
    uuid) if it is a block's, this block itself if the uid is unknown.
    Returns (string, kind or None)."""
    m = RE_WEB_LINK.search(string)
    if not m:
        return string, None
    uid = m.group(2)
    if uid in page_uids:
        link, kind = "logseq://graph/%s?page=%s" % (graph_name, urllib.parse.quote(page_uids[uid])), "page"
    elif uid in block_uids:
        link, kind = "logseq://graph/%s?block-id=%s" % (graph_name, derived_uuid(uid)), "block"
    else:
        link, kind = "logseq://graph/%s?block-id=%s" % (graph_name, own_uuid), "this block (unknown uid)"
    string = string[:m.start()] + m.group(1) + "Logseq link: " + link + "\n" + string[m.start():]
    # decided 2026-09-05: label the Roam lines as Roam's
    string = RE_ROAM_LINK_LABELS.sub(lambda mm: mm.group(1) + "Roam " + mm.group(2).lower() + " link:", string)
    return string, kind


RE_ROAM_RENDER_ACTIVE = re.compile(r'\{\{\[\[roam/render\]\]:\s*\(\(+[\w\-]+\)\)+[^}]*"Block UID"[^}]*\}\}')
ACTIVE_MACRO = "{{renderer :ankify-active}}"


def convert_roam_render(string):
    """The one roam/render component in use ("Block UID", 915 blocks: a switch that
    flips the ankify suspend tag) becomes the Ankify IDs plugin's macro. Returns
    (string, count)."""
    found = []
    def repl(m):
        found.append(m.group(0))
        return ACTIVE_MACRO
    return outside_code(string, lambda t: RE_ROAM_RENDER_ACTIVE.sub(repl, t)), found


def filename_to_title(filename):
    """How Logseq reads a triple-lowbar file name back into a page title (the parser's
    inverse of Logseq's sanitizing, incl. dropping empty namespace segments, so a
    title ending in "/" does not round-trip and gets front matter)."""
    from ankify_logseq.logseq.parser import title_from_filename
    return title_from_filename(filename[:-3], "triple-lowbar")


def needs_front_matter(title, filename, first_block_text):
    """Logseq takes the title from the file name and the page properties from the
    first block. Front matter with `title::` is needed only when the file name does
    not read back as the title, or when the first block would be swallowed as page
    properties (empty, or nothing but `key:: value` lines)."""
    if filename_to_title(os.path.basename(filename)) != title:
        return True
    lines = [l for l in first_block_text.split("\n") if l.strip()]
    return not lines or all(RE_PROP_LINE.match(l) for l in lines)


METADATA_TITLES = ("metadata", "metadata:", "meta data")
RE_ATTR_ONLY = re.compile(r"^([A-Za-z][\w.\-]*)::[ \t]?(.*)$")
# single-colon lines from the source template that are properties in spirit
RE_SINGLE_COLON_PROP = re.compile(r"^(Subtitle):[ \t]*(.*)$", re.I)


def lift_metadata(roam_children, referenced=frozenset()):
    """Decided 2026-09-05 (Eli): on a page whose first block is "metadata", the block
    is dissolved. Every child that is a single `key:: value` line becomes a page
    property (blank values kept), whether or not it has children; a "Subtitle: x"
    line (single colon, from the source template) becomes `subtitle::`. Everything
    else under metadata (the "Cards" subtree, children of lifted attributes, any
    other text, and attribute blocks that other blocks reference) becomes a
    top-level block, in original order, where the metadata block stood. Checked in
    Logseq 2026-09-05: a page-level `tags::` tags the page but is NOT inherited by
    its blocks in block queries (Part IX item: build that inheritance);
    ankify_logseq adds page-level tags to the cards' Anki tags itself.

    Pure function on the Roam JSON tree, so verify_graph applies the same transform.
    Returns (new_children, properties [(key, raw value)], lifted [records], metadata uid)."""
    if not roam_children:
        return roam_children, [], [], None
    meta = roam_children[0]
    if meta.get("string", "").strip().lower() not in METADATA_TITLES:
        return roam_children, [], [], None
    props, lifted, moved = [], [], []
    for i, child in enumerate(meta.get("children", [])):
        text = rename_property_keys(child.get("string", "").strip())[0]
        m = RE_ATTR_ONLY.match(text)
        if m is None:
            m = RE_SINGLE_COLON_PROP.match(text)
        if m is None or "\n" in text or child["uid"] in referenced:
            moved.append((i, child))
            continue
        key, value = m.group(1).lower(), m.group(2).strip()
        props.append((key, value))
        lifted.append({"roam_uid": child["uid"], "index": i, "key": key,
                       "children": [g["uid"] for g in child.get("children", [])],
                       "roam": {k: v for k, v in child.items() if k not in ("children",)}})
        moved.extend((i, g) for g in child.get("children", []))
    for _i, child in moved:
        child.setdefault("_from_metadata", True)
    return [ch for _i, ch in moved] + roam_children[1:], props, lifted, meta["uid"]


def referenced_uids(pages):
    """Every Roam uid that some block string references or embeds."""
    refs = set()
    def walk(bs):
        for b in bs:
            for m in re.finditer(r"\(\(+([\w\-]{9,12})\)\)+", b.get("string", "")):
                refs.add(m.group(1))
            walk(b.get("children", []))
    for p in pages:
        walk(p.get("children", []))
    return refs


RE_OPTION_TAG = re.compile(r"(\[\[)ankify_roam:")
OPTION_PREFIX_ROAM, OPTION_PREFIX_LOGSEQ = "ankify_roam:", "ankify_logseq:"


def rename_option_tags(string):
    """Decided 2026-09-05: `#[[ankify_roam: deck="x"]]` option tags become
    `#[[ankify_logseq: deck="x"]]` (ankify_logseq reads both; the reverse rewrites
    the prefix back). Only the `ankify_roam:` option form; the `[[ankify_roam]]`
    page itself is untouched. Returns (string, count)."""
    n = [0]
    def sub(m):
        n[0] += 1
        return m.group(1) + OPTION_PREFIX_LOGSEQ
    return outside_code(string, lambda t: RE_OPTION_TAG.sub(sub, t)), n[0]


def rename_option_title(title):
    """Roam pages named `ankify_roam: …` (the option tags are page refs) get the
    matching new name so the refs keep pointing at them."""
    if title.lower().startswith(OPTION_PREFIX_ROAM):
        return OPTION_PREFIX_LOGSEQ + title[len(OPTION_PREFIX_ROAM):]
    return PAGE_SPELLING_FIXES.get(title, title)


# Roam macros that are not buttons (everything else in `{{...}}` without a colon
# renders as a button in Roam; Eli uses them as labels: yes/no, Focusing checklist…)
ROAM_NON_BUTTON_MACROS = {
    "todo", "done", "embed", "table", "kanban", "word-count", "character-count", "calc", "query",
    "attr-table", "mentions", "video", "pdf", "youtube", "iframe", "pomodoro", "pomo", "slider",
    "encrypt", "diagram", "drawing", "mermaid", "roam/render", "roam/js", "roam/css", "date",
    "daily notes", "daily note", "dailynotes", "block-ref-count", "count", "search", "or", "not",
    "and", "between", "if", "random", "alias", "embed-path", "embed-children", "=", "∆", "delta",
    "orphans", "roam/comments", "comments", "tweet", "sidebar", "clock", "timer",
}
RE_ROAM_BUTTON = re.compile(r"\{\{(\[\[)?([^{}\[\]:]+?)(\]\])?\}\}")


def convert_buttons(string):
    """`{{[[Label]]}}` -> `{{renderer :rbutton, [[Label]]}}`, `{{Label}}` ->
    `{{renderer :rbutton, Label}}` (rendered by the Expand button plugin; decided
    2026-09-05). Returns (string, count, labels): `labels` are the bracketed ones,
    which in Roam were references to those pages; Logseq does not index refs inside
    macro arguments (checked 2026-09-05), so the caller records them in a hidden
    `button-refs::` property, which Logseq does index."""
    n = [0]; labels = []
    def sub(m):
        name = m.group(2).strip()
        if not name or name.lower() in ROAM_NON_BUTTON_MACROS or (m.group(1) is None) != (m.group(3) is None):
            return m.group(0)
        n[0] += 1
        if m.group(1) and name not in labels:
            labels.append(name)
        # keep the inner text exactly (whitespace included) so the way back is exact
        return "{{renderer :rbutton, %s}}" % ("[[%s]]" % name if m.group(1) else m.group(2))
    return outside_code(string, lambda t: RE_ROAM_BUTTON.sub(sub, t)), n[0], labels


# ---------------------------------------------------------------- SmartBlocks -> Logseq templates
RE_SMARTBLOCK_TAG = re.compile(r"\s*#\[?\[?SmartBlock\]?\]?\s*", re.I)
TEMPLATE_TOKEN_MAP = [
    # (Roam SmartBlock token, Logseq form). Logseq's own template variables use
    # `<% name %>` and are expanded by Logseq on insertion (they come out as page
    # links already, so no extra brackets). Logseq also eats any other `<%…%>`, so the
    # Template commands plugin's tokens use `{%NAME:args%}` instead.
    # everything goes through the plugin (Logseq's own `<% current page %>` only
    # expands when Logseq itself inserts the template, not when the plugin does)
    (re.compile(r"<%CONCAT:\[,\[<%CURRENTPAGENAME%>\],\]%>"), "{%CURRENTPAGE%}"),
    (re.compile(r"<%CURRENTPAGENAME%>"), "{%CURRENTPAGENAME%}"),
    # dates go through the plugin: Logseq does not expand `<% today %>` inside
    # property values (page-created-on:: …), the plugin expands `{%DATE%}` anywhere
    (re.compile(r"<%DATE%>"), "{%DATE%}"),
    (re.compile(r"<%DATE:([^%]+)%>"), lambda m: "{%DATE:" + m.group(1).strip() + "%}"),
    (re.compile(r"<%RESOLVEBLOCKREF:<%PARENT:<%TRIGGERREF%>%>%>"), "{%PARENTTEXT%}"),
    (re.compile(r"<%PARENT:<%TRIGGERREF%>,\w+,false%>"), ""),          # stores the parent uid in a variable: no output
    (re.compile(r"<%CURRENTBLOCKREF:,,false%>"), ""),
    (re.compile(r"<%CHILDREN:<%GETPAGEUID%>,0,0,\{uid\},1,%>"), "\u27e8BLOCK\u27e9"),
    (re.compile(r"<%GETPAGEUID%>"), "\u27e8PAGE\u27e9"),
    (re.compile(r"<%PARENT:<%TRIGGERREF%>,,false%>"), "\u27e8PARENT\u27e9"),
    (re.compile(r"<%GET:fun%>"), "\u27e8PARENT\u27e9"),
]
RE_ROAM_LINK_LINE = re.compile(r"(?m)^([ \t]*)(?:(Web|Desktop) link: )?(?:https://roamresearch\.com/#/app/[^/\s]+/page/|roam://#/app/[^/\s]+/page/)\u27e8(PAGE|BLOCK|PARENT)\u27e9[ \t]*$")


def convert_template_text(string):
    """A SmartBlock definition's block text, in Logseq template form."""
    for pat, rep in TEMPLATE_TOKEN_MAP:
        string = pat.sub(rep, string)
    # Roam web/desktop link lines with a uid token: one Logseq link line instead
    def link_line(m):
        indent, label, what = m.group(1), m.group(2), m.group(3)
        if label == "Desktop":
            return "\u27e8DROP\u27e9"
        return indent + ("Logseq link: " if label else "") + "{%" + what + "LINK%}"
    string = RE_ROAM_LINK_LINE.sub(link_line, string)
    string = re.sub(r"\n\u27e8DROP\u27e9(?=\n|$)|^\u27e8DROP\u27e9\n?", "", string)
    # a Roam url with a uid token anywhere else (e.g. mid-line): the Logseq link
    string = re.sub(r"(?:https://roamresearch\.com/#/app/[^/\s]+/page/|roam://#/app/[^/\s]+/page/)\u27e8(PAGE|BLOCK|PARENT)\u27e9",
                    lambda m: "{%" + m.group(1) + "LINK%}", string)
    string = re.sub(r"\u27e8(PAGE|BLOCK|PARENT)\u27e9", lambda m: "{%" + m.group(1) + "LINK%}", string)
    # every remaining Roam-style token (CURSOR, RANDOMNUMBER, REPEAT/INPUT/GET, …) is
    # the plugin's: same name, `{%…%}` delimiters (nested ones too)
    prev = None
    while prev != string:
        prev = string
        string = re.sub(r"<%([A-Z]+)((?::(?:(?!<%|%>).)*)?)%>", lambda m: "{%" + m.group(1) + m.group(2) + "%}", string, flags=re.S)
    return string


def template_name(string):
    """`[[Daily page template]] #SmartBlock` -> `Daily page template`."""
    name = RE_SMARTBLOCK_TAG.sub(" ", string).strip()
    name = re.sub(r"^\[\[(.*)\]\]$", r"\1", name).strip().rstrip(":").strip()
    return name


def relift_templates(roam_children, referenced=frozenset()):
    """What the converter does to a template's metadata block (dissolved into one
    property block that keeps the metadata block's uid), applied to a Roam tree so
    the verifiers can compare paths. Pure."""
    out = []
    for b in roam_children:
        b = dict(b)
        if RE_SMARTBLOCK_TAG.search(b.get("string", "")):
            kids, props, lifted, meta_uid = lift_metadata(b.get("children", []), referenced)
            if props:
                kids = [{"uid": meta_uid, "string": "", "children": []}] + kids
            b["children"] = kids
        else:
            b["children"] = relift_templates(b.get("children", []), referenced)
        out.append(b)
    return out


# Spelling fixes decided 2026-09-05 (Otter import pages; the Roam extension wrote these
# misspellings on every import). Applied to page titles and to every reference; the
# same renames are done by hand in Roam, and the importers write the new spellings,
# so old and new transcripts share pages. Recorded in the sidecar (`spelling_fixes`).
PAGE_SPELLING_FIXES = {
    "Automated transcirpt from otter": "Automated transcript from otter",
    "Transcricpt": "Transcript",
}
TEXT_SPELLING_FIXES = {
    "Recroding Metadata": "Recording Metadata",
}


def fix_spelling(string):
    """(string, count) with the page-reference and text spelling fixes applied outside code."""
    n = [0]
    def conv(t):
        for old, new in PAGE_SPELLING_FIXES.items():
            for pat, rep in (("[[%s]]" % old, "[[%s]]" % new), ("#%s" % old, "#%s" % new)):
                if pat in t:
                    n[0] += t.count(pat); t = t.replace(pat, rep)
        for old, new in TEXT_SPELLING_FIXES.items():
            if old in t:
                n[0] += t.count(old); t = t.replace(old, new)
        return t
    return outside_code(string, conv), n[0]


def fix_spelling_title(title):
    return PAGE_SPELLING_FIXES.get(title, title)


def fix_fences(s):
    """Logseq only recognizes a closing ``` at the start of a line, and nothing may
    follow it on that line; Roam renders `code```` and `` ``` #tag`` fine. Insert the
    missing newlines (134 + 3 blocks in the 2026-09-04 export). Odd fence counts are
    left alone."""
    if s.count("```") % 2:
        return s
    out = []
    pos = 0
    opening = True
    while True:
        i = s.find("```", pos)
        if i < 0:
            out.append(s[pos:])
            break
        chunk = s[pos:i]
        if not opening and chunk and not chunk.endswith("\n"):
            chunk += "\n"
        out.append(chunk)
        # the opening fence's info string runs to the end of the line
        j = s.find("\n", i + 3) if opening else i + 3
        if j < 0:
            j = len(s)
        out.append(s[i:j])
        if not opening and j < len(s) and s[j] != "\n":
            out.append("\n")
        pos = j
        opening = not opening
    return "".join(out)


def convert_block_text(string, uuid_for_uid, inline_checkboxes=True):
    """(marker, text, n_inline_checkboxes). A single checkbox at the very start becomes
    a Logseq task marker; any other arrangement becomes inline-checkbox macros."""
    string = fix_fences(string)
    # only checkboxes outside code count (inside code they are literal text)
    boxes = []
    outside_code(string, lambda t: (boxes.extend(RE_CHECKBOX.finditer(t)), t)[1])
    leading = bool(boxes) and string[:boxes[0].start()].strip() == "" and len(boxes) == 1
    if boxes and inline_checkboxes and not leading:
        n = [0]
        def repl(m):
            n[0] += 1
            return "{{renderer :cb, %s, %d}}" % (m.group(1).lower(), n[0])
        string = outside_code(string, lambda t: RE_CHECKBOX.sub(repl, t))
        marker, text = roam_to_logseq_text(string, uuid_for_uid)
        return None, (marker + " " + text if marker else text), n[0]
    marker, text = roam_to_logseq_text(string, uuid_for_uid)
    return marker, text, 0


class Converter:
    def __init__(self, pages, out_dir, journal_format="MMMM do, yyyy", inline_checkboxes=True, graph_name=None, lift_metadata=True, templates=True, page_tags=True):
        self.pages = pages
        self.lift_metadata = lift_metadata
        self.templates = templates
        self.page_tags = page_tags
        self.template_names = set()
        self.out = out_dir
        self.graph_name = graph_name or os.path.basename(os.path.abspath(out_dir))
        self.page_uids = {p["uid"]: collapse_ws(p.get("title", "")) for p in pages if p.get("uid")}
        self.journal_format = journal_format
        self.inline_checkboxes = inline_checkboxes
        self.counts = collections.Counter()
        self.notes = []
        self.map_blocks = []
        self.map_pages = []
        self.dangling = {}
        self.existing_uids = set()

    def build_blocks(self, roam_blocks, page_title, path=(), in_template=False):
        out = []
        for i, r in enumerate(roam_blocks):
            pth = path + (i,)
            raw = r.get("string", "")
            is_template_root = bool(RE_SMARTBLOCK_TAG.search(raw)) and self.templates
            child_in_template = in_template or is_template_root
            if in_template:
                raw = convert_template_text(raw)
            raw, n_spell = fix_spelling(raw)
            if n_spell:
                self.counts["spelling fixes (Otter pages)"] += n_spell
            string, renamed = rename_property_keys(raw)
            if renamed:
                self.counts["property keys renamed"] += len(renamed)
            string, n_opt = rename_option_tags(string)
            if n_opt:
                self.counts["ankify_roam: option tags -> ankify_logseq:"] += n_opt
            string, render_sources = convert_roam_render(string)
            n_render = len(render_sources)
            string, n_btn, btn_labels = convert_buttons(string)
            if n_btn:
                self.counts["Roam buttons -> {{renderer :rbutton}}"] += n_btn
            if n_render:
                self.counts["roam/render Block UID -> {{renderer :ankify-active}}"] += n_render
            string, link_kind = add_logseq_link(string, self.graph_name, self.page_uids, self.existing_uids, derived_uuid(r["uid"]))
            if link_kind:
                self.counts["Logseq link lines added (to %s)" % link_kind] += 1
            marker, text, n_inline = convert_block_text(string, self._uuid_for_uid, self.inline_checkboxes)
            if n_inline:
                self.counts["blocks with inline checkboxes"] += 1
                self.counts["inline checkboxes"] += n_inline
            heading = r.get("heading") or 0
            if heading and text and not text.startswith("#"):
                text = "#" * min(int(heading), 6) + " " + text
                self.counts["headings"] += 1
            b = Block(content=BlockContent.from_string(text), uid=derived_uuid(r["uid"]), marker=marker)
            if btn_labels:
                b.properties["button-refs"] = ", ".join("[[%s]]" % l for l in btn_labels)
                self.counts["blocks with hidden button-refs property"] += 1
            if r.get(":children/view-type") == ":numbered" and r.get("children"):
                self.counts["numbered lists"] += 1
                numbered = True
            else:
                numbered = False
            if is_template_root:
                name = template_name(raw)
                if name in self.template_names:
                    self.notes.append(f"duplicate template name {name!r} on {page_title!r}; second one left as is")
                    is_template_root = False
                else:
                    self.template_names.add(name)
                    b.properties["template"] = name
                    b.properties["template-including-parent"] = "false"
                    self.counts["SmartBlock definitions -> Logseq templates"] += 1
            child_src = r.get("children", [])
            template_props = None
            template_meta_record = None
            if is_template_root and self.lift_metadata:
                # the template's "metadata" block becomes a property block (first child), so
                # an inserted source page gets its page properties directly
                child_src, props, lifted, meta_uid = lift_metadata(child_src, self.referenced)
                if meta_uid:
                    template_meta_record = {"roam_uid": meta_uid, "lifted": lifted,
                                            "children_in_order": [ch["uid"] for ch in r["children"][0].get("children", [])],
                                            "roam": {k: v for k, v in r["children"][0].items() if k != "children"},
                                            "has_property_block": bool(props)}
                if props:
                    template_props = (meta_uid, props)
                    self.counts["template metadata blocks -> property blocks"] += 1
            children = self.build_blocks(child_src, page_title, pth, child_in_template)
            if template_props:
                meta_uid, props = template_props
                pb = Block(content=BlockContent.from_string(""), uid=derived_uuid(meta_uid))
                for key, value in props:
                    value = convert_template_text(value)
                    pb.properties[key] = roam_to_logseq_text(value, self._uuid_for_uid)[1] if value else ""
                children.insert(0, pb)
                self.map_blocks.append({"roam_uid": meta_uid, "logseq_uuid": pb.uid, "page": page_title, "path": list(pth) + [0],
                                        "template_property_block": [k for k, _v in props]})
            if numbered:
                for c in children:
                    c.properties["logseq.order-list-type"] = "number"
            b.children.extend(children)
            for c in children:
                c.parent = b
            out.append(b)
            entry = {"roam_uid": r["uid"], "logseq_uuid": b.uid, "page": page_title, "path": list(pth)}
            if re.match(r"^(TODO|DOING|DONE|LATER|NOW)(\s|$)", r.get("string", "")):
                entry["literal_marker"] = True
            if renamed:
                entry["renamed_keys"] = renamed
            if link_kind:
                entry["logseq_link"] = True
            if n_render:
                entry["roam_render_active"] = render_sources   # exact Roam macro text, in order
            if n_btn:
                entry["roam_buttons"] = n_btn
            if re.match(r"^\s*(collapsed|heading|id)::", r.get("string", "")):
                entry["literal_property_line"] = r.get("string", "")   # Logseq will read it as its own property
            bracketed = sorted(set(re.findall(r"\{\{\[\[([\w/\-]+)\]\]:", r.get("string", ""))))
            if bracketed:
                entry["bracket_macros"] = bracketed   # Roam wrote `{{[[name]]: x}}` (else `{{name: x}}`) for these
            if is_template_root:
                entry["smartblock_template"] = b.properties["template"]
            if template_meta_record:
                entry["template_metadata"] = template_meta_record
            if in_template and raw != r.get("string", ""):
                entry["template_source"] = r.get("string", "")   # exact Roam text, for the way back
                entry["template_text"] = text                     # what was written; unchanged => restore the source
            meta = {k: v for k, v in r.items() if k not in ROAM_META_SKIP}
            if meta:
                entry["roam"] = meta
            self.map_blocks.append(entry)
        return out

    def _uuid_for_uid(self, uid):
        u = derived_uuid(uid)
        if uid not in self.existing_uids:
            self.dangling[u] = uid
        return u

    def run(self):
        def walk(bs):
            for b in bs:
                yield b
                yield from walk(b.get("children", []))
        for p in self.pages:
            for b in walk(p.get("children", [])):
                self.existing_uids.add(b["uid"])
        self.referenced = referenced_uids(self.pages) if self.lift_metadata else frozenset()
        os.makedirs(os.path.join(self.out, "pages"), exist_ok=True)
        os.makedirs(os.path.join(self.out, "journals"), exist_ok=True)
        os.makedirs(os.path.join(self.out, "logseq"), exist_ok=True)
        used_files = {}
        for p in self.pages:
            title = collapse_ws(p.get("title", ""))
            self.map_pages.append({"title": title, **{k: v for k, v in p.items() if k not in ("children", "title")}})
            renamed_title = fix_spelling_title(rename_option_title(title))
            if renamed_title != title:
                self.map_pages[-1]["logseq_title"] = renamed_title
                self.counts["pages renamed (option prefix / spelling)"] += 1
                title = renamed_title
            if not p.get("children"):
                self.counts["pages without blocks (no file)"] += 1
                continue
            d = roam_title_date(title)
            if d:
                rel = os.path.join("journals", d.strftime("%Y_%m_%d") + ".md")
                page = Page(title=title, path=os.path.join(self.out, rel), is_journal=True)
            else:
                rel = os.path.join("pages", title_to_filename(title))
                page = Page(title=title, path=os.path.join(self.out, rel))
            key = rel.lower()
            if key in used_files:
                self.counts["file name collisions (suffixed)"] += 1
                self.notes.append(f"file name collision: {rel!r} for {title!r} and {used_files[key]!r}")
                base, ext = os.path.splitext(rel)
                n = 2
                while (base + f"_{n}" + ext).lower() in used_files:
                    n += 1
                rel = base + f"_{n}" + ext
                page.path = os.path.join(self.out, rel)
            used_files[rel.lower()] = title
            children, props, lifted, dropped_meta = lift_metadata(p.get("children", []), self.referenced) if self.lift_metadata else (p.get("children", []), [], [], None)
            page.children.extend(self.build_blocks(children, title))
            page.propagate_parents()
            for key, value in props:
                value = roam_to_logseq_text(value, self._uuid_for_uid)[1] if value else ""
                if key in page.properties and page.properties[key]:
                    value = page.properties[key] + (", " + value if value else "")
                page.properties[key] = value
            if dropped_meta:
                self.counts["metadata blocks dissolved"] += 1
                self.counts["attribute blocks lifted to page properties"] += len(lifted)
                meta_block = p["children"][0]
                self.map_pages[-1]["metadata"] = {
                    "roam_uid": dropped_meta, "lifted": lifted,
                    "children_in_order": [ch["uid"] for ch in meta_block.get("children", [])],
                    "roam": {k: v for k, v in meta_block.items() if k != "children"}}
                for rec in lifted:
                    self.map_blocks.append({"roam_uid": rec["roam_uid"], "logseq_uuid": None, "page": title,
                                            "lifted_to_page_property": rec["key"], "roam": rec["roam"]})
            # Part IX (2026-09-05): Logseq does not let blocks inherit the page's tags in
            # block queries, but blocks do inherit their ancestors' refs (path refs). So
            # every top-level block gets a hidden `page-tags::` property with the page's
            # tags; the page-tags plugin maintains it for new blocks. Hidden via
            # :block-hidden-properties; dropped on the way back to Roam.
            if self.page_tags and page.properties.get("tags"):
                for b in page.children:
                    b.properties["page-tags"] = page.properties["tags"]
                    self.counts["top-level blocks given page-tags"] += 1
            first_text = page.children[0].content.to_string() if page.children else ""
            if not d and needs_front_matter(title, rel, first_text):
                if page.properties:
                    page.properties = {"title": title, **page.properties}   # pre-block form holds all page properties
                else:
                    page.front_matter = True
                    page.properties["title"] = title
                self.counts["pages with title property"] += 1
            _atomic_write(page.path, page_text(page))
            self.counts["journal files" if d else "page files"] += 1
        self.dangling = {u: uid for u, uid in self.dangling.items() if uid not in self.existing_uids}
        self.counts["blocks"] = len(self.map_blocks)
        self.counts["dangling refs"] = len(self.dangling)
        # config
        with open(os.path.join(HERE, "config.edn.template"), encoding="utf-8") as f:
            cfg = f.read()
        cfg = re.sub(r'(?m)^[ \t]*:journal/page-title-format\s+"[^"]*"[ \t]*\n', "", cfg)
        cfg = re.sub(r'\{[ \t]*:journal/page-title-format\s+"[^"]*"[ \t]*\n', "{", cfg)
        cfg = cfg.replace("{", "{:journal/page-title-format \"%s\"\n " % self.journal_format, 1)
        # hide the converter's bookkeeping property (button labels kept as refs)
        cfg = re.sub(r'(?m)^[ \t]*:block-hidden-properties\s+#\{[^}]*\}[ \t]*\n', "", cfg)
        cfg = cfg.replace("{", "{:block-hidden-properties #{:button-refs :page-tags :backembed}\n ", 1)
        _atomic_write(os.path.join(self.out, "logseq", "config.edn"), cfg)
        if not os.path.exists(os.path.join(self.out, "logseq", "custom.css")):
            with open(os.path.join(HERE, "custom.css.template"), encoding="utf-8") as f:
                _atomic_write(os.path.join(self.out, "logseq", "custom.css"), f.read())

    def report(self):
        lines = ["# convert report", ""] + [f"- {k}: {v}" for k, v in sorted(self.counts.items())]
        if self.notes:
            lines += ["", "## Notes"] + [f"- {n}" for n in self.notes]
        return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export_json")
    ap.add_argument("graph_dir")
    ap.add_argument("--journal-format", default="MMMM do, yyyy")
    ap.add_argument("--no-lift-metadata", dest="lift_metadata", action="store_false",
                    help="keep `key:: value` children of a first 'metadata' block as blocks instead of page properties")
    ap.add_argument("--no-templates", dest="templates", action="store_false",
                    help="leave #SmartBlock definitions as plain blocks instead of Logseq templates")
    ap.add_argument("--no-page-tags", dest="page_tags", action="store_false",
                    help="do not add the hidden page-tags:: property to top-level blocks")
    ap.add_argument("--graph-name", default=None, help="name in logseq:// links (default: the folder name, which is what Logseq uses)")
    ap.add_argument("--no-inline-checkboxes", dest="inline_checkboxes", action="store_false",
                    help="do not convert multi/mid-block checkboxes to the inline-checkbox macro")
    ap.add_argument("--git", action="store_true", help="git init the graph and commit the result")
    ap.add_argument("--force", action="store_true", help="write into a non-empty directory")
    ap.add_argument("--no-verify", dest="verify", action="store_false")
    ap.add_argument("--report", default=None, help="directory for the reports and the fixed export (default: GRAPH_DIR/../<name>-convert-reports)")
    args = ap.parse_args(argv)

    out = os.path.abspath(args.graph_dir)
    if os.path.isdir(out) and os.listdir(out) and not args.force:
        raise SystemExit(f"{out} exists and is not empty (use --force)")
    rep_dir = args.report or os.path.join(os.path.dirname(out), os.path.basename(out) + "-convert-reports")
    os.makedirs(rep_dir, exist_ok=True)

    with open(args.export_json, encoding="utf-8") as f:
        pages = json.load(f)
    print(f"Loaded {len(pages)} pages from {args.export_json}")
    fixer = Fixer(pages)
    pages = fixer.run()
    fixed_path = os.path.join(rep_dir, "export.fixed.json")
    with open(fixed_path, "w", encoding="utf-8") as f:
        json.dump(pages, f, ensure_ascii=False)
    with open(os.path.join(rep_dir, "fix-report.md"), "w", encoding="utf-8") as f:
        f.write(fixer.report())
    print(fixer.report())

    conv = Converter(pages, out, journal_format=args.journal_format, inline_checkboxes=args.inline_checkboxes, graph_name=args.graph_name, lift_metadata=args.lift_metadata, templates=args.templates, page_tags=args.page_tags)
    conv.run()
    from roam2logseq.sidecar import NAME as SIDECAR_NAME, save_sidecar
    save_sidecar(os.path.join(out, SIDECAR_NAME),
                 {"namespace": str(NAMESPACE), "blocks": conv.map_blocks, "pages": conv.map_pages,
                  "dangling_refs": conv.dangling, "titles": fixer.title_map(), "uids": fixer.uid_map()})
    with open(os.path.join(rep_dir, "convert-report.md"), "w", encoding="utf-8") as f:
        f.write(conv.report())
    print(conv.report())

    rc = 0
    if args.verify:
        from roam2logseq.verify_graph import main as verify_main
        print("Verifying...")
        rc = verify_main([out, fixed_path])
    if args.git:
        subprocess.run(["git", "init", "-q"], cwd=out, check=True)
        with open(os.path.join(out, ".gitignore"), "w") as f:
            f.write("logseq/bak/\nlogseq/.recycle/\n.DS_Store\n")
        subprocess.run(["git", "add", "-A"], cwd=out, check=True)
        subprocess.run(["git", "commit", "-q", "-m", f"roam2logseq convert of {os.path.basename(args.export_json)}"], cwd=out, check=True)
        print("committed")
    return rc


if __name__ == "__main__":
    sys.exit(main())
