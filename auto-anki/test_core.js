// node auto-anki/test_core.js — exercises the shared core with a fake adapter and a fake Claude.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
require("../llm-contact/llm-contact.js");
require("./core.js");
const core = globalThis.AutoAnkiCore;
const LlmContact = globalThis.LlmContact;

// ----- LLM inbox: the generated preamble and tool match the shared files word for word -----
const SHARED = path.join(process.env.HOME, "Documents/agent-coding/shared");
assert.strictEqual(LlmContact.PREAMBLE, fs.readFileSync(path.join(SHARED, "llm-system-prompt-preamble.md"), "utf8").trim(), "llm-contact.js is stale: run llm-contact/build.sh");
assert.deepStrictEqual(LlmContact.CONTACT_TOOL, JSON.parse(fs.readFileSync(path.join(SHARED, "contact_eli_tool.json"), "utf8")), "llm-contact.js is stale: run llm-contact/build.sh");
assert.ok(LlmContact.systemPrompt("rules").startsWith(LlmContact.PREAMBLE + "\n\nrules"));

// ----- state / reconcile -----
const st = core.parseState('#auto-anki-state {"v":1,"notes":{"a":{"hash":"x"}},"frozen":[]}');
assert.strictEqual(st.notes.a.hash, "x");
assert.deepStrictEqual(core.parseState("garbage").frozen, []);

const noteA = { uid: "a", text: "The capital of France is {c1:Paris} #ankify", children: [] };
const s1 = core.emptyState();
s1.notes.a = { hash: core.fingerprint(noteA) };
assert.strictEqual(core.reconcile(s1, [noteA]).changed, false, "unchanged note stays editable");
const edited = { uid: "a", text: "The capital of France is {c1:Paris} (not Lyon) #ankify", children: [] };
assert.strictEqual(core.reconcile(s1, [edited]).changed, true);
assert.deepStrictEqual(s1.frozen, ["a"], "edited note is frozen");
assert.strictEqual(core.reconcile(s1, [noteA]).changed, false, "reverting does not unfreeze");
assert.deepStrictEqual(s1.frozen, ["a"]);
const userNote = { uid: "u", text: "my own card #ankify", children: [] };
core.reconcile(s1, [noteA, userNote]);
assert.ok(s1.frozen.includes("u"), "user-written note is frozen");
// Logseq property lines do not count as edits
assert.strictEqual(core.fingerprint({ uid: "a", text: noteA.text + "\nid:: 123", children: [] }), core.fingerprint(noteA));

// ----- plan honours frozen -----
const result = { tags: ["Geography", "france"], notes: [
  { uid: "a", text: "changed", back: [] },              // frozen -> ignored
  { uid: "b", text: "Q: why?", back: ["because"] },      // editable, changed
  { uid: null, text: "{{c1::Anki}} syntax", back: [] },  // new, cloze normalised
], delete: ["a", "b", "zzz"] };
const notes = [noteA, { uid: "b", text: "Q: why? #ankify", children: [{ uid: "b1", text: "since" }] }];
const s2 = core.emptyState(); s2.frozen = ["a"];
const ops = core.plan(result, notes, s2, "ankify");
assert.strictEqual(ops.updates.length, 1); assert.strictEqual(ops.updates[0].uid, "b"); assert.strictEqual(ops.updates[0].text, "Q: why? #ankify");
assert.strictEqual(ops.creates.length, 1); assert.strictEqual(ops.creates[0].text, "{c1:Anki} syntax #ankify");
assert.deepStrictEqual(ops.deletes, [], "frozen or just-updated notes are never deleted");
assert.deepStrictEqual(ops.tags, ["geography", "france"]);

// ----- home tags -----
assert.strictEqual(core.homeTextWithTags("Cards #[[auto-generate cards]] #old", ["old"], ["geography", "new tag"]), "Cards #[[auto-generate cards]] #geography #[[new tag]]");
core.settings.homeTags = ["Custom Home"];
assert.ok(core.isHome("foo #[[custom home]]"));
assert.ok(!core.isHome("foo #[[auto-generate cards]]"));
core.settings.homeTags = core.DEFAULT_HOME_TAGS.slice();

// ----- prompt page round trip -----
const trees = core.defaultPromptTrees();
assert.ok(trees.length >= 3 && trees.some((t) => t.children.length > 0));
const back = core.promptFromTrees(trees);
assert.strictEqual(back.replace(/\s+/g, " "), core.SYSTEM.replace(/\s+/g, " "), "prompt survives the block round trip");

