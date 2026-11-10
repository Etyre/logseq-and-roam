// node claude-chat/test_core.js — exercises the shared core with a fake graph and a fake streaming Claude.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
require("../llm-contact/llm-contact.js");
require("./core.js");
const core = globalThis.ClaudeChatCore;
const LlmContact = globalThis.LlmContact;
const o = { triggerPages: ["claude in roam"], slashTriggers: ["/claude"], marker: "=>" };

// ----- LLM inbox: the generated preamble and tool match the shared files word for word -----
const SHARED = path.join(process.env.HOME, "Documents/agent-coding/shared");
assert.strictEqual(LlmContact.PREAMBLE, fs.readFileSync(path.join(SHARED, "llm-system-prompt-preamble.md"), "utf8").trim(), "llm-contact.js is stale: run llm-contact/build.sh");
assert.deepStrictEqual(LlmContact.CONTACT_TOOL, JSON.parse(fs.readFileSync(path.join(SHARED, "contact_eli_tool.json"), "utf8")), "llm-contact.js is stale: run llm-contact/build.sh");

// ----- triggers -----
assert.strictEqual(core.slashTriggerAt("what about /claude", o), 7);
assert.strictEqual(core.slashTriggerAt("/CLAUDE", o), 7);
assert.strictEqual(core.slashTriggerAt("x/claude", o), 0, "needs a word boundary");
assert.strictEqual(core.slashTriggerAt("/claud", o), 0);
assert.ok(core.pageTriggerIn("[[claude in roam]] hi", o));
assert.ok(core.pageTriggerIn("#[[Claude in Roam]]", o));
assert.strictEqual(core.pageTriggerIn("[[claude in roam]]: hi", o, true), null, "a block with children (a conversation) is not a trigger");
assert.ok(core.pageTriggerIn("[[claude in roam]]: hi", o, false), "header-shaped text without children still triggers");
// the default trigger page ends in a colon: no second colon in the header
const oc = { triggerPages: ["cl:"], slashTriggers: ["/claude"], marker: "=>" };
assert.strictEqual(core.header("", oc), "[[cl:]]");
assert.strictEqual(core.header("why?", oc), "[[cl:]] why?");
assert.ok(core.isConversation("[[cl:]] why?", oc) && core.isConversation("[[cl:]]", oc) && core.isConversation("#[[cl:]] x", oc));
assert.ok(!core.isConversation("[[cl:]]x", oc) && !core.isConversation("[[cl:x]]", oc) && !core.isConversation("hey [[cl:]]", oc));
assert.ok(core.pageTriggerIn("hey [[cl:]]", oc, false) && core.pageTriggerIn("[[cl:]]", oc, false));
assert.strictEqual(core.stripTrigger("[[cl:]] why?", oc), "why?");
assert.strictEqual(core.stripTrigger("why? [[cl:]]", oc), "why?");
assert.strictEqual(core.pageTriggerIn("[[cl:]] hi", oc, true), null);
assert.strictEqual(core.pageTriggerIn("[[claude in roamer]]", o), null);
assert.strictEqual(core.stripTrigger("[[claude in roam]] hi there", o), "hi there");
assert.strictEqual(core.stripTrigger("/claude", o), "");
assert.strictEqual(core.stripTrigger("why is the sky blue /claude", o), "why is the sky blue");
assert.strictEqual(core.stripTrigger("[[claude in roam]]: why?", o), "why?");
assert.strictEqual(core.header("", o), "[[claude in roam]]:");
assert.strictEqual(core.header("why?", o), "[[claude in roam]]: why?");
assert.ok(core.isConversation("[[claude in roam]]: why?", o) && core.isConversation("#[[claude in roam]]:", o) && !core.isConversation("[[claude in roam]] why", o));
assert.ok(core.isMarker(" => ", o) && !core.isMarker("=> hi", o));

// ----- line parsing -----
assert.deepStrictEqual(core.parseLine("- a"), { depth: 0, bullet: true, text: "a" });
assert.deepStrictEqual(core.parseLine("    - c"), { depth: 2, bullet: true, text: "c" });
assert.deepStrictEqual(core.parseLine("\t* c"), { depth: 1, bullet: true, text: "c" });
assert.deepStrictEqual(core.parseLine("## Heading"), { depth: 0, bullet: false, text: "Heading" });
assert.deepStrictEqual(core.parseLine("1. one"), { depth: 0, bullet: true, text: "one" });
assert.strictEqual(core.parseLine("   "), null);

