"""Part VIII: import new Otter.ai transcripts into the Logseq graph (replaces the Roam
extension at github.com/Etyre/otter-import, which went through a SamePage backend).

    python3 otter2logseq.py GRAPH_DIR [--credentials ~/.otter-credentials] [--dry-run]
                            [--state ~/.otter2logseq/state.json] [--max 20] [--roam-spelling]

Talks to Otter's (unofficial, cookie-based) API directly from this machine, the way the
open-source clients do (login with email/password, then /speeches, /speech?otid=). No
third party sees the credentials. The credentials file has the email on line 1 and the
password on line 2 (chmod 600); an account created through Google needs an Otter
password set on otter.ai first.

Each new, fully processed recording becomes one top-level block on the page for its
Otter folder, in the exact shape the Roam extension used (block texts copied from
ImportOtterDialog.tsx, with the typos fixed; `--roam-spelling` keeps them):

    <Date page> [#[[Walking Journal]]]
      [[Automated transcirpt from otter]] [#[[transcribed verbal notes]]]
        Recroding Metadata
          date:: [[September 5th, 2026]]
          start-time:: 9:15 AM
          otter-link:: https://otter.ai/u/...
          [source::]                      (audio-notes folder only)
        TODO [[Transcricpt]]
          <the whole transcript as one block, "start - end - speaker: text" per line>

Block ids are derived from the Otter id (uuid5), so a re-run never duplicates. Imported
ids are remembered in the state file. Pages are written in Logseq's native layout;
Logseq's file watcher picks the change up if the app is running.
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import uuid

import requests

API = "https://otter.ai/forward/api/v1"
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/Etyre/otter2logseq")
# Otter folder id -> page and block texts (folder ids from the Roam extension, 2024)
FOLDERS = {
    1072467: {"page": "Otter auto-import walking journal transcripts", "title_tag": " #[[Walking Journal]]", "label_tag": "", "source": False},
    961073: {"page": "Otter auto-imported audio notes transcripts", "title_tag": "", "label_tag": " #[[transcribed verbal notes]]", "source": True},
    None: {"page": "Otter auto-imported transcripts (no folder)", "title_tag": "", "label_tag": "", "source": False},
}
TEXTS = {  # as in the Roam extension; --fix-typos swaps in the second column
    "label": ("[[Automated transcirpt from otter]]", "[[Automated transcript from otter]]"),
    "meta": ("Recroding Metadata", "Recording Metadata"),
    "transcript": ("[[Transcricpt]]", "[[Transcript]]"),
}


def roam_date(d):
    n = d.day
    suf = "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{d.strftime('%B')} {n}{suf}, {d.year}"


def clock(d):
    return d.strftime("%-I:%M %p")


class Otter:
    def __init__(self, email, password):
        self.s = requests.Session()
        self.s.headers["User-Agent"] = "Mozilla/5.0 (Macintosh) otter2logseq/0.1"
        self.email, self.password = email, password
        self.userid = None

    def login(self):
        r = self.s.get(f"{API}/login", params={"username": self.email}, auth=(self.email, self.password), timeout=30)
        r.raise_for_status()
        data = r.json()
        self.userid = data.get("userid") or (data.get("user") or {}).get("id")
        if not self.userid:
            raise SystemExit(f"Otter login gave no user id: {str(data)[:200]}")
        return data

    def speeches(self, page_size=20, folder=0):
        r = self.s.get(f"{API}/speeches", params={"userid": self.userid, "folder": folder, "page_size": page_size, "source": "owned"}, timeout=60)
        r.raise_for_status()
        return r.json().get("speeches", [])

    def speech(self, otid):
        r = self.s.get(f"{API}/speech", params={"otid": otid, "userid": self.userid}, timeout=60)
        r.raise_for_status()
        return r.json().get("speech", {})


def transcript_text(speech):
    """'start - end - Speaker: text' lines, like the Roam template `{start} - {end} - {text}`."""
    lines = []
    for t in speech.get("transcripts", []):
        start = t.get("start_offset", 0) / 1000.0 if t.get("start_offset", 0) > 100000 else t.get("start_offset", 0)
        end = t.get("end_offset", 0) / 1000.0 if t.get("end_offset", 0) > 100000 else t.get("end_offset", 0)
        sp = t.get("speaker_model_label") or (t.get("speaker") or {}).get("speaker_name") or ""
        text = (t.get("transcript") or "").strip()
        fmt = lambda s: time.strftime("%H:%M:%S", time.gmtime(s))
        lines.append(f"{fmt(start)} - {fmt(end)} - " + (f"{sp}: " if sp else "") + text)
    return "\n".join(lines)


def block_tree(speech, folder_cfg, fix_typos):
    i = 1 if fix_typos else 0
    created = datetime.datetime.fromtimestamp(speech.get("created_at") or speech.get("start_time") or time.time())
    date = roam_date(created)
    link = f"https://otter.ai/u/{speech['otid']}"
    meta = [("date", f"[[{date}]]"), ("start-time", clock(created)), ("otter-link", link)]
    if folder_cfg["source"]:
        meta.append(("source", ""))
    title = (speech.get("title") or "").strip()
    otid = speech["otid"]
    uid = lambda part: str(uuid.uuid5(NAMESPACE, f"{otid}:{part}"))
    return {
        "text": f"{date}{folder_cfg['title_tag']}", "id": uid("root"),
        "children": [{
            "text": TEXTS["label"][i] + folder_cfg["label_tag"] + (f" ({title})" if title and title.lower() != "untitled" else ""), "id": uid("label"),
            "children": [
                {"text": TEXTS["meta"][i], "id": uid("meta"),
                 "children": [{"text": f"{k}:: {v}", "id": uid("meta-" + k)} for k, v in meta]},
                {"text": "TODO " + TEXTS["transcript"][i], "id": uid("transcript"),
                 "children": [{"text": transcript_text(speech), "id": uid("text")}]},
            ],
        }],
    }


def render(block, depth=0):
    """Native Logseq layout: tabs for depth, continuation lines indented two more spaces."""
    ind = "\t" * depth
    lines = block["text"].split("\n")
    out = [f"{ind}- {lines[0]}"] + [f"{ind}  {l}" for l in lines[1:]]
    out.append(f"{ind}  id:: {block['id']}")
    for c in block.get("children", []):
        out.extend(render(c, depth + 1))
    return out


def page_path(graph_dir, title):
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "switching-from-roam-to-logseq"))
    from roam2logseq.normalize_graph import title_to_filename
    return os.path.join(graph_dir, "pages", title_to_filename(title))


def append_block(graph_dir, title, block, dry_run):
    path = page_path(graph_dir, title)
    text = "\n".join(render(block)) + "\n"
    if dry_run:
        print(f"--- would append to {os.path.relpath(path, graph_dir)}:\n{text[:600]}")
        return
    existing = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            existing = f.read()
        if block["id"] in existing:
            return
    if existing and not existing.endswith("\n"):
        existing += "\n"
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(existing + text)
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("graph_dir")
    ap.add_argument("--credentials", default="~/.otter-credentials")
    ap.add_argument("--state", default="~/.otter2logseq/state.json")
    ap.add_argument("--max", type=int, default=20, help="recordings to look at per run (newest first)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--roam-spelling", dest="fix_typos", action="store_false", default=True, help="write the Roam extension's misspelled page names (Transcricpt, Recroding, transcirpt) instead of the corrected ones")
    ap.add_argument("--list", action="store_true", help="only list recent recordings with their folders")
    args = ap.parse_args(argv)

    cred = os.path.expanduser(args.credentials)
    try:
        with open(cred, encoding="utf-8") as f:
            email, password = [l.strip() for l in f.read().splitlines()[:2]]
    except (OSError, ValueError):
        raise SystemExit(f"credentials file {cred} must hold the Otter email on line 1 and the password on line 2")
    state_path = os.path.expanduser(args.state)
    state = {"imported": {}}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)

    ot = Otter(email, password)
    ot.login()
    speeches = ot.speeches(page_size=args.max)
    print(f"{len(speeches)} recent recording(s)")
    if args.list:
        for sp in speeches:
            f = sp.get("folder") or {}
            print(f"  {sp['otid']}  folder={f.get('id')} {f.get('name')!r}  processed={sp.get('process_finished')}  {sp.get('title')!r}")
        return 0
    n = 0
    for sp in speeches:
        otid = sp["otid"]
        if otid in state["imported"]:
            continue
        if not (sp.get("process_finished") or sp.get("is_processed") or sp.get("upload_finished")):
            print(f"  {otid}: still processing, later")
            continue
        folder_id = (sp.get("folder") or {}).get("id")
        cfg = FOLDERS.get(folder_id, FOLDERS[None])
        full = ot.speech(otid)
        if not full.get("transcripts"):
            print(f"  {otid}: no transcript yet, later")
            continue
        block = block_tree({**sp, **full}, cfg, args.fix_typos)
        append_block(args.graph_dir, cfg["page"], block, args.dry_run)
        print(f"  {otid}: -> {cfg['page']!r}")
        if not args.dry_run:
            state["imported"][otid] = {"page": cfg["page"], "at": datetime.datetime.now().isoformat(timespec='seconds')}
            os.makedirs(os.path.dirname(state_path), exist_ok=True)
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=1)
        n += 1
    print(f"{'would import' if args.dry_run else 'imported'} {n} recording(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
