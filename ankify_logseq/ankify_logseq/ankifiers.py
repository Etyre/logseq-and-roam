"""Turn ankified Logseq blocks into Anki notes and upload them.

Derived from ankify_roam's ankifiers.py. Behavior is identical except:

- notes are matched to blocks by the "logseq uid" field, never by "uid";
- every note also carries "logseq parent uid" (parent block's uid, or the page
  title for top-level blocks);
- only the fields this tool generates are written or compared (content fields +
  the two logseq uid fields); "uid", "parent uid", "Extra" etc. are never touched;
- blocks without a persisted Logseq id cannot be ankified and are reported;
- a dry-run mode reports the sync plan without writing anything;
- per-block options may also come from Logseq block properties (opt-in);
- images referenced by graph-relative paths (../assets/...) are read from disk.
"""
import base64
import inspect
import logging
import os
import re
import string
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

from ankify_logseq import anki
from ankify_logseq.logseq import Cloze, Page
from ankify_logseq.logseq.persist import IdPersister, PersistError, blocks_needing_ids

logger = logging.getLogger(__name__)

ASCII_NON_PRINTABLE = "".join([chr(i) for i in range(128)
                               if chr(i) not in string.printable])

# Fields that are never treated as content fields, whatever their position
RESERVED_FIELDS = {"uid", "parent uid", "logseq uid", "logseq parent uid"}


class SyncReport:
    """Counts and details of one sync run (real or dry)."""

    def __init__(self, dry_run=False):
        self.dry_run = dry_run
        self.added = []
        self.updated = []
        self.unchanged = []
        self.failed = []
        self.missing_id = []
        self.persisted = []  # (path, line, uuid) written by the id fallback
        self.decks_created = []  # decks named by option tags that did not exist yet
        self.skipped_unchanged = []  # blocks on pages whose file did not change since the last run
        self.suspended = 0
        self.unsuspended = 0
        self.flagged = 0  # notes whose cards got the purple flag (suspend=False)

    def summary(self):
        verb = "would be " if self.dry_run else ""
        return (f"Results: {len(self.added)} notes {verb}added, {len(self.updated)} {verb}updated, "
                f"{len(self.unchanged)} unchanged, {len(self.missing_id)} skipped for missing id, "
                f"{len(self.failed)} failed; {len(self.persisted)} ids {verb}persisted; "
                f"{len(self.decks_created)} decks {verb}created; {len(self.skipped_unchanged)} on unchanged pages skipped")