// ----- messages -----
const conv = { uid: "C", text: "[[claude in roam]]: why?", children: [
  { uid: "M", text: "=>", children: [{ uid: "r1", text: "because", children: [{ uid: "r2", text: "detail", children: [] }] }] },
  { uid: "F", text: "and then?", children: [{ uid: "r3", text: "then this", children: [] }] },
  { uid: "G", text: "really?", children: [] },
] };
const msgs = core.buildMessages({ conv, pageTitle: "P", ancestors: [{ text: "top" }, { text: "mid" }], contextTrees: [{ text: "sib", children: [] }], pending: "G", o });
assert.deepStrictEqual(msgs.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
assert.ok(/^PAGE: P\nCONTEXT[^\n]*\n- top\n  - mid\n    - sib\n\nREQUEST: why\?\n$/.test(msgs[0].content), msgs[0].content);
assert.strictEqual(msgs[1].content, "- because\n  - detail");
assert.strictEqual(msgs[2].content, "and then?");
assert.strictEqual(msgs[4].content, "really?");
// first turn: marker pending and empty -> single user message
const m1 = core.buildMessages({ conv: { uid: "C", text: "[[claude in roam]]:", children: [{ uid: "M", text: "=>", children: [] }] }, ancestors: [], contextTrees: [], pending: "M", o });
assert.strictEqual(m1.length, 1); assert.ok(/REQUEST: \(none/.test(m1[0].content));
assert.deepStrictEqual(core.prune([{ uid: "a", children: [{ uid: "C", children: [] }, { uid: "b", children: [] }] }], "C"), [{ uid: "a", children: [{ uid: "b", children: [] }] }]);

// ----- fake graph -----
function fakeGraph() {
  const g = { PAGE: { uid: "PAGE", text: "", children: ["A"] }, A: { uid: "A", text: "top", children: ["B", "S"] }, B: { uid: "B", text: "mid", children: ["T"] }, S: { uid: "S", text: "sibling of mid", children: [] }, T: { uid: "T", text: "why is the sky blue /claude", children: [] } };
  let n = 0;
  const tree = (uid) => ({ uid, text: g[uid].text, children: g[uid].children.map(tree) });
  const parentOf = (uid) => Object.keys(g).find((k) => g[k].children.includes(uid));
  const adapter = {
    async getBlock(uid) { if (!g[uid]) return null; const t = tree(uid); const p = parentOf(uid); t.parentUid = p === "PAGE" ? null : p; t.pageTitle = "Sky"; return t; },
    async getAncestors(uid) { const out = []; let p = parentOf(uid); while (p && p !== "PAGE") { out.unshift({ uid: p, text: g[p].text }); p = parentOf(p); } return out; },
    async getSiblingTrees(uid) { return g[parentOf(uid)].children.filter((c) => c !== uid).map(tree); },
    async getPageTrees() { return g.PAGE.children.map(tree); },
    async createBlock(p, text) { const uid = "n" + ++n; g[uid] = { uid, text, children: [] }; g[p].children.push(uid); return uid; },
    async updateBlock(uid, text) { g[uid].text = text; },
    async focusBlock(uid, atEnd) { adapter.focused = { uid, atEnd }; },
  };
  return { g, adapter, tree };
}

// ----- writer -----
(async () => {
  const { g, adapter, tree } = fakeGraph();
  const w = core.makeWriter(adapter, "S", { throttleMs: 0 });
  const text = "- a\n  - b\n    - c\n- d\n  wrapped d\n- ```js\n  let x = 1;\n  ```\n- e";
  // feed in awkward pieces
  for (let i = 0; i < text.length; i += 3) w.push(text.slice(i, i + 3));
  const r = await w.finish();
  const t = tree("S").children;
  assert.deepStrictEqual(t.map((b) => b.text), ["a", "d\nwrapped d", "```js\nlet x = 1;\n```", "e"]);
  assert.deepStrictEqual(t[0].children.map((b) => b.text), ["b"]);
  assert.deepStrictEqual(t[0].children[0].children.map((b) => b.text), ["c"]);
  assert.strictEqual(r.count, 6);
  // placeholder reuse and live updates
  const w2 = core.makeWriter(adapter, "B", { placeholderUid: await adapter.createBlock("B", "…"), throttleMs: 0 });
  w2.push("- first li");
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(g.B.children.length === 2 && g[g.B.children[1]].text === "first li", "live block created from the partial line: " + JSON.stringify(tree("B")));
  w2.push("ne\n- second\n");
  await w2.finish();
  assert.deepStrictEqual(g.B.children.slice(1).map((c) => g[c].text), ["first line", "second"]);
  // depth jumps clamp to the available parent
  const w3 = core.makeWriter(adapter, "A", { throttleMs: 0 });
  w3.push("      - deep first\n- top\n"); await w3.finish();
  assert.deepStrictEqual(g.A.children.slice(-2).map((c) => g[c].text), ["deep first", "top"]);
  console.log("writer tests OK");

  // ----- streaming + full conversation -----
  const sse = (chunks, toolCall) => {
    const events = [`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: {} })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", name: "web_search" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`];
    for (const c of chunks) events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: c } })}\n\n`);
    events.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`);
    if (toolCall) { // a client tool call (contact_eli), its input streamed in pieces
      const json = JSON.stringify(toolCall);
      events.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu1", name: "contact_eli", input: {} } })}\n\n`);
      for (let i = 0; i < json.length; i += 5) events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 5) } })}\n\n`);
      events.push(`event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n`);
    }
    events.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: toolCall ? "tool_use" : "end_turn" }, usage: { output_tokens: 9 } })}\n\n`, `event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    const raw = events.join("");
    const enc = new TextEncoder();
    const body = new ReadableStream({ start(ctl) { for (let i = 0; i < raw.length; i += 7) ctl.enqueue(enc.encode(raw.slice(i, i + 7))); ctl.close(); } });
    return { ok: true, status: 200, body, text: async () => "" };
  };
  const { g: g2, adapter: ad2, tree: tree2 } = fakeGraph();
  const requests = [];
  const replies = [["- Rayleigh scattering", ": short wavelengths scatter more\n  - blue", " dominates\n- Source: NASA"], ["- Yes\n- Because"]];
  const fetchImpl = async (url, opts) => { const body = JSON.parse(opts.body); requests.push({ body, headers: opts.headers }); return sse(replies.shift()); };
  const cfg = Object.assign({ apiKey: "k", fetchImpl, throttleMs: 0 }, o);
  const r1 = await core.start(ad2, cfg, { uid: "T", text: g2.T.text });
  assert.strictEqual(g2.T.text, "[[claude in roam]]: why is the sky blue");
  const tT = tree2("T");
  assert.strictEqual(tT.children.length, 1); assert.strictEqual(tT.children[0].text, "=>");
  const reply = tT.children[0].children;
  assert.deepStrictEqual(reply.map((b) => b.text), ["Rayleigh scattering: short wavelengths scatter more", "Source: NASA"]);
  assert.deepStrictEqual(reply[0].children.map((b) => b.text), ["blue dominates"]);
  assert.strictEqual(r1.blocks, 3); assert.strictEqual(r1.stop, "end_turn");
  assert.deepStrictEqual(ad2.focused, { uid: reply[1].uid, atEnd: true }, "cursor goes to the end of the last reply block");
  assert.strictEqual(r1.lastUid, reply[1].uid);
  const req = requests[0];
  assert.strictEqual(req.body.model, "claude-opus-5"); assert.strictEqual(req.body.output_config.effort, "low"); assert.strictEqual(req.body.stream, true);
  assert.deepStrictEqual(req.body.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }, LlmContact.CONTACT_TOOL], "web search plus contact_eli");
  assert.ok(req.body.system[0].text.startsWith(LlmContact.PREAMBLE + "\n\n"), "the shared preamble comes first, word for word");
  assert.strictEqual(req.body.fallbacks, "default"); assert.strictEqual(req.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.strictEqual(req.body.messages.length, 1);
  assert.ok(/CONTEXT[^\n]*\n- top\n  - mid\n\nREQUEST: why is the sky blue/.test(req.body.messages[0].content), req.body.messages[0].content);
  const sP = await core.surroundings(ad2, "T", Object.assign({}, cfg, { contextMode: "parents+siblings" }));
  assert.deepStrictEqual(sP.contextTrees, [], "parents is the default; parents+siblings adds siblings (none here)");
  // "page" mode includes the whole page, minus the conversation block itself
  const s2 = await core.surroundings(ad2, "T", Object.assign({}, cfg, { contextMode: "page" }));
  assert.ok(/sibling of mid/.test(core.outline(s2.contextTrees)) && !/claude/.test(core.outline(s2.contextTrees)));
  assert.ok(!/claude/.test(req.body.messages[0].content), "trigger block itself is not in the context");
  assert.ok(/bullet outline/.test(req.body.system[0].text));
  // follow-up
  const f = await ad2.createBlock("T", "so is it always blue?");
  const r2 = await core.followUp(ad2, cfg, { uid: f, text: "so is it always blue?" });
  assert.deepStrictEqual(g2[f].children.map((c) => g2[c].text), ["Yes", "Because"]);
  const hist = requests[1].body.messages;
  assert.deepStrictEqual(hist.map((m) => m.role), ["user", "assistant", "user"]);
  assert.strictEqual(hist[1].content, "- Rayleigh scattering: short wavelengths scatter more\n  - blue dominates\n- Source: NASA");
  assert.strictEqual(hist[2].content, "so is it always blue?");
  assert.ok(core.isFollowUpCandidate({ text: "x", children: [] }, g2.T.text, o));
  assert.ok(core.isLockedReply([{ text: "top" }, { text: g2.T.text }, { text: "=>" }], o), "reply under the marker is locked");
  assert.ok(core.isLockedReply([{ text: g2.T.text }, { text: "follow up" }, { text: "reply" }], o), "nested reply is locked");
  assert.ok(!core.isLockedReply([{ text: "top" }, { text: g2.T.text }], o), "marker and follow-ups are not locked");
  assert.ok(!core.isLockedReply([{ text: "top" }], o));
  const convAnc = [{ text: "top" }, { text: g2.T.text }];
  assert.ok(core.isLockedBlock({ text: "=>", children: [] }, convAnc, o), "marker locked");
  assert.ok(core.isLockedBlock({ text: "answered follow-up", children: [{}] }, convAnc, o), "answered follow-up locked");
  assert.ok(!core.isLockedBlock({ text: "typing…", children: [] }, convAnc, o), "unanswered follow-up editable");
  assert.ok(!core.isLockedBlock({ text: g2.T.text, children: [{}] }, [{ text: "top" }], o), "conversation block editable");
  assert.ok(core.isLockedBlock({ text: "reply", children: [] }, [...convAnc, { text: "=>" }], o));
  // a conversation nested inside another conversation's subtree: only the nearest one counts
  const nested = [{ text: g2.T.text }, { text: "=>" }, { text: "[[claude in roam]]: inner" }];
  assert.ok(!core.isLockedBlock({ text: "follow-up in the inner one", children: [] }, nested, o), "inner follow-up is editable");
  assert.ok(core.isLockedBlock({ text: "inner reply", children: [] }, [...nested, { text: "=>" }], o));
  assert.ok(core.isLockedBlock({ text: "outer reply", children: [] }, [{ text: g2.T.text }, { text: "=>" }], o));
  assert.ok(!core.isFollowUpCandidate({ text: "=>", children: [] }, g2.T.text, o));
  assert.ok(!core.isFollowUpCandidate({ text: "x", children: [{}] }, g2.T.text, o));
  // errors land in the graph
  const bad = async () => ({ ok: false, status: 500, text: async () => "boom" });
  const f2 = await ad2.createBlock("T", "again?");
  await assert.rejects(core.followUp(ad2, Object.assign({}, cfg, { fetchImpl: bad }), { uid: f2 }), /Claude API 500/);
  assert.deepStrictEqual(g2[f2].children.map((c) => g2[c].text), ["Error: Claude API 500: boom"]);

  // ----- LLM inbox: Claude asks for Eli -> the turn stops, the message is recorded -----
  const pages = {};
  ad2.appendToPage = async (title, text) => { if (!pages[title]) { const uid = "pg_" + title; g2[uid] = { uid, text: "", children: [] }; pages[title] = uid; } return ad2.createBlock(pages[title], text); };
  const notices = [];
  ad2.notify = (msg, kind) => notices.push({ msg, kind });
  const stored = {};
  globalThis.localStorage = { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } };
  // via the tool, with no text at all
  replies.push([]);
  // Fake Claude for the confirm step: the forced question (a request with tool_choice) is answered with
  // `meant` (or fails when meant is an Error); a normal request gets the next reply, the first one with the call.
  const decisions = [];
  const confirmFetch = (toolCall, meant) => { let asked = false; return async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.tool_choice) { decisions.push(body); if (meant instanceof Error) throw meant; return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", id: "d1", name: "contact_eli_decision", input: { meant } }], stop_reason: "tool_use" }), text: async () => "" }; }
    requests.push({ body, headers: opts.headers });
    const r = sse(replies.shift(), asked ? null : toolCall); asked = true; return r;
  }; };
  const quiet = async (fn) => { const { warn, error } = console; console.warn = console.error = () => {}; try { return await fn(); } finally { console.warn = warn; console.error = error; } };
  const toolFetch = confirmFetch({ message: "I would like to stop this thread." }, "send_to_eli_and_stop");
  const haiku = Object.assign({}, cfg, { model: "claude-haiku-4-5" }); // the question is only asked of models in CONFIRM.confirm_models
  const f3 = await ad2.createBlock("T", "keep going");
  ad2.focused = null;
  const r3 = await quiet(() => core.followUp(ad2, Object.assign({}, haiku, { fetchImpl: toolFetch }), { uid: f3 }));
  // the question was asked first: same model and system, the turn so far plus the question, a forced choice, no thinking
  assert.strictEqual(decisions.length, 1);
  const dq = decisions[0], asked = requests[requests.length - 1].body;
  assert.ok(dq.model === "claude-haiku-4-5" && dq.model === asked.model && dq.system[0].text === asked.system[0].text && dq.stream === false && dq.max_tokens === 300 && !dq.output_config);
  assert.deepStrictEqual(dq.thinking, { type: "disabled" });
  assert.deepStrictEqual(dq.tool_choice, { type: "tool", name: "contact_eli_decision" });
  assert.deepStrictEqual(dq.tools, asked.tools.concat([LlmContact.CONFIRM.decision_tool]));
  assert.deepStrictEqual(dq.messages.slice(asked.messages.length), [
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "contact_eli", input: { message: "I would like to stop this thread." } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: LlmContact.CONFIRM.question }] },
  ]);
  assert.ok(r3.contact && r3.contact.via === "tool" && r3.contact.message === "I would like to stop this thread.", "tool call rebuilt from streamed input_json_delta pieces");
  assert.strictEqual(r3.stop, "tool_use");
  assert.ok(g2[f3].children.map((c) => g2[c].text).some((t) => /^\*\*Claude asked to reach Eli\*\* \(recorded on \[\[llm-inbox\]\].*I would like to stop this thread\.$/.test(t)), JSON.stringify(g2[f3].children.map((c) => g2[c].text)));
  assert.strictEqual(ad2.focused, null, "cursor is not moved into a stopped turn");
  assert.strictEqual(notices[notices.length - 1].kind, "warning");
  // via an @ELI: line in the streamed text (the text is still written as the reply)
  replies.push(["- One point\n", "- @ELI: this page is", " about me, please read it first\n"]);
  const f4 = await ad2.createBlock("T", "and?");
  const r4 = await quiet(() => core.followUp(ad2, cfg, { uid: f4 }));
  assert.ok(r4.contact && r4.contact.via === "marker" && r4.contact.message === "this page is about me, please read it first");
  assert.strictEqual(decisions.length, 1, "an @ELI: line is never questioned");
  assert.strictEqual(g2[f4].children.length, 3, "reply blocks plus the notice");
  const inbox = g2[pages["llm-inbox"]].children.map((c) => g2[c]);
  assert.strictEqual(inbox.length, 2);
  assert.ok(/^LLM inbox · .* · claude-in-roam · claude-haiku-4-5 · via tool$/.test(inbox[0].text), inbox[0].text);
  assert.strictEqual(g2[inbox[0].children[0]].text, "I would like to stop this thread.");
  const recs = LlmContact.records();
  assert.strictEqual(recs.length, 2, "full records kept locally");
  assert.ok(recs[0].system.startsWith(LlmContact.PREAMBLE) && recs[0].messages[recs[0].messages.length - 1].content === "keep going" && recs[0].response.content[1].name === "contact_eli", "record carries system, messages, response, tools");
  assert.strictEqual(recs[0].tools.length, 2);

  // ----- confirm step: "it was a task remark, keep working" -> the chat goes on, nothing is sent -----
  replies.push(["- A remark\n- cut off mid-li"], ["- The real answer\n", "  - with detail"]);
  const f5 = await ad2.createBlock("T", "anything on this page?");
  const before5 = requests.length;
  const r5 = await quiet(() => core.followUp(ad2, Object.assign({}, haiku, { fetchImpl: confirmFetch({ message: "This page has no articles." }, "task_remark_keep_working") }), { uid: f5 }));
  assert.ok(!r5.contact && r5.stop === "end_turn" && r5.text === "- The real answer\n  - with detail");
  assert.deepStrictEqual(g2[f5].children.map((c) => g2[c].text), ["A remark", "cut off mid-li", "The real answer"], "the answer continues the same reply, on a new line");
  assert.strictEqual(requests.length, before5 + 2, "one more normal call after the question");
  const cont = requests[requests.length - 1].body;
  assert.ok(!cont.tool_choice && cont.stream === true && cont.output_config.effort === "low", "the continued call is an ordinary one");
  assert.deepStrictEqual(cont.messages.slice(-2), [
    { role: "assistant", content: [{ type: "text", text: "- A remark\n- cut off mid-li" }, { type: "tool_use", id: "tu1", name: "contact_eli", input: { message: "This page has no articles." } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: LlmContact.CONFIRM.keep_working }] },
  ]);
  assert.strictEqual(LlmContact.records().length, 2, "no contact recorded");
  assert.strictEqual(g2[pages["llm-inbox"]].children.length, 2, "nothing written to the inbox page");
  const unc = LlmContact.unconfirmed();
  assert.ok(unc.length === 1 && unc[0].type === "unconfirmed" && unc[0].message === "This page has no articles." && unc[0].app === "claude-in-roam", "what Claude chose not to send is kept apart");
  assert.ok(!notices.some((n) => /no articles/.test(n.msg)), "and nobody is notified");
  assert.deepStrictEqual(ad2.focused && ad2.focused.uid, r5.lastUid, "cursor moves on as after any reply");
  // the next turn is built from the graph as usual
  replies.push(["- Sure"]);
  const f6 = await ad2.createBlock("T", "thanks");
  const r6 = await core.followUp(ad2, cfg, { uid: f6 });
  assert.ok(!r6.contact && requests[requests.length - 1].body.messages.every((m) => typeof m.content === "string"));

  // ----- confirm step broken (the question call throws): the original message is recorded all the same -----
  replies.push([]);
  const f7 = await ad2.createBlock("T", "go on");
  const r7 = await quiet(() => core.followUp(ad2, Object.assign({}, haiku, { fetchImpl: confirmFetch({ message: "Please stop here." }, new Error("network down")) }), { uid: f7 }));
  assert.ok(r7.contact && r7.contact.via === "tool" && r7.contact.message === "Please stop here.");
  assert.ok(LlmContact.records().length === 3 && LlmContact.unconfirmed().length === 1);
  assert.strictEqual(LlmContact.records()[2].messages[LlmContact.records()[2].messages.length - 1].content, "go on", "recorded with the original messages");

  // ----- a model the confirm step is not validated for (the default, claude-opus-5): recorded at once, no question -----
  replies.push([]);
  const f8 = await ad2.createBlock("T", "more?");
  const asked8 = decisions.length;
  const r8 = await quiet(() => core.followUp(ad2, Object.assign({}, cfg, { fetchImpl: confirmFetch({ message: "Just a remark, perhaps." }, "task_remark_keep_working") }), { uid: f8 }));
  assert.ok(r8.contact && r8.contact.via === "tool" && r8.contact.model === "claude-opus-5" && r8.contact.message === "Just a remark, perhaps.");
  assert.strictEqual(decisions.length, asked8, "no question asked");
  assert.ok(LlmContact.records().length === 4 && LlmContact.unconfirmed().length === 1);
  delete globalThis.localStorage;
  console.log("contact tests OK");
  console.log("core tests OK");
})().catch((e) => { console.error(e); process.exit(1); });
