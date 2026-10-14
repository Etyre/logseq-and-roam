"""Parse a Logseq file graph (markdown) into LogseqGraph / Page / Block objects.

Handles the two layouts found in practice:

1. Files written by the Roam importer: bullets are `<tabs> - text` (sometimes with a
   stray space before the dash), continuation lines and `id::` lines sit at column
   0, and blocks are separated by blank lines.
2. Files written by Logseq itself: bullets are `<tabs>- text`, continuation and
   property lines are indented by the block's tabs plus two spaces.

Page titles come from front matter (`title: X`), a `title::` page property, or the
decoded file name (triple-lowbar or legacy format). Journal titles are formatted
from the file name using the graph's `:journal/page-title-format`.
"""
import datetime
import logging
import os
import re
import urllib.parse

from ankify_logseq.logseq.containers import (
    Block, LogseqGraph, Page, file_hash,
)
from ankify_logseq.logseq.content import BlockContent

logger = logging.getLogger(__name__)

RE_BULLET = re.compile(r"^(?P<indent>[ \t]*)-(?: (?P<text>.*)|)$")
RE_PROPERTY = re.compile(r"^\s*(?P<key>[A-Za-z0-9_.\-]+):: ?(?P<value>.*?)\s*$")
RE_MARKER = re.compile(
    r"^(?P<marker>TODO|DOING|DONE|LATER|NOW|WAITING|WAIT|CANCELED|CANCELLED|IN-PROGRESS)"
    r"(?: \[#(?P<priority>[A-C])\])?(?: |$)")
RE_SCHEDULED = re.compile(r"^\s*(SCHEDULED|DEADLINE):\s*<.*>\s*$")
RE_JOURNAL_FILE = re.compile(r"^\d{4}[_\-]\d{2}[_\-]\d{2}$")

# Logseq bookkeeping properties that are never part of the block's content
HIDDEN_PROPERTIES = {
    "id", "collapsed", "heading", "background-color", "background_color",
    "card-last-interval", "card-repeats", "card-ease-factor", "card-next-schedule",
    "card-last-reviewed", "card-last-score", "logseq.order-list-type",
    "logseq.table.version", "query-table", "query-properties", "query-sort-by",
    "query-sort-desc", "pagination",
}


# --------------------------------------------------------------------------- config

def read_config(graph_dir):
    """Read the few keys of logseq/config.edn that matter, with Logseq's defaults."""
    config = {
        "journal/page-title-format": "MMM do, yyyy",
        "journal/file-name-format": "yyyy_MM_dd",
        "file/name-format": "legacy",
        "pages-directory": "pages",
        "journals-directory": "journals",
    }
    path = os.path.join(graph_dir, "logseq", "config.edn")
    if not os.path.exists(path):
        return config
    with open(path, encoding="utf-8") as f:
        text = f.read()
    # Drop comments before matching keys
    text = "\n".join(line.split(";", 1)[0] for line in text.splitlines())
    for key in list(config):
        m = re.search(r":%s\s+(\"([^\"]*)\"|:([\w-]+))" % re.escape(key), text)
        if m:
            config[key] = m.group(2) if m.group(2) is not None else m.group(3)
    return config


# --------------------------------------------------------------------------- titles

def title_from_filename(file_body, name_format):
    """Inverse of Logseq's file-name sanitizing (frontend.util.fs / graph_parser.util)."""
    if name_format == "triple-lowbar":
        title = file_body.replace("___", "/")
        title = re.sub(r"(?i)%[0-9a-f]{2}", lambda m: _safe_unquote(m.group(0)), title)
        title = "/".join(p for p in title.split("/") if p)  # make-valid-namespaces
        return title
    # legacy: dots were namespace separators, everything else url-encoded
    title = file_body.replace(".", "/")
    return _safe_unquote(title)


def _safe_unquote(s):
    try:
        return urllib.parse.unquote(s)
    except Exception:
        return s


def journal_date_from_filename(file_body, file_name_format="yyyy_MM_dd"):
    fmt = file_name_format.replace("yyyy", "%Y").replace("MM", "%m").replace("dd", "%d")
    try:
        return datetime.datetime.strptime(file_body, fmt).date()
    except ValueError:
        return None


def format_journal_title(date, page_title_format="MMM do, yyyy"):
    """Format a date with Logseq's (date-fns style) journal title pattern."""
    def ordinal(n):
        if 10 <= n % 100 <= 20:
            suffix = "th"
        else:
            suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
        return f"{n}{suffix}"
    tokens = {
        "yyyy": f"{date.year:04d}", "yy": f"{date.year % 100:02d}",
        "MMMM": date.strftime("%B"), "MMM": date.strftime("%b"),
        "MM": f"{date.month:02d}", "M": str(date.month),
        "EEEE": date.strftime("%A"), "EEE": date.strftime("%a"), "E": date.strftime("%a"),
        "do": ordinal(date.day), "dd": f"{date.day:02d}", "d": str(date.day),
    }
    out, i = "", 0
    pattern = page_title_format
    while i < len(pattern):
        for tok in ("yyyy", "MMMM", "EEEE", "MMM", "EEE", "do", "dd", "MM", "yy", "M", "d", "E"):
            if pattern.startswith(tok, i):
                out += tokens[tok]
                i += len(tok)
                break
        else:
            out += pattern[i]
            i += 1
    return out


