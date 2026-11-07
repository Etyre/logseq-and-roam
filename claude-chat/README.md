# claude-chat

Shared implementation of "Claude in Roam" / "Claude in Logseq": ask Claude from a block and
get the reply streamed into nested blocks, then keep the thread going with Enter.

- `core.js` — platform-independent logic: trigger detection (`/claude`, `[[claude in roam]]`, `[[cl:]]`),
  the context/conversation → messages builder, the streaming Claude call (raw HTTP, SSE,
  web search tool, effort), and the outline writer that turns streamed markdown bullets
  into blocks as the lines arrive (nesting by indentation, code fences kept in one block).
- `roam-adapter.js` — Roam side (roamAlphaAPI reads/writes, typing triggers, Enter for
  follow-ups, command palette, styling). `build.sh` concatenates core + adapter into
  `../roam/claude-in-roam.js`.
- `../logseq-plugins/claude-in-logseq/` — Logseq plugin; `build.sh` copies `core.js` there.
- `test_core.js` — `node claude-chat/test_core.js` runs the core against a fake graph and a
  fake streaming Claude (including a streamed `contact_eli` call and an `@ELI:` line).
- `../llm-contact/llm-contact.js` — the shared LLM-inbox preamble and `contact_eli` tool, baked in
  by `build.sh`; every system prompt starts with the preamble and every call offers the tool. When
  Claude uses either, the turn stops, the message goes to the graph page `llm-inbox` and the full
  record to localStorage ("Claude in Roam/Logseq: copy LLM inbox records" exports it; see the
  top-level README).

Edit `core.js` / `roam-adapter.js`, run `./build.sh`, then re-paste the Roam file and
reload the Logseq plugin.

## Shape of a conversation

```
- context
  - context
    - [[claude in roam]]: optional request     <- the trigger block, rewritten
      - =>                                     <- first reply goes here
        - reply bullet
          - nested reply bullet
      - user follow-up                         <- typed by the user; Enter asks again
        - reply bullet
```

What Claude sees besides the conversation (setting `contextMode`): `parents`, the chain of
parent blocks above the conversation (default); `parents+siblings`, also the other blocks
under the closest parent; `page`, also every block on the page. Finished turns are locked: Claude's reply
blocks, the marker, and answered follow-ups are read-only, but the cursor can still move
through them, and Enter inside one starts a new follow-up block at the end of the
conversation (Roam: command "toggle reply lock"; Logseq: setting). A follow-up without a
reply yet stays editable, and so does the conversation block. When a reply has arrived the
cursor is placed at the end of it. The user's messages are bold; Claude's blocks are regular weight, though the model may bold a key term. Whatever the user wrote next to the trigger
becomes the REQUEST; earlier turns of the thread are replayed from the blocks.

Model `claude-opus-5`, effort `low`, server-side web search allowed, `fallbacks: "default"`.
The reply is requested as a markdown bullet outline (at most three levels).
