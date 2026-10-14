import datetime
import os
import unittest

from ankify_logseq.logseq import (
    Alias, Attribute, Block, BlockRef, Cloze, Embed, LogseqGraph, Page, PageRef, PageTag,
)
from ankify_logseq.logseq.parser import (
    build_page, format_journal_title, journal_date_from_filename, read_config,
    title_from_filename,
)

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "fixtures", "graph")


def flatten(blocks):
    for b in blocks:
        yield b
        yield from flatten(b.children)


class TestTitles(unittest.TestCase):
    def test_triple_lowbar(self):
        self.assertEqual(title_from_filename("Logseq___native page", "triple-lowbar"), "Logseq/native page")
        self.assertEqual(title_from_filename("A%3F question %2F slash", "triple-lowbar"), "A? question / slash")
        self.assertEqual(title_from_filename("10% Less Democracy", "triple-lowbar"), "10% Less Democracy")
        self.assertEqual(title_from_filename("___leading", "triple-lowbar"), "leading")

    def test_legacy(self):
        self.assertEqual(title_from_filename("a.b", "legacy"), "a/b")
        self.assertEqual(title_from_filename("what%3F", "legacy"), "what?")

    def test_journal_title(self):
        d = journal_date_from_filename("2019_08_13")
        self.assertEqual(d, datetime.date(2019, 8, 13))
        self.assertEqual(format_journal_title(d, "MMM do, yyyy"), "Aug 13th, 2019")
        self.assertEqual(format_journal_title(d, "MMMM do, yyyy"), "August 13th, 2019")
        self.assertEqual(format_journal_title(datetime.date(2020, 11, 22), "MMMM do, yyyy"), "November 22nd, 2020")
        self.assertEqual(format_journal_title(datetime.date(2020, 11, 11), "MMMM do, yyyy"), "November 11th, 2020")
        self.assertEqual(format_journal_title(d, "yyyy-MM-dd EEEE"), "2019-08-13 Tuesday")

    def test_config(self):
        config = read_config(FIXTURE)
        self.assertEqual(config["journal/page-title-format"], "MMMM do, yyyy")  # not the commented-out value
        self.assertEqual(config["file/name-format"], "triple-lowbar")


