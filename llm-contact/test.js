// node llm-contact/test.js — the confirm step against stubbed model calls (no network, nothing notified).
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
  console.log("llm-contact tests OK");
})().catch((e) => { console.error(e); process.exit(1); });
