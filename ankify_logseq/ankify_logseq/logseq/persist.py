"""Persist Logseq block ids (`id::` properties) for blocks that lack one.

This is the sync tool's fallback for blocks the Ankify IDs plugin did not reach.
Two ways to write, chosen so that there is never more than one writer on the
graph files:

- api:  ask the running Logseq to do it (`logseq.Editor.upsertBlockProperty`), then
        wait for Logseq to write the file. Requires the HTTP API server and that
        Logseq has *this* graph open.
- file: edit the markdown file directly. Refused while any Logseq process is
        running.

`auto` picks api when Logseq is running, file otherwise. Every persisted id is
logged with file, line and uuid.
"""
import logging
import os
import re
import tempfile
import time
import uuid as uuidlib

from ankify_logseq.logseq.api import LogseqApi, LogseqApiError, logseq_process_running

logger = logging.getLogger(__name__)

RE_PROPERTY_LINE = re.compile(r"^\s*[A-Za-z0-9_.\-]+:: ?.*$")


class PersistError(Exception):
    pass


def _norm(text):
    text = "\n".join(l for l in text.splitlines() if not RE_PROPERTY_LINE.match(l))
    return re.sub(r"[\s ]+", " ", text).strip()


def blocks_needing_ids(blocks):
    """Given ankified blocks, return the unique list of blocks (them + their parent
    blocks) that have no persisted id, in file order."""
    need, seen = [], set()
    for b in blocks:
        for x in (b, b.parent if b.parent_blocks else None):
            if x is not None and not x.uid and id(x) not in seen:
                seen.add(id(x)); need.append(x)
    need.sort(key=lambda x: (x.path or "", x.line_start or 0))
    return need


class IdPersister:
    def __init__(self, graph, mode="auto", api=None, dry_run=False, wait_seconds=10):
        self.graph = graph
        self.mode = mode
        self.api = api or LogseqApi()
        self.dry_run = dry_run
        self.wait_seconds = wait_seconds
        self.written = []  # (path, line, uuid)

    # ------------------------------------------------------------------ mode

    def resolve_mode(self):
        if self.mode == "never":
            return "never"
        if self.mode in ("api", "file"):
            return self.mode
        return "api" if logseq_process_running() or self.api.reachable() else "file"

    # ------------------------------------------------------------------ entry

    def persist(self, blocks):
        """Persist ids for the given blocks (already filtered to those lacking one).
        Returns the list of blocks that now have an id. Reloads affected pages."""
        if not blocks:
            return []
        mode = self.resolve_mode()
        if mode == "never":
            logger.warning(f"{len(blocks)} block(s) lack a persisted id and --persist-ids=never; skipping them")
            return []
        if self.dry_run:
            logger.info(f"[dry run] would persist ids for {len(blocks)} block(s) via {mode}")
            return []
        if mode == "file":
            return self._persist_file(blocks)
        return self._persist_api(blocks)

    # ------------------------------------------------------------------ file mode

    def _persist_file(self, blocks):
        if logseq_process_running():
            raise PersistError("Refusing to edit graph files while a Logseq process is running. "
                               "Close Logseq, or use --persist-ids=api.")
        by_path = {}
        for b in blocks:
            by_path.setdefault(b.path, []).append(b)
        done = []
        for path, page_blocks in by_path.items():
            with open(path, encoding="utf-8") as f:
                lines = f.read().split("\n")
            # insert from the bottom so earlier line numbers stay valid
            for b in sorted(page_blocks, key=lambda x: -x.line_start):
                new_uuid = str(uuidlib.uuid4())
                lines.insert(b.line_start, f"{_property_indent(lines[b.line_start - 1], b.depth)}id:: {new_uuid}")
                self.written.append((path, b.line_start + 1, new_uuid))
                logger.info(f"persisted id {new_uuid} at {path}:{b.line_start + 1} (file)")
                done.append(b)
            _atomic_write(path, "\n".join(lines))
            self.graph.reload_page(path)
        return done

    # ------------------------------------------------------------------ api mode

    def _persist_api(self, blocks):
        try:
            current = self.api.current_graph()
        except LogseqApiError as e:
            raise PersistError(f"Logseq is running but its HTTP API is not usable: {e}")
        if not current or os.path.realpath(current.get("path", "")) != os.path.realpath(self.graph.path):
            raise PersistError(f"Logseq has graph {current and current.get('path')!r} open, not {self.graph.path!r}. "
                               "Switch graphs in Logseq, or close it and use --persist-ids=file.")
        by_page = {}
        for b in blocks:
            by_page.setdefault(b.parent_page, []).append(b)
        done = []
        for page, page_blocks in by_page.items():
            tree = self.api.page_blocks_tree(page.title)
            index = _index_tree(tree)
            targets = []
            for b in page_blocks:
                u = _find_uuid(b, index)
                if not u:
                    logger.error(f"Could not match block at {b.path}:{b.line_start} to a block in Logseq's view of "
                                 f"page '{page.title}'; not persisted")
                    continue
                self.api.upsert_block_property(u, "id", u)
                targets.append((b, u))
                self.written.append((b.path, b.line_start, u))
                logger.info(f"persisted id {u} at {b.path}:{b.line_start} (api)")
            if targets and self._wait_for_file(page.path, [u for _, u in targets]):
                self.graph.reload_page(page.path)
                done += [b for b, _ in targets]
            elif targets:
                logger.error(f"Logseq did not write {page.path} within {self.wait_seconds}s; ids are in memory only")
            time.sleep(0.4)  # let Logseq's file watcher settle before touching the next page
        return done

    def _wait_for_file(self, path, uuids):
        deadline = time.time() + self.wait_seconds
        while time.time() < deadline:
            try:
                with open(path, encoding="utf-8") as f:
                    text = f.read()
                if all(f"id:: {u}" in text for u in uuids):
                    return True
            except FileNotFoundError:
                pass
            time.sleep(0.25)
        return False


# ---------------------------------------------------------------------- helpers

def _index_tree(tree):
    """Flatten Logseq's page tree into [(path_tuple, normalized_content, uuid)]."""
    out = []
    def walk(bs, prefix):
        for i, b in enumerate(bs or []):
            p = prefix + (i,)
            out.append((p, _norm(b.get("content") or ""), b.get("uuid")))
            walk(b.get("children"), p)
    walk(tree, ())
    return out


def _tree_path(block):
    path = []
    node = block
    while node is not None and hasattr(node, "parent") and node.parent is not None:
        siblings = node.parent.children
        path.append(next(i for i, s in enumerate(siblings) if s is node))
        node = node.parent if hasattr(node.parent, "parent") else None
    return tuple(reversed(path))


def _find_uuid(block, index):
    """Match our parsed block to Logseq's: same tree position with the same text,
    else the unique block on the page with the same text."""
    want = _norm(block.to_string())
    path = _tree_path(block)
    for p, text, u in index:
        if p == path and text == want:
            return u
    same = [u for p, text, u in index if text == want]
    if len(same) == 1:
        return same[0]
    return None


def _property_indent(bullet_line, depth):
    """Indentation Logseq uses for a property line under a bullet: the bullet's
    indentation (tabs, or two spaces per level; the Roam importer's stray space
    before the dash is not part of it) plus two spaces."""
    lead = re.match(r"^[ \t]*", bullet_line).group(0)
    if "\t" in lead:
        return "\t" * lead.count("\t") + "  "
    return "  " * depth + "  "


def _atomic_write(path, text):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".ankify_", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise
