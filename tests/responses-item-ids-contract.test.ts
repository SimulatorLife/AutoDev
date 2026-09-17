import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  RESPONSES_ITEM_ID_PREFIXES,
  normalizeItemId,
  normalizeInputItemIds,
  dropUnresolvableReasoning,
} from "../src/shared/responses-item-ids.ts";

const contract: any = JSON.parse(readFileSync(new URL("./fixtures/contracts/responses-item-ids-contract.json", import.meta.url), "utf8"));
const POISONED_FIXTURE: any = JSON.parse(readFileSync(new URL("./fixtures/poisoned-rollout-items.json", import.meta.url), "utf8"));

const ITEM_CONFORMS = (item: any) => {
  const prefix = RESPONSES_ITEM_ID_PREFIXES[item.type as keyof typeof RESPONSES_ITEM_ID_PREFIXES];
  return !prefix || typeof item.id !== "string" || item.id.startsWith(prefix);
};

assert.equal(contract.schema, "autodev-responses-item-ids-contract-v1", "responses item-id contract must match its schema tag");

describe("Responses item-id contract schema", () => {
  test("RESPONSES_ITEM_ID_PREFIXES is frozen and matches the fixture", () => {
    assert.deepEqual({ ...RESPONSES_ITEM_ID_PREFIXES }, contract.prefixes, "frozen prefix map shape");
    assert.equal(Object.isFrozen(RESPONSES_ITEM_ID_PREFIXES), true, "prefix map must remain frozen");
    for (const [type, prefix] of Object.entries(contract.prefixes as Record<string, string>)) {
      assert.match(prefix, /^[a-z]+_$/, `${type} prefix shape`);
    }
  });
});

describe("normalizeItemId branches", () => {
  for (const [name, scenario] of Object.entries(contract.normalizeItemId as Record<string, any>)) {
    test(`${name}`, () => {
      if (Array.isArray(scenario.input)) {
        const inputs = scenario.input;
        const expected = scenario.expected;
        assert.equal(inputs.length, expected.length, `${name}: array length alignment`);
        for (let i = 0; i < inputs.length; i += 1) {
          const { type, id } = inputs[ i ];
          const value = Object.hasOwn(inputs[ i ], "id") ? id : undefined;
          assert.equal(normalizeItemId(type, value), expected[ i ], `${name}[${i}]`);
        }
        return;
      }
      const { type, id } = scenario.input;
      const value = Object.hasOwn(scenario.input, "id") ? id : undefined;
      assert.equal(normalizeItemId(type, value), scenario.expected, name);
    });
  }
});

