"""Round-trip tests for the import tooling.

    cd switching-from-roam-to-logseq && /usr/bin/python3 -m unittest discover tests
"""
import json
import os
import re
import shutil
import tempfile
import unittest

import roam2logseq  # noqa: F401  (puts ankify_logseq on sys.path)
from ankify_logseq.logseq import LogseqGraph
from ankify_logseq.logseq.parser import build_page, read_config
from roam2logseq.fix_export import Fixer
from roam2logseq.normalize_graph import NAMESPACE, derived_uuid, norm_text, roam_to_logseq_text, title_to_filename
from roam2logseq.serialize import page_text

HERE = os.path.dirname(os.path.abspath(__file__))
ANKIFY_FIXTURE = os.path.normpath(os.path.join(HERE, "..", "..", "ankify_logseq", "tests", "fixtures", "graph"))
MINI = os.path.join(HERE, "..", "fixtures", "mini-roam-export.json")


def flat(page):
    out = []
    def walk(bs, d):
        for b in bs:
            text = b.to_string()
            if text.startswith("\n```"):
                text = text[1:]  # the serializer drops the importer's newline before a fence
            out.append((d, b.marker, text, b.uid, {k: v for k, v in b.properties.items() if k != "id"}))
            walk(b.children, d + 1)
    walk(page.children, 0)
    return out


class TestSerializer(unittest.TestCase):
    def test_roundtrip_both_layouts(self):
        """parse -> serialize (native) -> parse gives the same tree, for the Roam-importer
        layout and the native layout alike; the serialized form is stable."""
        g = LogseqGraph.from_path(ANKIFY_FIXTURE)
        for page in g.pages:
            text = page_text(page)
            again = build_page(page.path, text, g.config, is_journal=page.is_journal)
            self.assertEqual(flat(again), flat(page), page.title)
            self.assertEqual(again.title, page.title)
            self.assertEqual(page_text(again), text)
            # native layout: no column-0 continuation lines, tabs only, no blank separator lines
            for line in text.split("\n")[:-1]:
                if line.startswith("---") or line.startswith("title:") or re.match(r"^[a-z]+:: ", line) or line == "":
                    continue
                self.assertTrue(re.match(r"^\t*(- |-$|  )", line), repr(line))

    def test_empty_block_with_id_uses_logseq_form(self):
        from ankify_logseq.logseq import Block
        from roam2logseq.serialize import block_lines
        b = Block.from_string("", uid="11111111-1111-1111-1111-111111111111")
        self.assertEqual(block_lines(b, 1), ["\t- id:: 11111111-1111-1111-1111-111111111111"])
        again = build_page("x/pages/t.md", "\n".join(block_lines(b, 0)) + "\n", {})
        self.assertEqual((again.children[0].to_string(), again.children[0].uid), ("", "11111111-1111-1111-1111-111111111111"))

    def test_empty_first_block_keeps_two_line_form(self):
        from ankify_logseq.logseq import Block, Page
        pg = Page("t", path="x/pages/t.md")
        a = Block.from_string("", uid="11111111-1111-1111-1111-111111111111"); b = Block.from_string("", uid="22222222-2222-2222-2222-222222222222")
        pg.children.extend([a, b]); pg.propagate_parents()
        self.assertEqual(page_text(pg), "-\n  id:: 11111111-1111-1111-1111-111111111111\n- id:: 22222222-2222-2222-2222-222222222222\n")
        again = build_page("x/pages/t.md", page_text(pg), {})
        self.assertEqual([(c.to_string(), c.uid) for c in again.children], [("", a.uid), ("", b.uid)])

    def test_uuid_for_hook_and_markers(self):
        g = LogseqGraph.from_path(ANKIFY_FIXTURE)
        page = g.get_page("Logseq/native page")
        text = page_text(page, uuid_for=lambda b: "11111111-1111-1111-1111-111111111111")
        self.assertIn("- TODO [#A] first task block with priority #ankify\n  id:: 11111111-1111-1111-1111-111111111111\n", text)
        self.assertIn("\t- DONE a done child\n\t  id:: 11111111-1111-1111-1111-111111111111\n\t  collapsed:: true\n", text)
        self.assertTrue(text.startswith("title:: Logseq/native page\ntags:: study, [[geography]]\nalias:: native\n- TODO"))
        # code-fence-first block: fence on the bullet line, id after the closing fence
        self.assertIn("\t- ```python\n\t  def f(x):\n\t      return x  # indented code keeps its own indentation\n\t  ```\n\t  id:: 11111111-1111-1111-1111-111111111111\n", text)


