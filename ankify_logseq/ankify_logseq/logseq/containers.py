"""Graph, Page and Block containers for a Logseq file graph.

Mirrors ankify_roam's roam/containers.py so that the ankifier code can be shared
almost verbatim. The differences:

- A graph is loaded from a directory (pages/ + journals/) instead of a JSON export.
- A block's `uid` is its persisted Logseq uuid (`id::` property), or None when the
  block has no persisted id yet.
- Blocks know their source file and line span, so ids can be written back.
- Blocks carry a task marker (TODO/DONE/...) and their Logseq properties.
"""
import hashlib
import logging
import os
import re

from ankify_logseq.logseq.content import (
    Attribute, BlockContent, Checkbox, PageRef, String,
)

logger = logging.getLogger(__name__)


class LogseqGraph:
    def __init__(self, pages, path=None, config=None, name=None):
        self.pages = list(pages)
        self.path = path
        self.config = config or {}
        self.name = name or (os.path.basename(os.path.normpath(path)) if path else None)
        self._pages_by_name = {}
        for page in self.pages:
            page.graph = self
            self._pages_by_name[page.title.lower()] = page
        self.propagate_parents()

    @classmethod
    def from_path(cls, path, **kwargs):
        from ankify_logseq.logseq.parser import parse_graph
        return parse_graph(os.path.expanduser(path), **kwargs)

    def get_page(self, title):
        if title is None:
            return None
        return self._pages_by_name.get(title.lower())

    def query_many(self, condition):
        blocks = []
        for page in self.pages:
            blocks += page.query_many(condition)
        return blocks

    def query_by_uid(self, uid):
        if not uid:
            return None
        for page in self.pages:
            block = page.query_by_uid(uid)
            if block:
                return block

    def query_by_tag(self, tag):
        return self.query_many(lambda b: tag in b.get_tags())

    def propagate_parents(self):
        for page in self.pages:
            page.propagate_parents()

    def all_blocks(self):
        return self.query_many(lambda b: True)

    def reload_page(self, path):
        """Re-parse one page file (after something wrote to it) and swap it in."""
        from ankify_logseq.logseq.parser import build_page
        for i, page in enumerate(self.pages):
            if page.path == path:
                with open(path, encoding="utf-8") as f:
                    text = f.read()
                new = build_page(path, text, self.config, is_journal=page.is_journal, graph=self)
                self.pages[i] = new
                self._pages_by_name[new.title.lower()] = new
                return new
        return None


class Page:
    def __init__(self, title, children=None, path=None, properties=None,
                 is_journal=False, content_hash=None, graph=None):
        self.title = title
        self.children = BlockChildren(children or [])
        self.path = path
        self.properties = properties or {}
        self.is_journal = is_journal
        self.content_hash = content_hash
        self.graph = graph
        self.parse_errors = []
        self.front_matter = False  # title came from a `---` front-matter block

    @property
    def uid(self):
        # Pages only have a persisted uuid when an `id::` page property exists.
        return self.properties.get("id")

    def get_attribute(self, key, default=None):
        """Roam-style attribute block among the page's children, e.g. `tags:: [[a]]`."""
        for o in self.children:
            if o.content and type(o.content[0]) == Attribute and o.content[0].title == key:
                return o.content[1:]
        return default

    def get_tags(self, from_attr=False, drop_duplicates=False, *args, **kwargs):
        tags = [self.title]
        # Logseq page property `tags:: a, [[b]]` tags the page, and Logseq treats every
        # block on the page as carrying it (path refs); so do we, always.
        tags += _split_property_refs(self.properties.get("tags", ""))
        if from_attr:
            bc = self.get_attribute("tags")
            tags += bc.get_tags() if bc else []
        if drop_duplicates:
            tags = list(dict.fromkeys(tags))
        return tags

    def get(self, key, default=None):
        return getattr(self, key) if hasattr(self, key) else default

    def query_by_uid(self, uid, default=None, blocks=None):
        if blocks is None: blocks = self.children
        for block in blocks:
            if block.uid == uid:
                return block
            block = self.query_by_uid(uid, default=default, blocks=block.children)
            if block:
                return block
        return default

    def query_many(self, condition, blocks=None):
        if blocks is None: blocks = self.children
        res = []
        for block in blocks:
            if condition(block):
                res.append(block)
            res += self.query_many(condition, blocks=block.children)
        return res

    def num_descendants(self):
        return sum(1 + b.num_descendants() for b in self.children)

    def propagate_parents(self):
        for block in self.children:
            block.propagate_parents(parent=self)

    def to_html(self, children=False, *args, **kwargs):
        if children:
            return Block._listify_back(None, list(self.children), **kwargs)
        return PageRef(self.title, graph=self.graph).to_html(**kwargs)

    def __repr__(self):
        return "<%s(title='%s')>" % (self.__class__.__name__, self.title)


