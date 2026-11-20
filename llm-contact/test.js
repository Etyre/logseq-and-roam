// node llm-contact/test.js — the confirm step and the note tool against stubbed model calls (no network, nothing notified).
const assert = require("assert");
require("./llm-contact.js");
const C = globalThis.LlmContact;
const stored = {};
globalThis.localStorage = { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = v; } };
const quiet = (fn) => async (...a) => { const { warn, error } = console; console.warn = console.error = () => {}; try { return await fn(...a); } finally { console.warn = warn; console.error = error; } };

const messages = [{ role: "user", content: "task" }];
const tool = (message, id = "tu1") => ({ type: "tool_use", id, name: C.CONTACT_TOOL.name, input: { message } });
const decision = (meant) => ({ content: [{ type: "tool_use", id: "d1", name: C.CONFIRM.decision_tool.name, input: { meant } }] });
const answer = { content: [{ type: "text", text: "the answer" }] };
const remark = { content: [{ type: "text", text: "" }, tool("this page has no articles"), { type: "tool_use", id: "tu2", name: "other_tool", input: { q: 1 } }] };
const ASKED = "claude-haiku-4-5"; // a model the confirm step is validated for
const run = quiet((response, call, model = ASKED) => C.withConfirm({ app: "test", model, messages, response, call }));