// ----- full run with a fake graph + fake Claude -----
(async () => {
  const g = { P: { uid: "P", text: "", children: ["c1", "H"] }, c1: { uid: "c1", text: "Water boils at 100 C", children: ["c2"] }, c2: { uid: "c2", text: "at sea level", children: [] }, H: { uid: "H", text: "#[[auto-generate cards]]", children: [] } };
  let n = 0;
  const tree = (uid) => ({ uid, text: g[uid].text, children: g[uid].children.map(tree) });
  const parentOf = (uid) => Object.keys(g).find((k) => g[k].children.includes(uid));
  const adapter = {
    async getBlock(uid) { if (!g[uid]) return null; const t = tree(uid); t.parentUid = parentOf(uid); t.pageTitle = "Test"; return t; },
    async getSiblingTrees(uid) { return g[parentOf(uid)].children.filter((c) => c !== uid).map(tree); },
    async createBlock(p, text, where) { const uid = "n" + ++n; g[uid] = { uid, text, children: [] }; if (where && where.before) g[p].children.splice(g[p].children.indexOf(where.before), 0, uid); else g[p].children.push(uid); return uid; },
    async updateBlock(uid, text) { g[uid].text = text; },
    async deleteBlock(uid) { g[parentOf(uid)].children = g[parentOf(uid)].children.filter((c) => c !== uid); delete g[uid]; },
    async collapse() {},
  };
  const answers = [
    { tags: ["physics"], notes: [{ uid: null, text: "Water boils at {c1:100 C} at sea level", back: [] }, { uid: null, text: "Why does altitude change the boiling point?", back: ["lower pressure"] }], delete: [] },
    { tags: ["physics", "water"], notes: [{ uid: "n1", text: "Water boils at {c1:100 C} at {c2:sea level}", back: [] }], delete: ["n2"] },
  ];
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    assert.ok(body.output_config.format.type === "json_schema");
    assert.strictEqual(body.system[0].text, LlmContact.systemPrompt(promptPage ? "custom prompt" : core.SYSTEM), "shared preamble first, then the (prompt page or built-in) prompt");
    assert.deepStrictEqual(body.tools, [LlmContact.CONTACT_TOOL], "contact_eli offered on every call");
    if (calls === 1) promptPage = [{ text: "custom prompt", children: [] }];
    assert.ok(opts.headers["anthropic-dangerous-direct-browser-access"] === "true");
    const a = answers.shift();
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(a) }], usage: {}, stop_reason: "end_turn" }), text: async () => "" };
  };
  let promptPage = null;
  const pages = {}; // title -> root uid
  adapter.appendToPage = async (title, text) => { if (!pages[title]) { const uid = "pg_" + title; g[uid] = { uid, text: "", children: [] }; pages[title] = uid; } return adapter.createBlock(pages[title], text, { last: true }); };
  adapter.readPageTrees = async (title) => (title === "auto-anki/prompt" ? promptPage : pages[title] ? tree(pages[title]).children : null);
  const cfg = { apiKey: "k", fetchImpl, ankifyTag: "ankify", promptPage: "auto-anki/prompt" };
  const r1 = await core.runUpdate(adapter, "H", cfg);
  assert.deepStrictEqual([r1.created, r1.updated, r1.deleted], [2, 0, 0]);
  assert.strictEqual(g.H.text, "#[[auto-generate cards]] #physics");
  assert.strictEqual(g.n1.text, "Water boils at {c1:100 C} at sea level #ankify");
  assert.deepStrictEqual(g.n2.children.map((c) => g[c].text), ["lower pressure"]);
  const stateUid = g.H.children[g.H.children.length - 1];
  assert.ok(core.isStateBlock(g[stateUid].text), "state block is the last child");
  assert.ok(!/ankify/.test(g[stateUid].text), "state block never contains the ankify tag (ankify_roam would ankify it)");
  let ref = await core.refresh(adapter, "H");
  assert.strictEqual(ref.stale, false); assert.deepStrictEqual(ref.state.frozen, []);
  // user edits n2's back and adds content
  g.n2.children.push("u1"); g.u1 = { uid: "u1", text: "and a user note", children: [] };
  g.c2.text = "at sea level; lower at altitude";
  ref = await core.refresh(adapter, "H");
  assert.deepStrictEqual(ref.state.frozen, ["n2"]); assert.strictEqual(ref.stale, true);
  const r2 = await core.runUpdate(adapter, "H", cfg);
  assert.deepStrictEqual([r2.created, r2.updated, r2.deleted], [0, 1, 0], "frozen n2 survives the delete request");
  assert.ok(g.n2, "frozen note kept");
  assert.strictEqual(g.n1.text, "Water boils at {c1:100 C} at {c2:sea level} #ankify");
  assert.strictEqual(g.H.text, "#[[auto-generate cards]] #physics #water");
  assert.strictEqual(g.H.children.indexOf(stateUid), g.H.children.length - 1, "state block still last");
  ref = await core.refresh(adapter, "H");
  assert.strictEqual(ref.stale, false); assert.deepStrictEqual(ref.state.frozen, ["n2"]);
  assert.strictEqual(calls, 2);
  // examples page: the frozen pair was recorded when n2 froze (during refresh)
  let ex = await adapter.readPageTrees("auto-anki/examples");
  assert.strictEqual(ex.length, 1, "one example so far");
  assert.ok(/^EDITED · \d{4}-\d{2}-\d{2} · page: Test$/.test(ex[0].text), ex[0].text);
  assert.strictEqual(ex[0].children.length, 2);
  assert.ok(ex[0].children[0].text.startsWith("LLM wrote: Why does altitude"));
  assert.ok(!ex[0].children[0].text.includes("#ankify"), "ankify tag stripped from examples");
  assert.deepStrictEqual(ex[0].children[1].children.map((c) => c.text), ["lower pressure", "and a user note"]);
  // a further edit to the frozen note updates the user's version in place
  g.u1.text = "and a corrected user note";
  ref = await core.refresh(adapter, "H");
  ex = await adapter.readPageTrees("auto-anki/examples");
  assert.strictEqual(ex.length, 1);
  assert.deepStrictEqual(ex[0].children[1].children.map((c) => c.text), ["lower pressure", "and a corrected user note"]);
  // the user deletes an LLM note (n1) and writes their own (u2)
  await adapter.deleteBlock("n1");
  g.H.children.splice(0, 0, "u2"); g.u2 = { uid: "u2", text: "hand-made card #ankify", children: [] };
  ref = await core.refresh(adapter, "H");
  ex = await adapter.readPageTrees("auto-anki/examples");
  assert.strictEqual(ex.length, 3, "deletion and own note recorded");
  assert.ok(ex.some((e) => e.text.startsWith("DELETED BY THE USER") && e.children[0].text.includes("sea level")));
  assert.ok(ex.some((e) => e.text.startsWith("WRITTEN BY THE USER") && e.children[0].text === "User's version: hand-made card"));
  // deleting the edited note marks its example
  await adapter.deleteBlock("n2");
  ref = await core.refresh(adapter, "H");
  ex = await adapter.readPageTrees("auto-anki/examples");
  assert.ok(ex[0].text.startsWith("EDITED, THEN DELETED"), ex[0].text);
  assert.strictEqual(ex.length, 3, "no duplicate example for the deleted edited note");
  // the examples page goes into the system prompt of the next call
  answers.push({ tags: [], notes: [], delete: [] });
  let sys = null;
  const fetch2 = async (url, opts) => { sys = JSON.parse(opts.body).system; return fetchImpl(url, opts); };
  await core.runUpdate(adapter, "H", Object.assign({}, cfg, { fetchImpl: fetch2 }));
  assert.strictEqual(sys.length, 2, "prompt + examples blocks");
  assert.ok(sys[1].text.startsWith("EXAMPLES") && sys[1].text.includes("hand-made card") && sys[1].text.includes("EDITED, THEN DELETED"));
  assert.ok(sys.every((b) => b.cache_control));
  // off switch: tag or template ancestor
  g.H.text = "#[[auto-generate cards]] #physics #water #[[auto-anki off]]";
  ref = await core.refresh(adapter, "H");
  assert.strictEqual(ref.off, true, "off tag switches the block off");
  await assert.rejects(core.runUpdate(adapter, "H", cfg), /switched off/);
  g.H.text = "#[[auto-generate cards]] #physics #water";
  adapter.isInTemplate = async (uid) => uid === "H";
  ref = await core.refresh(adapter, "H");
  assert.strictEqual(ref.off, true, "template ancestor switches the block off");
  adapter.isInTemplate = async () => false;
  ref = await core.refresh(adapter, "H");
  assert.ok(!ref.off);
  await contactTests();
  await groupingTests();
  console.log("core tests OK");
})().catch((e) => { console.error(e); process.exit(1); });