class TestGraph(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.graph = LogseqGraph.from_path(FIXTURE)

    def page(self, title):
        p = self.graph.get_page(title)
        self.assertIsNotNone(p, f"page '{title}' not found; have {[p.title for p in self.graph.pages]}")
        return p

    def test_pages_and_titles(self):
        titles = sorted(p.title for p in self.graph.pages)
        self.assertEqual(titles, sorted([
            "Roam imported page", "Logseq/native page", "A? question / slash", "August 13th, 2019"]))
        self.assertTrue(self.page("August 13th, 2019").is_journal)
        self.assertEqual(self.page("Logseq/native page").properties["alias"], "native")

    def test_roam_import_layout(self):
        p = self.page("Roam imported page")
        self.assertEqual(p.properties, {"title": "Roam imported page"})
        author, meta, notes = p.children
        # with front matter, a property-only first bullet is an ordinary block (as in Logseq)
        self.assertEqual(author.to_string(), "Author:: [[lesswrong.com]]")
        self.assertEqual(author.properties, {"Author": "[[lesswrong.com]]"})
        self.assertEqual(meta.to_string(), "metadata")
        author, tags = meta.children
        # First-line attributes stay content, as in ankify_roam
        self.assertEqual(type(author.content[0]), Attribute)
        self.assertEqual(tags.to_string(), "tags:: #source")
        self.assertEqual(tags.properties, {"tags": "#source"})
        self.assertIn("source", tags.get_tags(inherit=False))
        # Column-0 continuation lines, blank lines inside the block preserved, trailing blank dropped
        placeholder = tags.children[0].children[0].children[0]
        self.assertEqual(placeholder.to_string().split("\n")[0], "[[Roam imported page]]")
        self.assertIn("\n\n#ankify #[[ankify_roam: deck=", placeholder.to_string())
        self.assertFalse(placeholder.to_string().endswith("\n"))
        self.assertIn("ankify", placeholder.get_tags(inherit=False))
        self.assertIn('ankify_roam: deck="Spaced Learning Projects::z-Sources"', placeholder.get_tags(inherit=False))
        self.assertIn("ankify_roam: suspend=True", placeholder.get_tags(inherit=False))
        # Inherited tags: parents and page
        self.assertIn("Roam imported page", placeholder.get_tags())
        self.assertIn("source", placeholder.get_tags())

    def test_column_zero_id(self):
        p = self.page("Roam imported page")
        circle = p.children[2].children[0]
        self.assertEqual(circle.uid, "35e8dd88-0367-4768-931d-6bef5183759a")
        self.assertEqual(circle.to_string(), "What is the formula for a circle? #ankify #Calculus")
        self.assertEqual(len(circle.children), 1)
        self.assertEqual(circle.children[0].to_string(), "(x-h)^2 + (y-k)^2 = r^2")
        self.assertEqual((circle.line_start, circle.line_end), (21, 22))
        self.assertIsNone(circle.parent.uid)
        self.assertEqual(circle.parent_uid, None)
        self.assertEqual(circle.parent_page.title, "Roam imported page")
        self.assertIs(self.graph.query_by_uid(circle.uid), circle)

    def test_top_level_parent_uid_is_page_title(self):
        p = self.page("Roam imported page")
        self.assertEqual(p.children[0].parent_uid, "Roam imported page")

    def test_roam_checkbox_and_cloze(self):
        p = self.page("Roam imported page")
        notes = p.children[2]
        checkbox, cloze = notes.children[1], notes.children[2]
        self.assertIn("TODO", checkbox.get_tags(inherit=False))
        self.assertTrue(any(type(o) == Cloze for o in cloze.get_contents(recursive=True)))

    def test_embeds_and_refs(self):
        p = self.page("Roam imported page")
        notes = p.children[2]
        quad, normal, ref, emph = notes.children[3:7]
        for b in (quad, normal):
            embed = [o for o in b.content if type(o) == Embed]
            self.assertEqual(len(embed), 1, b.to_string())
            self.assertEqual(embed[0].blockref.uid, "35e8dd88-0367-4768-931d-6bef5183759a")
            html = b.to_html()
            self.assertIn('rm-embed-container', html)
            self.assertIn("What is the formula for a circle?", html)  # resolved through the graph
        refs = [o for o in ref.get_contents(recursive=True) if type(o) == BlockRef]
        aliases = [o for o in ref.get_contents(recursive=True) if type(o) == Alias and type(o.destination) == BlockRef]
        self.assertEqual((len(refs), len(aliases)), (1, 1))
        self.assertIn("What is the formula for a circle?", ref.to_html())
        html = emph.to_html()
        self.assertEqual(html.count('<span class="roam-highlight">'), 1)  # ^^..^^ only; ==..== left alone
        self.assertIn("==logseq highlight==", html)
        self.assertEqual(Block.from_string("a === b and c == d").to_html(), "a === b and c == d")
        self.assertIn("<em>italic</em>", html)
        self.assertIn("<b>bold</b>", html)

    def test_importer_layout_keeps_code_indentation(self):
        p = self.page("Roam imported page")
        self.assertTrue(p.importer_layout)
        self.assertFalse(self.page("Logseq/native page").importer_layout)
        notes = p.children[2]
        url, code = notes.children[7], notes.children[8]
        self.assertEqual(url.to_string(), "URL::")
        self.assertEqual(url.properties, {"URL": ""})
        self.assertEqual(code.to_string(), "\n```python\ndef f():\n    return 4  # four spaces must survive\n```")

    def test_logseq_native_layout(self):
        p = self.page("Logseq/native page")
        self.assertEqual(p.properties["title"], "Logseq/native page")
        self.assertEqual(p.properties["tags"], "study, [[geography]]")
        self.assertEqual(p.get_tags(from_attr=True), ["Logseq/native page", "study", "geography"])
        task, multi, attr, empty, last = p.children
        # Marker, priority, SCHEDULED line, indented id
        self.assertEqual(task.marker, "TODO")
        self.assertEqual(task.properties["priority"], "A")
        self.assertEqual(task.uid, "0b0a8e59-b0f7-45cf-996b-dfe13011303c")
        self.assertEqual(task.to_string(), "first task block with priority #ankify")
        self.assertIn("TODO", task.get_tags(inherit=False))
        self.assertTrue(task.to_html().startswith('<span><label class="check-container">'))
        done, later = task.children
        self.assertEqual(done.marker, "DONE")
        self.assertEqual(done.properties, {"collapsed": "true"})
        self.assertEqual(done.to_string(), "a done child")
        self.assertEqual(later.marker, "LATER")
        self.assertNotIn("LATER", later.get_tags(inherit=False))
        # Multi-line block indented the Logseq way; logbook stripped
        self.assertEqual(multi.to_string(), "a multi-line block\nsecond line indented the Logseq way")
        self.assertEqual(multi.uid, "028b6432-9cba-433a-9f05-6c97c530082d")
        code, prop, embed = multi.children
        self.assertEqual(code.to_string(), "```python\ndef f(x):\n    return x  # indented code keeps its own indentation\n```")
        self.assertEqual(prop.properties, {"deck": "My Deck"})
        self.assertEqual(prop.to_string(), "a block with a property that is not an id")
        embeds = [o for o in embed.content if type(o) == Embed]
        self.assertEqual(type(embeds[0].blockref), PageRef)
        self.assertIn("Placeholder card for this page", embed.to_html())  # page embed resolved
        # Attribute first line stays content
        self.assertEqual(type(attr.content[0]), Attribute)
        self.assertEqual(attr.properties, {})  # keys with spaces are not Logseq properties
        self.assertEqual(empty.to_string(), "")
        self.assertEqual(last.children[0].to_string(), "grandchild attached to nearest shallower block")

    def test_journal(self):
        j = self.page("August 13th, 2019")
        card = j.children[1]
        self.assertIn("ankify", card.get_tags(inherit=False))
        self.assertEqual(card.get_tags(), ["ankify", "August 13th, 2019"])

    def test_query_many_and_hash(self):
        ankified = self.graph.query_many(lambda b: "ankify" in b.get_tags(inherit=False))
        self.assertEqual(len(ankified), 6)
        for p in self.graph.pages:
            self.assertEqual(len(p.content_hash), 64)


class TestBuildPage(unittest.TestCase):
    def test_bullet_variants(self):
        text = "- a\n\t- b\n\t - c\n  - d\n    - e\n"
        p = build_page("x/pages/t.md", text, {"file/name-format": "triple-lowbar"})
        a = p.children[0]
        self.assertEqual([b.to_string() for b in a.children], ["b", "c", "d"])
        self.assertEqual(a.children[2].children[0].to_string(), "e")

    def test_id_only_block_and_hidden_props(self):
        text = "- q\n  id:: 11111111-1111-1111-1111-111111111111\n  collapsed:: true\n  heading:: 2\n"
        p = build_page("x/pages/t.md", text, {})
        b = p.children[0]
        self.assertEqual(b.to_string(), "q")
        self.assertEqual(b.uid, "11111111-1111-1111-1111-111111111111")

    def test_property_like_line_inside_code_block_is_content(self):
        text = "- ```\n  key:: value\n  ```\n"
        p = build_page("x/pages/t.md", text, {})
        self.assertEqual(p.children[0].to_string(), "```\nkey:: value\n```")
        self.assertEqual(p.children[0].properties, {})

    def test_logseq_macro_renders_like_roam_button(self):
        from ankify_logseq.logseq import Button
        roam = Block.from_string('x {{[[roam/render]]:((nU1XMzhKA)) "Block UID" }} #ankify')
        logseq = Block.from_string('x {{roam/render ((4e6934f0-b0ae-4343-9a6e-66cf99ed4320)) "Block UID" }} #ankify')
        self.assertEqual(roam.to_html(), logseq.to_html())
        self.assertIn('<button class="bp3-button bp3-small dont-focus-block">[[roam/render]]</button>', logseq.to_html())
        self.assertEqual(Block.from_string("{{pomodoro}}").to_html(), Block.from_string("{{pomodoro}}").to_html())

    def test_escaped_dash_renders_as_dash(self):
        # (braces inside $$...$$ would be read as a cloze, as in ankify_roam; keep the LaTeX brace-free here)
        b = Block.from_string("$$x^2$$ \\- The squares\n\\- a dash line\n\\# not a heading")
        self.assertEqual(b.to_html(), "$$x^2$$ - The squares<br>- a dash line<br># not a heading")

    def test_inline_checkbox_macro_renders_like_roam_checkbox(self):
        from ankify_logseq.logseq import Checkbox
        roam = Block.from_string("{{[[DONE]]}} a {{[[TODO]]}} b")
        logseq = Block.from_string("{{renderer :cb, done, 1}} a {{renderer :cb, todo, 2}} b")
        self.assertEqual(roam.to_html(), logseq.to_html())
        self.assertEqual([type(o) for o in logseq.content if type(o) == Checkbox].count(Checkbox), 2)
        self.assertEqual(sorted(logseq.get_tags(inherit=False)), ["DONE", "TODO"])
        self.assertEqual(logseq.to_string(), "{{renderer :cb, done, 1}} a {{renderer :cb, todo, 2}} b")

    def test_title_from_filename_when_no_property(self):
        p = build_page("x/pages/Some___Name.md", "- x\n", {"file/name-format": "triple-lowbar"})
        self.assertEqual(p.title, "Some/Name")


if __name__ == "__main__":
    unittest.main()