# --------------------------------------------------------------------------- parsing

class _RawBlock:
    __slots__ = ("depth", "lines", "line_start", "line_end")

    def __init__(self, depth, first_line, line_no):
        self.depth = depth
        self.lines = [first_line]
        self.line_start = line_no
        self.line_end = line_no


def _indent_depth(indent):
    """Depth from leading whitespace: tabs count one, spaces count in pairs.

    The Roam importer writes `<tab><space>- `; the lone space must not add depth.
    """
    tabs = indent.count("\t")
    spaces = indent.count(" ")
    return tabs + spaces // 2


def split_front_matter(lines):
    """Return (front_matter_dict, remaining_lines, consumed_line_count)."""
    if not lines or lines[0].strip() != "---":
        return {}, lines, 0
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            fm = {}
            for line in lines[1:i]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    fm[k.strip()] = v.strip()
            return fm, lines[i + 1:], i + 1
    return {}, lines, 0


def is_importer_layout(lines):
    """Files written by Logseq's Roam importer have `<tab> - ` bullets (a space before
    the dash) and blank lines between blocks, and write continuation lines at column 0.
    Logseq itself writes neither. In importer layout nothing is stripped from
    continuation lines, so code indentation survives."""
    prev_blank = False
    seen_bullet = False
    for line in lines:
        if re.match(r"^\t+ - ", line):
            return True
        if RE_BULLET.match(line):
            if prev_blank and seen_bullet:
                return True  # a truly empty line between two blocks
            seen_bullet = True
        # Native layout writes a blank line *inside* a block as indentation only;
        # the importer's separators between blocks are completely empty lines.
        prev_blank = (line == "")
    return False


def split_blocks(lines, first_line_no=1):
    """Split file lines into raw blocks (depth + lines). Non-bullet lines attach to the
    preceding block; leading non-bullet lines form a depth-0 pseudo block (page
    properties)."""
    raw_blocks = []
    current = None
    for offset, line in enumerate(lines):
        line = line.rstrip("\n")
        m = RE_BULLET.match(line)
        if m:
            depth = _indent_depth(m.group("indent"))
            current = _RawBlock(depth, m.group("text") or "", first_line_no + offset)
            raw_blocks.append(current)
        else:
            if current is None:
                if not line.strip():
                    continue
                # Leading non-bullet lines (page properties written without a bullet)
                current = _RawBlock(0, line, first_line_no + offset)
                raw_blocks.append(current)
            else:
                current.lines.append(line)
            current.line_end = first_line_no + offset
    return raw_blocks


def _strip_continuation_indent(line, depth):
    """Logseq writes continuation and property lines as `<indent>  <text>`, where
    <indent> is the block's bullet indentation (tabs, or two spaces per level) and
    the two extra spaces align the text under the bullet's content. Remove exactly
    that prefix when present. Lines that don't carry it (the Roam importer writes
    continuation lines at column 0) are left untouched, so a code block's own
    indentation is preserved in both layouts."""
    for indent in ("\t" * depth, "  " * depth):
        prefix = indent + "  "
        if line.startswith(prefix):
            return line[len(prefix):]
        if line.strip() == "" and line.startswith(indent):
            return ""  # blank line inside a block, written as bare indentation
    return line


def _separate_properties(lines, depth, is_first_block=False, importer_layout=False):
    """Split a raw block's lines into (content_lines, properties, marker, priority).

    Property lines are `key:: value` lines *after* the first line. A first line that
    is itself `key:: value` stays as content (ankify_roam treats it as an Attribute,
    e.g. a nested `tags:: #source` block) and is also recorded in `properties`.
    Exceptions: Logseq bookkeeping keys (`id::`, `collapsed::`...) are never
    content, and the first block of a page made only of properties is the page's
    property block, not content.
    """
    content_lines = []
    properties = {}
    first = True
    for line in lines:
        if first:
            first = False
            content_lines.append(line)
            continue
        line = line if importer_layout else _strip_continuation_indent(line, depth)
        if RE_SCHEDULED.match(line):
            continue
        if line.strip() in (":LOGBOOK:", ":END:") or line.strip().startswith("CLOCK: "):
            continue
        pm = RE_PROPERTY.match(line)
        if pm and not _inside_code(content_lines):
            properties[pm.group("key")] = pm.group("value")
            continue
        content_lines.append(line)

    # A block whose lines are all `key:: value`
    if content_lines and all(RE_PROPERTY.match(l) or not l.strip() for l in content_lines):
        kept = []
        first_props = {}
        for l in content_lines:
            m2 = RE_PROPERTY.match(l)
            if not m2:
                continue
            first_props[m2.group("key")] = m2.group("value")
            if not is_first_block and m2.group("key") not in HIDDEN_PROPERTIES:
                kept.append(l)  # stays content, as in ankify_roam
        # keep line order: the first line's properties come before those already collected
        merged = dict(first_props); merged.update({k: v for k, v in properties.items() if k not in merged})
        properties.clear(); properties.update(merged)
        content_lines = kept

    marker = priority = None
    if content_lines:
        mm = RE_MARKER.match(content_lines[0])
        if mm:
            marker, priority = mm.group("marker"), mm.group("priority")
            content_lines[0] = content_lines[0][mm.end():]

    # Trailing blank lines are file layout, not content
    while content_lines and not content_lines[-1].strip():
        content_lines.pop()
    return content_lines, properties, marker, priority


