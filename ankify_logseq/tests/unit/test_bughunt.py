"""Regressions for the defects found in the 2026-11-20 review."""
import unittest
from types import SimpleNamespace

from ankify_logseq.logseq.parser import build_page
from ankify_logseq.logseq.persist import _find_uuid, _id_line_index, _index_tree, _norm


def flatten(blocks):
    for b in blocks:
        yield b
        yield from flatten(b.children)


def page(text):
    return build_page("/tmp/p.md", text, {}, title="p")


class TestParser(unittest.TestCase):
    def test_dash_lines_inside_a_fence_stay_in_the_block(self):
        blocks = list(flatten(page("- q #ankify\n  ```yaml\n  - a\n  - b\n  ```\n- next\n").children))
        self.assertEqual([b.to_string() for b in blocks], ["q #ankify\n```yaml\n- a\n- b\n```", "next"])

    def test_unclosed_fence_does_not_swallow_the_page(self):
        blocks = list(flatten(page("- ```\n- a\n- b\n").children))
        self.assertEqual(len(blocks), 3)

    def test_double_colon_without_space_is_content(self):
        b = page("- q #ankify\n  std::vector is the default\n  id:: abc\n  empty::\n").children[0]
        self.assertEqual(b.to_string(), "q #ankify\nstd::vector is the default")
        self.assertEqual(b.uid, "abc")
        self.assertEqual(b.properties.get("empty"), "")

    def test_line_numbers_count_newlines_only(self):
        blocks = page("- first still first\n- second\x0cx #ankify\n- third\n").children
        self.assertEqual([b.line_start for b in blocks], [1, 2, 3])

    def test_open_markers_render_as_unchecked_todo(self):
        later, cancelled = page("- LATER read it\n- CANCELED plan\n").children
        self.assertIn("TODO", later.get_tags())
        self.assertIn('type="checkbox"', later.to_html())
        self.assertIn("DONE", cancelled.get_tags())


class TestPersist(unittest.TestCase):
    def test_id_goes_after_a_fence_opened_on_the_first_line(self):
        text = "- ```python\n  x = 1\n  ```\n  what? #ankify\n- other"
        b = page(text).children[0]
        self.assertEqual(_id_line_index(text.split("\n"), b), 3)
        plain = "- plain #ankify\n- other"
        self.assertEqual(_id_line_index(plain.split("\n"), page(plain).children[0]), 1)

    def test_norm_drops_what_the_parser_drops(self):
        self.assertEqual(_norm("TODO [#A] what is x? #ankify\nSCHEDULED: <2026-01-01 Thu>\nid:: 1"), "what is x? #ankify")
        self.assertEqual(_norm("tags:: foo"), "tags:: foo")

    def test_page_properties_block_does_not_shift_positions(self):
        a, b = page("tags:: foo\n\n- same #ankify\n- same #ankify\n").children
        tree = [{"uuid": "pre", "content": "tags:: foo", "children": []},
                {"uuid": "A", "content": "same #ankify", "children": []},
                {"uuid": "B", "content": "same #ankify", "children": []}]
        index = _index_tree(tree)
        self.assertEqual((_find_uuid(a, index), _find_uuid(b, index)), ("A", "B"))


class TestOptions(unittest.TestCase):
    def test_include_page_accepts_lowercase(self):
        from ankify_logseq.ankifiers import BlockAnkifier
        ank = BlockAnkifier.__new__(BlockAnkifier)
        ank.include_page = False
        ank._get_option = lambda block, key: "true"
        self.assertTrue(ank._get_include_page(SimpleNamespace()))
        ank.include_page = True
        ank._get_option = lambda block, key: "False"
        self.assertFalse(ank._get_include_page(SimpleNamespace()))


if __name__ == "__main__":
    unittest.main()