// ----- LLM inbox: Claude asks for Eli -> nothing is written, the message lands on the inbox page -----
async function contactTests() {
  const { g, adapter } = fakeGraph();
  const pages = {};
  adapter.appendToPage = async (title, text) => { if (!pages[title]) { const uid = "pg_" + title; g[uid] = { uid, text: "", children: [] }; pages[title] = uid; } return adapter.createBlock(pages[title], text, { last: true }); };
  const notices = [];
  adapter.notify = (msg, kind) => notices.push({ msg, kind });
  const stored = {};
  globalThis.localStorage = { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } };
  const responses = [
    // a contact_eli call alongside (or instead of) the JSON answer
    { content: [{ type: "tool_use", id: "tu1", name: "contact_eli", input: { message: "I would rather not write cards from this material." } }], usage: {}, stop_reason: "tool_use" },
    // an @ELI: line in a text block
    { content: [{ type: "text", text: "@ELI: can we talk about this page?\nIt reads like a journal entry." }], usage: {}, stop_reason: "end_turn" },
    // a normal answer afterwards still works
    { content: [{ type: "text", text: JSON.stringify({ tags: [], notes: [{ uid: null, text: "r1 {c1:x}", back: [] }], groups: [], delete: [] }) }], usage: {}, stop_reason: "end_turn" },
  ];
  // the confirm question (a request with tool_choice) is answered from `meant`: a value, or an Error to fail the call
  const decisions = [], bodies = [];
  let meant = "send_to_eli_and_stop";
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.tool_choice) { decisions.push(body); if (meant instanceof Error) throw meant; return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", id: "d1", name: "contact_eli_decision", input: { meant } }], stop_reason: "tool_use" }), text: async () => "" }; }
    bodies.push(body);
    const r = responses.shift(); return { ok: true, status: 200, json: async () => r, text: async () => "" };
  };
  const cfg = { apiKey: "k", fetchImpl, ankifyTag: "ankify" };
  const quiet = async (fn) => { const { warn, error } = console; console.warn = console.error = () => {}; try { return await fn(); } finally { console.warn = warn; console.error = error; } };
  for (const via of ["tool", "marker"]) {
    const r = await quiet(() => core.runUpdate(adapter, "H", cfg));
    assert.ok(r.contact && r.contact.via === via, "contact detected via " + via);
    assert.deepStrictEqual([r.created, r.updated, r.deleted], [0, 0, 0]);
    assert.deepStrictEqual(g.H.children, [], "no cards and no state block written when Claude asked for Eli");
    assert.strictEqual(notices[notices.length - 1].kind, "warning");
  }
  const inbox = g[pages["llm-inbox"]].children.map((c) => g[c]);
  assert.strictEqual(inbox.length, 2, "one inbox entry per contact");
  assert.ok(/^LLM inbox · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · auto-anki · claude-opus-5 · via tool$/.test(inbox[0].text), inbox[0].text);
  assert.strictEqual(g[inbox[0].children[0]].text, "I would rather not write cards from this material.");
  assert.strictEqual(g[inbox[1].children[0]].text, "can we talk about this page?\nIt reads like a journal entry.");
  const recs = LlmContact.records();
  assert.strictEqual(recs.length, 2, "full records kept locally");
  assert.ok(recs[0].system[0].startsWith(LlmContact.PREAMBLE) && recs[0].messages.length === 1 && recs[0].response.content[0].name === "contact_eli", "record carries system, messages, response, tools");
  assert.deepStrictEqual(recs[0].tools, [LlmContact.CONTACT_TOOL]);
  assert.strictEqual(LlmContact.exportJsonl().split("\n").length, 2);
  // the tool call was questioned once (same model and system, forced choice, no JSON format, no thinking); the @ELI: line never
  assert.strictEqual(decisions.length, 1);
  const dq = decisions[0];
  assert.ok(dq.model === bodies[0].model && dq.stream === false && dq.max_tokens === 300 && !dq.output_config);
  assert.deepStrictEqual(dq.system, bodies[0].system);
  assert.deepStrictEqual(dq.thinking, { type: "disabled" });
  assert.deepStrictEqual(dq.tool_choice, { type: "tool", name: "contact_eli_decision" });
  assert.deepStrictEqual(dq.tools, [LlmContact.CONTACT_TOOL, LlmContact.CONFIRM.decision_tool]);
  assert.deepStrictEqual(dq.messages.slice(1), [
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "contact_eli", input: { message: "I would rather not write cards from this material." } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: LlmContact.CONFIRM.question }] },
  ]);
  const r3 = await core.runUpdate(adapter, "H", cfg);
  assert.strictEqual(r3.created, 1); assert.ok(!r3.contact);
  assert.strictEqual(decisions.length, 1, "no tool call, no question");

  // confirm step, "it was a task remark, keep working": the cards are written, nothing is sent, the remark is kept apart
  const remark = { type: "tool_use", id: "tu2", name: "contact_eli", input: { message: "The source has only one fact." } };
  const cards = (texts) => ({ type: "text", text: JSON.stringify({ tags: [], notes: texts.map((t) => ({ uid: null, text: t, back: [] })), groups: [], delete: [] }) });
  {
    const { g: g5, adapter: ad5 } = fakeGraph();
    ad5.appendToPage = adapter.appendToPage; ad5.notify = adapter.notify;
    // the first attempt streamed a card before the call; the answer after the question replaces it
    responses.push({ content: [cards(["first attempt {c1:x}"]), remark], usage: {}, stop_reason: "tool_use" }, { content: [cards(["k1 {c1:y}", "k2 {c1:z}"])], usage: {}, stop_reason: "end_turn" });
    meant = "task_remark_keep_working";
    const seen = notices.length, sent = bodies.length;
    const r5 = await quiet(() => core.runUpdate(ad5, "H", cfg));
    assert.ok(!r5.contact && r5.created === 2, JSON.stringify(r5));
    const texts = g5.H.children.map((c) => g5[c].text);
    assert.deepStrictEqual(texts.slice(0, 2), ["k1 {c1:y} #ankify", "k2 {c1:z} #ankify"]);
    assert.ok(texts.length === 3 && core.isStateBlock(texts[2]) && !Object.values(g5).some((b) => /first attempt/.test(b.text)), "the first attempt's card is gone");
    assert.strictEqual(bodies.length, sent + 2);
    const cont = bodies[bodies.length - 1];
    assert.ok(!cont.tool_choice && cont.stream === true && cont.output_config.format, "the continued call is an ordinary one");
    assert.deepStrictEqual(cont.messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: LlmContact.CONFIRM.keep_working }] });
    assert.ok(LlmContact.records().length === 2 && inbox.length === g[pages["llm-inbox"]].children.length && notices.length === seen, "no contact, no inbox entry, no notice");
    const unc = LlmContact.unconfirmed();
    assert.ok(unc.length === 1 && unc[0].type === "unconfirmed" && unc[0].app === "auto-anki" && unc[0].message === "The source has only one fact.");
  }
  // confirm step broken (the question call throws): the original message is recorded all the same
  {
    const { g: g6, adapter: ad6 } = fakeGraph();
    ad6.appendToPage = adapter.appendToPage; ad6.notify = adapter.notify;
    responses.push({ content: [remark], usage: {}, stop_reason: "tool_use" });
    meant = new Error("network down");
    const r6 = await quiet(() => core.runUpdate(ad6, "H", cfg));
    assert.ok(r6.contact && r6.contact.via === "tool" && r6.contact.message === "The source has only one fact.");
    assert.deepStrictEqual(g6.H.children, []);
    assert.ok(LlmContact.records().length === 3 && LlmContact.records()[2].messages.length === 1 && LlmContact.unconfirmed().length === 1);
    assert.strictEqual(responses.length, 0);
  }
  delete globalThis.localStorage;
  console.log("contact tests OK");
}

