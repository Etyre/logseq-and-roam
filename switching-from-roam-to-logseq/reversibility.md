# Keeping the door open: Logseq → Roam

Requirement (2026-09-04): after using Logseq for a while it must be possible to go
back to Roam, converting anything Logseq-specific that accumulated in the meantime
into a Roam-compatible form. Everything built for the forward migration should be
designed with this in mind.

## 1. What the reverse path needs

1. **A block identity that survives both directions.** Roam identifies blocks by
   9-character uids; Logseq by uuids, persisted only as `id::` properties. Anki
   notes will hold both (Part II). For the rest of the graph we need a mapping so
   that a block that came from Roam goes back with its original uid (keeps
   `roam://` links, block refs and Anki `uid` fields valid), and a block created in
   Logseq gets a fresh Roam uid.

2. **A Logseq → Roam JSON exporter** (mirror of the importer), built on
   ankify_logseq's parser: graph directory → Roam export JSON (pages, nested
   blocks with `string`, `uid`, `children`), which Roam's Import can ingest.

3. **A syntax back-converter** applied per block string on the way out.

## 2. Design decision that follows: derive Logseq ids from Roam uids

During the post-import normalization (import-issues.md §0 step 3) assign every block
that needs a persisted id a **deterministic uuid derived from its Roam uid**:

    logseq_uuid = uuid5(ANKIFY_NAMESPACE, roam_uid)

and write a sidecar table `roam-uid-map.json.gz` (`roam_uid ↔ logseq_uuid ↔ page,
block-path`) for every block in the export, not only the persisted ones.

Consequences:
- Part II's "pair every Anki note with its Logseq block" becomes a lookup, not a
  structural match: `logseq uid = uuid5(ns, roam uid)`.
- The reverse direction is a lookup too: a Logseq block with a derived uuid maps
  back to its Roam uid; one with any other uuid is new and gets a fresh uid.
- **Every block gets a persisted, derived id in the normalization** (decided
  2026-09-04: optionality is worth the larger files). So every imported block
  carries `id:: uuid5(ns, roam_uid)`, and the sidecar map is a convenience, not a
  necessity, for the reverse direction. The plugin's bulk command then has nothing
  to do on the imported graph; it only matters for blocks created later.
- The plugin stays the mechanism for blocks tagged *after* the import; those get
  random uuids and are "new" on the way back.
- **Logseq-born blocks get a derived Roam uid on the way back** (decided
  2026-09-04): `roam_uid = base64url(sha256(logseq_uuid))[:9]`, recorded in the
  same sidecar map. So both directions are pure functions plus a map; the map is
  the source of truth, the derivations just avoid needing it to mint an id. The
  exporter must check the 9-char uids for collisions against all uids in use
  (54 bits: about one in a million for a graph this size). To verify once on a
  throwaway Roam graph: that Roam's JSON import honors caller-supplied `uid`s
  (roam-to-git round trips suggest it does).
- Anki: a card made in Logseq has `logseq uid` set and `uid` empty; on switching
  back, `uid` is filled by lookup and ankify_roam takes over. A card made in Roam
  has both from Part II. Coming back to Logseq later needs no re-derivation.

## 2b. Roam metadata that Logseq cannot hold lives in the sidecar

Per block, the Roam export carries `create-time`, `edit-time`, `create-email`,
`edit-email`, `heading`, `text-align`, `:children/view-type`, `open`, and more.
The Logseq importer drops all of it. The normalizer's sidecar map stores every such
field per uid, so the reverse exporter restores them verbatim (decided 2026-09-04).
Decided 2026-09-05: timestamps stay in the sidecar only; no `created-at::` /
`updated-at::` block properties (Logseq would not maintain them).

The export fixer's page-title changes (trimmed or merged titles) are written to a
title map (`--title-map`) for the same reason.

## 3. Logseq-specific syntax to convert back (inventory, extend as we go)

