import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENT_EVENTS_URL_HEADER,
  REQUEST_ID_HEADER,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  resolveAgentEventReporter,
} from "../scripts/codex/lib/agent-events.mjs";
import { agyArgs, modelEffort, resolveEffort, resolveModel } from "../scripts/codex-antigravity-cli-responses-proxy.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const routerHeaders = {
  [ AGENT_EVENTS_URL_HEADER ]: "http://127.0.0.1:4100/v1/agent-events",
  [ REQUEST_ID_HEADER ]: "request-1",
  [ SUBAGENT_SPAWN_TOOLS_HEADER ]: "invoke_subagent,Agent",
};

test("a bridge reports spawns only when the router asked it to", () => {
  const reporter = resolveAgentEventReporter(routerHeaders);
  assert.ok(reporter);
  assert.equal(reporter.isSpawnTool("invoke_subagent"), true);
  assert.equal(reporter.isSpawnTool("Agent"), true);
  // `manage_subagents` lists and stops existing children; it is not a spawn.
  assert.equal(reporter.isSpawnTool("manage_subagents"), false);
  assert.equal(reporter.isSpawnTool("run_command"), false);
  assert.equal(reporter.isSpawnTool(undefined), false);

  // Header casing survives LiteLLM and other intermediaries.
  assert.ok(resolveAgentEventReporter({
    "X-Autodev-Agent-Events-Url": routerHeaders[ AGENT_EVENTS_URL_HEADER ],
    "X-Autodev-Request-Id": "request-1",
    "X-Autodev-Subagent-Spawn-Tools": "Agent,Task",
  }));

  // A provider with no spawn tools, or a caller that is not the router, gets
  // no reporter at all rather than a reporter that posts nowhere.
  assert.equal(resolveAgentEventReporter({}), null);
  assert.equal(resolveAgentEventReporter(null), null);
  for (const missing of [ AGENT_EVENTS_URL_HEADER, REQUEST_ID_HEADER, SUBAGENT_SPAWN_TOOLS_HEADER ]) {
    const partial = { ...routerHeaders };
    delete partial[ missing ];
    assert.equal(resolveAgentEventReporter(partial), null, `missing ${missing} must disable reporting`);
  }
  assert.equal(resolveAgentEventReporter({ ...routerHeaders, [ SUBAGENT_SPAWN_TOOLS_HEADER ]: " , " }), null);
});

test("a reported spawn names the request that authorizes it", async () => {
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const reporter = resolveAgentEventReporter({
      ...routerHeaders,
      [ AGENT_EVENTS_URL_HEADER ]: `http://127.0.0.1:${server.address().port}/v1/agent-events`,
    });
    await reporter.reportSpawn({ tool: "invoke_subagent", role: "explorer" });
    assert.deepEqual(received, [ {
      requestId: "request-1",
      events: [ { type: "subagent_spawn", tool: "invoke_subagent", role: "explorer", status: "started", count: 1 } ],
    } ]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a failed report costs a count, never the model turn", async () => {
  // Nothing is listening on this port; the reporter must resolve anyway.
  const reporter = resolveAgentEventReporter({ ...routerHeaders, [ AGENT_EVENTS_URL_HEADER ]: "http://127.0.0.1:1/v1/agent-events" });
  await reporter.reportSpawn({ tool: "invoke_subagent" });
});

test("the Antigravity bridge never hands agy a model and effort that conflict", () => {
  // agy encodes reasoning depth in the model id and rejects the whole
  // invocation when a separate --effort disagrees with it:
  //   invalid model selection (--model "gemini-3.8-flash-high" --effort "medium")
  // The router picks the model per tier and the caller's effort independently,
  // so the two routinely disagree. The model id wins and --effort is dropped.
  assert.equal(modelEffort("gemini-3.8-flash-high"), "high");
  assert.equal(modelEffort("gemini-3.8-flash-medium"), "medium");
  assert.equal(modelEffort("gemini-3.8-flash-low"), "low");
  assert.equal(modelEffort("claude-sonnet-4-6"), null, "a model id that fixes no effort");

  for (const effort of [ "low", "medium", "high" ]) {
    const args = agyArgs("task", "gemini-3.8-flash-high", effort);
    assert.equal(args.includes("--effort"), false, `--effort ${effort} must not accompany a model that fixes one`);
    assert.deepEqual(args.slice(0, 4), [ "-p", "task", "--model", "gemini-3.8-flash-high" ]);
  }

  // A model id that fixes no effort still receives the caller's.
  const unsuffixed = agyArgs("task", "claude-sonnet-4-6", "high");
  assert.equal(unsuffixed[ unsuffixed.indexOf("--effort") + 1 ], "high");

  // Unknown/empty models and efforts collapse to the bridge defaults rather
  // than reaching the CLI as arbitrary text.
  assert.equal(resolveModel("antigravity-subscription"), "gemini-3.8-flash-medium");
  assert.equal(resolveModel("not a model id"), "gemini-3.8-flash-medium");
  assert.equal(resolveEffort({ reasoning: { effort: "xhigh" } }), "high");
  assert.equal(resolveEffort({}), "medium");
});

test("the Antigravity bridge reports the subagents its own CLI spawns", () => {
  const source = read("scripts/codex-antigravity-cli-responses-proxy.mjs");
  // Reached only from inside handle(), so this stays a source assertion.
  assert.match(source, /from "\.\/codex\/lib\/agent-events\.mjs"/);
  assert.match(source, /resolveAgentEventReporter\(request\.headers\)/);
  assert.match(source, /agentEvents\.reportSpawn\(/);
});

test("the Claude bridge reports the spawns its Agent tool makes in-process", () => {
  const source = read("scripts/codex-claude-cli-responses-proxy.py");
  assert.match(source, /class AgentEventReporter/);
  assert.match(source, /resolve_agent_event_reporter\(self\.headers\)/);
  assert.match(source, /report_spawn_async\(/);
  // Claude streams tool arguments as input_json_delta after the block opens,
  // so the child agent type is only known once the block closes.
  assert.match(source, /class ToolUseAccumulator/);
  assert.match(source, /input_json_delta/);
  assert.match(source, /subagent_role_from_input\(block\)/);
  // The three header names must match the shared JS module byte for byte, or
  // the router's headers land in a bridge that ignores them.
  for (const [ name, value ] of [
    [ "REQUEST_ID_HEADER", REQUEST_ID_HEADER ],
    [ "SUBAGENT_SPAWN_TOOLS_HEADER", SUBAGENT_SPAWN_TOOLS_HEADER ],
    [ "AGENT_EVENTS_URL_HEADER", AGENT_EVENTS_URL_HEADER ],
  ]) {
    assert.match(source, new RegExp(`${name} = "${value}"`), name);
  }
  // The orchestrator keeps the Agent tool; every leaf role still loses it.
  assert.match(source, /DISALLOWED_CLAUDE_TOOLS = \("Agent", "Task"\)/);
  assert.match(source, /subagent_boundary = \[\] if orchestrator else \[ ?"--disallowed-tools"/);
});

test("the installer ships the reporting module the bridges import at runtime", () => {
  assert.match(read("scripts/codex/install-codex-integration.sh"), /scripts\/codex\/lib\/agent-events\.mjs/);
});
