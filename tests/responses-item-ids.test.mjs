import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RESPONSES_ITEM_ID_PREFIXES,
  normalizeItemId,
  normalizeInputItemIds,
} from "../scripts/codex/lib/responses-item-ids.mjs";

const conforms = (item) => {
  const prefix = RESPONSES_ITEM_ID_PREFIXES[item.type];
  return !prefix || typeof item.id !== "string" || item.id.startsWith(prefix);
};

test("a MiniMax-minted id is rewritten to its type's prefix", () => {
  assert.match(normalizeItemId("custom_tool_call", "06ef3bc08924acade1facee14da0af2e_fc_0"), /^ctc_[0-9a-f]{32}$/);
  assert.match(normalizeItemId("reasoning", "06eea1506b9c37f6f3f4bb02f90abd28_rs"), /^rs_[0-9a-f]{32}$/);
  assert.match(normalizeItemId("function_call", "06a9c3a9e1f7e0da8b8f2979b8775435_fc_1"), /^fc_[0-9a-f]{32}$/);
});

test("an id that already conforms is left exactly as it is", () => {
  for (const [ type, prefix ] of Object.entries(RESPONSES_ITEM_ID_PREFIXES)) {
    assert.equal(normalizeItemId(type, `${prefix}abc123`), null, type);
  }
});

// `custom_tool_call_output` ids begin `ctco_`, which shares its first three
// characters with a `custom_tool_call`'s `ctc_`. A prefix test that ignored the
// separator would call every tool output well-formed as a tool call.
test("ctco_ is not mistaken for a conforming ctc_ id", () => {
  assert.equal(normalizeItemId("custom_tool_call_output", "ctco_abc"), null);
  assert.match(normalizeItemId("custom_tool_call", "ctco_abc"), /^ctc_/);
});

test("an item with no id keeps having no id", () => {
  assert.equal(normalizeItemId("custom_tool_call_output", undefined), null);
  const input = [ { type: "custom_tool_call_output", call_id: "call_1", output: "x" } ];
  const { input: out, changed } = normalizeInputItemIds(input);
  assert.equal(changed, 0);
  assert.equal(out[ 0 ].id, undefined);
});

test("an unrecognised item type is passed through untouched", () => {
  assert.equal(normalizeItemId("web_search_call", "ws_abc"), null);
  assert.equal(normalizeItemId("some_future_item", "whatever"), null);
});

test("call_id is never rewritten", () => {
  const input = [
    { type: "custom_tool_call", id: "06ef_fc_0", call_id: "call_8ec20ad454e0460d9d4b6662", name: "exec" },
    { type: "custom_tool_call_output", id: "ctco_1", call_id: "call_8ec20ad454e0460d9d4b6662", output: "ok" },
  ];
  const { input: out } = normalizeInputItemIds(input);
  assert.equal(out[ 0 ].call_id, "call_8ec20ad454e0460d9d4b6662");
  assert.equal(out[ 1 ].call_id, "call_8ec20ad454e0460d9d4b6662");
  // The pair still resolves to each other, which is the only thing that makes
  // a tool result attach to its call.
  assert.equal(out[ 0 ].call_id, out[ 1 ].call_id);
});

test("normalisation is deterministic, so a replayed turn hashes the same way", () => {
  const first = normalizeItemId("reasoning", "06eea1506b9c37f6f3f4bb02f90abd28_rs");
  const second = normalizeItemId("reasoning", "06eea1506b9c37f6f3f4bb02f90abd28_rs");
  assert.equal(first, second);
  // Distinct originals stay distinct: two items must never collapse onto one id.
  assert.notEqual(first, normalizeItemId("reasoning", "06eea1506b9c37f6f3f4bb02f90abd29_rs"));
});

test("normalisation is idempotent", () => {
  const input = [ { type: "reasoning", id: "06eea1506b9c37f6f3f4bb02f90abd28_rs" } ];
  const once = normalizeInputItemIds(input);
  const twice = normalizeInputItemIds(once.input);
  assert.equal(once.changed, 1);
  assert.equal(twice.changed, 0);
  assert.equal(twice.input, once.input);
});

test("an input needing no repair is returned as the same array", () => {
  const input = [ { type: "message", id: "msg_1", role: "user" } ];
  const { input: out, changed } = normalizeInputItemIds(input);
  assert.equal(changed, 0);
  assert.equal(out, input);
});

test("a non-array input is handled without throwing", () => {
  for (const value of [ undefined, null, "text", 7, {} ]) {
    assert.deepEqual(normalizeInputItemIds(value), { input: value, changed: 0 });
  }
});

test("other fields on a repaired item survive the rewrite", () => {
  const item = { type: "custom_tool_call", id: "06ef_fc_0", call_id: "call_1", name: "exec", input: "await tools.exec_command({})", status: "completed" };
  const { input: [ out ] } = normalizeInputItemIds([ item ]);
  assert.deepEqual({ ...out, id: item.id }, item);
});

// The session that first surfaced this: a Codex-served orchestrator turn failed
// over to MiniMax mid-conversation, and the next turn -- routed back to Codex
// because a fresh turn is not a continuation -- was rejected outright. The
// fixture is the item skeleton of that rollout, with the upstream error it
// produced.
test("the rollout that crashed the orchestrator normalises cleanly", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/poisoned-rollout-items.json", import.meta.url), "utf8"));

  assert.equal(fixture.upstreamError.param, "input[18].id");
  assert.equal(fixture.items[ 18 ].type, "custom_tool_call");
  assert.equal(conforms(fixture.items[ 18 ]), false, "input[18] is the item the upstream named");

  const poisoned = fixture.items.filter((item) => !conforms(item));
  assert.equal(poisoned.length, 9);

  const { input, changed } = normalizeInputItemIds(fixture.items);
  assert.equal(changed, 9);
  assert.deepEqual(input.filter((item) => !conforms(item)), [], "no item is left violating the contract");
  assert.match(input[ 18 ].id, /^ctc_/);
  assert.deepEqual(input.map((item) => item.call_id), fixture.items.map((item) => item.call_id));
});
