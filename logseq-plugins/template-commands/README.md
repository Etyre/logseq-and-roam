# Template commands (Logseq plugin)

SmartBlock-style commands for Logseq templates. Insert a template with `/Template`
(any block with a `template:: Name` property is one; add
`template-including-parent:: false` to leave the title block out). Logseq expands its
own `<% today %>`, `<% tomorrow %>`, `<% time %>`, `<% current page %>` and
natural-language dates (those come out as page links). Logseq also eats any other
`<%…%>`, so this plugin's tokens use `{%…%}`; they are expanded in freshly inserted
blocks (or typed by hand), then the cursor is placed.

| Token | Result |
|---|---|
| `{%CURSOR%}` | removed; the cursor goes there |
| `{%NOBLOCKOUTPUT%}` | the block is deleted if nothing else is left in it |
| `{%CURRENTPAGENAME%}` / `{%CURRENTPAGE%}` | name of the current page / link to it |
| `{%PAGELINK%}` / `{%BLOCKLINK%}` / `{%BLOCKREF%}` | `logseq://` link to the page / to this block; `((ref))` to this block |
| `{%PARENTTEXT%}` / `{%PARENTLINK%}` / `{%PARENTREF%}` / `{%PARENTPAGE%}` | text / link / ref / page of the block the template was inserted under |
| `{%DATE%}` / `{%DATE:tomorrow%}` / `{%DATE:3 days ago%}` / `{%DATE:next friday%}` / `{%DATE:2026-09-05%}` | journal-page link in the graph's date format; `DATEPLAIN` gives it without brackets |
| `{%TIME%}` / `{%TIMEAMPM%}` | 14:05 / 2:05 PM |
| `{%RANDOMNUMBER:1,100%}` | random integer |
| `{%RANDOMBLOCK%}` / `{%RANDOMBLOCKFROM:page%}` / `{%RANDOMBLOCKMENTION:page%}` / `{%RANDOMCHILDOF:((ref))%}` | `((ref))` to a random block (any / on that page / referencing that page / child of that block) |
| `{%RANDOMPAGE%}` | `[[link]]` to a random page |
| `{%INPUT:prompt,default%}` | asks; the typed value |
| `{%SET:name,value%}` / `{%GET:name%}` / `{%HAS:name%}` | variables (SET outputs nothing) |
| `{%IF:condition,then,else%}` | condition is JavaScript (may use `ctx`), e.g. `{%IF:new Date().getHours() < 12,morning,afternoon%}` |
| `{%IFDAYOFWEEK:1 2 3 4 5,text%}` | text only on those days (1 = Monday, 7 = Sunday) |
| `{%REPEAT:{%INPUT:How many?%},Chapter {%GET:ITERATION%}%}` | that many sibling blocks after this one |
| `{%CONCAT:a,b%}` / `{%UPPER:x%}` / `{%LOWER:x%}` / `{%TRIM:x%}` | text helpers |
| `{%CHILDREN:((ref))%}` | `((refs))` of that block's children |
| `{%SMARTBLOCK:Template name%}` | inserts another template's blocks after this one |
| `{%JAVASCRIPT:code%}` or `{%J:code%}` | runs the code (async ok; `ctx` = block, page, parent, graph, vars; `logseq` = plugin API); the return value is inserted |

Tokens nest: inner ones are expanded first. Unknown tokens are left as typed.

**Buttons**: `{{renderer :template-button, Caption, Template name}}` renders a button
that inserts that template right after the button's block (`/template button` inserts
the macro). Roam's own `{{[[Label]]}}` buttons are the Expand button plugin's job.

A freshly inserted "metadata" block (source-page template) is lifted into page
properties, as the converter does for imported pages.

Install: Settings, Advanced, Developer mode; Plugins, "Load unpacked plugin", this folder.

**Inserting a template fast**: every template is its own slash command, so `/sour` + Enter
inserts "Source page template" where you are (an empty block is replaced). New templates
appear after a plugin reload or a Logseq restart.

**Dropdown**: every command is also a slash command prefixed `SB`, so typing `/sb da`
filters to the DATE entries and inserts the token at the cursor, like `<%` did in Roam.
