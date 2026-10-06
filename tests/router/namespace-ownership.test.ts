import assert from "node:assert/strict";
import test from "node:test";

import * as responses from "@simulatorlife/autodev-runtime/router/responses";
import {
  MULTI_AGENT_CLOSE_TOOL,
  MULTI_AGENT_NAMESPACE,
  MULTI_AGENT_SPAWN_TOOL,
  MULTI_AGENT_WAIT_TOOL,
  multiAgentToolName
} from "@simulatorlife/autodev-runtime/shared/tool-names";

// The router recognizes a flat `namespace__name` in a model response and splits
// it back into the `namespace`/`name` pair the provider expects. Which prefixes
// it recognizes used to be an exported table in router/responses.ts that hardcoded
// the versioned `multi_agent_v1` namespace as a string literal, duplicating
// `shared/tool-names.ts` -- the module that documents itself as the one owner of
// canonical AutoDev tool names, and that calls that namespace versioned.
//
// These tests pin the ownership: the router's recognized multi-agent prefix is
// derived from the shared constant, and every family it recognizes round-trips.
// A version bump in tool-names.ts must move the router with it.

const MULTI_AGENT_TOOLS = [
  MULTI_AGENT_SPAWN_TOOL,
  MULTI_AGENT_WAIT_TOOL,
  MULTI_AGENT_CLOSE_TOOL
];

/** The rewriters return `unknown`; every assertion here is about a record. */
function record(value: unknown, context: string): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${context} must rewrite to a record, got ${JSON.stringify(value)}`
  );
  return value as Record<string, unknown>;
}

function split(name: string): Record<string, unknown> {
  return record(
    responses.rewriteToolNamespaces({ type: "function_call", name }),
    `un-flattening ${name}`
  );
}

test("the router splits the multi-agent family using the shared namespace owner", () => {
  const prefix = `${MULTI_AGENT_NAMESPACE}__`;
  for (const tool of MULTI_AGENT_TOOLS) {
    const result = split(tool);
    assert.equal(result.namespace, MULTI_AGENT_NAMESPACE);
    assert.equal(result.name, tool.slice(prefix.length));
    assert.equal(
      `${result.namespace}__${result.name}`,
      tool,
      "the split must rebuild the name it was given"
    );
  }
});

test("the recognized multi-agent prefix is the shared owner's, not a local literal", () => {
  // If someone bumps MULTI_AGENT_NAMESPACE in tool-names.ts while the router
  // still recognized the old literal, every new tool name would pass through
  // unsplit. Building a fresh name from the owner must therefore always split.
  for (const suffix of [
    "spawn_agent",
    "wait_agent",
    "a_suffix_it_does_not_know"
  ]) {
    const result = split(multiAgentToolName(suffix));
    assert.equal(result.namespace, MULTI_AGENT_NAMESPACE);
    assert.equal(result.name, suffix);
  }
});

test("an already-namespaced name is not split twice", () => {
  const result = record(
    responses.rewriteToolNamespaces({
      type: "function_call",
      name: "read_file",
      namespace: MULTI_AGENT_NAMESPACE
    }),
    "an already-namespaced call"
  );
  assert.equal(result.name, "read_file");
  assert.equal(result.namespace, MULTI_AGENT_NAMESPACE);
});

test("every namespace the router flattens is one it can un-flatten", () => {
  // The flatten side has a generic `${namespace}__` fallback, so a namespace the
  // router could emit but not recognize would produce a response name it then
  // silently declined to split back. Round-trip the families it recognizes.
  for (const namespace of [MULTI_AGENT_NAMESPACE, "collaboration", "agents"]) {
    const flat = record(
      responses.flattenOutboundTool({
        type: "function",
        namespace,
        name: "do_thing"
      }),
      `flattening the ${namespace} family`
    );
    assert.equal(flat.name, `${namespace}__do_thing`);
    const result = split(String(flat.name));
    assert.equal(
      result.namespace,
      namespace,
      `${namespace}__do_thing must un-flatten back to ${namespace}`
    );
    assert.equal(result.name, "do_thing");
  }
});

test("a double underscore outside the recognized families is left alone", () => {
  // The table is an allowlist, not a rule: a provider's own tool may contain a
  // double underscore, and splitting it would invent a namespace that was never
  // there.
  for (const name of ["my_tool__thing", "weird__name", "a__b__c"]) {
    const result = split(name);
    assert.equal(result.name, name);
    assert.equal(result.namespace, undefined);
  }
});
