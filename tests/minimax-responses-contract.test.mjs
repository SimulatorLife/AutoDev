import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  coerceResponseBody,
  flattenOutboundTools,
  freeformInputFromArguments,
  isWebResearchTool,
  rewrite,
} from "../scripts/codex-minimax-responses-proxy.mjs";

const contract = await import("../tests/fixtures/contracts/minimax-responses-contract.json", { with: { type: "json" } }).then((m) => m.default ?? m);

assert.equal(contract.schema, "autodev-minimax-responses-contract-v1", "MiniMax boundary contract must match its schema tag");

describe("MiniMax boundary contract", () => {
  describe("normal_stream_flatten", () => {
    const entry = contract.cases.normal_stream_flatten;

    test("rewrite re-expands response output tool namespaces", () => {
      const rewritten = rewrite(entry.upstreamResponse);
      assert.equal(rewritten.output[0].namespace, "multi_agent_v1");
      assert.equal(rewritten.output[0].name, "spawn_agent");
    });

    test("flattenOutboundTools rewrites the request tools into the upstream shape", () => {
      const flattened = flattenOutboundTools(entry.request.tools ?? []);
      assert.deepEqual(flattened, entry.expected.proxyRequestTools);
    });

    test("isWebResearchTool keeps Codex-native web research tools untouched", () => {
      for (const tool of [{ type: "web_search" }, { name: "web_fetch" }]) {
        assert.equal(isWebResearchTool(tool), true);
      }
      assert.equal(isWebResearchTool({ type: "function", name: "read_file" }), false);
    });
  });

  describe("freeform_coercion_non_streaming", () => {
    const entry = contract.cases.freeform_coercion_non_streaming;
    const freeformNames = new Set(["exec"]);

    test("coerceResponseBody rewrites a freeform function_call into a custom_tool_call", () => {
      const coerced = coerceResponseBody(entry.upstreamResponse, freeformNames);
      const rewritten = coerced.response.output[0];
      assert.equal(rewritten.type, entry.expected.coercedType);
      assert.match(rewritten.input, new RegExp(entry.expected.inputSource.startsWith.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(rewritten.input, new RegExp(entry.expected.inputSource.mentions.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });

    test("freeformInputFromArguments unwraps an exec_command-shaped payload directly", () => {
      const source = freeformInputFromArguments('{"cmd":"wc -l README.md"}');
      assert.match(source ?? "", /await tools\.exec_command\(/);
      assert.match(source ?? "", /wc -l README\.md/);
    });

    test("freeformInputFromArguments returns a raw script unchanged", () => {
      const source = freeformInputFromArguments("node -e 'console.log(1)'");
      assert.equal(source, "node -e 'console.log(1)'");
    });
  });

  describe("web_search_preserved", () => {
    const entry = contract.cases.web_search_preserved;

    test("web research tools survive flattening unchanged", () => {
      const flattened = flattenOutboundTools(entry.request.tools ?? []);
      assert.deepEqual(flattened, entry.expected.proxyRequestTools);
    });
  });
});
