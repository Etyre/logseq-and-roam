import argparse
import logging
import os
import subprocess
import sys
from collections import Counter

from ankify_logseq import __version__, anki, util
from ankify_logseq.ankifiers import LogseqGraphAnkifier
from ankify_logseq.default_models import add_default_models
from ankify_logseq.logseq import LogseqGraph

logging.basicConfig(format='%(asctime)s - %(levelname)s - %(message)s', level=logging.INFO)
logger = logging.getLogger(__name__)


def add(path, graph_name=None, **kwargs):
    logger.info("Setting up Ankifier")
    ankifier = LogseqGraphAnkifier(**kwargs)
    ankifier.check_conn_and_params()
    logger.info("Loading Logseq graph")
    graph = LogseqGraph.from_path(path, name=graph_name)
    logger.info(f"Loaded {len(graph.pages)} pages")
    report = ankifier.ankify(graph)
    if report.dry_run:
        _print_plan(report)
    return report


def _print_plan(report):
    def show(label, blocks, limit=20):
        if not blocks:
            return
        print(f"\n{label} ({len(blocks)}):")
        for b in blocks[:limit]:
            print(f"  {_loc(b)}  {b.to_string().splitlines()[0][:80]!r}")
        if len(blocks) > limit:
            print(f"  ... and {len(blocks) - limit} more")
    print("\n=== DRY RUN: nothing was written to Anki ===")
    show("Would ADD", report.added)
    show("Would UPDATE", report.updated)
    if report.persisted:
        print(f"\nWould persist ids for {len(report.persisted)} block(s)")
    if report.decks_created:
        print(f"\nWould create decks: {', '.join(report.decks_created)}")
    show("Skipped, no persisted Logseq id", report.missing_id)
    show("Failed to convert", report.failed)
    print(f"\nUnchanged: {len(report.unchanged)}")
    print(report.summary())


def _loc(block):
    return f"{os.path.relpath(block.path) if block.path else '?'}:{block.line_start}"


def check(path, tag_ankify="ankify", tag_dont_ankify="dont-ankify", tags_from_attr=False, limit=50, **kwargs):
    """Parse the graph and report what a sync would have to deal with. No Anki needed."""
    graph = LogseqGraph.from_path(path)
    ankifier = LogseqGraphAnkifier(tag_ankify=tag_ankify, tag_dont_ankify=tag_dont_ankify, tags_from_attr=tags_from_attr)
    blocks = ankifier.blocks_to_ankify(graph)
    block_ankifier = ankifier.make_block_ankifier()
    all_blocks = graph.all_blocks()
    missing = [b for b in blocks if not b.uid]
    parent_missing = [b for b in blocks if b.parent_blocks and not b.parent.uid]
    top_level = [b for b in blocks if not b.parent_blocks]
    decks = Counter(block_ankifier._get_deck(b) for b in blocks)
    notes = Counter(block_ankifier._get_note_type(b) for b in blocks)
    suspend = Counter(str(block_ankifier._get_suspend(b)) for b in blocks)

    print(f"Graph: {graph.path} (name '{graph.name}')")
    print(f"Config: journal title format '{graph.config['journal/page-title-format']}', "
          f"file name format '{graph.config['file/name-format']}'")
    print(f"Pages: {len(graph.pages)} ({sum(p.is_journal for p in graph.pages)} journals); blocks: {len(all_blocks)}")
    print(f"Blocks with persisted id: {sum(1 for b in all_blocks if b.uid)}")
    print(f"\nAnkified blocks ('#{tag_ankify}'): {len(blocks)}")
    print(f"  without a persisted id:            {len(missing)}")
    print(f"  whose parent block has no id:      {len(parent_missing)}")
    print(f"  at top level (parent is the page): {len(top_level)}")
    print(f"  note types: {dict(notes)}")
    print(f"  suspend option: {dict(suspend)}")
    print("  decks:")
    for deck, n in decks.most_common():
        print(f"    {n:6d}  {deck}")
    if missing:
        print(f"\nAnkified blocks without a persisted id (first {limit}):")
        for b in missing[:limit]:
            print(f"  {_loc(b)}  {b.to_string().splitlines()[0][:80]!r}")
    return {"blocks": len(blocks), "missing": len(missing), "parent_missing": len(parent_missing)}


def init_models(overwrite=False, **kwargs):
    models = add_default_models(overwrite=overwrite)
    for name, model in models.items():
        if model:
            logger.info(f"Added '{name}'")
        else:
            logger.info(f"'{name}' already in Anki. "
                        "If you want to overwrite its templates and css, use `ankify_logseq init-models --overwrite`")


