import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_TOOLS_SCHEMA_ID,
  controlApiToolsResponseSchema,
  isControlApiToolsResponse
} from "../src/control-api/tools.ts";

/**
The Tools catalogue contract.

The Runtime produces this response and the Console reads it. The Console used
to hold the contract as two hand-written guards; one schema, owned by Core,
now answers for both sides -- so these tests are the contract.
*/
const ROW = {
  name: "search_code",
  source: "mcp",
  sourceAuthority: "rulesync-mcp",
  server: "codegraph",
  exposedRoles: ["coder", "reviewer"],
  availability: "configured"
};

function response(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema: CONTROL_API_TOOLS_SCHEMA_ID,
    source: ".rulesync/mcp.jsonc",
    readOnly: true,
    coverage: "complete",
    validity: "valid",
    executionContractObserved: true,
    totalTools: 1,
    tools: [ROW],
    usageLink: "/usage",
    ...overrides
  };
}

function withoutKey(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function isAccepted(value: unknown): boolean {
  const accepted = controlApiToolsResponseSchema.safeParse(value).success;
  assert.equal(isControlApiToolsResponse(value), accepted);
  return accepted;
}

test("a complete catalogue is accepted", () => {
  assert.equal(isAccepted(response()), true);
});

test("an unobserved catalogue with no tools and no count is accepted", () => {
  assert.equal(
    isAccepted(
      response({
        coverage: "unknown",
        validity: "not-observed",
        executionContractObserved: false,
        totalTools: null,
        tools: []
      })
    ),
    true
  );
});

test("a row keeps the members the schema does not check", () => {
  const row = {
    ...ROW,
    description: "Search the code graph.",
    canonicalEditSurface: { section: "mcps", identifier: "codegraph" },
    usage: { calls: null, errors: null, observed: false }
  };
  const parsed = controlApiToolsResponseSchema.parse(
    response({ tools: [row] })
  );
  assert.deepEqual(parsed.tools[0], row);
});

test("a response under another schema id is refused", () => {
  assert.equal(
    isAccepted(response({ schema: "autodev-control-tools-v1" })),
    false
  );
});

test("an envelope with an unknown coverage or validity is refused", () => {
  assert.equal(isAccepted(response({ coverage: "full" })), false);
  assert.equal(isAccepted(response({ validity: "observed" })), false);
});

test("an envelope missing a member the reader depends on is refused", () => {
  for (const key of [
    "source",
    "readOnly",
    "executionContractObserved",
    "totalTools",
    "tools",
    "usageLink"
  ]) {
    const envelope = withoutKey(response(), key);
    assert.equal(isAccepted(envelope), false, key);
  }
});

test("a count that is not a number or null is refused", () => {
  assert.equal(isAccepted(response({ totalTools: "1" })), false);
});

test("a row missing a member the views read is refused", () => {
  for (const key of [
    "name",
    "source",
    "sourceAuthority",
    "exposedRoles",
    "availability"
  ]) {
    const row = withoutKey(ROW, key);
    assert.equal(isAccepted(response({ tools: [row] })), false, key);
  }
});

test("a row whose role exposure is not a list of names is refused", () => {
  assert.equal(
    isAccepted(response({ tools: [{ ...ROW, exposedRoles: "coder" }] })),
    false
  );
  assert.equal(
    isAccepted(response({ tools: [{ ...ROW, exposedRoles: [1] }] })),
    false
  );
});

test("a catalogue that is not a list of rows is refused", () => {
  assert.equal(isAccepted(response({ tools: [null] })), false);
  assert.equal(isAccepted(response({ tools: {} })), false);
});

test("a catalogue that claims to be writable is refused", () => {
  assert.equal(isAccepted(response({ readOnly: false })), false);
});
