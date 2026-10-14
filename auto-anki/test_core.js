// node auto-anki/test_core.js — exercises the shared core with a fake adapter and a fake Claude.
const assert = require("assert");
require("./core.js");
const core = globalThis.AutoAnkiCore;

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
    assert.strictEqual(body.system[0].text, promptPage ? "custom prompt" : core.SYSTEM, "prompt page overrides the built-in prompt");
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
  await groupingTests();
  console.log("core tests OK");
})().catch((e) => { console.error(e); process.exit(1); });

// ----- heading groups -----
function fakeGraph() {
  const g = { P: { uid: "P", text: "", children: ["c1", "H"] }, c1: { uid: "c1", text: "Lots of facts about rivers", children: [] }, H: { uid: "H", text: "#[[auto-generate cards]]", children: [] } };
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