describe("normalizeInputItemIds branches", () => {
  test("all_valid_input_returns_same_array_with_zero_changes", () => {
    const scenario = contract.normalizeInputItemIds.all_valid_input_returns_same_array_with_zero_changes;
    const result = normalizeInputItemIds(scenario.input);
    assert.equal(result.changed, scenario.expected.changed, "changed");
    assert.equal(result.input, scenario.input, "array reference preserved on no-op");
    assert.deepEqual((result.input as any[]).map((i: any) => i.id ?? null), scenario.expected.ids, "ids preserved");
  });

  test("non_array_inputs_are_passed_through_untouched", () => {
    const scenario = contract.normalizeInputItemIds.non_array_inputs_are_passed_through_untouched;
    const jsonCases = scenario.input;
    const expected = scenario.expected;
    assert.equal(jsonCases.length, expected.length, "json-pass-through length alignment");
    for (let i = 0; i < jsonCases.length; i += 1) {
      assert.deepEqual(normalizeInputItemIds(jsonCases[ i ]), expected[ i ], `case[${i}]`);
    }
    // `undefined` lives outside the JSON contract but the runtime invariant must
    // still hold against the same expected shape.
    assert.deepEqual(normalizeInputItemIds(undefined), { input: undefined, changed: 0 }, "undefined host primitive");
  });

  test("mixed_input_rewrites_only_non_conforming_items", () => {
    const scenario = contract.normalizeInputItemIds.mixed_input_rewrites_only_non_conforming_items;
    const result = normalizeInputItemIds(scenario.input);
    assert.equal(result.changed, scenario.expected.changed, "changed count");
    const input = result.input as any[];
    assert.deepEqual(input.map((i: any) => i.id ?? null), scenario.expected.ids, "ids after normalization");
    assert.deepEqual(input.map((i: any) => i.call_id ?? null), scenario.expected.callIds, "call_ids preserved");
  });

  test("deterministic_hash_collapses_replayed_id_to_same_value", () => {
    const scenario = contract.normalizeInputItemIds.deterministic_hash_collapses_replayed_id_to_same_value;
    const { type, id } = scenario.input;
    const first = normalizeItemId(type, id);
    const second = normalizeItemId(type, id);
    assert.equal(first, scenario.expected.firstCall, "first call hash");
    assert.equal(second, scenario.expected.secondCall, "second call hash");
    assert.equal(first, second, "same input twice");
    assert.equal(scenario.expected.equal, true, "equal flag pinned true");
  });

  test("call_id_is_preserved_across_the_rewrite", () => {
    const scenario = contract.normalizeInputItemIds.call_id_is_preserved_across_the_rewrite;
    const result = normalizeInputItemIds(scenario.input);
    assert.equal(result.changed, scenario.expected.changed, "changed count");
    const input = result.input as any[];
    assert.match(input[ 0 ].id, new RegExp("^" + scenario.expected.firstItemNewIdPrefix), "first item id prefix");
    assert.deepEqual(input.map((i: any) => i.call_id ?? null), scenario.expected.callIds, "call_ids preserved");
    assert.equal(input[ 0 ].call_id, input[ 1 ].call_id, "pair resolves to the same call_id");
  });

  test("unrepaired_input_is_idempotent_on_second_pass", () => {
    const scenario = contract.normalizeInputItemIds.unrepaired_input_is_idempotent_on_second_pass;
    const once = normalizeInputItemIds([ scenario.input.item ]);
    const twice = normalizeInputItemIds(once.input);
    assert.equal(once.changed, scenario.expected.onceChanged, "once.changed");
    assert.equal(twice.changed, scenario.expected.twiceChanged, "twice.changed");
    assert.equal(twice.input, once.input, "same array reference on the second pass");
    assert.equal((once.input as any[])[ 0 ].id, scenario.expected.firstId, "deterministic hash matches pinned value");
  });

  test("other_fields_on_a_repaired_item_survive_the_rewrite", () => {
    const scenario = contract.normalizeInputItemIds.other_fields_on_a_repaired_item_survive_the_rewrite;
    const { input: rawOut } = normalizeInputItemIds([ scenario.input.item ]);
    const out = rawOut as any[];
    for (const field of scenario.expected.retainedFields) {
      assert.equal(out[ 0 ][ field ], scenario.input.item[ field ], `retained ${field}`);
    }
    assert.notEqual(out[ 0 ].id, scenario.expected.originalIdBeforeRewrite, "id was rewritten");
    assert.match(out[ 0 ].id, new RegExp("^" + scenario.expected.rewrittenIdPrefix), "rewritten id has the expected prefix");
  });

  test("poisoned_rollout_fixture_repairs_every_non_conforming_item", () => {
    const scenario = contract.normalizeInputItemIds.poisoned_rollout_fixture_repairs_every_non_conforming_item;
    const expected = scenario.expected;
    assert.equal(POISONED_FIXTURE.items.length, expected.itemCount, "fixture item count is pinned");
    const poisoned = POISONED_FIXTURE.items.filter((item: any) => !ITEM_CONFORMS(item));
    assert.equal(poisoned.length, expected.nonConformingBeforeRepair, "non-conforming count before repair");

    const { input: rawInput, changed } = normalizeInputItemIds(POISONED_FIXTURE.items);
    const input = rawInput as any[];
    assert.equal(changed, expected.changed, "changed count matches pinned value");
    const still = input.filter((item: any) => !ITEM_CONFORMS(item));
    assert.equal(still.length, expected.nonConformingAfterRepair, "no item is left violating the contract");
    assert.equal(input.length, expected.itemCount, "output length matches input length");

    assert.equal(input[ 18 ].type, expected.index18Type, "items[18] type after repair");
    assert.equal(input[ 18 ].id, expected.index18NewId, "items[18] new id matches pinned deterministic hash");

    // The upstream reported `input[18].id` as the violating field.
    assert.equal(POISONED_FIXTURE.upstreamError.param, expected.upstreamErrorParam, "upstream error points at item-id field");
    assert.equal(ITEM_CONFORMS(POISONED_FIXTURE.items[ 18 ]), false, "items[18] is non-conforming -- the upstream was right to reject it");

    const wireCalls = input.filter((i: any) => i.type === "custom_tool_call");
    const wireOutputs = input.filter((i: any) => i.type === "custom_tool_call_output");
    assert.equal(wireCalls.length, expected.toolCallCount, "13 custom_tool_call items after repair");
    assert.equal(wireOutputs.length, expected.toolOutputCount, "13 custom_tool_call_output items after repair");
    assert.equal(wireCalls.length, expected.customToolCallIdsAfterRepair.length, "pinned ctc ids count");
    assert.deepEqual(wireCalls.map((i: any) => i.id), expected.customToolCallIdsAfterRepair, "every ctc id matches the deterministic hash");
    assert.deepEqual(wireCalls.map((i: any) => i.call_id), expected.expectedCallIds, "call_id preserved across ctc ids");
    assert.deepEqual(wireOutputs.map((i: any) => i.call_id), POISONED_FIXTURE.items.filter((i: any) => i.type === "custom_tool_call_output").map((i: any) => i.call_id), "tool outputs preserve call_id exactly");

    // The four genuine reasoning items survive without id rewriting or drop.
    const { input: rawResolvable, dropped } = dropUnresolvableReasoning(input);
    const resolvable = rawResolvable as any[];
    assert.equal(dropped, 0, "no reasoning items dropped on the poisoned fixture");
    assert.equal(resolvable.filter((i: any) => i.type === "reasoning").length, expected.reasoningCount, "reasoning items survive repair");
  });
});