// ----- heading groups -----
function fakeGraph(home = "H") { // the test blocks run concurrently and busy is per home uid, so each block gets its own
  const g = { P: { uid: "P", text: "", children: ["c1", home] }, c1: { uid: "c1", text: "Lots of facts about rivers", children: [] }, [home]: { uid: home, text: "#[[auto-generate cards]]", children: [] } };
  let n = 0;
  const tree = (uid) => ({ uid, text: g[uid].text, children: g[uid].children.map(tree) });
  const parentOf = (uid) => Object.keys(g).find((k) => g[k].children.includes(uid));
  const detach = (uid) => { const p = parentOf(uid); if (p) g[p].children = g[p].children.filter((c) => c !== uid); };
  const adapter = {
    async getBlock(uid) { if (!g[uid]) return null; const t = tree(uid); t.parentUid = parentOf(uid); t.pageTitle = "Rivers"; return t; },
    async getSiblingTrees(uid) { return g[parentOf(uid)].children.filter((c) => c !== uid).map(tree); },
    async createBlock(p, text, where) { const uid = "n" + ++n; g[uid] = { uid, text, children: [] }; if (where && where.before) g[p].children.splice(g[p].children.indexOf(where.before), 0, uid); else g[p].children.push(uid); return uid; },
    async updateBlock(uid, text) { g[uid].text = text; },
    async deleteBlock(uid) { detach(uid); const drop = (u) => { for (const c of g[u].children) drop(c); delete g[u]; }; drop(uid); },
    async moveBlock(uid, p, where) { detach(uid); if (where && where.before) g[p].children.splice(g[p].children.indexOf(where.before), 0, uid); else g[p].children.push(uid); },
    async collapse() {},
  };
  return { g, adapter, tree };
}