| Logseq | Roam | Notes |
|---|---|---|
| `TODO`/`DOING`/`NOW`/`LATER` marker | `{{[[TODO]]}}` | `DONE` → `{{[[DONE]]}}`; other markers → TODO |
| `{{renderer :cb, todo}}` / `{{renderer :cb, done}}` (inline checkbox plugin, import-issues §6) | `{{[[TODO]]}}` / `{{[[DONE]]}}` | one-to-one |
| `id:: uuid` | (drop; becomes the block's `uid` via the map) | |
| `collapsed:: true` | `"open": false` in JSON | |
| other `key:: value` block properties | `key:: value` attribute text | same syntax in Roam; keys the converter renamed (`Author(s)`→`Author`, `Start time`→`start-time`, …) go back via the block's `renamed_keys` in the sidecar |
| page properties `title::`, `alias::`, `tags::` | drop title; `alias::`/`tags::` as first-block attributes | |
| `((uuid))` | `((roam-uid))` via map | unknown uuid → new uid |
| `{{embed ((uuid))}}` / `{{embed [[page]]}}` | `{{[[embed]]: ((uid))}}` / `{{[[embed]]: [[page]]}}` | |
| `{{roam/render ((uuid)) "x"}}` | `{{[[roam/render]]:((uid)) "x"}}` | importer's own conversion, inverted |
| `==highlight==` | `^^highlight^^` | |
| `*italic*`, `_italic_` | `__italic__` | careful with snake_case |
| `~~strike~~`, `**bold**`, `` `code` ``, ``` fences, `$$latex$$`, `[[page]]`, `#tag`, `#[[tag]]`, `[text](url)`, `> quote` | unchanged | |
| `\-` escapes we added on import (§4b) | `-` | must be inverted |
| `#[[ankify_logseq: deck="x"]]` option tags and pages named `ankify_logseq: …` | `ankify_roam:` prefix | global rule; `pages[].logseq_title` in the sidecar |
| `{{renderer :rbutton, [[X]]}}` / `{{renderer :rbutton, X}}` (Expand button plugin) + hidden `button-refs:: [[X]]` property | `{{[[X]]}}` / `{{X}}`; drop the property | one-to-one; blocks flagged `roam_buttons`; Logseq indexes refs in properties but not inside macros |
| `{{renderer :ankify-active}}` | `{{[[roam/render]]:((nU1XMzhKA)) "Block UID" }}` | blocks flagged `roam_render_active` |
| `Roam web link:` / `Roam desktop link:` labels | `Web link:` / `Desktop link:` | converter relabels the Roam lines (2026-09-05) |
| Logseq templates (`template::` blocks, `<% current page %>`, `<%PARENTTEXT%>`… ) | `#SmartBlock` definitions with `<%…%>` commands | blocks flagged `smartblock_template`; every rewritten block keeps `template_source` (exact Roam text) |
| hidden `page-tags::` property on top-level blocks (Part IX tag inheritance) | (drop) | Roam nests cards under the tags line instead |
| `Logseq link: logseq://…` line (Part III) | (drop the line) | blocks flagged `logseq_link` in the sidecar; the Roam link lines below it were never removed |
| `# Heading` | `"heading": 1` in JSON | |
| `SCHEDULED:`/`DEADLINE:` lines, `:LOGBOOK:` drawers | drop or keep as text | flag in report |
| `logseq.order-list-type:: number` | `{{[[numbered]]}}`? | Roam numbered lists are a view type; flag |
| `{{query ...}}` (Logseq DSL / datalog) | `{{query: ...}}` | query languages differ; flag for manual rewrite |
| `{{renderer ...}}`, `{{cloze ...}}`, other plugin macros | flag | |
| `../assets/x.png` | needs a URL | upload to Roam or host elsewhere; flag |
| journal file `2024_01_05.md` | page `January 5th, 2024` | |
| namespace `a/b` | `a/b` | same |
| trailing-space page merges (§1) | leave merged | the marker block says where it came from |

Anything flagged goes into a report so it can be handled by hand.

## 4. Status (2026-09-05)

Built: `roam2logseq/export_roam.py` (+ `verify_roundtrip.py`). Full-export round trip
is exact except trailing whitespace Logseq trims and the space the converter adds
after a glued `{{[[TODO]]}}`. The sidecar now also records, per block: renamed keys,
Roam macro spellings (`bracket_macros`), the exact roam/render text, template
sources, literal `collapsed::` lines; per page: the dissolved metadata block; per
template root: its dissolved metadata block. Confirmed 2026-09-05 on a throwaway Roam graph: Roam's JSON import keeps the
supplied uids (`mini00004`, `mini00005` came back as-is).

## 5. Where this lives

- Forward tooling (export fixer, normalizer, verifier) and the reverse tooling
  (exporter, back-converter) share ankify_logseq's parser and the uid map.
- Build the reverse exporter early enough to test round trips on the fixture:
  Roam JSON → import → normalize → export → compare with the original JSON.