describe("dropUnresolvableReasoning branches", () => {
  test("drops_reasoning_items_lacking_encrypted_content", () => {
    const scenario = contract.dropUnresolvableReasoning.drops_reasoning_items_lacking_encrypted_content;
    const { input: rawOut, dropped } = dropUnresolvableReasoning(scenario.input);
    const out = rawOut as any[];
    assert.equal(dropped, scenario.expected.dropped, "dropped count");
    assert.equal(out.length, scenario.expected.length, "kept length");
    assert.deepEqual(out.map((i: any) => i.id ?? null), scenario.expected.ids, "kept ids");
  });

  test("preserves_inputs_with_only_valid_encrypted_reasoning_or_no_reasoning", () => {
    const scenario = contract.dropUnresolvableReasoning.preserves_inputs_with_only_valid_encrypted_reasoning_or_no_reasoning;
    const { input: rawOut, dropped } = dropUnresolvableReasoning(scenario.input);
    const out = rawOut as any[];
    assert.equal(dropped, scenario.expected.dropped, "dropped count");
    assert.equal(out, scenario.input, "array reference preserved on no-op");
    assert.deepEqual(out.map((i: any) => i.id ?? null), scenario.expected.ids, "ids preserved");
  });

  test("non_array_inputs_are_passed_through_untouched", () => {
    const scenario = contract.dropUnresolvableReasoning.non_array_inputs_are_passed_through_untouched;
    const jsonCases = scenario.input;
    const expected = scenario.expected;
    assert.equal(jsonCases.length, expected.length, "json-pass-through length alignment");
    for (let i = 0; i < jsonCases.length; i += 1) {
      assert.deepEqual(dropUnresolvableReasoning(jsonCases[ i ]), expected[ i ], `case[${i}]`);
    }
    assert.deepEqual(dropUnresolvableReasoning(undefined), { input: undefined, dropped: 0 }, "undefined host primitive");
  });

  test("non_string_encrypted_content_also_drops_the_reasoning_item", () => {
    const scenario = contract.dropUnresolvableReasoning.non_string_encrypted_content_also_drops_the_reasoning_item;
    const { input: rawOut, dropped } = dropUnresolvableReasoning(scenario.input);
    const out = rawOut as any[];
    assert.equal(dropped, scenario.expected.dropped, "dropped count");
    assert.equal(out.length, scenario.expected.length, "kept length");
    assert.deepEqual(out.map((i: any) => i.id ?? null), scenario.expected.ids, "kept ids");
  });
});