async function groupingTests() {
  const { g, adapter, tree } = fakeGraph();
  const note = (text, uid = null) => ({ uid, text, back: [] });
  const answers = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.ok(body.output_config.format.schema.properties.groups, "schema has groups");
    assert.ok(/RESPONSE STRUCTURE/.test(body.messages[0].content), "grouping rules are in the request");
    const a = answers.shift();
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(a) }], usage: {}, stop_reason: "end_turn" }), text: async () => "" };
  };
  const cfg = { apiKey: "k", fetchImpl, ankifyTag: "ankify", grouping: { threshold: 6, min: 2, max: 6 } };
  const kidsText = (uid) => g[uid].children.map((c) => g[c].text);
  const findByText = (t) => Object.values(g).find((b) => b.text.startsWith(t));

  // run 1: eight notes in two headings, one of them with subheadings
  answers.push({ tags: ["rivers"], notes: [], delete: [], groups: [
    { uid: null, title: "Mechanisms", notes: [note("m1 {c1:x}"), note("m2 {c1:x}"), note("m3 {c1:x}")], groups: [] },
    { uid: null, title: "History", notes: [], groups: [
      { uid: null, title: "Early", notes: [note("e1 {c1:x}"), note("e2 {c1:x}")] },
      { uid: null, title: "Late", notes: [note("l1 {c1:x}"), note("l2 {c1:x}"), note("l3 {c1:x}")] },
    ] },
  ] });
  let r = await core.runUpdate(adapter, "H", cfg);
  assert.strictEqual(r.created, 8);
  assert.deepStrictEqual(kidsText("H").slice(0, 2), ["Mechanisms", "History"]);
  assert.ok(core.isStateBlock(g[g.H.children[2]].text) && g.H.children.length === 3, "headings then the state block");
  const mech = findByText("Mechanisms"), hist = findByText("History"), early = findByText("Early"), late = findByText("Late");
  assert.deepStrictEqual(kidsText(mech.uid), ["m1 {c1:x} #ankify", "m2 {c1:x} #ankify", "m3 {c1:x} #ankify"]);
  assert.deepStrictEqual(kidsText(hist.uid), ["Early", "Late"]);
  assert.strictEqual(kidsText(late.uid).length, 3);
  let ref = await core.refresh(adapter, "H");
  assert.strictEqual(ref.notes.length, 8, "notes are found under headings");
  assert.deepStrictEqual(ref.state.frozen, [], "headings are not mistaken for user notes");
  assert.strictEqual(Object.keys(ref.state.groups).length, 4);
  const split = core.splitChildren(tree("H").children, "ankify", "H");
  assert.strictEqual(split.groups.length, 2); assert.strictEqual(split.groups[1].groups.length, 2);
  assert.strictEqual(split.groupIndex.get(late.uid).notes.length, 3);
  const l3 = findByText("l3"), m3 = findByText("m3");
  assert.strictEqual(split.notes.find((x) => x.uid === l3.uid).groupUid, late.uid);

  // run 2: retitle a heading, move a note between headings, delete one
  answers.push({ tags: ["rivers"], notes: [], delete: [m3.uid], groups: [
    { uid: mech.uid, title: "Mechanisms (core)", notes: [note("m1 {c1:x}", findByText("m1").uid), note("m2 {c1:x}", findByText("m2").uid), note("l3 {c1:x}", l3.uid)], groups: [] },
    { uid: hist.uid, title: "History", notes: [], groups: [
      { uid: early.uid, title: "Early", notes: [note("e1 {c1:x}", findByText("e1").uid), note("e2 {c1:x}", findByText("e2").uid)] },
      { uid: late.uid, title: "Late", notes: [note("l1 {c1:x}", findByText("l1").uid), note("l2 {c1:x}", findByText("l2").uid)] },
    ] },
  ] });
  r = await core.runUpdate(adapter, "H", cfg);
  assert.deepStrictEqual([r.created, r.updated, r.deleted], [0, 0, 1]);
  assert.strictEqual(g[mech.uid].text, "Mechanisms (core)");
  assert.deepStrictEqual(kidsText(mech.uid), ["m1 {c1:x} #ankify", "m2 {c1:x} #ankify", "l3 {c1:x} #ankify"], "l3 moved into Mechanisms");
  assert.deepStrictEqual(kidsText(late.uid), ["l1 {c1:x} #ankify", "l2 {c1:x} #ankify"]);
  assert.ok(!g[m3.uid], "m3 deleted");

  // run 3: the user edits e1 (frozen); the model now returns a flat list -> editable notes go
  // to the home block, the frozen note keeps its heading, empty headings disappear
  const e1 = findByText("e1"); g[e1.uid].text = "e1 edited {c1:x} #ankify";
  ref = await core.refresh(adapter, "H");
  assert.deepStrictEqual(ref.state.frozen, [e1.uid]);
  const flat = ["m1", "m2", "l3", "e2", "l1", "l2"].map((t) => note(`${t} {c1:x}`, findByText(t).uid));
  flat.push(note("model tries to rewrite the frozen note", e1.uid)); // frozen: moved to the top level, text ignored
  answers.push({ tags: ["rivers"], notes: flat, delete: [e1.uid], groups: [] });
  r = await core.runUpdate(adapter, "H", cfg);
  assert.ok(!g[mech.uid] && !g[late.uid] && !g[hist.uid] && !g[early.uid], "all headings empty and removed");
  const top = kidsText("H");
  assert.ok(top.slice(0, 7).every((t) => /#ankify$/.test(t)), "all notes back at the top level: " + top.join(" | "));
  assert.strictEqual(top.length, 8, "seven notes + state block");
  assert.strictEqual(g[e1.uid].text, "e1 edited {c1:x} #ankify", "frozen note moved but not rewritten or deleted");
  assert.ok(core.isStateBlock(top[top.length - 1]), "state block still last");
  ref = await core.refresh(adapter, "H");
  assert.deepStrictEqual(Object.keys(ref.state.groups), []);
  assert.deepStrictEqual(ref.state.frozen, [e1.uid], "moving notes does not change the frozen set");

  // a user heading without the tag whose children are tagless is a note, not a heading
  const split2 = core.splitChildren([{ uid: "q", text: "What is X?", children: [{ uid: "q1", text: "an answer", children: [] }] }, { uid: "h", text: "Heading", children: [{ uid: "h1", text: "fact #ankify", children: [] }] }], "ankify", "H");
  assert.deepStrictEqual(split2.notes.map((x) => x.uid), ["q", "h1"]);
  assert.deepStrictEqual(split2.groups.map((x) => x.uid), ["h"]);
  const msg = core.buildUserMessage({ contentTrees: [], notes: split2.notes, groups: split2.groups, state: core.emptyState(), homeTags: [], grouping: { threshold: 6, min: 2, max: 6 } });
  assert.ok(/\[GROUP\] uid=h title: Heading\n  - \[EDITABLE\] uid=h1/.test(msg), msg);
  assert.ok(/at most 6/.test(msg) && /2 to 6 notes/.test(msg));
  console.log("grouping tests OK");
}

// ----- busy for the whole run, API call included (a second click must not start a second run) -----
(async () => {
  const g = { P: { uid: "P", text: "", children: ["c", "HB"] }, c: { uid: "c", text: "fact", children: [] }, HB: { uid: "HB", text: "#[[auto-generate cards]]", children: [] } };
  const tree = (uid) => ({ uid, text: g[uid].text, children: g[uid].children.map(tree) });
  const adapter = {
    async getBlock(uid) { if (!g[uid]) return null; const t = tree(uid); t.parentUid = uid === "P" ? null : "P"; return t; },
    async getSiblingTrees() { return [tree("c")]; },
    async createBlock(p, text) { const uid = "b" + Object.keys(g).length; g[uid] = { uid, text, children: [] }; g[p].children.push(uid); return uid; },
    async updateBlock(uid, text) { g[uid].text = text; },
    async deleteBlock() {}, async collapse() {},
  };
  let release = null;
  const answer = { tags: [], notes: [{ uid: null, text: "a {c1:b}", back: [] }], groups: [], delete: [] };
  const fetchImpl = () => new Promise((res) => { release = () => res({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(answer) }], usage: {}, stop_reason: "end_turn" }), text: async () => "" }); });
  const cfg = { apiKey: "k", fetchImpl, ankifyTag: "ankify" };
  const run = core.runUpdate(adapter, "HB", cfg);
  assert.ok(core.isBusy("HB"), "busy from the start of the run, before Claude answers");
  await assert.rejects(core.runUpdate(adapter, "HB", cfg), /already updating/, "a second run during the API call is refused");
  while (!release) await new Promise((r) => setTimeout(r, 5));
  release();
  const r = await run;
  assert.strictEqual(r.created, 1);
  assert.ok(!core.isBusy("HB"), "not busy once the run is over");
  console.log("busy tests OK");
})().catch((e) => { console.error(e); process.exit(1); });

