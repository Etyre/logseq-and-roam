"""Write a parsed Logseq page back out in Logseq's own (native) file layout.

Layout, matching what Logseq OG writes itself:

    ---                      (front matter kept if the page had it)
    title: Page title
    ---

    - first line of block        <- "\\t" * depth + "- "
      id:: <uuid>                <- "\\t" * depth + "  " + property line (id first)
      key:: value
      continuation line          <- same prefix; blank lines inside a block keep the prefix
    \t- child block
    \t  id:: ...

Task markers (`TODO ...`) and priorities (`[#A]`) go back on the first line.
"""
import re

from ankify_logseq.logseq.parser import RE_PROPERTY


def block_lines(block, depth, uuid_for=None, first_in_page=False):
    """Lines for one block (not its children)."""
    prefix = "\t" * depth
    cont = prefix + "  "
    text = block.to_string()
    if text.startswith("\n```"):
        text = text[1:]  # the Roam importer's newline before a code fence; Logseq puts the fence on the bullet line
    lines = text.split("\n") if text else [""]
    first = lines[0]
    if block.marker:
        pri = block.properties.get("priority")
        first = block.marker + (f" [#{pri}]" if pri else "") + (" " + first if first else "")
    out = [prefix + "- " + first if first else prefix + "-"]
    props = []
    uid = uuid_for(block) if uuid_for else block.uid
    if uid:
        props.append(f"{cont}id:: {uid}")
    content_props = {(m.group("key"), m.group("value")) for m in (RE_PROPERTY.match(l) for l in lines) if m}
    for k, v in block.properties.items():
        if k == "id" or (k == "priority" and block.marker):
            continue
        if (k, v) in content_props:
            continue  # an attribute line that is content (e.g. `URL::`, `tags:: #source`) is already written
        if not RE_PROPERTY.match(f"{k}:: {v}"):
            continue
        props.append(f"{cont}{k}:: {v}" if v != "" else f"{cont}{k}::")
    rest = [cont + line if line else cont for line in lines[1:]]
    if first.startswith("```"):
        # a block that starts with a code fence: Logseq writes the properties after the content
        out += rest + props
    elif not first and props and not rest and not first_in_page:
        # an empty block with properties: Logseq writes the first property on the bullet line.
        # Not for the first block of a page: there Logseq would read a property-only
        # line as the page's properties and drop the block.
        out = [prefix + "- " + props[0][len(cont):]] + props[1:]
    else:
        out += props + rest
    return out


def page_text(page, uuid_for=None):
    out = []
    if page.properties:
        front = {k: v for k, v in page.properties.items()}
        if getattr(page, "front_matter", False) and "title" in front:
            out += ["---", f"title: {front.pop('title')}", "---", ""]
        for k, v in front.items():
            out.append(f"{k}:: {v}")
    def walk(blocks, depth):
        for b in blocks:
            out.extend(block_lines(b, depth, uuid_for, first_in_page=(depth == 0 and b is page.children[0])))
            walk(b.children, depth + 1)
    walk(page.children, 0)
    return "\n".join(out) + "\n"
