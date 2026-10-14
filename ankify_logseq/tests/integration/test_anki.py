"""End-to-end test against a real Anki through AnkiConnect.

Runs ONLY in the throwaway profile named in TEST_PROFILE (default "ankify_test"):
it switches to that profile, does everything there, deletes what it created, and
switches back to the profile that was active before. It refuses to run if the
test profile does not exist.

    /usr/bin/python3 -m unittest tests.integration.test_anki -v
"""
import os
import shutil
import tempfile
import unittest

from ankify_logseq import anki
from ankify_logseq.ankifiers import LogseqGraphAnkifier
from ankify_logseq.default_models import add_default_models
from ankify_logseq.logseq import LogseqGraph
from ankify_logseq.logseq import persist as persist_mod
from ankify_logseq.logseq.persist import IdPersister, blocks_needing_ids

TEST_PROFILE = os.environ.get("ANKIFY_TEST_PROFILE", "ankify_test")
DECK = "ankify_logseq integration test"
OPTION_DECK = "Spaced Learning Projects::z-Sources"   # named by an option tag in the fixture; created by the sync
FIXTURE = os.path.join(os.path.dirname(__file__), "..", "fixtures", "graph")


def _invoke(action, **params):
    return anki._invoke(action, **params)


def _switch_profile(name, timeout=15):
    """loadProfile returns before the switch is complete; wait until it is."""
    import time
    assert anki.load_profile(name) is True
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _invoke("getActiveProfile") == name:
            return
        time.sleep(0.5)
    raise RuntimeError(f"Anki did not switch to profile {name!r} within {timeout}s")


class TestAnkiEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not anki.connection_open():
            raise unittest.SkipTest("Anki/AnkiConnect not running")
        profiles = anki.get_profiles()
        if TEST_PROFILE not in profiles:
            raise unittest.SkipTest(f"profile '{TEST_PROFILE}' not found (have {profiles}); create it in Anki")
        cls.previous_profile = _invoke("getActiveProfile")
        _switch_profile(TEST_PROFILE)
        # a fresh graph copy with ids persisted the file way (Logseq does not have this dir open)
        cls.tmp = tempfile.mkdtemp()
        cls.gdir = os.path.join(cls.tmp, "graph")
        shutil.copytree(FIXTURE, cls.gdir)
        cls._running = persist_mod.logseq_process_running
        persist_mod.logseq_process_running = lambda: False
        g = LogseqGraph.from_path(cls.gdir)
        IdPersister(g, mode="file").persist(blocks_needing_ids(g.query_many(lambda b: "ankify" in b.get_tags(inherit=False))))
        persist_mod.logseq_process_running = cls._running

    @classmethod
    def tearDownClass(cls):
        try:
            if _invoke("getActiveProfile") == TEST_PROFILE:
                ids = anki.find_notes('"logseq uid:_*"')
                if ids:
                    _invoke("deleteNotes", notes=ids)
                anki.delete_deck(DECK)
                anki.delete_deck(OPTION_DECK.split("::")[0])
        finally:
            _switch_profile(cls.previous_profile)
            shutil.rmtree(cls.tmp, ignore_errors=True)

    def graph(self):
        return LogseqGraph.from_path(self.gdir)

    def ankifier(self, **kw):
        # skip_unchanged=False (`--full`): the checks below want every block looked at on
        # every sync, not skipped because its page file is unchanged; cache kept in the tmp dir
        return LogseqGraphAnkifier(deck=DECK, persist_ids="never", skip_unchanged=False,
                                   cache_dir=os.path.join(self.tmp, "cache"), **kw)

    def test_end_to_end(self):
        self.assertEqual(_invoke("getActiveProfile"), TEST_PROFILE)
        # --- note types with all four id fields, and the deck
        add_default_models()
        self.assertEqual(anki.get_field_names("Roam Basic"), ["Front", "Back", "Extra", "uid", "parent uid", "logseq uid", "logseq parent uid"])
        self.assertEqual(anki.get_field_names("Roam Cloze"), ["Text", "Back Extra", "uid", "parent uid", "logseq uid", "logseq parent uid"])
        anki.create_deck(DECK)
        self.assertNotIn(OPTION_DECK, anki.get_deck_names())

        # --- first sync: every ankified block with an id is added
        g = self.graph()
        ankified = g.query_many(lambda b: "ankify" in b.get_tags(inherit=False))
        self.assertEqual(blocks_needing_ids(ankified), [])
        report = self.ankifier().ankify(g)
        self.assertEqual((len(report.added), len(report.updated), len(report.unchanged), len(report.failed), len(report.missing_id)),
                         (len(ankified), 0, 0, 0, 0))
        note_ids = anki.find_notes('"logseq uid:_*"')
        self.assertEqual(len(note_ids), len(ankified))
        notes = {n["fields"]["logseq uid"]["value"]: n for n in anki.get_notes(note_ids)}
        # deck from the option tag beats the default deck, and was created by the sync
        self.assertEqual(report.decks_created, [OPTION_DECK])
        self.assertIn(OPTION_DECK, anki.get_deck_names())
        placeholder = next(b for b in ankified if "suspend=True" in b.to_string())
        self.assertEqual(_invoke("cardsInfo", cards=notes[placeholder.uid]["cards"])[0]["deckName"], OPTION_DECK)
        self.assertEqual(len(anki.find_notes(f'"deck:{DECK}"')), len(ankified) - 1)
        for b in ankified:
            n = notes[b.uid]
            self.assertEqual(n["fields"]["logseq parent uid"]["value"], b.parent_uid)
            self.assertEqual(n["fields"]["uid"]["value"], "")          # Roam field never written
            self.assertEqual(n["fields"]["parent uid"]["value"], "")
            self.assertEqual(n["fields"]["Extra"]["value"] if "Extra" in n["fields"] else "", "")
        # cloze block -> Roam Cloze with anki cloze markup
        cloze = next(b for b in ankified if "{do/don't::do}" in b.to_string())
        self.assertEqual(notes[cloze.uid]["modelName"], "Roam Cloze")
        self.assertIn("{{c1::do/don&#x27;t::do}}", notes[cloze.uid]["fields"]["Text"]["value"])  # apostrophe html-escaped, as in ankify_roam
        # basic block with a child -> Roam Basic, child on the back
        circle = next(b for b in ankified if b.to_string().startswith("What is the formula for a circle?"))
        self.assertEqual(notes[circle.uid]["modelName"], "Roam Basic")
        self.assertIn("(x-h)^2 + (y-k)^2 = r^2", notes[circle.uid]["fields"]["Back"]["value"])
        # suspend=True option -> cards suspended; others not
        susp = _invoke("areSuspended", cards=notes[placeholder.uid]["cards"] + notes[circle.uid]["cards"])
        self.assertEqual(susp, [True] * len(notes[placeholder.uid]["cards"]) + [False] * len(notes[circle.uid]["cards"]))
        # inherited tags, spaces -> underscores
        self.assertIn("Roam_imported_page", notes[circle.uid]["tags"])

        # --- second sync: nothing changes
        report = self.ankifier().ankify(self.graph())
        self.assertEqual((len(report.added), len(report.updated), len(report.unchanged)), (0, 0, len(ankified)))

        # --- user data in non-owned fields survives an update
        nid = notes[circle.uid]["noteId"]
        anki.update_fields(nid, {"Extra": "my own note", "uid": "ROAMUID01"})
        path = os.path.join(self.gdir, "pages", "roam-imported.md")
        with open(path, encoding="utf-8") as f:
            text = f.read()
        with open(path, "w", encoding="utf-8") as f:
            f.write(text.replace("What is the formula for a circle?", "What is the formula for a circle of radius r?"))
        report = self.ankifier().ankify(self.graph())
        self.assertEqual((len(report.added), len(report.updated), len(report.unchanged)), (0, 1, len(ankified) - 1))
        n = anki.get_note(nid)
        self.assertIn("circle of radius r?", n["fields"]["Front"]["value"])
        self.assertEqual(n["fields"]["Extra"]["value"], "my own note")
        self.assertEqual(n["fields"]["uid"]["value"], "ROAMUID01")

        # --- dry run reports the plan and writes nothing
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)  # revert the edit -> would be 1 update
        report = self.ankifier(dry_run=True).ankify(self.graph())
        self.assertTrue(report.dry_run)
        self.assertEqual(len(report.updated), 1)
        self.assertIn("circle of radius r?", anki.get_note(nid)["fields"]["Front"]["value"])  # unchanged in Anki

        # --- suspend=True -> suspend=False: cards unsuspended and flagged purple; a second sync leaves them alone
        with open(path, "w", encoding="utf-8") as f:
            f.write(text.replace("suspend=True", "suspend=False"))
        report = self.ankifier().ankify(self.graph())
        self.assertEqual((report.unsuspended, report.flagged), (1, 1))
        cards = notes[placeholder.uid]["cards"]
        self.assertEqual(_invoke("areSuspended", cards=cards), [False] * len(cards))
        self.assertEqual([c["flags"] for c in _invoke("cardsInfo", cards=cards)], [anki.FLAG_PURPLE] * len(cards))
        self.assertEqual(anki.get_card_ids({"fields": {"logseq uid": placeholder.uid}}, without_flag=anki.FLAG_PURPLE), [])
        report = self.ankifier().ankify(self.graph())
        self.assertEqual((len(report.updated), report.flagged), (0, 1))  # flag_note is called again but finds nothing to do
        self.assertEqual([c["flags"] for c in _invoke("cardsInfo", cards=cards)], [anki.FLAG_PURPLE] * len(cards))


if __name__ == "__main__":
    unittest.main()