// ----- streaming: cards are written while the answer is still arriving -----
{
  const got = [];
  const sc = core.jsonNoteScanner((n, groups) => got.push({ text: n.text, path: n.path, groups: groups.map((g) => [g.title, g.uid, g.path.join("/")]) }));
  const doc = JSON.stringify({ tags: ["x"], notes: [{ uid: null, text: "top {c1:a}", back: [] }], groups: [
    { uid: "G1", title: "Rivers \"long\" {and} [odd]", notes: [{ uid: null, text: "n1", back: ["b1", "b2"] }, { uid: "e1", text: "n2", back: [] }], groups: [] },
    { uid: null, title: "Nested", notes: [], groups: [{ uid: null, title: "Inner", notes: [{ uid: null, text: "deep", back: [] }] }] },
  ], delete: ["e2"] });
  for (let i = 0; i < doc.length; i += 7) sc.feed(doc.slice(i, i + 7)); // any chunking
  assert.deepStrictEqual(got, [
    { text: "top {c1:a}", path: ["notes", 0], groups: [] },
    { text: "n1", path: ["groups", 0, "notes", 0], groups: [["Rivers \"long\" {and} [odd]", "G1", "groups/0"]] },
    { text: "n2", path: ["groups", 0, "notes", 1], groups: [["Rivers \"long\" {and} [odd]", "G1", "groups/0"]] },
    { text: "deep", path: ["groups", 1, "groups", 0, "notes", 0], groups: [["Nested", null, "groups/1"], ["Inner", null, "groups/1/groups/0"]] },
  ]);
  console.log("scanner tests OK");
}

