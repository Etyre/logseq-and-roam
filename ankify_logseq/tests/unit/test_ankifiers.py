import unittest
import re
import json
import logging
from ankify_logseq import anki
from ankify_logseq.default_models import ROAM_BASIC, ROAM_CLOZE, add_default_models
from ankify_logseq.ankifiers import BlockAnkifier, LogseqGraphAnkifier, SyncReport
from ankify_logseq.logseq import Page, Block, BlockContent, LogseqGraph
from ankify_logseq import util
from bs4 import BeautifulSoup


class TestBlockAnkifier(unittest.TestCase):
    def test_get_option(self):
        ankifier = BlockAnkifier()

        block = Block.from_string("a block #[[[[ankify_roam]]:note='Roam Basic']]")
        self.assertEqual(ankifier._get_option(block, 'note'), "Roam Basic")

        block = Block.from_string("a block #[[[[ankify]]:note='Roam Basic']]")
        self.assertEqual(ankifier._get_option(block, 'note'), "Roam Basic")

        block = Block.from_string("a block #[[ankify: note='Roam Basic']]")
        self.assertEqual(ankifier._get_option(block, 'note'), "Roam Basic")

        block = Block.from_string("a block #[[ankify: note=Roam Basic]]")
        self.assertEqual(ankifier._get_option(block, 'note'), "Roam Basic")

        block = Block.from_string("a block #[[ankify: note= Roam Basic]]")
        self.assertEqual(ankifier._get_option(block, 'note'), "Roam Basic")

        block = Block.from_string("a block #[[ankify: deck='1-Daily']]")
        self.assertEqual(ankifier._get_option(block, 'deck'), "1-Daily")

    def test_state_block_is_not_ankified(self):
        # auto-anki's hidden state block stores every note's text, "#ankify" included,
        # inside its JSON; it must not be ankified itself
        ankifier = LogseqGraphAnkifier()
        state = Block.from_string('#auto-anki-state {"notes":{"x":{"text":"What is a dopamine neuron? #ankify"}}}')
        self.assertFalse(ankifier.is_block_to_ankify(state))
        note = Block.from_string("What is a dopamine neuron? #ankify")
        self.assertTrue(ankifier.is_block_to_ankify(note))

    def test_front_to_html(self):
        """
        - [[Page title]]
          - grandparent block
            - parent block
              - ankified block
        """
        block = Block.from_string("ankified block")
        block.parent = Block.from_string("parent block")
        block.parent.parent = Block.from_string("grandparent block")
        block.parent.parent.parent = Page("Page title")

        # No parent blocks or page
        ankifier = BlockAnkifier(num_parents=0, include_page=False)
        expected = '<div class="front-side">ankified block</div>'
        self.assertEqual(ankifier.front_to_html(block), expected)

        # All parent blocks and page
        ankifier = BlockAnkifier(num_parents="all", include_page=True)
        expected = remove_html_whitespace("""
        <div class="front-side">
            <ul>
                <li class="page-title parent parent-3 parent-top">
                    <span data-link-title="Page title">
                    <span class="rm-page-ref-brackets">[[</span>
                    <span class="rm-page-ref rm-page-ref-link-color">Page title</span>
                    <span class="rm-page-ref-brackets">]]</span></span>
                </li>
                <ul>
                    <li class="block parent parent-2">grandparent block</li>
                    <ul>
                        <li class="block parent parent-1">parent block</li>
                        <ul>
                            <li class="block">ankified block</li>
                        </ul>
                    </ul>
                </ul>
            </ul>
        </div>
        """)
        self.assertEqual(ankifier.front_to_html(block), expected)

        # Some parent blocks and page
        ankifier = BlockAnkifier(num_parents=1, include_page=True)
        expected = remove_html_whitespace("""
        <div class="front-side">
            <ul>
                <li class="page-title parent parent-3 parent-top">
                    <span data-link-title="Page title">
                    <span class="rm-page-ref-brackets">[[</span>
                    <span class="rm-page-ref rm-page-ref-link-color">Page title</span>
                    <span class="rm-page-ref-brackets">]]</span></span>
                </li>
                <ul>
                    <li class="block parent parent-2"><span class="ellipsis">...</span></li>
                    <ul>
                        <li class="block parent parent-1">parent block</li>
                        <ul>
                            <li class="block">ankified block</li>
                        </ul>
                    </ul>
                </ul>
            </ul>
        </div>
        """)
        self.assertEqual(ankifier.front_to_html(block), expected)

        # All parent blocks and page
        block = Block.from_string("ankified block")
        block.parent = Block.from_string("parent block #ankify-root")
        block.parent.parent = Block.from_string("grandparent block")
        block.parent.parent.parent = Page("Page title")

        ankifier = BlockAnkifier(num_parents="all", tag_ankify_root="ankify-root")
        expected = remove_html_whitespace("""
        <div class="front-side">
            <ul>
                <li class="block parent parent-1 parent-top">parent block <span data-tag="ankify-root" class="rm-page-ref rm-page-ref-tag">#ankify-root</span></li>
                <ul>
                    <li class="block">ankified block</li>
                </ul>
            </ul>
        </div>
        """)
        self.assertEqual(ankifier.front_to_html(block), expected)

    def test_back_to_html(self):
        block = Block.from_string("block with children")
        child1 = Block.from_string("child 1")
        grandchild1 = Block.from_string("grandchild 1")
        child2 = Block.from_string("child 2")

        # one child
        block.children = [child1]
        ankifier = BlockAnkifier()
        expected = '<div class="back-side">child 1</div>'
        self.assertEqual(ankifier.back_to_html(block), expected)

        # multiple children
        child1.children = [grandchild1]
        block.children = [child1, child2]
        ankifier = BlockAnkifier()
        expected = remove_html_whitespace("""
        <div class="back-side list">
            <ul>
                <li>child 1</li>
                <ul>
                    <li>grandchild 1</li>
                </ul>
                <li>child 2</li>
            </ul>
        </div>
        """)
        self.assertEqual(ankifier.back_to_html(block), expected)

        # max depth
        block.children = [child1, child2]
        ankifier = BlockAnkifier(max_depth=1)
        expected = remove_html_whitespace("""
        <div class="back-side list">
            <ul>
                <li>child 1</li>
                <li>child 2</li>
            </ul>
        </div>
        """)
        self.assertEqual(ankifier.back_to_html(block), expected)

    def test_ankify(self):
        block = Block(
            content=BlockContent.from_string("question"),
            children=[Block.from_string("answer")],
            parent=Page("page")
        )
        ankifier = BlockAnkifier(
            deck="my deck",
            note_basic="my basic",
            field_names = {"my basic": ["Front", "Back"]}
        )
        expected = {
            "deckName": "my deck",
            "modelName": "my basic",
            "fields": {
                "Front": '<div class="front-side">question</div>', 
                "Back": '<div class="back-side">answer</div>',
                "logseq uid": "",
                "logseq parent uid": "page",
            },
            "tags": ["page"],
            "suspend": None,
        }
        self.assertEqual(expected, ankifier.ankify(block))

    def test_only_owned_fields_are_written(self):
        """Fields ankify_roam doesn't generate (Extra, user-added fields) must
        not appear in the note dict, otherwise updateNoteFields blanks them."""
        block = Block(
            content=BlockContent.from_string("question"),
            children=[Block.from_string("answer")],
            parent=Page("page")
        )
        ankifier = BlockAnkifier(
            note_basic="my basic",
            field_names={"my basic": ["Front", "Back", "Extra", "uid",
                                      "parent uid", "logseq uid", "logseq parent uid"]}
        )
        fields = ankifier.ankify(block)["fields"]
        self.assertEqual(set(fields.keys()), {"Front", "Back", "logseq uid", "logseq parent uid"})

        block = Block(
            content=BlockContent.from_string("a {cloze} question"),
            parent=Page("page")
        )
        ankifier = BlockAnkifier(
            note_cloze="my cloze",
            field_names={"my cloze": ["Text", "Back Extra", "uid",
                                      "parent uid", "logseq uid", "logseq parent uid"]}
        )
        fields = ankifier.ankify(block)["fields"]
        self.assertEqual(set(fields.keys()), {"Text", "logseq uid", "logseq parent uid"})

    def test_download_imgs(self):
        block = Block(
            content=BlockContent.from_string("![](https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png)"),
            children=[],
            parent=Page("page")
        )
        ankifier = BlockAnkifier(
            deck="my deck",
            note_basic="my basic",
            field_names = {"my basic": ["Front", "Back"]},
            download_imgs='always'
        )

        # Confirm srcs were replaced with filenames
        ankified_note = ankifier.ankify(block)
        soup = BeautifulSoup(ankified_note['fields']['Front'], 'html.parser')
        actual_srcs = [img['src'] for img in soup.find_all("img")]
        self.assertEqual(actual_srcs, ["googlelogo_color_272x92dp.png"])

        # Confirm images were downloaded
        for image in ankified_note["images"]:
            self.assertTrue(len(image['data']) > 0)
            image['data'] = ''
        self.assertEqual(ankified_note["images"], [{'data': '', 'filename': 'googlelogo_color_272x92dp.png'}])

    def test_download_imgs_never(self):
        block = Block(
            content=BlockContent.from_string("![](https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png)"),
            children=[],
            parent=Page("page")
        )
        ankifier = BlockAnkifier(
            deck="my deck",
            note_basic="my basic",
            field_names = {"my basic": ["Front", "Back"]},
            download_imgs='never'
        )

        ankified_note = ankifier.ankify(block)
        soup = BeautifulSoup(ankified_note['fields']['Front'], 'html.parser')
        
        actual_srcs = [img['src'] for img in soup.find_all("img")]
        expected_srcs = ["https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png"]

        self.assertEqual(actual_srcs, expected_srcs)

    def test_ankify_root(self):
        block = Block(
            content=BlockContent.from_string("question"),
            children=[Block.from_string("answer")],
            parent=Page("page")
        )
        ankifier = BlockAnkifier(
            deck="my deck",
            note_basic="my basic",
            field_names = {"my basic": ["Front", "Back"]}
        )
        expected = {
            "deckName": "my deck",
            "modelName": "my basic",
            "fields": {
                "Front": '<div class="front-side">question</div>', 
                "Back": '<div class="back-side">answer</div>',
                "logseq uid": "",
                "logseq parent uid": "page",
            },
            "tags": ["page"],
            "suspend": None,
        }
        self.assertEqual(expected, ankifier.ankify(block))

    def test_suspend(self):
        ankifier = BlockAnkifier()
        block = Block.from_string("a block #[[[[ankify_roam]]: suspend=True]]")
        self.assertEqual(ankifier._get_suspend(block), True)
        block = Block.from_string("a block #[[[[ankify_roam]]: suspend=False]]")
        self.assertEqual(ankifier._get_suspend(block), False)
        block = Block.from_string("a block")
        self.assertEqual(ankifier._get_suspend(block), None)
        
    def test_flag_note(self):
        """suspend=False cards get the purple flag; cards already flagged are skipped."""
        calls = []
        def fake_invoke(action, **params):
            calls.append((action, params))
            if action == "findCards":
                return [101, 102]
            return [True]
        saved = anki._invoke
        anki._invoke = fake_invoke
        try:
            res = anki.flag_note({"fields": {"logseq uid": "abc-123"}}, "logseq uid", anki.FLAG_PURPLE)
        finally:
            anki._invoke = saved
        self.assertEqual(anki.FLAG_PURPLE, 7)
        self.assertEqual(calls, [
            ("findCards", {"query": '"logseq uid:abc-123" -flag:7'}),
            ("setSpecificValueOfCard", {"card": 101, "keys": ["flags"], "newValues": [7]}),
            ("setSpecificValueOfCard", {"card": 102, "keys": ["flags"], "newValues": [7]}),
        ])
        self.assertEqual(res, [[True], [True]])

    def test_upload_flags_unsuspended_notes(self):
        """Only suspend=False notes are flagged, and never during a dry run."""
        calls = []
        saved = {n: getattr(anki, n) for n in ("get_deck_names", "get_note_id", "add_note", "suspend_note",
                                                "unsuspend_note", "flag_note")}
        try:
            anki.get_deck_names = lambda: ["Default"]
            anki.get_note_id = lambda n, f: None
            anki.add_note = lambda n: calls.append(("add", n["fields"]["logseq uid"]))
            anki.suspend_note = lambda n, f: calls.append(("suspend", n["fields"]["logseq uid"]))
            anki.unsuspend_note = lambda n, f: calls.append(("unsuspend", n["fields"]["logseq uid"]))
            anki.flag_note = lambda n, f, flag: calls.append(("flag", n["fields"]["logseq uid"], f, flag))
            def note(uid, suspend):
                return {"deckName": "Default", "fields": {"logseq uid": uid}, "suspend": suspend}
            a = LogseqGraphAnkifier(prefetch_notes=False); rep = SyncReport()
            a._upload(note("off", False), None, rep)
            a._upload(note("on", True), None, rep)
            a._upload(note("none", None), None, rep)
            self.assertEqual(calls, [("add", "off"), ("unsuspend", "off"), ("flag", "off", "logseq uid", 7),
                                     ("add", "on"), ("suspend", "on"),
                                     ("add", "none")])
            self.assertEqual((rep.suspended, rep.unsuspended, rep.flagged), (1, 1, 1))
            calls.clear()
            LogseqGraphAnkifier(prefetch_notes=False, dry_run=True)._upload(note("off", False), None, SyncReport(True))
            self.assertEqual(calls, [])
        finally:
            for n, f in saved.items():
                setattr(anki, n, f)

    def test_assign_cloze_ids(self):
        block = Block(
            content=BlockContent.from_string("something {with} some {c1:clozes} in {it}"),
            children=[],
            parent=Page("page")
        )
        ankifier = BlockAnkifier(
            note_cloze="Roam Cloze",
            field_names = {"Roam Cloze": ["Text", "Back Extra"]}
        )
        ankified_note = ankifier.ankify(block)
        actual = ankified_note['fields']['Text']
        expected = '<div class="front-side">something {{c2::with}} some {{c1::clozes}} in {{c3::it}}</div>'
        self.assertEqual(actual, expected)


