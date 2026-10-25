import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTODEV_MCP_SERVER_ALIASES,
  AUTODEV_SKILL_ALIASES
} from "../src/router/otel-attributes.ts";
import {
  toolKey,
  toolNameAttribute,
  toolServerAttribute
} from "../src/router/usage.ts";

/**
 * The names a server and a tool are recorded under.
 *
 * These are read from the telemetry as it arrives, so the names have to be the
 * names the telemetry uses. A span whose server cannot be named is a span
 * that belongs to no server: the call is counted, and the Console shows the
 * MCP as unused.
 */

test("a server named the way the Runtime's MCP client names it is found", () => {
  // The Runtime's own MCP client writes `mcp.server.name`, and it is the
  // attribute its tool-call spans carry. Reading only `server`/`mcp_server`
  // found nothing there, and every one of those calls was counted against no
  // server at all.
  assert.equal(
    toolServerAttribute({ "mcp.server.name": "playwright" }),
    "playwright"
  );
  assert.equal(
    toolServerAttribute({ "mcp.connector.name": "cocoindex-code" }),
    "cocoindex-code"
  );
});

test("a server named the way the tool-call metric names it is found", () => {
  assert.equal(toolServerAttribute({ server: "lsp" }), "lsp");
  assert.equal(toolServerAttribute({ mcp_server: "lsp" }), "lsp");
  assert.equal(toolServerAttribute({ server_name: "lsp" }), "lsp");
  assert.equal(toolServerAttribute({ serverName: "lsp" }), "lsp");
});

test("a call with no server in it belongs to no server", () => {
  assert.equal(toolServerAttribute({}), "");
  assert.equal(toolServerAttribute({ "mcp.server.name": "  " }), "");
});

test("a tool named the way the tool-call metric names it is found", () => {
  // `tool.name` and `gen_ai.tool.name` are the names the metrics carry. A
  // call whose tool cannot be named is counted as "unknown-tool", which is a
  // tool nobody has heard of.
  assert.equal(toolNameAttribute({ "tool.name": "search" }), "search");
  assert.equal(toolNameAttribute({ "gen_ai.tool.name": "search" }), "search");
  assert.equal(toolNameAttribute({ tool: "search" }), "search");
  assert.equal(toolNameAttribute({ tool_name: "search" }), "search");
});

test("a call with no tool in it is an unknown tool", () => {
  assert.equal(toolNameAttribute({}), "unknown-tool");
});

test("the tool key separates two calls of the same tool on different servers", () => {
  const first = toolKey({
    tool_name: "search",
    "mcp.server.name": "cocoindex-code"
  });
  const second = toolKey({
    tool_name: "search",
    "mcp.server.name": "other"
  });
  assert.notEqual(
    first,
    second,
    "two servers offering the same tool are two different tools in use"
  );
});

test("the alias lists name the attributes the telemetry carries", () => {
  assert.equal(
    AUTODEV_MCP_SERVER_ALIASES.includes("mcp.server.name"),
    true,
    "the Runtime's MCP client names the server this way"
  );
  assert.equal(AUTODEV_MCP_SERVER_ALIASES.includes("mcp.connector.name"), true);
  assert.equal(AUTODEV_SKILL_ALIASES.includes("skill"), true);
  assert.equal(AUTODEV_SKILL_ALIASES.includes("skill.name"), true);
});