def _inside_code(content_lines):
    return sum(l.count("```") for l in content_lines) % 2 == 1


def build_page(path, text, config, title=None, is_journal=False, graph=None):
    """Parse one markdown file into a Page."""
    lines = text.splitlines()
    front_matter, body, consumed = split_front_matter(lines)
    raw_blocks = split_blocks(body, first_line_no=consumed + 1)
    importer_layout = is_importer_layout(body)

    page_properties = {}
    for k, v in front_matter.items():
        page_properties[k] = v

    blocks = []  # (depth, Block)
    for rb in raw_blocks:
        # The first block can hold the page's properties (Logseq's "pre-block"), but only
        # when the file has no front matter: with front matter, Logseq treats the first
        # bullet as an ordinary block even if it is all `key:: value` lines.
        is_first = rb is raw_blocks[0] and rb.depth == 0 and not front_matter
        content_lines, properties, marker, priority = _separate_properties(rb.lines, rb.depth, is_first_block=is_first, importer_layout=importer_layout)
        if is_first and not content_lines and any(k not in HIDDEN_PROPERTIES for k in properties):
            # Leading properties-only block = page properties. (An empty first block that
            # only carries bookkeeping such as `id::` is a real, empty block.)
            page_properties.update(properties)
            continue
        string = "\n".join(content_lines)
        try:
            content = BlockContent.from_string(string, graph=graph)
        except Exception:
            logger.exception(f"Failed parsing block at {path}:{rb.line_start}; using plain text")
            content = BlockContent(string)
        block = Block(
            content=content, uid=properties.get("id"), marker=marker,
            properties=properties, path=path, line_start=rb.line_start,
            line_end=rb.line_end, depth=rb.depth, graph=graph, raw=rb.lines,
        )
        if priority:
            block.properties.setdefault("priority", priority)
        blocks.append((rb.depth, block))

    if title is None:
        title = page_properties.get("title")
    if title is None:
        body_name = os.path.splitext(os.path.basename(path))[0]
        if is_journal:
            date = journal_date_from_filename(body_name, config.get("journal/file-name-format", "yyyy_MM_dd"))
            title = format_journal_title(date, config.get("journal/page-title-format", "MMM do, yyyy")) if date else body_name
        else:
            title = title_from_filename(body_name, config.get("file/name-format", "legacy"))

    page = Page(title=title, children=_nest(blocks), path=path, properties=page_properties,
                is_journal=is_journal, content_hash=file_hash(text.encode("utf-8")), graph=graph)
    page.front_matter = bool(front_matter)
    page.importer_layout = importer_layout
    page.propagate_parents()
    return page


def _nest(depth_blocks):
    """Turn a flat (depth, block) list into a tree using a stack. Depth jumps of more
    than one level are tolerated (the child attaches to the nearest shallower block)."""
    roots = []
    stack = []  # (depth, block)
    for depth, block in depth_blocks:
        while stack and stack[-1][0] >= depth:
            stack.pop()
        if stack:
            stack[-1][1].children.append(block)
        else:
            roots.append(block)
        stack.append((depth, block))
    return roots


def iter_graph_files(graph_dir, config):
    for sub, is_journal in ((config["pages-directory"], False), (config["journals-directory"], True)):
        d = os.path.join(graph_dir, sub)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.startswith(".") or not name.endswith(".md"):
                continue
            yield os.path.join(d, name), is_journal


def parse_graph(graph_dir, name=None):
    config = read_config(graph_dir)
    graph = LogseqGraph([], path=graph_dir, config=config, name=name)
    pages = []
    for path, is_journal in iter_graph_files(graph_dir, config):
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except UnicodeDecodeError:
            logger.warning(f"Skipping non-UTF-8 file {path}")
            continue
        try:
            pages.append(build_page(path, text, config, is_journal=is_journal, graph=graph))
        except Exception:
            logger.exception(f"Failed parsing {path}; skipping page")
    graph.pages = pages
    graph._pages_by_name = {}
    for page in pages:
        page.graph = graph
        graph._pages_by_name.setdefault(page.title.lower(), page)
    graph.propagate_parents()
    return graph
