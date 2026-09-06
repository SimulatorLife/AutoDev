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
import { agyArgs, modelEffort, resolveEffort, resolveModel, spawnedChildren, subagentModel } from "../scripts/codex-antigravity-cli-responses-proxy.mjs";

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
      events: [ { type: "subagent_spawn", tool: "invoke_subagent", role: "explorer", status: "started", count: 1, children: [ { id: "c1" } ] } ],
    } ]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("a batch of children is reported as a batch, grouped by role", async () => {
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
    // One `invoke_subagent` call, four children, two roles: the router must see
    // four spawns, not one, and must be able to tell the roles apart.
    await reporter.reportSpawns({
      tool: "invoke_subagent",
      children: [ { id: "s3.0", role: "explorer" }, { id: "s3.1", role: "explorer", model: "gemini-3.8-flash-high" }, { id: "s3.2", role: "validator" }, { id: "s3.3", role: null } ],
    });
    assert.deepEqual(received.at(-1), {
      requestId: "request-1",
      events: [
        { type: "subagent_spawn", tool: "invoke_subagent", role: "explorer", status: "started", count: 2, children: [ { id: "s3.0" }, { id: "s3.1", model: "gemini-3.8-flash-high" } ] },
        { type: "subagent_spawn", tool: "invoke_subagent", role: "validator", status: "started", count: 1, children: [ { id: "s3.2" } ] },
        { type: "subagent_spawn", tool: "invoke_subagent", role: null, status: "started", count: 1, children: [ { id: "s3.3" } ] },
      ],
    });

    // The close names the same children the open did, which is what lets the
    // router measure each child's own turn instead of the whole parent turn.
    await reporter.reportResults({
      tool: "invoke_subagent",
      children: [ { id: "s3.0", role: "explorer" }, { id: "s3.2", role: "validator" } ],
      outcome: "success",
      durationMs: 41230,
    });
    assert.deepEqual(received.at(-1).events, [
      { type: "subagent_result", tool: "invoke_subagent", role: "explorer", status: "success", count: 1, children: [ { id: "s3.0" } ], outcome: "success", durationMs: 41230 },
      { type: "subagent_result", tool: "invoke_subagent", role: "validator", status: "success", count: 1, children: [ { id: "s3.2" } ], outcome: "success", durationMs: 41230 },
    ]);

    // No children at all still reports the call, so a CLI that stops exporting
    // its tool arguments degrades to the old count rather than to silence. The
    // router still gets an id, so even that child can be closed individually.
    await reporter.reportSpawns({ tool: "invoke_subagent", children: [] });
    const [ degraded ] = received.at(-1).events;
    assert.equal(degraded.count, 1);
    assert.equal(degraded.role, null);
    assert.equal(degraded.children.length, 1);
    assert.match(degraded.children[ 0 ].id, /^c\d+$/, "a caller with no id of its own is given one");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the Antigravity bridge counts every child in an invoke_subagent batch", () => {
  // The shape agy recorded for the delegation that started this: the batch is
  // an array under `Subagents`, one entry per child.
  const batch = {
    step_index: 3,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "invoke_subagent",
    tool_info: {
      name: "invoke_subagent",
      args: JSON.stringify({
        Subagents: [
          { TypeName: "explorer", Model: "inherit", Prompt: "You are an explorer agent investigating build issues" },
          { TypeName: "explorer", Model: "inherit", Prompt: "Catalog the lint failures" },
          { TypeName: "validator", Model: "inherit", Prompt: "Re-run the suites" },
        ],
      }),
    },
  };
  // Each child is addressable, so its own turn can be opened and closed rather
  // than measured against the whole parent turn.
  assert.deepEqual(spawnedChildren(batch), [
    { id: "s3.0", role: "explorer", model: "inherit" },
    { id: "s3.1", role: "explorer", model: "inherit" },
    { id: "s3.2", role: "validator", model: "inherit" },
  ]);
  // `inherit` is agy naming the parent's model, not choosing one; resolving
  // that is the router's job, so the bridge reports what the step said.
  assert.equal(subagentModel({ Model: "gemini-3.8-flash-high" }), "gemini-3.8-flash-high");
  assert.equal(subagentModel({ TypeName: "explorer" }), null);

  // agy has carried the arguments as a nested object and at other paths across
  // versions, so the batch is found by shape rather than by one pinned path.
  assert.deepEqual(
    spawnedChildren({ tool_name: "invoke_subagent", tool_info: { args: { Subagents: [ { TypeName: "worker" } ] } } }).map(({ role, model }) => ({ role, model })),
    [ { role: "worker", model: null } ],
  );
  assert.deepEqual(
    spawnedChildren({ tool_name: "invoke_subagent", tool_input: '{"subagents":[{"name":"docs-researcher"},{}]}' }).map(({ role }) => ({ role })),
    [ { role: "docs-researcher" }, { role: null } ],
  );

  // A child that names only a model names no role: `byRole` must not fill up
  // with model ids.
  assert.deepEqual(spawnedChildren({ tool_info: { args: { Subagents: [ { Model: "inherit" } ] } } }).map(({ role }) => role), [ null ]);

  // `self` is agy's back-reference to the caller's own archetype, not the name
  // of one. Recorded verbatim it becomes a `self` row sitting beside real roles
  // in `byRole` as though it were one, and every self-dispatched child collapses
  // under a label that describes nothing. It declares no archetype, which is
  // what the unattributed bucket is for.
  for (const declared of [ "self", "Self", "SELF", " self " ]) {
    assert.deepEqual(
      spawnedChildren({ tool_info: { args: { Subagents: [ { TypeName: declared } ] } } }).map(({ role }) => role),
      [ null ],
      `TypeName ${JSON.stringify(declared)} must not become a role`,
    );
  }
  // A batch mixing the two keeps the one that named an archetype.
  assert.deepEqual(
    spawnedChildren({ tool_info: { args: { Subagents: [ { TypeName: "self" }, { TypeName: "explorer" } ] } } }).map(({ role }) => role),
    [ null, "explorer" ],
  );
  // Only the exact token: a real archetype whose name merely contains it stays.
  assert.deepEqual(
    spawnedChildren({ tool_info: { args: { Subagents: [ { TypeName: "self-review" } ] } } }).map(({ role }) => role),
    [ "self-review" ],
  );

  // A step that exports no arguments is still one spawn, never zero.
  const roleless = [
    { tool_name: "invoke_subagent", state: "ACTIVE" },
    { tool_info: { args: "not json" } },
    { tool_info: { args: { Subagents: [] } } },
    undefined,
    // Free text that happens to mention the tool is not a batch.
    { text_delta: "I will call invoke_subagent with Subagents" },
  ];
  const rolelessIds = new Set();
  for (const update of roleless) {
    const [ child, ...rest ] = spawnedChildren(update);
    assert.equal(rest.length, 0);
    assert.equal(child.role, null);
    // A step with no index still gets a distinct id: keying every one of them
    // the same would let one step's close settle another step's children.
    assert.equal(rolelessIds.has(child.id), false, `duplicate child id ${child.id}`);
    rolelessIds.add(child.id);
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
  assert.match(source, /agentEvents\.reportSpawns\(\{ tool: toolName, children \}\)/);
  // A child's own turn is measured only if the step that opened it is closed,
  // and a run that ends without closing every step must not strand any.
  assert.match(source, /agentEvents\.reportResults\(\{ tool: open\.tool, children: open\.children/);
  assert.match(source, /flushSpawns\("failure"\)/);
  assert.match(source, /flushSpawns\("success"\)/);
  // Only the opening transition is counted, and a step with no index must not
  // key every later spawn out of the count under a shared `undefined`.
  assert.match(source, /Number\.isFinite\(update\.step_index\)/);
});

test("an Antigravity turn that dies names its own cause in the log", () => {
  // 156 of 283 Antigravity turns had failed, every one of them reaching the
  // router as `upstream_error` at HTTP 200 and leaving nothing in the bridge
  // log but the step lines that happened to precede it. The turn logged its
  // start and never its end, so the reason it died was written down nowhere.
  const source = read("scripts/codex-antigravity-cli-responses-proxy.mjs");

  // Every exit from a turn names itself and how long it took.
  assert.match(source, /const logTurnEnd = \(outcome, detail = ""\) =>/);
  assert.match(source, /logTurnEnd\("succeeded"\)/);
  assert.match(source, /logTurnEnd\("failed"/);
  assert.match(source, /logTurnEnd\("aborted"/);

  // The failure that ends long delegating turns is agy stopping without a
  // terminal result. Whether it was killed, exited, or died on a signal is
  // only recoverable from the exit status and stderr, so both travel with the
  // error rather than being discarded into a bare sentence.
  assert.match(source, /agy exited \$\{how\} without a terminal result event/);
  assert.match(source, /const how = signal \? `on \$\{signal\}` : `with code \$\{code\}`/);
  assert.doesNotMatch(source, /new Error\("agy exited without a terminal result event"\)/);

  // A turn that failed because the client had already gone is exactly the case
  // worth seeing, and the streaming path used to return without a word.
  assert.match(source, /if \(!turnSettled\) logTurnEnd\("failed", `\$\{message\}\$\{isWritable\(\) \? "" : " \(client already gone\)"\}`\)/);
  const catchBlock = source.slice(source.lastIndexOf("} catch (error) {"));
  assert.ok(
    catchBlock.indexOf("logTurnEnd(") < catchBlock.indexOf("if (!isWritable()) return;"),
    "the failure must be logged before the writability check returns",
  );

  // The close that always follows a completed stream is not the client hanging
  // up, so only an unsettled turn reports an abort.
  assert.match(source, /let turnSettled = false;/);
  assert.match(source, /turnSettled = true;/);
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
  // A workspace can remove the delegation tool from under an orchestrator turn,
  // so the bridge checks the CLI's own init inventory and reports the absence.
  assert.match(source, /def note_available_tools/);
  assert.match(source, /report_spawn_tools_unavailable_async/);
  assert.match(source, /if any\(agent_events\.is_spawn_tool\(name\) for name in names\)/);
  assert.match(source, /yield \("tools", value\["tools"\], value\)/);
  // Only the orchestrator: a leaf is *supposed* to have no delegation tool.
  assert.match(source, /if agent_events is None or not is_orchestrator_role\(agent_role\):\n\s+return/);

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
  // The orchestrator keeps the delegation tools; every leaf loses them. Both
  // lose the tools that reach another orchestrator's agents, so the boundary is
  // no longer "orchestrator gets no --disallowed-tools at all".
  assert.match(source, /CROSS_SESSION_CLAUDE_TOOLS = \("SendMessage", "ListAgents"\)/);
  assert.match(source, /denied = list\(CROSS_SESSION_CLAUDE_TOOLS\) if orchestrator else \[\*DISALLOWED_CLAUDE_TOOLS, \*CROSS_SESSION_CLAUDE_TOOLS\]/);
  // The behavioural halves of this are pinned in tests/test_local_setup.py
  // (test_no_role_may_reach_another_orchestrators_agents), which builds the
  // real argv rather than reading the source.
});

test("the installer ships the reporting module the bridges import at runtime", () => {
  assert.match(read("scripts/codex/install-codex-integration.sh"), /scripts\/codex\/lib\/agent-events\.mjs/);
});
