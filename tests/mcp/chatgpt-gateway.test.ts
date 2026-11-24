import assert from "node:assert/strict";
import test from "node:test";

import {
  allowedTool,
  defaultGatewayPolicy,
  downstreamEnv,
  gatewayToolName,
  parseGatewayPolicy
} from "../../runtime/src/mcp/chatgpt-gateway.ts";

test("ChatGPT filesystem policy is read-only and cannot be widened", () => {
  assert.equal(allowedTool(defaultGatewayPolicy, "filesystem", "read_text_file"), true);
  assert.equal(allowedTool(defaultGatewayPolicy, "filesystem", "write_file"), false);
  assert.throws(() => parseGatewayPolicy({ filesystem: ["*"] }), /read-only/);
  assert.throws(() => parseGatewayPolicy({ filesystem: ["write_file"] }), /read-only/);
  assert.throws(() => parseGatewayPolicy({ shell: ["*"] }), /Unknown/);
  assert.throws(() => parseGatewayPolicy({ playwright: [] }), /allowlist/);
});

test("separate server policies and deterministic names prevent ambiguous dispatch", () => {
  const policy = parseGatewayPolicy({ playwright: ["browser_snapshot"], codegraphcontext: ["*"] });
  assert.equal(allowedTool(policy, "playwright", "browser_snapshot"), true);
  assert.equal(allowedTool(policy, "playwright", "browser_evaluate"), false);
  assert.equal(allowedTool(policy, "filesystem", "read_text_file"), false);
  assert.equal(allowedTool(policy, "codegraphcontext", "query"), true);
  assert.equal(gatewayToolName("cocoindex-code", "search"), "cocoindex_code__search");
  assert.throws(() => gatewayToolName("filesystem", "x".repeat(64)), /Unsupported/);
});

test("downstream processes never receive tunnel or unrelated provider credentials", () => {
  const env = downstreamEnv({
    HOME: "/home/test",
    PATH: "/bin",
    CONTROL_PLANE_API_KEY: "secret",
    OPENAI_ADMIN_KEY: "secret",
    OPENAI_API_KEY: "secret",
    AUTODEV_MCP_READ_ONLY: "0",
    AUTODEV_MCP_WORKSPACE: "/wrong"
  }, "/project");
  assert.deepEqual(env, {
    AUTODEV_MCP_WORKSPACE: "/project",
    AUTODEV_MCP_READ_ONLY: "1",
    HOME: "/home/test",
    PATH: "/bin"
  });
});
