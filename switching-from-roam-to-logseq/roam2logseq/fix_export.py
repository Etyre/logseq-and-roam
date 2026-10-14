"""Fix a Roam JSON export before importing it into Logseq.

    python3 -m roam2logseq.fix_export eli.json eli.fixed.json [--report report.md]

Fixes (all documented in ../import-issues.md):

1. Page titles that collide once Logseq normalizes them. Logseq trims titles and
   treats them case-insensitively, and writes one file per title, so Roam pages
   `December 16th, 2019 ` (trailing space) and `December 16th, 2019` become one file
   and one of them is silently lost. Titles are stripped of surrounding whitespace;
   when the stripped title (case-insensitively) already exists, the page's blocks are
   appended to the surviving page under a marker block. Every `[[ref]]` and `#[[ref]]`
   to a renamed page is rewritten.
2. Embeds with surplus parentheses `((((uid))))` → `((uid))` (Logseq cannot render
   the former; Roam rendered it anyway).
3. `$$...$$ - text` on a block's first line → `$$...$$ \\- text`, continuation lines
   starting with `- ` → `\\- `, and continuation lines starting with `# ` (a markdown
   heading) → `\\# `. Logseq's parser otherwise splits these into separate blocks;
   the escapes render as the plain character and are inverted on the way back.

The input is never modified. The output keeps every block's uid, so ankify_roam and
Roam itself keep working with it.
"""
import argparse
import base64
import collections
import hashlib
import json
import re
import sys

RE_QUAD_PARENS = re.compile(r"\({3,}([\w\-]{9,40})\){3,}")
RE_LATEX_DASH = re.compile(r"^(\s*\$\$.*?\$\$)(\s+)- ")
RE_DASH_CONTINUATION = re.compile(r"(\n\s*)- ")
RE_HASH_CONTINUATION = re.compile(r"(\n[ \t]*)(#+ )")   # a markdown heading line inside a block splits it in Logseq


def walk(blocks, parent=None):
    for b in blocks:
        yield b, parent
        yield from walk(b.get("children", []), b)