def get_version():
    try:
        res = subprocess.run(["git", "-C", os.path.dirname(__file__), "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True)
        if res.returncode == 0:
            return __version__ + "+" + res.stdout.decode().strip()
    except Exception:
        pass
    return __version__


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Import flashcards from a Logseq file graph to Anki',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument('--version', action='version', version='%(prog)s {version}'.format(version=get_version()))
    subparsers = parser.add_subparsers(help='sub-command help')

    default_args = util.get_default_args(LogseqGraphAnkifier.__init__)
    parser_add = subparsers.add_parser("add", help='Add a Logseq graph to Anki', description='Add a Logseq graph to Anki')
    parser_add.add_argument('path', metavar='path', type=str, help='path to the Logseq graph directory')
    parser_add.add_argument('--deck', default=default_args['deck'], type=str, help='Deck to add notes to')
    parser_add.add_argument('--note-basic', default=default_args['note_basic'], type=str, help='Note type to assign basic flashcards')
    parser_add.add_argument('--note-cloze', default=default_args['note_cloze'], type=str, help='Note type to assign cloze flashcards')
    parser_add.add_argument('--pageref-cloze', default=default_args['pageref_cloze'], type=str, choices=["inside", "outside", "base_only"], help='Where to place clozes around page references')
    parser_add.add_argument('--tag-ankify', default=default_args['tag_ankify'], type=str, help='Tag used to flag blocks to ankify')
    parser_add.add_argument('--tag-dont-ankify', default=default_args['tag_dont_ankify'], type=str, help='Tag used to flag blocks not to ankify, even if they have the `--tag-ankify` tag')
    parser_add.add_argument('--tag-ankify-root', default=default_args['tag_ankify_root'], type=str, help='Tag used to treat a block as a root node, even if there are parents above it')
    parser_add.add_argument('--num-parents', default=default_args['num_parents'], type=str, help='Number of parent blocks to include on anki notes (pass "all" to select all)')
    parser_add.add_argument('--include-page', default=default_args['include_page'], action='store_true', help='Whether to include page titles on anki notes')
    parser_add.add_argument('--full', dest='skip_unchanged', action='store_false', default=True, help='Check every ankified block, even on pages whose file is unchanged since the last successful run (the default skips those; use after editing a block that other cards embed)')
    parser_add.add_argument('--tags-from-attr', default=default_args['tags_from_attr'], action='store_true', help='Whether to assign tags next to "tags::" property to parent')
    parser_add.add_argument('--max-depth', default=default_args['max_depth'], type=str, help="Maximum depth of children to ankify")
    parser_add.add_argument('--download-imgs', default=default_args['download_imgs'], type=str, choices=["once", "always", "never"], help='Whether to download images embedded in blocks and save in anki')
    parser_add.add_argument('--uid-field', default=default_args['uid_field'], type=str, help='Note field holding the Logseq block uid')
    parser_add.add_argument('--parent-uid-field', default=default_args['parent_uid_field'], type=str, help='Note field holding the uid of the block\'s parent')
    parser_add.add_argument('--options-from-properties', default=False, action='store_true', help='Also read per-block options (deck::, suspend::, ...) from Logseq block properties; deck:: inherits from parent blocks')
    parser_add.add_argument('--graph-name', default=None, type=str, help='Logseq graph name, for logseq:// links (default: directory name)')
    parser_add.add_argument('--no-create-decks', dest='create_decks', default=True, action='store_false', help='Fail on a deck named by an option tag that does not exist, instead of creating it')
    parser_add.add_argument('--dry-run', default=False, action='store_true', help='Report what would be added/updated without writing to Anki or to the graph')
    parser_add.add_argument('--persist-ids', default=default_args['persist_ids'], type=str, choices=["auto", "api", "file", "never"], help='How to persist ids for ankified blocks that lack one: through the running Logseq (api), by editing files with Logseq closed (file), auto-pick, or never')
    parser_add.add_argument('--logseq-api-url', default=None, type=str, help='Logseq HTTP API url (default http://127.0.0.1:12315/api)')
    parser_add.add_argument('--logseq-token', default=None, type=str, help='Logseq HTTP API token (else $LOGSEQ_API_TOKEN or ~/.ankify_logseq/logseq_api_token)')
    parser_add.set_defaults(func=add)

    parser_check = subparsers.add_parser("check", help="Parse a graph and report ankified blocks, missing ids, decks", description="Parse a graph and report ankified blocks, missing ids, decks. Does not need Anki.")
    parser_check.add_argument('path', metavar='path', type=str, help='path to the Logseq graph directory')
    parser_check.add_argument('--tag-ankify', default=default_args['tag_ankify'], type=str)
    parser_check.add_argument('--tag-dont-ankify', default=default_args['tag_dont_ankify'], type=str)
    parser_check.add_argument('--tags-from-attr', default=False, action='store_true')
    parser_check.add_argument('--limit', default=50, type=int, help='How many blocks without ids to list')
    parser_check.set_defaults(func=check)

    parser_init = subparsers.add_parser("init-models", help="Initialize Anki with the default note types", description="Initialize Anki with the Roam Basic / Roam Cloze note types (with all id fields)")
    parser_init.add_argument('--overwrite', action="store_true", help="whether to overwrite the templates and css of existing note types")
    parser_init.set_defaults(func=init_models)

    args = vars(parser.parse_args(argv))
    if "func" not in args:
        parser.print_help(sys.stderr)
        sys.exit(1)

    if args.get("num_parents"):
        try:
            args["num_parents"] = int(args["num_parents"])
        except ValueError:
            if args["num_parents"] != "all":
                raise ValueError("Invalid num-parents value")
    if args.get("max_depth"):
        if args["max_depth"] == "None":
            args["max_depth"] = None
        else:
            try:
                args["max_depth"] = int(args["max_depth"])
            except ValueError:
                raise ValueError("Invalid max-depth value")

    func = args.pop("func")
    func(**args)


if __name__ == "__main__":
    main()