class LogseqGraphAnkifier:
    def __init__(self, deck="Default", note_basic="Roam Basic", note_cloze="Roam Cloze",
                 pageref_cloze="outside", tag_ankify="ankify", tag_dont_ankify="dont-ankify",
                 tag_ankify_root="ankify-root", num_parents=0, include_page=False,
                 max_depth=None, tags_from_attr=False, download_imgs='never',
                 uid_field="logseq uid", parent_uid_field="logseq parent uid",
                 options_from_properties=False, dry_run=False, persist_ids="auto",
                 logseq_api_url=None, logseq_token=None, create_decks=True, prefetch_notes=True,
                 skip_unchanged=True, cache_dir=None):
        self.deck = deck
        # Part IX (2026-09-05): remember each page file's hash after a successful run and
        # skip its blocks next time if the file is unchanged. A card can also depend on
        # blocks embedded from *other* pages; `--full` (skip_unchanged=False) re-checks all.
        self.skip_unchanged = skip_unchanged
        self.cache_dir = os.path.expanduser(cache_dir or "~/.ankify_logseq")
        self.note_basic = note_basic
        self.note_cloze = note_cloze
        self.pageref_cloze = pageref_cloze
        self.tag_ankify = tag_ankify
        self.tag_dont_ankify = tag_dont_ankify
        self.tag_ankify_root = tag_ankify_root
        self.num_parents = num_parents
        self.include_page = include_page
        self.max_depth = max_depth
        self.tags_from_attr = tags_from_attr
        self.download_imgs = download_imgs
        self.uid_field = uid_field
        self.parent_uid_field = parent_uid_field
        self.options_from_properties = options_from_properties
        self.dry_run = dry_run
        self.persist_ids = persist_ids
        self.logseq_api_url = logseq_api_url
        self.logseq_token = logseq_token
        self.create_decks = create_decks
        self.prefetch_notes = prefetch_notes
        self._known_decks = None
        self._notes_by_uid = None  # uid -> (note_id, fields) when prefetched

    def check_conn_and_params(self):
        if not anki.connection_open():
            raise ValueError("Couldn't connect to Anki.")
        if not self.deck in anki.get_deck_names():
            raise ValueError(f"Deck named '{self.deck}' not in Anki.")
        if not self.note_basic in anki.get_model_names():
            raise ValueError(f"Note type named '{self.note_basic}' not in Anki.")
        if not self.note_cloze in anki.get_model_names():
            raise ValueError(f"Note type named '{self.note_cloze}' not in Anki.")
        for name, n_content in ((self.note_basic, 2), (self.note_cloze, 1)):
            field_names = anki.get_field_names(name)
            for f in (self.uid_field, self.parent_uid_field):
                if f not in field_names:
                    raise ValueError(f"'{name}' note type is missing a '{f}' field.")
            content_fields = [f for f in field_names if f not in RESERVED_FIELDS]
            if len(content_fields) < n_content:
                raise ValueError(f"'{name}' note type requires {n_content} content field(s) "
                                 f"besides the id fields.")
        if not anki.is_model_cloze(self.note_cloze):
            raise ValueError(f"note_cloze must be a cloze note type and '{self.note_cloze}' isn't.")

    def is_block_to_ankify(self, block):
        tags_in_block = block.get_tags(inherit=False, from_attr=self.tags_from_attr)
        all_tags = block.get_tags(inherit=True, from_attr=self.tags_from_attr)
        if self.tag_ankify in tags_in_block:
            if self.tag_dont_ankify and self.tag_dont_ankify in all_tags:
                return False
            return True
        return False

    def blocks_to_ankify(self, graph):
        return graph.query_many(lambda b: self.is_block_to_ankify(b))

    def make_persister(self, graph):
        from ankify_logseq.logseq.api import LogseqApi
        api = LogseqApi(url=self.logseq_api_url, token=self.logseq_token) if self.logseq_api_url else LogseqApi(token=self.logseq_token)
        return IdPersister(graph, mode=self.persist_ids, api=api, dry_run=self.dry_run)

    def make_block_ankifier(self):
        block_ankifier_args = inspect.getfullargspec(BlockAnkifier.__init__).args
        kwargs = {k: v for k, v in vars(self).items() if k in block_ankifier_args}
        return BlockAnkifier(**kwargs)

    def ankify(self, graph):
        """Convert and upload every ankified block. Returns a SyncReport."""
        self.check_conn_and_params()
        blocks = self.blocks_to_ankify(graph)
        logger.info(f"Found {len(blocks)} blocks with the '{self.tag_ankify}' tag")
        report = SyncReport(dry_run=self.dry_run)

        # Fallback for blocks the plugin did not reach: persist ids, then re-select
        # the blocks from the reloaded pages.
        need = blocks_needing_ids(blocks)
        if need:
            logger.info(f"{len(need)} block(s) (ankified or parents) have no persisted id")
            persister = self.make_persister(graph)
            try:
                done = persister.persist(need)
            except PersistError as e:
                logger.error(str(e))
                done = []
            report.persisted = list(persister.written)
            if done:
                blocks = self.blocks_to_ankify(graph)

        block_ankifier = self.make_block_ankifier()
        block_ankifier.graph_path = graph.path
        hashes, cached = self._page_hashes(graph, blocks)
        if self.skip_unchanged and cached:
            keep = []
            for block in blocks:
                path = block.parent_page.path if getattr(block, "parent_page", None) else None
                if path and cached.get(path) == hashes.get(path):
                    report.skipped_unchanged.append(block)
                else:
                    keep.append(block)
            logger.info(f"{len(report.skipped_unchanged)} block(s) on unchanged pages skipped; {len(keep)} to check")
            blocks = keep
        if self.prefetch_notes and blocks:
            self._prefetch()

        for block in blocks:
            if not block.uid:
                report.missing_id.append(block)
                continue
            try:
                note = block_ankifier.ankify(block)
            except Exception:
                logger.exception(f"Failed ankifying {block} during conversion to anki note")
                report.failed.append(block)
                continue
            try:
                self._upload(note, block, report)
            except Exception:
                logger.exception(f"Failed ankifying {block} during upload to anki")
                report.failed.append(block)

        if report.missing_id:
            logger.warning(f"{len(report.missing_id)} ankified block(s) have no persisted Logseq id "
                           f"and were skipped. Run `ankify_logseq check` to list them.")
        logger.info(report.summary())
        if not self.dry_run:
            failed_pages = {b.parent_page.path for b in report.failed + report.missing_id if getattr(b, "parent_page", None)}
            self._save_page_hashes(graph, {p: h for p, h in hashes.items() if p not in failed_pages}, cached)
        return report

    # ---- unchanged-page cache
    def _cache_path(self, graph):
        import hashlib
        key = hashlib.sha1(os.path.abspath(graph.path).encode()).hexdigest()[:12]
        return os.path.join(self.cache_dir, f"page-hashes-{key}.json")

    def _page_hashes(self, graph, blocks):
        """(current hashes of the pages that hold ankified blocks, cached hashes)."""
        import hashlib, json
        hashes = {}
        for b in blocks:
            page = getattr(b, "parent_page", None)
            if page is None or not page.path or page.path in hashes:
                continue
            try:
                with open(page.path, "rb") as f:
                    hashes[page.path] = hashlib.sha256(f.read()).hexdigest()
            except OSError:
                pass
        cached = {}
        try:
            with open(self._cache_path(graph), encoding="utf-8") as f:
                cached = json.load(f)
        except (OSError, ValueError):
            pass
        return hashes, cached

    def _save_page_hashes(self, graph, hashes, cached):
        import json
        os.makedirs(self.cache_dir, exist_ok=True)
        merged = dict(cached); merged.update(hashes)
        with open(self._cache_path(graph), "w", encoding="utf-8") as f:
            json.dump(merged, f)

    def _prefetch(self):
        """Fetch every note of the two note types once (a few bulk requests) instead
        of two requests per block; ~7k blocks went from 11 minutes to seconds."""
        query = " OR ".join(f'note:"{t}"' for t in (self.note_basic, self.note_cloze))
        ids = anki.find_notes(f"({query})")
        self._notes_by_uid = {}
        for i in range(0, len(ids), 500):
            for n in anki.get_notes(ids[i:i + 500]):
                fields = {k: v["value"] for k, v in n["fields"].items()}
                uid = fields.get(self.uid_field, "").strip()
                if uid:
                    self._notes_by_uid[uid] = (n["noteId"], fields)
        logger.info(f"Prefetched {len(ids)} notes from Anki ({len(self._notes_by_uid)} with a {self.uid_field})")

    def _find_existing(self, note):
        """(note_id, existing fields) for the note matching this block, or (None, None)."""
        uid = note["fields"][self.uid_field]
        if self._notes_by_uid is not None:
            hit = self._notes_by_uid.get(uid)
            return hit if hit else (None, None)
        note_id = anki.get_note_id(note, self.uid_field)
        if not note_id:
            return None, None
        return note_id, {k: v['value'] for k, v in anki.get_note(note_id)['fields'].items()}

    def _ensure_deck(self, deck_name, report):
        """Return the deck name to use: an existing deck (Anki deck names are
        case-insensitive, so a differently capitalized tag maps to the existing
        spelling), or a newly created one."""
        if self._known_decks is None:
            self._known_decks = {d.lower(): d for d in anki.get_deck_names()}
        existing = self._known_decks.get(deck_name.lower())
        if existing is not None:
            return existing
        if not self.create_decks:
            raise ValueError(f"deck '{deck_name}' does not exist in Anki (and --no-create-decks is set)")
        if not self.dry_run:
            anki.create_deck(deck_name)
        self._known_decks[deck_name.lower()] = deck_name
        report.decks_created.append(deck_name)
        logger.info(f"{'[dry run] would create' if self.dry_run else 'created'} deck '{deck_name}'")
        return deck_name

    def _upload(self, note, block, report):
        note["deckName"] = self._ensure_deck(note["deckName"], report)
        note_id, existing = self._find_existing(note)
        if note_id:
            owned_existing = {k: existing.get(k, "") for k in note['fields']}
            if owned_existing == note['fields']:
                report.unchanged.append(block)
            else:
                if not self.dry_run:
                    anki.update_note(note, note_id, self.uid_field)
                report.updated.append(block)
        else:
            if not self.dry_run:
                anki.add_note(note)
            report.added.append(block)
        if self.dry_run:
            return
        if note['suspend'] is True:
            anki.suspend_note(note, self.uid_field)
            report.suspended += 1
        elif note['suspend'] is False:
            anki.unsuspend_note(note, self.uid_field)
            report.unsuspended += 1
            # suspend=False also marks the cards with a purple flag so they're easy to find in Anki
            anki.flag_note(note, self.uid_field, anki.FLAG_PURPLE)
            report.flagged += 1