class TestDerivedIds(unittest.TestCase):
    def test_deterministic(self):
        self.assertEqual(derived_uuid("abc123XYZ"), derived_uuid("abc123XYZ"))
        self.assertNotEqual(derived_uuid("abc123XYZ"), derived_uuid("abc123XYz"))
        self.assertEqual(str(NAMESPACE), "%s" % NAMESPACE)  # stable constant
        self.assertRegex(derived_uuid("nU1XMzhKA"), r"^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


class TestCodeRepair(unittest.TestCase):
    def test_inline_code_repaired(self):
        from roam2logseq.normalize_graph import repair_inline_code_from_roam, inline_code
        roam = "use `{{[[embed]]: ((abc123XYZ))}}` here and ```\n{{x: y}}\n```"
        logseq = "use `{{embed  ((6a9b-uuid))}}` here and ```\n{{x  y}}\n```"
        fixed = repair_inline_code_from_roam(logseq, roam)
        self.assertEqual(inline_code(fixed), inline_code(roam))
        self.assertTrue(fixed.startswith("use `{{[[embed]]: ((abc123XYZ))}}` here"))
        self.assertIn("{{x  y}}", fixed)  # fenced part untouched by this repair
        self.assertIsNone(repair_inline_code_from_roam("`a` `b`", "`a`"))


class TestNormText(unittest.TestCase):
    def test_roam_and_logseq_forms_agree(self):
        pairs = [
            ("{{[[TODO]]}} a task", "a task"),
            ("{{[[embed]]: ((abc123XYZ))}}", "{{embed ((6a9b-uuid))}}"),
            ("{{[[roam/render]]:((abc123XYZ)) \"Block UID\" }}", "{{roam/render ((6a9b)) \"Block UID\" }}"),
            ("see ((abc123XYZ)) here", "see ((11111111-1111-1111-1111-111111111111)) here"),
            ("line one\n\nline  two  ", "line one\nline two"),
            ("{{embed: ((abc123XYZ))}}", "{{embed  ((6a9b-uuid))}}"),
            ("{{iframe: https://x}}", "{{iframe  https://x}}"),
            ("{{alias: [[A]] b}}", "{{alias [[A]] b}}"),
            ("{{[[DONE]]}} {{[[TODO]]}} Kathryn", "TODO Kathryn"),
            ("{{[[DONE]]}}{{[[DONE]]}}{{[[DONE]]}}", "DONEDONEDONE"),
            ("{{[[DONE]]}}. [[x]]", "DONE. [[x]]"),
            ("\ufeff[4] (13:27)\xa0text", "[4] (13:27) text"),
            ("```js\nfoo();```", "\n```js\nfoo();\n```"),
        ]
        for roam, logseq in pairs:
            self.assertEqual(norm_text(roam), norm_text(logseq), (roam, logseq))


class TestFixer(unittest.TestCase):
    def test_mini_export(self):
        with open(MINI, encoding="utf-8") as f:
            pages = json.load(f)
        fx = Fixer(pages); out = fx.run()
        titles = [p["title"] for p in out]
        self.assertNotIn("December 16th, 2019 ", titles)
        self.assertEqual(fx.counts["pages merged"], 1)
        self.assertEqual(fx.counts["surplus-paren embeds"], 2)
        self.assertEqual(fx.counts["latex-dash first lines"], 1)
        self.assertEqual(fx.counts["dash continuation lines"], 2)
        strings = [b["string"] for p in out for b, _ in __import__("roam2logseq.fix_export", fromlist=["walk"]).walk(p["children"])]
        self.assertTrue(any(s.startswith("$$\\mathbb{N}$$ \\- ") for s in strings))
        self.assertTrue(any("\n\\- this continuation" in s for s in strings))
        fx2 = Fixer([{"title": "h", "children": [{"string": "yaml:\n# comment\n  ## deeper\n```\n# in code stays\n```", "uid": "hhhhhhhhh"}]}]); out2 = fx2.run()
        self.assertEqual(out2[0]["children"][0]["string"], "yaml:\n\\# comment\n  \\## deeper\n```\n# in code stays\n```")
        self.assertEqual(fx2.counts["heading-like continuation lines"], 2)
        self.assertTrue(all("((((" not in s for s in strings))
        self.assertTrue(any("[[December 16th, 2019]] and a daily page ref [[December 16th, 2019]]" in s for s in strings))
        journal = next(p for p in out if p["title"] == "December 16th, 2019")
        self.assertEqual(journal["children"][0]["string"], "A daily note block")
        self.assertTrue(journal["children"][1]["string"].startswith("Merged on import from Roam page"))
        self.assertEqual(fx.title_map(), {"December 16th, 2019 ": "December 16th, 2019"})

    def test_duplicate_uids_and_empty_titles(self):
        pages = [
            {"title": "A", "children": [{"string": "x", "uid": "dupdupdup"}, {"string": "x", "uid": "dupdupdup",
                                          "children": [{"string": "y", "uid": "dupdupdup"}]}]},
            {"title": "   ", "children": [{"string": "orphan", "uid": "orphan001"}]},
            {"title": "", "children": []},
        ]
        fx = Fixer(pages); out = fx.run()
        uids = [b["uid"] for p in out for b, _ in __import__("roam2logseq.fix_export", fromlist=["walk"]).walk(p.get("children", []))]
        self.assertEqual(len(uids), len(set(uids)))
        self.assertEqual(uids[0], "dupdupdup")
        self.assertTrue(all(len(u) == 9 for u in uids))
        self.assertEqual(fx.counts["duplicate block uids replaced"], 2)
        self.assertEqual(fx.uid_map(), {u: "dupdupdup" for u in uids[1:3]})
        titles = [p["title"] for p in out]
        self.assertIn("Untitled Roam page", titles)
        self.assertNotIn("", titles); self.assertNotIn("   ", titles)


class TestRoamToLogseq(unittest.TestCase):
    def test_conversion(self):
        u = lambda uid: "U-" + uid
        self.assertEqual(roam_to_logseq_text("{{[[TODO]]}} do it ((abc123XYZ))", u), ("TODO", "do it ((U-abc123XYZ))"))
        self.assertEqual(roam_to_logseq_text("{{[[embed]]: ((abc123XYZ))}}", u), (None, "{{embed ((U-abc123XYZ))}}"))
        self.assertEqual(roam_to_logseq_text("{{embed: ((abc123XYZ))}} {{iframe: x}}", u), (None, "{{embed ((U-abc123XYZ))}} {{iframe x}}"))
        self.assertEqual(roam_to_logseq_text("{{- $x := 1 -}}", u), (None, "{{- $x := 1 -}}"))  # not a Roam macro: untouched
        self.assertEqual(roam_to_logseq_text("\ufeffDONE", u), ("DONE", ""))
        self.assertEqual(roam_to_logseq_text("  \n\n TODO leading space and blank lines \n", u), ("TODO", "leading space and blank lines"))
        self.assertEqual(roam_to_logseq_text("keep\n  inner indentation\n", u), (None, "keep\n  inner indentation"))
        self.assertEqual(roam_to_logseq_text("{{[[DONE]]}}{{[[DONE]]}}", u), ("DONE", "DONE"))  # glued: a space is added so the first is a marker (2026-09-05)

    def test_filenames(self):
        self.assertEqual(title_to_filename("Logseq/native page"), "Logseq___native page.md")
        self.assertEqual(title_to_filename("A? question: yes"), "A%3F question%3A yes.md")
        self.assertEqual(title_to_filename("What was\xa0[[John]]'s plan"), "What was [[John]]'s plan.md")


class TestFixFences(unittest.TestCase):
    def test_fences(self):
        from roam2logseq.convert import fix_fences
        self.assertEqual(fix_fences("```js\nx```"), "```js\nx\n```")
        self.assertEqual(fix_fences("```js\nx\n``` #ankify"), "```js\nx\n```\n #ankify")
        self.assertEqual(fix_fences("```js\nx\n```  \n#ankify"), "```js\nx\n```\n  \n#ankify")
        self.assertEqual(fix_fences("a ```js\nx\n```\nb"), "a ```js\nx\n```\nb")
        self.assertEqual(fix_fences("```\n```"), "```\n```")
        self.assertEqual(fix_fences("no fences"), "no fences")
        self.assertEqual(fix_fences("odd ``` fence"), "odd ``` fence")
        self.assertEqual(fix_fences("```a\n1```\n```b\n2```"), "```a\n1\n```\n```b\n2\n```")


class TestRenameKeys(unittest.TestCase):
    def test_rename(self):
        from roam2logseq.convert import rename_property_keys
        self.assertEqual(rename_property_keys("Author(s):: [[X]]\nfoo:: bar"), ("Author:: [[X]]\nfoo:: bar", [("Author(s)", "Author")]))
        self.assertEqual(rename_property_keys("source(S)::")[0], "Source::")
        self.assertEqual(rename_property_keys("Author::")[1], [])
        self.assertEqual(rename_property_keys("x Author(s):: y")[1], [])
        self.assertEqual(rename_property_keys("```\nAuthor(s):: y\n```")[1], [])
        self.assertEqual(rename_property_keys("Start time:: 9:00"), ("start-time:: 9:00", [("Start time", "start-time")]))
        self.assertEqual(rename_property_keys("page created on:: [[May 23rd, 2024]]")[0], "page-created-on:: [[May 23rd, 2024]]")
        self.assertEqual(rename_property_keys("{{[[TODO]]}} Credence:: 0.7")[1], [])
        self.assertEqual(rename_property_keys("Start time:: 9\nStart time:: 10")[1], [("Start time", "start-time")] * 2)


class TestLogseqLink(unittest.TestCase):
    def test_link(self):
        from roam2logseq.convert import add_logseq_link
        s = "[[My page]]\nWeb link: https://roamresearch.com/#/app/eli/page/PAGEUID01\nDesktop link: roam://#/app/eli/page/PAGEUID01\n#ankify"
        out, kind = add_logseq_link(s, "g", {"PAGEUID01": "My page"}, set(), "u")
        self.assertEqual(kind, "page")
        self.assertEqual(out.split("\n")[1], "Logseq link: logseq://graph/g?page=My%20page")
        self.assertEqual(out.split("\n")[2], "Roam web link: https://roamresearch.com/#/app/eli/page/PAGEUID01")
        self.assertEqual(out.split("\n")[3], "Roam desktop link: roam://#/app/eli/page/PAGEUID01")
        out, kind = add_logseq_link("  Web link: https://roamresearch.com/#/app/eli/page/BLOCKUID1", "g", {}, {"BLOCKUID1"}, "u")
        self.assertEqual(kind, "block")
        self.assertTrue(out.startswith("  Logseq link: logseq://graph/g?block-id=" ))
        out, kind = add_logseq_link("Web link: https://roamresearch.com/#/app/eli/page/NOPE00000", "g", {}, set(), "u")
        self.assertEqual((kind, out.split("\n")[0]), ("this block (unknown uid)", "Logseq link: logseq://graph/g?block-id=u"))
        self.assertEqual(add_logseq_link("no links here", "g", {}, set(), "u"), ("no links here", None))


class TestRoamRenderAndFrontMatter(unittest.TestCase):
    def test_roam_render(self):
        from roam2logseq.convert import convert_roam_render
        s = 'Q #ankify {{[[roam/render]]:((nU1XMzhKA)) "Block UID" }} #[[ankify_roam: suspend=False]]'
        self.assertEqual(convert_roam_render(s), ("Q #ankify {{renderer :ankify-active}} #[[ankify_roam: suspend=False]]", ['{{[[roam/render]]:((nU1XMzhKA)) "Block UID" }}']))
        self.assertEqual(convert_roam_render('{{[[roam/render]]:((nU1XMzhKA)). "Block UID"}}')[0], "{{renderer :ankify-active}}")
        self.assertEqual(convert_roam_render('{{[[roam/render]]:((other0000)) "Other"}}')[1], [])

    def test_front_matter(self):
        from roam2logseq.convert import needs_front_matter, filename_to_title
        from roam2logseq.normalize_graph import title_to_filename
        for t in ("Plain", "a/b", "AI 2040: Plan A", "LeetCode problem #14", "50% off", "x___y", ".dotfile", "Foo & Bar"):
            self.assertEqual(filename_to_title(title_to_filename(t)), t, t)
            self.assertFalse(needs_front_matter(t, "pages/" + title_to_filename(t), "text"), t)
        self.assertTrue(needs_front_matter("Plain", "pages/Plain.md", ""))
        self.assertTrue(needs_front_matter("Plain", "pages/Plain.md", "tags:: source\nurl:: x"))
        self.assertFalse(needs_front_matter("Plain", "pages/Plain.md", "metadata"))


class TestLiftMetadata(unittest.TestCase):
    def test_lift(self):
        from roam2logseq.convert import lift_metadata
        cards = {"uid": "c1", "string": "Cards", "children": [{"uid": "c2", "string": "Q #ankify"}]}
        tree = [{"uid": "m", "string": "metadata", "children": [
                    {"uid": "s", "string": "Subtitle: The sub"},
                    {"uid": "a", "string": "Author(s):: [[X]]", "children": [{"uid": "n", "string": "note on author"}]},
                    {"uid": "t", "string": "tags:: #source", "children": [cards]},
                    {"uid": "o", "string": "some other text"},
                    {"uid": "p", "string": "page created on:: [[May 1st, 2024]]"}]},
                {"uid": "g", "string": "Global notes"}]
        new, props, lifted, meta = lift_metadata(tree)
        self.assertEqual(props, [("subtitle", "The sub"), ("author", "[[X]]"), ("tags", "#source"), ("page-created-on", "[[May 1st, 2024]]")])
        self.assertEqual([b["uid"] for b in new], ["n", "c1", "o", "g"])   # leftovers become top-level, in order
        self.assertEqual(meta, "m")
        self.assertEqual([(r["roam_uid"], r["index"], r["children"]) for r in lifted], [("s", 0, []), ("a", 1, ["n"]), ("t", 2, ["c1"]), ("p", 4, [])])
        # a referenced attribute block stays a block (moved to top level)
        new2, props2, lifted2, _ = lift_metadata(tree, referenced={"a"})
        self.assertEqual(([k for k, v in props2], [b["uid"] for b in new2]), (["subtitle", "tags", "page-created-on"], ["a", "c1", "o", "g"]))
        # no metadata block -> untouched
        self.assertEqual(lift_metadata([{"uid": "g", "string": "y"}])[1:], ([], [], None))
        # blank values kept
        self.assertEqual(lift_metadata([{"uid": "m", "string": "metadata", "children": [{"uid": "a", "string": "Author(s)::"}, {"uid": "s", "string": "Subtitle:"}]}])[1], [("author", ""), ("subtitle", "")])


class TestOptionTags(unittest.TestCase):
    def test_rename(self):
        from roam2logseq.convert import rename_option_tags, rename_option_title
        self.assertEqual(rename_option_tags('Q #ankify #[[ankify_roam: deck="A::B"]] [[ankify_roam: suspend=True]] [[ankify_roam]] #ankify_roam'),
                         ('Q #ankify #[[ankify_logseq: deck="A::B"]] [[ankify_logseq: suspend=True]] [[ankify_roam]] #ankify_roam', 2))
        self.assertEqual(rename_option_tags("`[[ankify_roam: x]]`")[1], 0)
        self.assertEqual(rename_option_title('ankify_roam: deck="X"'), 'ankify_logseq: deck="X"')
        self.assertEqual(rename_option_title("ankify_roam"), "ankify_roam")


class TestButtons(unittest.TestCase):
    def test_buttons(self):
        from roam2logseq.convert import convert_buttons
        self.assertEqual(convert_buttons("{{[[TODO]]}} {{[[yes]]}} x {{[[Focusing checklist]]}} {{nap}}"),
                         ("{{[[TODO]]}} {{renderer :rbutton, [[yes]]}} x {{renderer :rbutton, [[Focusing checklist]]}} {{renderer :rbutton, nap}}", 3, ["yes", "Focusing checklist"]))
        self.assertEqual(convert_buttons("{{[[embed]]: ((x))}} {{query: {and: [[a]]}}} {{word-count}} {{table}}")[1], 0)
        self.assertEqual(convert_buttons("```\n{{end}} {{define \"main\"}}\n```")[1], 0)
        self.assertEqual(convert_buttons("{{renderer :cb, todo, 1}}")[1], 0)


class TestTemplates(unittest.TestCase):
    def test_tokens(self):
        from roam2logseq.convert import convert_template_text, template_name
        self.assertEqual(template_name("[[Daily page template]] #SmartBlock"), "Daily page template")
        self.assertEqual(template_name("Book chapter template: #SmartBlock"), "Book chapter template")
        self.assertEqual(template_name("#SmartBlock Journaling prompt"), "Journaling prompt")
        src = "<%CONCAT:[,[<%CURRENTPAGENAME%>],]%>\n\nWeb link: https://roamresearch.com/#/app/eli/page/<%GETPAGEUID%>\nDesktop link: roam://#/app/eli/page/<%GETPAGEUID%>\n\n#ankify"
        self.assertEqual(convert_template_text(src), "{%CURRENTPAGE%}\n\nLogseq link: {%PAGELINK%}\n\n#ankify")
        self.assertEqual(convert_template_text("page created on:: <%DATE%>"), "page created on:: {%DATE%}")
        self.assertEqual(convert_template_text("<%DATE:1 year ago%>"), "{%DATE:1 year ago%}")
        self.assertEqual(convert_template_text("<%CURRENTPAGENAME%>'s state?"), "{%CURRENTPAGENAME%}'s state?")
        self.assertEqual(convert_template_text("<%RESOLVEBLOCKREF:<%PARENT:<%TRIGGERREF%>%>%><%PARENT:<%TRIGGERREF%>,fun,false%>\nWeb link: https://roamresearch.com/#/app/eli/page/<%GET:fun%>\nDesktop link: roam://#/app/eli/page/<%GET:fun%>"),
                         "{%PARENTTEXT%}\nLogseq link: {%PARENTLINK%}")
        self.assertEqual(convert_template_text("x https://roamresearch.com/#/app/eli/page/<%PARENT:<%TRIGGERREF%>,,false%>"), "x {%PARENTLINK%}")
        self.assertEqual(convert_template_text("Web link: https://roamresearch.com/#/app/eli/page/<%CHILDREN:<%GETPAGEUID%>,0,0,{uid},1,%>\nDesktop link: roam://#/app/eli/page/<%CHILDREN:<%GETPAGEUID%>,0,0,{uid},1,%>"), "Logseq link: {%BLOCKLINK%}")
        self.assertEqual(convert_template_text("<%CURSOR%>"), "{%CURSOR%}")
        self.assertEqual(convert_template_text("[<%RANDOMNUMBER:1,1000000000000%>]"), "[{%RANDOMNUMBER:1,1000000000000%}]")
        self.assertEqual(convert_template_text("<%RANDOMBLOCKFROM:prompts for journaling%>"), "{%RANDOMBLOCKFROM:prompts for journaling%}")
        self.assertEqual(convert_template_text("<%REPEAT:<%INPUT:How many repeats?%>,Chapter <%GET:ITERATION%>%>"), "{%REPEAT:{%INPUT:How many repeats?%},Chapter {%GET:ITERATION%}%}")


class TestConverter(unittest.TestCase):
    def test_convert_block_text(self):
        from roam2logseq.convert import convert_block_text
        u = lambda uid: "U-" + uid
        self.assertEqual(convert_block_text("{{[[TODO]]}} single leading", u), ("TODO", "single leading", 0))
        self.assertEqual(convert_block_text("{{[[DONE]]}} {{[[TODO]]}} two", u), (None, "{{renderer :cb, done, 1}} {{renderer :cb, todo, 2}} two", 2))
        self.assertEqual(convert_block_text("mid {{[[TODO]]}} box", u), (None, "mid {{renderer :cb, todo, 1}} box", 1))
        self.assertEqual(convert_block_text("{{[[DONE]]}}{{[[DONE]]}}", u), (None, "{{renderer :cb, done, 1}}{{renderer :cb, done, 2}}", 2))
        self.assertEqual(convert_block_text("plain ((abc123XYZ))", u), (None, "plain ((U-abc123XYZ))", 0))
        # code is never converted: fenced, inline, refs, macros, checkboxes
        code = "see `{{[[TODO]]}}` and\n```js\nx.includes('{{[[TODO]]}}') // ((abc123XYZ)) {{embed: x}}\n```"
        self.assertEqual(convert_block_text(code, u), (None, code, 0))
        self.assertEqual(convert_block_text("{{[[TODO]]}} `{{[[DONE]]}}`", u), ("TODO", "`{{[[DONE]]}}`", 0))

    def test_convert_fixture_and_extras(self):
        import subprocess
        from roam2logseq.convert import main as convert_main
        pages = json.load(open(MINI, encoding="utf-8"))
        pages.append({"title": "Extras", "children": [
            {"string": "A heading", "uid": "hdg000001", "heading": 2, "children": [
                {"string": "{{[[TODO]]}} first {{[[DONE]]}} second", "uid": "cbx000001"}]},
            {"string": "Numbered parent", "uid": "num000001", ":children/view-type": ":numbered", "children": [
                {"string": "one", "uid": "num000002"}, {"string": "two", "uid": "num000003"}]},
        ]})
        d = tempfile.mkdtemp()
        src = os.path.join(d, "export.json"); json.dump(pages, open(src, "w"))
        out = os.path.join(d, "graph")
        rc = convert_main([src, out, "--report", os.path.join(d, "reports")])
        self.assertEqual(rc, 0)  # verify_graph OK
        g = LogseqGraph.from_path(out)
        ex = g.get_page("Extras")
        self.assertEqual(ex.children[0].to_string(), "## A heading")
        self.assertEqual(ex.children[0].children[0].to_string(), "{{renderer :cb, todo, 1}} first {{renderer :cb, done, 2}} second")
        self.assertEqual([c.properties.get("logseq.order-list-type") for c in ex.children[1].children], ["number", "number"])
        self.assertTrue(all(b.uid for b in g.all_blocks()))
        from roam2logseq.sidecar import load_sidecar
        m = load_sidecar(os.path.join(out, "roam-uid-map.json.gz"))
        self.assertEqual(len([e for e in m["blocks"] if e.get("logseq_uuid")]), len(g.all_blocks()))
        self.assertIn("pages", m)
        self.assertTrue(os.path.exists(os.path.join(out, "logseq", "config.edn")))
        self.assertIn(':journal/page-title-format "MMMM do, yyyy"', open(os.path.join(out, "logseq", "config.edn")).read())
        shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