class Fixer:
    def __init__(self, pages):
        self.pages = pages
        self.counts = collections.Counter()
        self.notes = []
        self.renames = {}

    # ------------------------------------------------------------ page titles

    @staticmethod
    def _size(page):
        return sum(1 for _ in walk(page.get("children", [])))

    def fix_titles(self):
        by_key = {}  # normalized title -> surviving page
        renames = self.renames  # original title -> new title (for ref rewriting)
        survivors, merged = [], []
        # Survivor of a collision: a clean title, then the page with the most blocks.
        groups = collections.defaultdict(list)
        for p in self.pages:
            groups[p.get("title", "").strip().lower()].append(p)
        for key, ps in groups.items():
            clean = [p for p in ps if p.get("title", "") == p.get("title", "").strip()]
            pool = clean or ps
            by_key[key] = max(pool, key=self._size)
        for p in self.pages:
            t = p.get("title", "")
            key = t.strip().lower()
            if by_key.get(key) is p:
                if t != t.strip():
                    # survivor with a dirty title (no clean twin): rename it
                    new_title = t.strip()
                    self.notes.append(f"renamed page {t!r} -> {new_title!r}")
                    renames[t] = new_title
                    p["title"] = new_title
                    self.counts["pages renamed"] += 1
                survivors.append(p)
                continue
            target = by_key.get(key)
            # collision: merge into the survivor
            reason = "trailing/leading whitespace" if t.strip() == target["title"] else "differs only by case"
            marker = {
                "string": f"Merged on import from Roam page \"{t}\" ({reason})",
                "uid": "mrg" + base64.urlsafe_b64encode(hashlib.sha256(t.encode()).digest()).decode()[:6],
                "children": p.get("children", []),
                "create-time": p.get("create-time"), "edit-time": p.get("edit-time"),
            }
            if p.get("children"):
                target.setdefault("children", []).append(marker)
            self.notes.append(f"merged page {t!r} into {target['title']!r} ({reason}; {len(p.get('children', []))} top-level blocks)")
            renames[t] = target["title"]
            merged.append(p)
            self.counts["pages merged"] += 1
        self.pages = survivors
        self.renames = renames
        return renames

    def rewrite_refs(self):
        """Rewrite [[refs]] to pages whose title changed by more than case. Logseq
        resolves page names case-insensitively, so case-only merges need no rewriting,
        and leaving those refs alone keeps the block text identical to Roam's."""
        needed = {old: new for old, new in self.renames.items() if old.lower() != new.lower()}
        if not needed:
            self.counts["refs rewritten"] = 0
            return
        pat = re.compile(r"\[\[(" + "|".join(re.escape(t) for t in sorted(needed, key=len, reverse=True)) + r")\]\]")
        self.renames_for_refs = needed
        n = 0
        for p in self.pages:
            for b, _ in walk(p.get("children", [])):
                s = b.get("string")
                if s and "[[" in s:
                    new = pat.sub(lambda m: "[[" + needed[m.group(1)] + "]]", s)
                    if new != s:
                        b["string"] = new; n += 1
        self.counts["refs rewritten"] = n

    # ------------------------------------------------------------ block strings

    def fix_strings(self):
        for p in self.pages:
            for b, _ in walk(p.get("children", [])):
                s = b.get("string")
                if not s:
                    continue
                new = RE_QUAD_PARENS.sub(r"((\1))", s)
                if new != s:
                    self.counts["surplus-paren embeds"] += 1
                s2 = RE_LATEX_DASH.sub(r"\1\2\\- ", new)
                if s2 != new:
                    self.counts["latex-dash first lines"] += 1
                new = s2
                # dash / heading continuation lines, but not inside fenced code
                if re.search(r"\n\s*(- |#+ )", new):
                    parts = new.split("```")
                    for i in range(0, len(parts), 2):  # even parts are outside code fences
                        fixed, k = RE_DASH_CONTINUATION.subn(r"\1\\- ", parts[i])
                        if k:
                            self.counts["dash continuation lines"] += k
                        fixed, k = RE_HASH_CONTINUATION.subn(r"\1\\\2", fixed)
                        if k:
                            self.counts["heading-like continuation lines"] += k
                        parts[i] = fixed
                    new = "```".join(parts)
                if new != s:
                    b["string"] = new

    # ------------------------------------------------------------ uids

    def fix_uids(self):
        """Roam sometimes exports the same block (same uid, same text) in several
        places. Logseq keeps one id per uuid and drops the rest, and derived ids would
        collide. Every occurrence after the first gets a fresh deterministic 9-char uid;
        `uid_map()` records new -> original."""
        seen = set()
        self.uid_replacements = {}
        all_uids = {b["uid"] for p in self.pages for b, _ in walk(p.get("children", [])) if "uid" in b}
        for p in self.pages:
            for b, _ in walk(p.get("children", [])):
                u = b.get("uid")
                if u is None:
                    continue
                if u not in seen:
                    seen.add(u)
                    continue
                n = 1
                while True:
                    digest = hashlib.sha256(f"{u}#{n}".encode()).digest()
                    new = base64.urlsafe_b64encode(digest).decode()[:9]
                    if new not in all_uids and new not in seen:
                        break
                    n += 1
                b["uid"] = new
                seen.add(new); all_uids.add(new)
                self.uid_replacements[new] = u
                self.counts["duplicate block uids replaced"] += 1

    def fix_empty_titles(self):
        for p in self.pages:
            t = p.get("title", "")
            if re.sub(r"\s+", " ", t).strip() != t.strip() or re.search(r"[\n\r\t\u00a0]", t):
                new = re.sub(r"\s+", " ", t).strip()
                self.notes.append(f"title with unusual whitespace {t!r} -> {new!r}")
                self.renames[t] = new
                p["title"] = new
                self.counts["titles with unusual whitespace"] += 1
            if not p.get("title", "").strip():
                self.notes.append(f"page with empty title {p.get('title')!r} ({len(p.get('children', []))} top-level blocks) renamed to 'Untitled Roam page'")
                p["title"] = "Untitled Roam page"
                self.counts["empty titles renamed"] += 1

    def uid_map(self):
        return dict(getattr(self, "uid_replacements", {}))

    def run(self):
        self.fix_empty_titles()
        self.fix_titles()
        self.rewrite_refs()
        self.fix_strings()
        self.fix_uids()
        return self.pages

    def report(self):
        lines = ["# fix_export report", ""]
        for k, v in sorted(self.counts.items()):
            lines.append(f"- {k}: {v}")
        if self.notes:
            lines += ["", "## Pages"] + [f"- {n}" for n in self.notes]
        return "\n".join(lines) + "\n"

    def title_map(self):
        """original Roam title -> title used from now on (for the reverse direction)."""
        return dict(self.renames)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--report", default=None, help="write a markdown report here")
    ap.add_argument("--title-map", default=None, help="write the original->new page title map (JSON) here")
    args = ap.parse_args(argv)
    with open(args.input, encoding="utf-8") as f:
        pages = json.load(f)
    fixer = Fixer(pages)
    pages = fixer.run()
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(pages, f, ensure_ascii=False, indent=1)
    rep = fixer.report()
    if args.title_map:
        with open(args.title_map, "w", encoding="utf-8") as f:
            json.dump({"titles": fixer.title_map(), "uids": fixer.uid_map()}, f, ensure_ascii=False, indent=1)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            f.write(rep)
    sys.stdout.write(rep)


if __name__ == "__main__":
    main()