class BlockAnkifier:
    def __init__(self, deck="Default", note_basic="Roam Basic", note_cloze="Roam Cloze",
                 pageref_cloze="outside", tag_ankify="ankify", tag_ankify_root="ankify-root",
                 num_parents=0, include_page=False, max_depth=None,
                 option_keys=("ankify", "ankify_roam", "ankify_logseq"), field_names=None,
                 tags_from_attr=False, download_imgs='never', uid_field="logseq uid",
                 parent_uid_field="logseq parent uid", options_from_properties=False,
                 graph_path=None):
        self.deck = deck
        self.note_basic = note_basic
        self.note_cloze = note_cloze
        self.pageref_cloze = pageref_cloze
        self.tag_ankify = tag_ankify
        self.tag_ankify_root = tag_ankify_root
        self.num_parents = num_parents
        self.include_page = include_page
        self.max_depth = max_depth
        self.option_keys = list(option_keys)
        self.field_names = dict(field_names or {})
        self.tags_from_attr = tags_from_attr
        self.download_imgs = download_imgs
        self.uid_field = uid_field
        self.parent_uid_field = parent_uid_field
        self.options_from_properties = options_from_properties
        self.graph_path = graph_path

    def ankify(self, block, **kwargs):
        tags = block.get_tags(from_attr=self.tags_from_attr)
        modelName = self._get_note_type(block)
        deckName = self._get_deck(block)
        if modelName not in self.field_names:
            self.field_names[modelName] = anki.get_field_names(modelName)
        flashcard_type = self._get_flashcard_type(modelName)
        kwargs["pageref_cloze"] = self._get_pageref_cloze(block)
        kwargs["num_parents"] = self._get_num_parents(block)
        kwargs["include_page"] = self._get_include_page(block)
        kwargs["max_depth"] = self._get_max_depth(block)
        fields = self._block_to_fields(block, self.field_names[modelName], flashcard_type, **kwargs)
        res = {
            "deckName": deckName,
            "modelName": modelName,
            "fields": fields,
            "tags": self.ankify_tags(tags),
            "suspend": self._get_suspend(block),
        }
        download_imgs = self._get_download_imgs(block)
        if download_imgs != 'never':
            overwrite = download_imgs == 'always'
            new_fields, images, errors = self.download_images(fields, overwrite)
            if errors:
                errors_list = "\n".join(["  " + str(e) for e in errors])
                logger.error(f"Errors while downloading images on block '{block.uid}':\n{errors_list}")
            else:
                res['fields'] = new_fields
                if images:
                    res['images'] = images
                    logger.info(f"Downloaded {len(res['images'])} images on block '{block.uid}'")
        return res

    # --- images ---

    def download_images(self, fields, overwrite=False):
        new_fields, images, errors = {}, {}, []
        for name, field in fields.items():
            soup = BeautifulSoup(field, 'html.parser')
            for img in soup.find_all("img"):
                src = img['src']
                filename = os.path.basename(urlparse(src).path).split("%2F")[-1]
                if filename in images or (anki.found_media(filename) and not overwrite):
                    img['src'] = filename
                    continue
                try:
                    data = self._fetch_image(src)
                    images[filename] = {"data": data, "filename": filename}
                    img['src'] = filename
                except Exception as e:
                    errors.append(e)
            new_fields[name] = str(soup)
        return new_fields, list(images.values()), errors

    def _fetch_image(self, src):
        """Return base64 data for an http(s) url or a graph-relative asset path."""
        if re.match(r"^https?://", src):
            res = requests.get(src)
            if res.status_code != 200:
                raise ValueError(f"Download of '{src}' failed with return code {res.status_code}")
            return base64.b64encode(res.content).decode()
        if self.graph_path is None:
            raise ValueError(f"Cannot resolve relative image '{src}' without a graph path")
        path = os.path.normpath(os.path.join(self.graph_path, "pages", src))
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode()

    # --- options ---

    def _get_option(self, block, option):
        pat = r'''^(\[\[)?(%s)(\]\])?:\s*%s\s?=\s?(.*)$''' % ("|".join(self.option_keys), option)
        for tag in block.get_tags(from_attr=self.tags_from_attr):
            m = re.match(pat, tag)
            if m:
                res = m.groups()[-1]
                if res.startswith("'") and res.endswith("'"):
                    res = res[1:-1]
                elif res.startswith('"') and res.endswith('"'):
                    res = res[1:-1]
                return res
        if self.options_from_properties:
            for b in [block] + block.parent_blocks:
                if option in b.properties:
                    return b.properties[option]
                if b is block and option != "deck":
                    break  # only `deck` inherits from parent blocks
        return None

    def _get_suspend(self, block):
        opt = self._get_option(block, "suspend")
        if opt == 'True' or opt == 'true':
            return True
        if opt == 'False' or opt == 'false':
            return False
        return None

    def ankify_tags(self, tags):
        return [re.sub(r"\s+", "_", tag) for tag in tags]

    def _get_note_type(self, block):
        opt = self._get_option(block, "note")
        if opt:
            return opt
        if any(type(obj) == Cloze for obj in block.get_contents(recursive=True)):
            return self.note_cloze
        return self.note_basic

    def _get_deck(self, block):
        opt = self._get_option(block, "deck")
        return opt or self.deck

    def _get_pageref_cloze(self, block):
        opt = self._get_option(block, "pageref-cloze")
        return opt or self.pageref_cloze

    def _get_flashcard_type(self, modelName):
        return "cloze" if re.search("[Cc]loze", modelName) else "basic"

    def _get_num_parents(self, block):
        num_parents = self._get_option(block, "num-parents")
        if num_parents:
            if num_parents == "all":
                return num_parents
            try:
                return int(num_parents)
            except ValueError:
                pass
        return self.num_parents

    def _get_include_page(self, block):
        opt = self._get_option(block, "include-page")
        if opt:
            if opt == 'True':
                return True
            if opt == 'False':
                return False
        return self.include_page

    def _get_max_depth(self, block):
        opt = self._get_option(block, "max-depth")
        if opt:
            if opt == "None":
                return None
            if re.match(r"^([1-9]?\d+|0)$", opt):
                return int(opt)
        return self.max_depth

    def _get_download_imgs(self, block):
        opt = self._get_option(block, "download-imgs")
        return opt or self.download_imgs

    # --- fields ---

    def _block_to_fields(self, block, field_names, flashcard_type, **kwargs):
        htmls = []
        if flashcard_type == "cloze":
            htmls.append(self.front_to_html(block, proc_cloze=True, **kwargs))
        else:
            htmls.append(self.front_to_html(block, proc_cloze=False, **kwargs))
            htmls.append(self.back_to_html(block, proc_cloze=False, **kwargs))
        htmls = [re.sub("[%s]" % ASCII_NON_PRINTABLE, "", html) for html in htmls]

        # Only the fields this tool owns: leading content fields + the two logseq ids.
        content_field_names = [fn for fn in field_names if fn not in RESERVED_FIELDS][:len(htmls)]
        fields = dict(zip(content_field_names, htmls))
        fields[self.uid_field] = block.uid or ""
        fields[self.parent_uid_field] = block.parent_uid or ""
        return fields

    def front_to_html(self, block, **kwargs):
        parents_kwargs = kwargs.copy()
        parents_kwargs["proc_cloze"] = False  # never convert cloze markup in parents
        num_parents_to_include = kwargs.get("num_parents", self.num_parents)
        include_page = kwargs.get("include_page", self.include_page)

        parents = block.parents
        parents_to_root = parents
        if self.tag_ankify_root is not None:
            for i, o in enumerate(parents):
                if self.tag_ankify_root in o.get_tags(inherit=False, from_attr=self.tags_from_attr):
                    parents_to_root = parents[:i + 1]
                    break

        page_html = block.parent_page.to_html(**parents_kwargs)
        parents_to_root_html = [p.to_html(**parents_kwargs) for p in parents_to_root]
        question_html = block.to_html(**kwargs)

        if num_parents_to_include == "all":
            num_parents_to_include = len(parents_to_root)
        else:
            num_parents_to_include = min(num_parents_to_include, len(parents_to_root))
        parents_selected_html = parents_to_root_html[:num_parents_to_include]
        if include_page:
            if len(parents_selected_html) == len(parents):
                pass
            elif len(parents_selected_html) == len(parents) - 1:
                parents_selected_html = parents_selected_html + [page_html]
            else:
                parents_selected_html = parents_selected_html + ['<span class="ellipsis">...</span>'] + [page_html]

        if len(parents_selected_html) == len(parents):
            list_html = self._listify_front(parents_selected_html[::-1] + [question_html], cls='page-title')
            return f'<div class="front-side">{list_html}</div>'
        elif len(parents_selected_html) > 0:
            list_html = self._listify_front(parents_selected_html[::-1] + [question_html])
            return f'<div class="front-side">{list_html}</div>'
        else:
            return f'<div class="front-side">{question_html}</div>'

    def _listify_front(self, block_htmls, cls='block', depth=0):
        if len(block_htmls) == 1:
            return '<ul><li class="block">' + block_htmls[0] + '</li></ul>'
        cls += f" parent parent-{len(block_htmls) - 1}"
        if depth == 0: cls += " parent-top"
        return f'<ul><li class="{cls}">' + block_htmls[0] + '</li>' + \
            self._listify_front(block_htmls[1:], 'block', depth + 1) + '</ul>'

    def back_to_html(self, block, **kwargs):
        children = block.children
        num_descendants = block.num_descendants()
        if num_descendants >= 2:
            return f'<div class="back-side list">{self._listify_back(children, **kwargs)}</div>'
        elif num_descendants == 1:
            return f'<div class="back-side">{children[0].to_html(**kwargs)}</div>'
        else:
            return '<div class="back-side"></div>'

    def _listify_back(self, blocks, level=0, **kwargs):
        if not blocks:
            return ""
        if self.max_depth is not None and level == self.max_depth:
            return ""
        html_list = ""
        for block in blocks:
            html_list += f'<li>{block.to_html(**kwargs)}</li>'
            html_list += f'{self._listify_back(block.children, level=level + 1)}'
        return f'<ul>{html_list}</ul>'