def remove_html_whitespace(html_string):
    html_string = re.sub(">\s*\n?\s*<", "><", html_string)
    html_string = re.sub("^\s*\n?\s*", "", html_string)
    html_string = re.sub("\s*\n?\s*$", "", html_string)
    return html_string


if __name__=="__main__":
    unittest.main()


class TestLogseqSpecific(unittest.TestCase):
    FIELDS = {"Roam Basic": ["Front", "Back", "Extra", "uid", "parent uid", "logseq uid", "logseq parent uid"],
              "Roam Cloze": ["Text", "Back Extra", "uid", "parent uid", "logseq uid", "logseq parent uid"]}

    def graph(self):
        import os
        return LogseqGraph.from_path(os.path.join(os.path.dirname(__file__), "..", "fixtures", "graph"))

    def test_uid_fields(self):
        g = self.graph()
        circle = g.query_by_uid("35e8dd88-0367-4768-931d-6bef5183759a")
        note = BlockAnkifier(field_names=self.FIELDS).ankify(circle)
        self.assertEqual(note["modelName"], "Roam Basic")
        self.assertEqual(note["fields"]["logseq uid"], "35e8dd88-0367-4768-931d-6bef5183759a")
        self.assertEqual(note["fields"]["logseq parent uid"], "")  # parent block has no persisted id
        self.assertNotIn("uid", note["fields"])
        self.assertNotIn("parent uid", note["fields"])
        self.assertNotIn("Extra", note["fields"])
        top = g.get_page("Roam imported page").children[0]
        note = BlockAnkifier(field_names=self.FIELDS).ankify(top)
        self.assertEqual(note["fields"]["logseq parent uid"], "Roam imported page")
        task = g.get_page("Logseq/native page").children[0]
        note = BlockAnkifier(field_names=self.FIELDS).ankify(task)
        self.assertEqual(note["fields"]["logseq uid"], "0b0a8e59-b0f7-45cf-996b-dfe13011303c")
        self.assertEqual(note["fields"]["logseq parent uid"], "Logseq/native page")
        self.assertIn("TODO", note["tags"])

    def test_roam_option_tags_still_work(self):
        g = self.graph()
        placeholder = g.query_many(lambda b: "ankify_roam: suspend=True" in b.get_tags(inherit=False))[0]
        a = BlockAnkifier(field_names=self.FIELDS, deck="Fallback")
        self.assertEqual(a._get_deck(placeholder), "Spaced Learning Projects::z-Sources")
        self.assertEqual(a._get_suspend(placeholder), True)

    def test_options_from_properties(self):
        g = self.graph()
        prop = g.get_page("Logseq/native page").children[1].children[1]  # has deck:: My Deck
        self.assertEqual(BlockAnkifier(field_names=self.FIELDS, deck="Fallback")._get_deck(prop), "Fallback")
        a = BlockAnkifier(field_names=self.FIELDS, deck="Fallback", options_from_properties=True)
        self.assertEqual(a._get_deck(prop), "My Deck")
        # deck:: inherits from parent blocks; other options do not
        parent = Block.from_string("parent", properties={"deck": "Inherited", "suspend": "true"})
        child = Block.from_string("child #ankify"); parent.children.append(child); child.parent = parent
        self.assertEqual(a._get_deck(child), "Inherited")
        self.assertIsNone(a._get_suspend(child))
        # a tag on the block beats a property
        tagged = Block.from_string("x #[[ankify_roam: deck=\"Tagged\"]]", properties={"deck": "Prop"})
        self.assertEqual(a._get_deck(tagged), "Tagged")

    def test_dry_run_plan(self):
        """Dry run classifies notes using only read calls; no write call is made."""
        g = self.graph()
        calls = []
        fake_existing = {35: {"fields": {"Front": {"value": "OLD"}, "Back": {"value": ""}, "Extra": {"value": "keep me"},
                                         "uid": {"value": "roamUID"}, "logseq uid": {"value": "35e8dd88-0367-4768-931d-6bef5183759a"},
                                         "logseq parent uid": {"value": ""}}}}
        def fake_get_note_id(note, uid_field):
            return 35 if note["fields"][uid_field] == "35e8dd88-0367-4768-931d-6bef5183759a" else None
        def forbidden(*a, **k):
            calls.append(a); raise AssertionError("write call during dry run")
        saved = {n: getattr(anki, n) for n in ("connection_open", "get_deck_names", "get_model_names", "get_field_names",
                                                "is_model_cloze", "get_note_id", "get_note", "add_note", "update_note",
                                                "suspend_note", "unsuspend_note", "flag_note", "create_deck")}
        try:
            anki.connection_open = lambda: True
            anki.get_deck_names = lambda: ["Default"]
            anki.get_model_names = lambda: list(self.FIELDS)
            anki.get_field_names = lambda m: self.FIELDS[m]
            anki.is_model_cloze = lambda m: "Cloze" in m
            anki.get_note_id = fake_get_note_id
            anki.get_note = lambda nid: fake_existing[nid]
            anki.add_note = anki.update_note = anki.suspend_note = anki.unsuspend_note = anki.flag_note = anki.create_deck = forbidden
            report = LogseqGraphAnkifier(dry_run=True, prefetch_notes=False).ankify(g)
        finally:
            for n, f in saved.items():
                setattr(anki, n, f)
        self.assertTrue(report.dry_run)
        self.assertEqual(len(report.updated), 1)       # the circle block: exists, content differs
        self.assertEqual(len(report.added), 1)         # the TODO block: has id, not in Anki
        self.assertEqual(len(report.missing_id), 4)    # the other ankified fixture blocks have no id
        self.assertEqual(calls, [])
        self.assertEqual(report.decks_created, [])     # the two synced blocks use the default deck
        # a block whose option tag names a missing deck: reported in dry run, error with --no-create-decks
        try:
            anki.connection_open = lambda: True; anki.get_deck_names = lambda: ["Default"]
            anki.get_model_names = lambda: list(self.FIELDS); anki.get_field_names = lambda m: self.FIELDS[m]
            anki.is_model_cloze = lambda m: "Cloze" in m; anki.get_note_id = lambda n, f: None
            anki.add_note = anki.create_deck = forbidden
            a = LogseqGraphAnkifier(dry_run=True); rep = SyncReport(dry_run=True)
            a._upload({"deckName": "New::Deck", "fields": {"logseq uid": "x"}, "suspend": None}, None, rep)
            self.assertEqual(rep.decks_created, ["New::Deck"])
            note = {"deckName": "DEFAULT", "fields": {"logseq uid": "x"}, "suspend": None}
            a._upload(note, None, rep)
            self.assertEqual(note["deckName"], "Default")            # case variant -> existing spelling
            self.assertEqual(rep.decks_created, ["New::Deck"])       # nothing new created
            with self.assertRaises(ValueError):
                LogseqGraphAnkifier(dry_run=True, create_decks=False)._upload({"deckName": "Other", "fields": {"logseq uid": "x"}, "suspend": None}, None, SyncReport(True))
        finally:
            for n, f in saved.items():
                setattr(anki, n, f)

    def test_prefetch_uses_bulk_fetch_only(self):
        """With prefetch, existing notes are found from one bulk fetch; no per-note lookups."""
        g = self.graph()
        saved = {n: getattr(anki, n) for n in ("connection_open", "get_deck_names", "get_model_names", "get_field_names",
                                                "is_model_cloze", "get_note_id", "get_note", "find_notes", "get_notes",
                                                "add_note", "update_note", "suspend_note", "unsuspend_note", "create_deck")}
        calls = []
        def forbidden(*a, **k): calls.append(a); raise AssertionError("per-note or write call")
        try:
            anki.connection_open = lambda: True; anki.get_deck_names = lambda: ["Default"]
            anki.get_model_names = lambda: list(self.FIELDS); anki.get_field_names = lambda m: self.FIELDS[m]
            anki.is_model_cloze = lambda m: "Cloze" in m
            anki.find_notes = lambda q: [35]
            anki.get_notes = lambda ids: [{"noteId": 35, "fields": {"Front": {"value": "OLD"}, "Back": {"value": ""},
                                          "logseq uid": {"value": "35e8dd88-0367-4768-931d-6bef5183759a"}, "logseq parent uid": {"value": ""}}}]
            anki.get_note_id = anki.get_note = anki.add_note = anki.update_note = anki.suspend_note = anki.unsuspend_note = forbidden
            report = LogseqGraphAnkifier(dry_run=True).ankify(g)
        finally:
            for n, f in saved.items(): setattr(anki, n, f)
        self.assertEqual((len(report.updated), len(report.added), calls), (1, 1, []))

    def test_relative_asset_image(self):
        import os, tempfile, base64
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "assets")); os.makedirs(os.path.join(d, "pages"))
            with open(os.path.join(d, "assets", "pic.png"), "wb") as f:
                f.write(b"PNGDATA")
            a = BlockAnkifier(field_names=self.FIELDS, graph_path=d, download_imgs="always")
            saved = anki.found_media; anki.found_media = lambda fn: False
            try:
                block = Block.from_string("![](../assets/pic.png) #ankify", uid="u", parent=Page("p"))
                note = a.ankify(block)
            finally:
                anki.found_media = saved
            self.assertEqual(note["images"], [{"data": base64.b64encode(b"PNGDATA").decode(), "filename": "pic.png"}])
            self.assertIn('src="pic.png"', note["fields"]["Front"])


if __name__ == '__main__':
    unittest.main()