class Block:
    def __init__(self, content=None, children=None, uid=None, parent=None,
                 marker=None, properties=None, path=None, line_start=None,
                 line_end=None, depth=0, graph=None, raw=None):
        self.content = content if content is not None else BlockContent()
        self.children = BlockChildren(children or [])
        self.uid = uid
        self.parent = parent
        self.marker = marker
        self.properties = properties or {}
        self.path = path
        self.line_start = line_start
        self.line_end = line_end
        self.depth = depth
        self.graph = graph
        self.raw = raw

    # --- tree navigation (same API as ankify_roam) ---

    @property
    def parents(self):
        if isinstance(self.parent, Page):
            return [self.parent]
        elif isinstance(self.parent, Block):
            return [self.parent] + self.parent.parents
        return []

    @property
    def parent_blocks(self):
        if isinstance(self.parent, Block):
            return [self.parent] + self.parent.parent_blocks
        return []

    @property
    def parent_page(self):
        parent = self.parent
        while parent and not isinstance(parent, Page):
            parent = parent.parent
        return parent

    @property
    def parent_uid(self):
        """Persisted uid of the parent block, or the page title for top-level blocks."""
        if isinstance(self.parent, Block):
            return self.parent.uid
        if isinstance(self.parent, Page):
            return self.parent.title
        return None

    def get(self, key, default=None):
        if default is None: default = BlockChildren()
        return getattr(self, key) if hasattr(self, key) else default

    def get_attribute(self, key, default=None):
        for o in self.children:
            if o.content and type(o.content[0]) == Attribute and o.content[0].title == key:
                return o.content[1:]
        return default

    def get_tags(self, inherit=True, drop_duplicates=False, from_attr=False):
        """Tags on the block, own tags first, then parents' (see ankify_roam)."""
        tags = self.content.get_tags()
        if self.marker in ("TODO", "DONE"):
            tags = tags + [self.marker]
        if inherit:
            if isinstance(self.parent, Page):
                tags += self.parent.get_tags(from_attr=from_attr)
            elif isinstance(self.parent, Block):
                tags += self.parent.get_tags(inherit=True, from_attr=from_attr)
        if from_attr:
            bc = self.get_attribute("tags", [])
            tags += bc.get_tags() if bc else []
            tags += _split_property_refs(self.properties.get("tags", ""))
        if drop_duplicates:
            tags = list(dict.fromkeys(tags))
        return tags

    def get_contents(self, recursive=False):
        return self.content.get_contents(recursive=recursive)

    def to_string(self):
        return self.content.to_string()

    def to_html(self, children=False, *args, **kwargs):
        if children:
            return self._listify_back([self], **kwargs)
        html = self.content.to_html(*args, **kwargs)
        if self.marker in ("TODO", "DONE"):
            html = Checkbox(checked=(self.marker == "DONE")).to_html() + " " + html
        return html

    def _listify_back(self, blocks, **kwargs):
        if not blocks:
            return ""
        html_list = ""
        for block in blocks:
            html_list += f'<li>{block.to_html(**kwargs)}</li>'
            html_list += f'{Block._listify_back(None, block.children, **kwargs)}'
        return f'<ul>{html_list}</ul>'

    def num_descendants(self):
        return sum(1 + b.num_descendants() for b in self.children)

    def propagate_parents(self, parent=None):
        self.parent = parent
        for block in self.children:
            block.propagate_parents(parent=self)

    @classmethod
    def from_string(cls, string, *args, **kwargs):
        content = BlockContent.from_string(string, graph=kwargs.pop("graph", None))
        return cls(content, *args, **kwargs)

    def __repr__(self):
        return "<%s(uid='%s', string='%s')>" % (
            self.__class__.__name__, self.uid, self.to_string()[:10] + "...")


class BlockChildren(list):
    def __init__(self, blocks=()):
        for b in blocks:
            self.append(b)

    def __repr__(self):
        return "<%s(%s)>" % (self.__class__.__name__, repr(list(self)))


def _split_property_refs(value):
    """`a, [[b c]], #d` -> ['a', 'b c', 'd']"""
    if not value:
        return []
    refs = []
    for part in re.split(r",\s*", value.strip()):
        part = part.strip()
        m = re.match(r"^#?\[\[(.*)\]\]$", part)
        if m:
            refs.append(m.group(1))
        elif part.startswith("#"):
            refs.append(part[1:])
        elif part:
            refs.append(part)
    return refs


def file_hash(data):
    return hashlib.sha256(data).hexdigest()