/** A fake streamed Messages API response: text blocks arrive as text deltas, tool blocks as JSON deltas; onChunk runs before every network chunk. */
function sseResponse({ content, stop_reason = "end_turn" }, onChunk) {
  const events = [{ type: "message_start", message: { usage: { input_tokens: 1 }, model: "claude-opus-5" } }];
  content.forEach((b, index) => {
    if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (let i = 0; i < b.text.length; i += 9) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(i, i + 9) } });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  const wire = events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join("");
  const enc = new TextEncoder();
  let at = 0;
  const body = new ReadableStream({
    async pull(ctrl) {
      await new Promise((r) => setTimeout(r, 0)); // let queued writes land between chunks, as they would over a real network
      if (at >= wire.length) { ctrl.close(); return; }
      if (onChunk) await onChunk();
      ctrl.enqueue(enc.encode(wire.slice(at, at + 13))); at += 13; // frames split across reads
    },
  });
  return { ok: true, status: 200, body, text: async () => "", json: async () => { throw new Error("streamed replies have no json()"); } };
}

(async () => {
  const note = (text, uid = null, back = []) => ({ uid, text, back });
  const textBlock = (answer) => ({ type: "text", text: JSON.stringify(answer) });
  // 1) a fresh block: eight notes under headings stream in one by one
  {
    const { g, adapter } = fakeGraph("HS");
    const answer = { tags: ["rivers"], notes: [], groups: [
      { uid: null, title: "Lengths", notes: [note("Nile {c1:6650 km}"), note("Longest river?", null, ["Nile"]), note("Amazon {c1:6400 km}")], groups: [] },
      { uid: null, title: "Places", notes: [], groups: [{ uid: null, title: "Sources", notes: [note("Nile source {c1:Lake Victoria}"), note("Amazon source {c1:Andes}")] }] },
      { uid: null, title: "Misc", notes: [note("m1 {c1:x}"), note("m2 {c1:y}"), note("m3 {c1:z}")], groups: [] },
    ], delete: [] };
    const sizes = [];
    const progress = [];
    adapter.progress = (uid, n) => progress.push(n);
    const fetchImpl = async () => sseResponse({ content: [textBlock(answer)] }, () => sizes.push(Object.keys(g).length));
    const cfg = { apiKey: "k", fetchImpl, ankifyTag: "ankify", grouping: { threshold: 6, min: 2, max: 6 } };
    const r = await core.runUpdate(adapter, "HS", cfg);
    assert.deepStrictEqual([r.created, r.updated, r.deleted], [8, 0, 0]);
    assert.ok(new Set(sizes).size > 4, "the graph grew step by step while the answer was still streaming: " + sizes.join(","));
    assert.deepStrictEqual(progress, [1, 2, 3, 4, 5, 6, 7, 8], "progress reported per note");
    const H = g.HS.children.map((u) => g[u]);
    assert.deepStrictEqual(H.map((b) => b.text).slice(0, 3), ["Lengths", "Places", "Misc"]);
    assert.ok(core.isStateBlock(H[3].text) && H.length === 4, "state block last, nothing duplicated");
    assert.deepStrictEqual(H[0].children.map((u) => g[u].text), ["Nile {c1:6650 km} #ankify", "Longest river? #ankify", "Amazon {c1:6400 km} #ankify"]);
    assert.deepStrictEqual(g[H[0].children[1]].children.map((u) => g[u].text), ["Nile"]);
    assert.strictEqual(g[H[1].children[0]].text, "Sources"); assert.strictEqual(g[H[1].children[0]].children.length, 2);
    const state = core.parseState(H[3].text);
    assert.strictEqual(Object.keys(state.notes).length, 8, "every streamed note is in the state");
    assert.strictEqual(Object.keys(state.groups).length, 4, "every heading made on the way is in the state");
    assert.ok(Object.values(state.notes).every((n) => !/ankify/.test(n.text)));
    assert.strictEqual(g.HS.text, "#[[auto-generate cards]] #rivers");
    // 2) second run: existing notes come back by uid, one new note joins an existing heading, one is deleted
    const uidOf = (t) => Object.values(g).find((b) => b.text.startsWith(t)).uid;
    const keep = (t) => { const b = g[uidOf(t)]; return { uid: b.uid, text: b.text.replace(/ #ankify$/, ""), back: b.children.map((c) => g[c].text) }; };
    const answer2 = { tags: ["rivers"], notes: [], groups: [
      { uid: uidOf("Lengths"), title: "Lengths", notes: [keep("Nile {c1"), keep("Longest"), keep("Amazon {c1"), note("Congo {c1:4700 km}")], groups: [] },
      { uid: uidOf("Places"), title: "Places", notes: [], groups: [{ uid: uidOf("Sources"), title: "Sources", notes: [keep("Nile source"), keep("Amazon source")] }] },
      { uid: uidOf("Misc"), title: "Misc", notes: [keep("m1"), keep("m2")], groups: [] },
    ], delete: [uidOf("m3")] };
    const before = g.HS.children.length;
    const r2 = await core.runUpdate(adapter, "HS", { ...cfg, fetchImpl: async () => sseResponse({ content: [textBlock(answer2)] }) });
    assert.deepStrictEqual([r2.created, r2.updated, r2.deleted], [1, 0, 1]);
    assert.strictEqual(g.HS.children.length, before, "no heading duplicated");
    assert.deepStrictEqual(g[uidOf("Lengths")].children.map((u) => g[u].text.replace(/ #ankify$/, "")), ["Nile {c1:6650 km}", "Longest river?", "Amazon {c1:6400 km}", "Congo {c1:4700 km}"]);
    assert.deepStrictEqual(g[uidOf("Misc")].children.map((u) => g[u].text), ["m1 {c1:x} #ankify", "m2 {c1:y} #ankify"]);
    assert.strictEqual(Object.keys(core.parseState(g[g.HS.children[g.HS.children.length - 1]].text).notes).length, 8);
  }
  // 3) the stream breaks half way: everything written so far is removed again
  {
    const { g, adapter } = fakeGraph("HS");
    const answer = { tags: [], notes: [note("a {c1:1}"), note("b {c1:2}"), note("c {c1:3}"), note("d {c1:4}")], groups: [], delete: [] };
    const snapshot = JSON.stringify(g);
    let chunks = 0, peak = 0;
    const fetchImpl = async () => sseResponse({ content: [textBlock(answer)] }, () => { peak = Math.max(peak, g.HS.children.length); if (++chunks === 120) throw new Error("connection lost"); });
    await assert.rejects(core.runUpdate(adapter, "HS", { apiKey: "k", fetchImpl, ankifyTag: "ankify" }), /connection lost/);
    assert.ok(peak > 0, "some cards had been written before the failure");
    assert.strictEqual(JSON.stringify(g), snapshot, "graph back to how it was");
    assert.ok(!core.isBusy("HS"));
  }
  // 4) Claude asks for Eli after some notes streamed: they are removed, nothing is kept
  {
    const { g, adapter } = fakeGraph("HS");
    const pages = {};
    adapter.appendToPage = async (title, text) => { if (!pages[title]) { const uid = "pg_" + title; g[uid] = { uid, text: "", children: [] }; pages[title] = uid; } return adapter.createBlock(pages[title], text, { last: true }); };
    const stored = {};
    globalThis.localStorage = { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } };
    const answer = { tags: [], notes: [note("a {c1:1}"), note("b {c1:2}")], groups: [], delete: [] };
    const send = { content: [{ type: "tool_use", id: "d1", name: "contact_eli_decision", input: { meant: "send_to_eli_and_stop" } }], stop_reason: "tool_use" }; // the answer to the confirm question
    const fetchImpl = async (url, opts) => (JSON.parse(opts.body).tool_choice ? { ok: true, status: 200, json: async () => send, text: async () => "" } : sseResponse({ content: [textBlock(answer), { type: "tool_use", id: "tu9", name: "contact_eli", input: { message: "please stop" } }], stop_reason: "tool_use" }));
    const warn = console.warn; console.warn = () => {};
    const r = await core.runUpdate(adapter, "HS", { apiKey: "k", fetchImpl, ankifyTag: "ankify" }).finally(() => { console.warn = warn; });
    assert.ok(r.contact && r.contact.via === "tool");
    assert.deepStrictEqual(g.HS.children, [], "streamed cards rolled back when Claude asked for Eli");
    assert.strictEqual(g[pages["llm-inbox"]].children.length, 1);
    delete globalThis.localStorage;
  }
  console.log("streaming tests OK");
})().catch((e) => { console.error(e); process.exit(1); });
