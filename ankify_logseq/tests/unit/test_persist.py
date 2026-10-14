import os
import re
import shutil
import tempfile
import unittest

from ankify_logseq.logseq import LogseqGraph
from ankify_logseq.logseq import persist as persist_mod
from ankify_logseq.logseq.persist import IdPersister, PersistError, blocks_needing_ids

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "fixtures", "graph")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class FakeApi:
    """Stands in for the Logseq HTTP API: serves the page tree built from our own
    parse (with made-up uuids) and records upserts, writing the id into the file the
    way Logseq would."""

    def __init__(self, graph, graph_path):
        self.graph = graph
        self.graph_path = graph_path
        self.upserts = []
        self.uuids = {}

    def reachable(self):
        return True

    def current_graph(self):
        return {"name": "fixture", "path": self.graph_path}

    def page_blocks_tree(self, name):
        page = self.graph.get_page(name)
        def conv(b):
            u = b.uid or self.uuids.setdefault(id(b), f"aaaaaaaa-0000-4000-8000-{len(self.uuids):012d}")
            return {"uuid": u, "content": b.to_string(), "children": [conv(c) for c in b.children]}
        return [conv(b) for b in page.children]

    def upsert_block_property(self, uuid, key, value):
        self.upserts.append((uuid, key, value))
        # emulate Logseq writing the file: find the block by uuid and add an id:: line
        for page in self.graph.pages:
            for b in page.query_many(lambda b: True):
                if self.uuids.get(id(b)) == uuid and not b.uid:
                    with open(b.path, encoding="utf-8") as f:
                        lines = f.read().split("\n")
                    # earlier writes shift line numbers: find the block's bullet line by text
                    at = next(i for i in range(b.line_start - 1, len(lines))
                              if persist_mod.re.match(r"^[ \t]*- ", lines[i]) and lines[i].rstrip().endswith(b.raw[0].rstrip()))
                    lines.insert(at + 1, f"{persist_mod._property_indent(lines[at], b.depth)}id:: {uuid}")
                    with open(b.path, "w", encoding="utf-8") as f:
                        f.write("\n".join(lines))
                    return


class TestPersist(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.gdir = os.path.join(self.tmp, "graph")
        shutil.copytree(FIXTURE, self.gdir)
        self.graph = LogseqGraph.from_path(self.gdir)
        self._running = persist_mod.logseq_process_running
        persist_mod.logseq_process_running = lambda: False

    def tearDown(self):
        persist_mod.logseq_process_running = self._running
        shutil.rmtree(self.tmp)

    def ankified(self):
        return self.graph.query_many(lambda b: "ankify" in b.get_tags(inherit=False))

    def test_blocks_needing_ids(self):
        need = blocks_needing_ids(self.ankified())
        texts = sorted(b.to_string().splitlines()[0][:30] for b in need)
        # 4 ankified blocks lack ids, plus 2 parents without ids (others are persisted or the page)
        self.assertEqual(len(need), 6, texts)
        self.assertTrue(all(b.uid is None for b in need))

    def test_file_mode_writes_ids_and_reloads(self):
        need = blocks_needing_ids(self.ankified())
        p = IdPersister(self.graph, mode="file")
        done = p.persist(need)
        self.assertEqual(len(done), len(need))
        self.assertEqual(len(p.written), len(need))
        # every ankified block and parent now has an id after reload
        self.assertEqual(blocks_needing_ids(self.ankified()), [])
        for b in self.ankified():
            self.assertTrue(UUID_RE.match(b.uid), b)
            if b.parent_blocks:
                self.assertTrue(UUID_RE.match(b.parent.uid))
        # id lines are indented under their block, and nothing else changed
        with open(os.path.join(self.gdir, "pages", "roam-imported.md"), encoding="utf-8") as f:
            new = f.read().split("\n")
        with open(os.path.join(FIXTURE, "pages", "roam-imported.md"), encoding="utf-8") as f:
            old = f.read().split("\n")
        added = [l for l in new if l not in old]
        self.assertTrue(all(re.match(r"^\t*  id:: [0-9a-f-]{36}$", l) for l in added), added)
        self.assertEqual([l for l in old if l not in new], [])

    def test_file_mode_refuses_while_logseq_runs(self):
        persist_mod.logseq_process_running = lambda: True
        with self.assertRaises(PersistError):
            IdPersister(self.graph, mode="file").persist(blocks_needing_ids(self.ankified()))

    def test_never_and_dry_run_write_nothing(self):
        need = blocks_needing_ids(self.ankified())
        self.assertEqual(IdPersister(self.graph, mode="never").persist(need), [])
        self.assertEqual(IdPersister(self.graph, mode="file", dry_run=True).persist(need), [])
        self.assertEqual(blocks_needing_ids(self.ankified()), need)

    def test_api_mode(self):
        api = FakeApi(self.graph, self.gdir)
        need = blocks_needing_ids(self.ankified())
        p = IdPersister(self.graph, mode="api", api=api, wait_seconds=2)
        done = p.persist(need)
        self.assertEqual(len(done), len(need))
        self.assertEqual(len(api.upserts), len(need))
        self.assertTrue(all(k == "id" and u == v for u, k, v in api.upserts))
        self.assertEqual(blocks_needing_ids(self.ankified()), [])

    def test_api_mode_refuses_other_graph(self):
        api = FakeApi(self.graph, "/somewhere/else")
        with self.assertRaises(PersistError):
            IdPersister(self.graph, mode="api", api=api).persist(blocks_needing_ids(self.ankified()))


if __name__ == "__main__":
    unittest.main()