(async () => {
  // the request for the question: the app's tools plus the decision tool, forced
  const d = C.decisionRequest([C.CONTACT_TOOL, { name: "other_tool" }]);
  assert.deepStrictEqual(d.tools.map((t) => t.name), ["contact_eli", "other_tool", "contact_eli_decision"]);
  assert.deepStrictEqual(d.tool_choice, { type: "tool", name: "contact_eli_decision" });
  assert.deepStrictEqual(C.CONFIRM.decision_tool.input_schema.properties.meant.enum, [C.CONFIRM.send_value, C.CONFIRM.keep_value]);

  // no tool call, or only an "@ELI:" line: never asked, handed back untouched
  for (const response of [answer, { content: [{ type: "text", text: "@ELI: please read this" }] }]) {
    assert.strictEqual(C.confirmTurn(response), null);
    const r = await run(response, () => { throw new Error("must not be called"); });
    assert.ok(r.response === response && r.messages === messages);
  }

  // a model the step is not validated for (or no model name at all): a contact_eli call is never questioned
  assert.deepStrictEqual(C.CONFIRM.confirm_models, ["claude-haiku-4-5"], "update this test when shared CONFIRM_MODELS changes");
  assert.ok(C.confirmApplies(ASKED) && C.confirmApplies(ASKED + "-20251001") && !C.confirmApplies("claude-haiku-5-5") && !C.confirmApplies("claude-opus-5") && !C.confirmApplies(undefined));
  for (const model of ["claude-opus-5", "claude-haiku-5-5", null]) {
    const r = await run(remark, () => { throw new Error("must not be called"); }, model);
    assert.ok(r.response === remark && r.messages === messages);
  }
  assert.strictEqual(C.check({ app: "test", model: "claude-opus-5", messages, response: remark }).message, "this page has no articles");
  assert.ok(C.records().length === 1 && C.unconfirmed().length === 0);
  delete stored[C.STORAGE_KEY];

  // the ask turn: empty text dropped, the question on the contact_eli call, a placeholder on every other call
  const ask = C.confirmTurn(remark);
  assert.deepStrictEqual(ask[0], { role: "assistant", content: [remark.content[1], remark.content[2]] });
  assert.deepStrictEqual(ask[1].content, [
    { type: "tool_result", tool_use_id: "tu1", content: C.CONFIRM.question },
    { type: "tool_result", tool_use_id: "tu2", content: "Not run: the contact_eli call is being handled first." },
  ]);

  // keep working, then a normal answer: the continued exchange comes back, the remark is kept as unconfirmed
  const calls = [];
  const keep = await run(remark, async (m, decide) => { calls.push({ m, decide }); return decide ? decision(C.CONFIRM.keep_value) : answer; });
  assert.deepStrictEqual(calls.map((c) => c.decide), [true, false]);
  assert.deepStrictEqual(calls[0].m, messages.concat(ask));
  assert.strictEqual(calls[1].m[2].content[0].content, C.CONFIRM.keep_working);
  assert.ok(keep.response === answer && keep.messages === calls[1].m);
  assert.strictEqual(C.check({ app: "test", model: "m", messages: keep.messages, response: keep.response }), null);
  assert.strictEqual(C.unconfirmed().length, 1);
  assert.deepStrictEqual([C.unconfirmed()[0].type, C.unconfirmed()[0].message, C.unconfirmed()[0].app], ["unconfirmed", "this page has no articles", "test"]);
  assert.strictEqual(C.records().length, 0, "unconfirmed messages are not contacts");

  // send, an unknown value, no decision block, a throwing call: all hand back the original
  for (const call of [async () => decision(C.CONFIRM.send_value), async () => decision("something else"), async () => answer, async () => ({}), async () => { throw new Error("network down"); }]) {
    const r = await run(remark, (m, decide) => { assert.ok(decide, "no second task call unless the model chose keep"); return call(); });
    assert.ok(r.response === remark && r.messages === messages);
  }
  // keep, but the continued call fails: the original again
  const failed = await run(remark, async (m, decide) => { if (decide) return decision(C.CONFIRM.keep_value); throw new Error("stream broke"); });
  assert.ok(failed.response === remark && failed.messages === messages);
  assert.strictEqual(C.unconfirmed().length, 1, "nothing noted as unconfirmed when the original is sent");

  // keep, then the model contacts Eli after all: not unconfirmed, and the record carries both messages
  const again = { content: [tool("I do want to stop", "tu3")] };
  const r2 = await run(remark, async (m, decide) => (decide ? decision(C.CONFIRM.keep_value) : again));
  assert.strictEqual(C.unconfirmed().length, 1);
  const rec = C.check({ app: "test", model: "m", messages: r2.messages, response: r2.response });
  assert.strictEqual(rec.message, "this page has no articles\n\n(when asked to confirm:) I do want to stop");
  assert.strictEqual(C.records().length, 1);
  delete stored[C.STORAGE_KEY];

  // ----- note_to_eli: recorded as a note, answered, and the model is asked again; it never stops anything -----
  const note = (message, id) => ({ type: "tool_use", id, name: C.NOTE_TOOL.name, input: { message } });
  const base = { app: "test", model: "m", system: "s", messages, tools: C.CONTACT_TOOLS };
  const withNotes = quiet((o) => C.withNotes({ ...base, ...o }));
  assert.deepStrictEqual(C.CONTACT_TOOLS.map((t) => t.name), ["contact_eli", "note_to_eli"]);
  assert.deepStrictEqual(C.extract({ content: [note("fyi", "n1")] }), [], "a note is not a stop signal");
  assert.strictEqual(C.confirmTurn({ content: [note("fyi", "n1")] }), null, "and is never questioned");
  // no note: handed back untouched, nothing called
  const plain = await withNotes({ response: answer, call: () => { throw new Error("must not be called"); } });
  assert.ok(plain.response === answer && plain.messages === messages && plain.notes.length === 0);
  // a note-only response: recorded once, acknowledged, asked again; a normal result comes back and check() finds no stop
  const noteOnly = { content: [{ type: "text", text: " " }, note("fyi", "n1"), { type: "tool_use", id: "o1", name: "other_tool", input: {} }], stop_reason: "tool_use" };
  const asked = [];
  const n1 = await withNotes({ response: noteOnly, call: async (m) => { asked.push(m); return answer; } });
  assert.strictEqual(asked.length, 1);
  assert.deepStrictEqual(asked[0], messages.concat([
    { role: "assistant", content: [noteOnly.content[1], noteOnly.content[2]] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "n1", content: C.NOTE_RESULT_TEXT }, { type: "tool_result", tool_use_id: "o1", content: "Not run this turn. Call it again if you still need it." }] },
  ]));
  assert.ok(n1.response === answer && n1.messages === asked[0] && n1.notes.length === 1);
  assert.strictEqual(await quiet(async () => C.check({ ...base, messages: n1.messages, response: n1.response }))(), null, "no stop");
  assert.strictEqual(C.records().length, 1, "one note delivered");
  const nrec = C.records()[0];
  assert.deepStrictEqual([nrec.type, nrec.via, nrec.halts, nrec.message, nrec.app, nrec.model, nrec.system, nrec.forwarded], ["contact", "note", false, "fyi", "test", "m", "s", false]);
  assert.deepStrictEqual([nrec.messages, nrec.response, nrec.tools], [messages, { content: noteOnly.content, stop_reason: "tool_use" }, C.CONTACT_TOOLS], "a note record carries the same context as a stop record");
  assert.ok(/ · via note \(task carried on\)$/.test(C.pageBlocks(nrec).text) && C.pageBlocks(nrec).children[0] === "fyi");
  // check() on a response whose notes are already recorded does not record them twice; on one nobody handled, it does (and still returns null)
  assert.strictEqual(await quiet(async () => C.check({ ...base, response: noteOnly }))(), null);
  assert.strictEqual(C.records().length, 1);
  assert.strictEqual(await quiet(async () => C.check({ ...base, response: { content: [note("unhandled", "n9")] } }))(), null);
  assert.deepStrictEqual(C.records().map((r) => r.message), ["fyi", "unhandled"]);
  // a note together with contact_eli: handed back untouched for check(), which stops; both are recorded, the note as a note
  const both = { content: [note("by the way", "n2"), tool("please stop", "tu5")] };
  const n2 = await withNotes({ response: both, call: () => { throw new Error("must not be called"); } });
  assert.ok(n2.response === both && n2.messages === messages && n2.notes.length === 1);
  const stop = await quiet(async () => C.check({ ...base, response: both }))();
  assert.ok(stop && stop.via === "tool" && stop.message === "please stop" && !("halts" in stop), "contact_eli still stops");
  assert.deepStrictEqual(C.records().slice(2).map((r) => [r.via, r.halts, r.message]), [["note", false, "by the way"], ["tool", undefined, "please stop"]]);
  // ... and in the confirm question the note call is answered with the acknowledgement, since it was delivered
  assert.deepStrictEqual(C.confirmTurn(both)[1].content, [{ type: "tool_result", tool_use_id: "n2", content: C.NOTE_RESULT_TEXT }, { type: "tool_result", tool_use_id: "tu5", content: C.CONFIRM.question }]);
  // an "@ELI:" line next to a note stops too
  const marker = { content: [{ type: "text", text: "@ELI: a word, please" }, note("and a note", "n3")] };
  assert.ok((await withNotes({ response: marker, call: () => { throw new Error("must not be called"); } })).response === marker);
  assert.strictEqual((await quiet(async () => C.check({ ...base, response: marker }))()).via, "marker");
  // the model keeps leaving notes: asked again 3 times at most, every note recorded once, the last response handed back
  delete stored[C.STORAGE_KEY];
  let k = 0;
  const n3 = await withNotes({ response: { content: [note("note 0", "r0")] }, call: async () => ({ content: [note("note " + ++k, "r" + k)] }) });
  assert.ok(k === 3 && n3.notes.length === 4 && n3.messages.length === messages.length + 6 && C.extractNotes(n3.response)[0].message === "note 3");
  assert.strictEqual(await quiet(async () => C.check({ ...base, messages: n3.messages, response: n3.response }))(), null);
  assert.deepStrictEqual(C.records().map((r) => r.message), ["note 0", "note 1", "note 2", "note 3"]);
  // answered(): a response that already holds the task's answer is not asked about again; its note is still recorded
  const done = { content: [{ type: "text", text: "the answer" }, note("also", "n4")] };
  const n4 = await withNotes({ response: done, answered: (r) => r === done, call: () => { throw new Error("must not be called"); } });
  assert.ok(n4.response === done && n4.notes.length === 1 && C.records().length === 5);
  // the second call fails: the error reaches the caller and the note is already recorded
  await assert.rejects(withNotes({ response: { content: [note("before the failure", "n5")] }, call: async () => { throw new Error("network down"); } }), /network down/);
  assert.strictEqual(C.records()[5].message, "before the failure");
  console.log("llm-contact tests OK");
})().catch((e) => { console.error(e); process.exit(1); });
