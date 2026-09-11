import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

import {
  AGENT_EVENTS_URL_HEADER,
  REQUEST_ID_HEADER,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  resolveAgentEventReporter,
} from "../scripts/codex/lib/agent-events.mjs";
import {
  ANTIGRAVITY_SKILL_EXPOSURE_SOURCE,
  agyArgs,
  agyErrorDetails,
  agyFailureMessage,
  agyPermissionFailure,
  antigravityToolServer,
  createSpawnTracker,
  createToolObserver,
  modelEffort,
  resolveEffort,
  resolveModel,
  spawnedChildren,
  subagentModel,
  toolStepEvidence,
} from "../scripts/codex-antigravity-cli-responses-proxy.mjs";
import {
  copilotToolOutcome,
  SKILL_EXPOSURE_SOURCE as COPILOT_SKILL_EXPOSURE_SOURCE,
} from "../scripts/codex-copilot-cli-responses-proxy.mjs";
import {
  observeResponseEvent,
  reportExecutedToolCalls,
  reportRequestedToolCall,
  toolOutputOutcome as minimaxToolOutputOutcome,
} from "../scripts/codex-minimax-responses-proxy.mjs";

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
      children: [ { id: "s3.0", role: "explorer" }, { id: "s3.1", role: "explorer", model: "gemini-3.8-flash-high", logUri: null }, { id: "s3.2", role: "validator" }, { id: "s3.3", role: null } ],
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
    { id: "s3.0", role: "explorer", model: "inherit", logUri: null },
    { id: "s3.1", role: "explorer", model: "inherit", logUri: null },
    { id: "s3.2", role: "validator", model: "inherit", logUri: null },
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

test("Antigravity permission failures become structured diagnostics", () => {
  const stderr = 'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.';
  assert.deepEqual(agyPermissionFailure(stderr), {
    failureCode: "AGY_PERMISSION_DENIED",
    failurePhase: "tool_permission",
    failureTool: "read_file",
  });
  assert.deepEqual(agyPermissionFailure("ordinary provider stderr"), {});
  assert.deepEqual(agyErrorDetails({
    message: "permission denied",
    failureCode: "AGY_PERMISSION_DENIED",
    failurePhase: "tool_permission",
    failureTool: "read_file",
  }, "explorer", "/workspace"), {
    type: "AGY_PERMISSION_DENIED",
    message: "permission denied",
    provider: "antigravity",
    role: "explorer",
    workspace: "/workspace",
    requestId: null,
    code: "AGY_PERMISSION_DENIED",
    phase: "tool_permission",
    tool: "read_file",
  });

  // The router-generated request id is what lets an AGY_PERMISSION_DENIED
  // failure be correlated back to the router request that produced it,
  // without carrying any prompt text.
  assert.deepEqual(agyErrorDetails({
    message: "permission denied",
    failureCode: "AGY_PERMISSION_DENIED",
    failurePhase: "tool_permission",
    failureTool: "read_file",
  }, "explorer", "/workspace", "req-abc123"), {
    type: "AGY_PERMISSION_DENIED",
    message: "permission denied",
    provider: "antigravity",
    role: "explorer",
    workspace: "/workspace",
    requestId: "req-abc123",
    code: "AGY_PERMISSION_DENIED",
    phase: "tool_permission",
    tool: "read_file",
  });
});

test("the router's request id reaches agyErrorDetails and logTurnEnd without any prompt content", () => {
  // An AGY_PERMISSION_DENIED failure used to surface at the router as a bare
  // `upstream_error`, with nothing in either the error body or the bridge log
  // that could be matched back to the router request that produced it. The
  // request id the router already issues on every request (the same header
  // AgentEventReporter is authorized from) is what closes that gap -- it
  // carries no prompt text, only an id the router itself assigned.
  const source = read("scripts/codex-antigravity-cli-responses-proxy.mjs");
  assert.match(source, /import \{ REQUEST_ID_HEADER, resolveAgentEventReporter \} from "\.\/codex\/lib\/agent-events\.mjs";/);
  assert.match(source, /const requestId = headerValue\(request\.headers, REQUEST_ID_HEADER\);/);
  // Both places agyErrorDetails is called for an upstream failure (the
  // non-streaming 502 path and the stream-not-yet-started 429/503 path) pass
  // it through.
  const errorDetailsCallSites = [ ...source.matchAll(/agyErrorDetails\(error, agentRole, cwd, requestId\)/g) ];
  assert.equal(errorDetailsCallSites.length, 2, "both agyErrorDetails call sites must thread the router request id");
  // logTurnEnd names the request alongside the outcome, so a turn's end can be
  // matched to the router's own log of the same request.
  assert.match(source, /agy turn \$\{outcome\} after \$\{elapsed\(\)\} request=\$\{requestId \?\? "none"\}/);
});

test("Antigravity failures retain terminal status, exit details, and bounded stderr", () => {
  const message = agyFailureMessage({
    status: "ERROR",
    error: "timeout waiting for response",
    stderr: "diagnostic\n".repeat(500),
    code: 1,
  });
  assert.match(message, /status ERROR/);
  assert.match(message, /timeout waiting for response/);
  assert.match(message, /exit code 1/);
  assert.match(message, /stderr:/);
  assert.ok(message.length <= 2100, `failure detail must stay bounded (got ${message.length})`);

  assert.match(agyFailureMessage({ status: "SUCCESS", error: "empty response" }), /empty response/);
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

test("agyArgs sandboxes read-only roles instead of granting them permission bypass", () => {
  // validator/explorer/docs-researcher/browser-tester are readOnly: true in
  // the execution contract. A headless run of one of those roles still needs
  // to get past agy's interactive permission gate -- but --dangerously-skip-permissions
  // (or an operator granting command(*)) would hand it a write escalation its
  // contract never authorizes. agy's own --sandbox flag runs the turn without
  // prompting, inside terminal restrictions, instead of bypassing permissions,
  // so a read-only role gets a headless run without gaining anything a
  // write-capable role has.
  for (const role of [ "validator", "explorer", "docs-researcher", "browser-tester" ]) {
    const args = agyArgs("task", "claude-sonnet-4-6", "high", role);
    assert.ok(args.includes("--sandbox"), `${role} (readOnly) must be sandboxed`);
    assert.equal(args.includes("--dangerously-skip-permissions"), false, `${role} must never receive permission bypass`);
  }

  // Write-capable roles are unaffected: no --sandbox, and their existing
  // AGY_SKIP_PERMISSIONS behavior is unchanged.
  for (const role of [ "default", "orchestrator", "smart", "worker" ]) {
    const args = agyArgs("task", "claude-sonnet-4-6", "high", role);
    assert.equal(args.includes("--sandbox"), false, `${role} (write-capable) must not be sandboxed`);
  }

  // No role at all (null) must not be sandboxed either -- it resolves to the
  // "default" contract, which is write-capable.
  assert.equal(agyArgs("task", "claude-sonnet-4-6", "high", null).includes("--sandbox"), false);
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
  // Both roles lose the tools that reach another orchestrator's agents, so the
  // boundary is not "orchestrator gets no --disallowed-tools at all".
  assert.match(source, /CROSS_SESSION_CLAUDE_TOOLS = \("SendMessage", "ListAgents"\)/);
  // Which delegation tool the orchestrator keeps now depends on whether this
  // turn can reach Codex's own spawner: with the shim in play Claude's `Agent`
  // tool is denied to the orchestrator too, because a child spawned inside this
  // CLI is invisible to Codex and to the app, and leaving `Agent` available
  // would offer a second, worse door. Without a session to hold, `Agent` stays
  // as the fallback.
  assert.match(source, /shim_available = orchestrator and bool\(spawn_session\)/);
  assert.match(source, /if orchestrator and not shim_available:/);
  // The behavioural halves of this are pinned in tests/test_local_setup.py
  // (test_no_role_may_reach_another_orchestrators_agents,
  // test_the_orchestrator_delegates_through_codex_when_it_can, and
  // test_a_leaf_never_gets_the_delegation_shim), which build the real argv
  // rather than reading the source.
});

test("the installer ships the reporting module the bridges import at runtime", () => {
  assert.match(read("scripts/codex/install-codex-integration.sh"), /scripts\/codex\/lib\/agent-events\.mjs/);
});

// The two `invoke_subagent` step_updates agy really emitted for one dispatch,
// captured from `agy -p ... --output-format stream-json`. The turn ran 45s and
// the child genuinely did the work; the dispatch step reports 43ms.
const AGY_INVOKE_SUBAGENT_STEPS = JSON.parse(readFileSync(new URL("./fixtures/agy-invoke-subagent-steps.json", import.meta.url), "utf8"));

function recordingReporter() {
  const spawns = [];
  const results = [];
  return {
    spawns,
    results,
    isSpawnTool: (name) => name === "invoke_subagent",
    reportSpawns: async (event) => { spawns.push(event); },
    reportResults: async (event) => { results.push(event); },
  };
}

test("a dispatch completing is not the child completing", async () => {
  // agy's own numbers: DONE carries duration_seconds 0.043 for a child that ran
  // inside a 45s turn. Closing on that DONE filled the usage tables with ~40ms
  // durations for children that ran for minutes -- a number that looks like a
  // measurement and is not one.
  const [ active, done ] = AGY_INVOKE_SUBAGENT_STEPS;
  assert.equal(active.state, "ACTIVE");
  assert.equal(done.state, "DONE");
  assert.ok(done.duration_seconds < 0.5, "the dispatch step is the hand-off, not the child's work");

  const reporter = recordingReporter();
  const tracker = createSpawnTracker(reporter);
  tracker.observeSpawnStep(active);
  assert.equal(reporter.spawns.length, 1);
  assert.deepEqual(reporter.spawns[ 0 ].children.map(({ role }) => role), [ "research" ]);

  tracker.observeSpawnStep(done);
  assert.equal(reporter.results.length, 0, "a completed dispatch must not close the child it started");
  assert.equal(tracker.openSpawnCount(), 1);

  // The child closes with the turn that contained it, which bounds its runtime
  // honestly: it ran somewhere inside that window.
  tracker.flushSpawns("success");
  assert.equal(reporter.results.length, 1);
  assert.equal(reporter.results[ 0 ].outcome, "success");
  assert.equal(tracker.openSpawnCount(), 0);
});

test("a dispatch that never happened closes immediately as a failure", async () => {
  // Any terminal state other than DONE means the hand-off itself failed. That
  // child was never dispatched, so there is no runtime to bound and nothing to
  // wait for.
  const [ active ] = AGY_INVOKE_SUBAGENT_STEPS;
  for (const state of [ "ERROR", "CANCELLED" ]) {
    const reporter = recordingReporter();
    const tracker = createSpawnTracker(reporter);
    tracker.observeSpawnStep(active);
    tracker.observeSpawnStep({ ...active, state });
    assert.equal(reporter.results.length, 1, state);
    assert.equal(reporter.results[ 0 ].outcome, "failure", state);
    assert.equal(tracker.openSpawnCount(), 0, state);
  }
});

test("one dispatch is reported once however many updates it emits", async () => {
  const [ active, done ] = AGY_INVOKE_SUBAGENT_STEPS;
  const reporter = recordingReporter();
  const tracker = createSpawnTracker(reporter);
  for (const update of [ active, active, done, active ]) tracker.observeSpawnStep(update);
  assert.equal(reporter.spawns.length, 1, "a repeated ACTIVE is the same dispatch, not another one");
  tracker.flushSpawns("success");
  assert.equal(reporter.results.length, 1);
});

test("a tool that is not the spawn tool is ignored entirely", async () => {
  const reporter = recordingReporter();
  const tracker = createSpawnTracker(reporter);
  // `manage_subagents` is how agy tends its children afterwards; it dispatches
  // nothing and must not be counted as a spawn.
  tracker.observeSpawnStep({ step_index: 9, state: "ACTIVE", step_type: "tool", tool_name: "manage_subagents" });
  tracker.observeSpawnStep({ step_index: 9, state: "DONE", step_type: "tool", tool_name: "manage_subagents" });
  assert.equal(reporter.spawns.length, 0);
  assert.equal(reporter.results.length, 0);
});

test("a pending child's telemetry close cannot fire twice", async () => {
  // The request handler's disconnect path and its normal-completion path both
  // can reach flushSpawns for the same turn (a close event racing the
  // response finishing). The Map-delete-on-close in createSpawnTracker is
  // what has to make a second close a no-op instead of a second report.
  const [ active ] = AGY_INVOKE_SUBAGENT_STEPS;
  const reporter = recordingReporter();
  const tracker = createSpawnTracker(reporter);
  tracker.observeSpawnStep(active);
  tracker.flushSpawns("success");
  assert.equal(reporter.results.length, 1);
  assert.equal(tracker.openSpawnCount(), 0);
  tracker.flushSpawns("success");
  assert.equal(reporter.results.length, 1, "closing an already-closed spawn must not report a second time");
});

test("pending-child tracking works even when no AgentEventReporter exists, but reports nothing", async () => {
  // resolveAgentEventReporter returns null whenever the router's telemetry
  // headers are absent (or the caller is not the router). Losing pending-child
  // tracking in that case is exactly what let the bridge kill agy mid-delegation
  // with no explanation, so the tracker must still recognize agy's own spawn
  // tool without a reporter -- while still sending no telemetry anywhere, since
  // nothing authorized a report.
  const [ active, done ] = AGY_INVOKE_SUBAGENT_STEPS;
  const tracker = createSpawnTracker(null);
  tracker.observeSpawnStep(active);
  assert.equal(tracker.openSpawnCount(), 1, "agy's own spawn tool name is recognized without a reporter");
  tracker.observeSpawnStep(done);
  assert.equal(tracker.openSpawnCount(), 1, "DONE still does not close the child without a reporter");
  tracker.flushSpawns("success");
  assert.equal(tracker.openSpawnCount(), 0);

  // A hand-off failure (ERROR/CANCELLED) still closes immediately without a
  // reporter, exactly as it does with one.
  const failed = createSpawnTracker(null);
  failed.observeSpawnStep(active);
  failed.observeSpawnStep({ ...active, state: "ERROR" });
  assert.equal(failed.openSpawnCount(), 0);
});

test("a child is identified by agy's own conversation id, not its position", () => {
  // agy puts a `conversation_id` on every batch entry and repeats it on the
  // DONE step for the same child. Pairing the open with the close by position
  // instead only works while agy emits the batch in the same order both times
  // -- an assumption about its internals, not something it promises -- and a
  // mispairing silently charges one child's duration to another.
  const [ active, done ] = AGY_INVOKE_SUBAGENT_STEPS;
  const opened = spawnedChildren(active);
  const closed = spawnedChildren(done);

  assert.deepEqual(opened, [ {
    id: "b1655ed9-e48d-4f88-9c51-e8fbf1a8b9b1",
    role: "research",
    model: null,
    logUri: "file:///Users/henrykirk/.gemini/antigravity-cli/brain/b1655ed9-e48d-4f88-9c51-e8fbf1a8b9b1/.system_generated/logs/transcript.jsonl",
  } ]);
  // The same child, recognised across both steps by identity.
  assert.equal(closed[ 0 ].id, opened[ 0 ].id);
  // The role is the archetype, not the human-facing "Line Counter" label.
  assert.equal(opened[ 0 ].role, "research");
});

test("a batch entry with no id of its own still gets a stable positional one", () => {
  // Older agy builds, and any entry that omits the field, must keep working.
  const anonymous = { step_index: 7, subagent_info: { subagents: [ { type_name: "explorer" }, { type_name: "worker" } ] } };
  assert.deepEqual(spawnedChildren(anonymous), [
    { id: "s7.0", role: "explorer", model: null, logUri: null },
    { id: "s7.1", role: "worker", model: null, logUri: null },
  ]);
});

test("a known transcript path travels with the child, and its absence costs nothing", () => {
  // A CLI-delegated child leaves no rollout the router can read, so the CLI's
  // own transcript is the only pointer to what it actually did.
  const reporter = resolveAgentEventReporter({
    "x-autodev-agent-events-url": "http://127.0.0.1:1/v1/agent-events",
    "x-autodev-request-id": "req-1",
    "x-autodev-subagent-spawn-tools": "invoke_subagent",
  });
  const [ withUri ] = reporter.childEvents("subagent_spawn", {
    tool: "invoke_subagent",
    children: [ { id: "c1", role: "research", logUri: "file:///tmp/t.jsonl" } ],
    status: "started",
  });
  assert.deepEqual(withUri.children, [ { id: "c1", logUri: "file:///tmp/t.jsonl" } ]);

  const [ without ] = reporter.childEvents("subagent_spawn", {
    tool: "invoke_subagent",
    children: [ { id: "c1", role: "research" } ],
    status: "started",
  });
  assert.deepEqual(without.children, [ { id: "c1" } ]);
});

test("the Antigravity bridge delegates through Codex when the turn can reach it", () => {
  const source = read("scripts/codex-antigravity-cli-responses-proxy.mjs");
  // agy has no per-invocation MCP flag -- its server list is the single global
  // ~/.gemini/config/mcp_config.json -- so the shim cannot be told which turn
  // it belongs to through its arguments. It is told through the environment:
  // agy spawns its MCP servers as its own children and they inherit this.
  assert.match(source, /function agyEnvironment\(spawnSession\)/);
  assert.match(source, /AUTODEV_SPAWN_SESSION: spawnSession \?\? ""/);
  assert.match(source, /env: agyEnvironment\(spawnSession\)/);
  // A leaf turn passes no session, so the handshake finds nothing to attach to.
  assert.match(source, /SpawnSessionRegistry\.canHold\(sessionHeader, sessionScope\)/);
  assert.match(source, /spawnSessions\.open\(spawnSession, \{ orchestrator: isOrchestratorRole\(agentRole\) \}\)/);
  assert.match(source, /recoverParentId: spawnSession/);
  // The collected batch becomes one exec call appended to the turn's output.
  assert.match(source, /buildSpawnScript\(spawnChildren, \{ recoverParentId: spawnSession \}\)/);
  assert.match(source, /execToolCallSseEvents\(/);
  // And the registry never outlives the turn, on any path.
  assert.match(source, /if \(spawnSession\) spawnSessions\.close\(spawnSession\);/);
});

test("agy's own in-CLI spawns are still reported, because they cannot be denied", () => {
  // agy has no --disallowed-tools, so `invoke_subagent` stays available whatever
  // the prompt says and one turn can produce both kinds of child. Dropping the
  // bridge-native reporting would make those children vanish from /status
  // entirely rather than merely being invisible in the app.
  const source = read("scripts/codex-antigravity-cli-responses-proxy.mjs");
  assert.match(source, /createSpawnTracker\(agentEvents\)/);
  assert.match(source, /observeSpawnStep\(event\.step_update \?\? \{\}\)/);
});

test("pending children from the spawn tracker gate the bridge's disconnect kill and heartbeat", () => {
  // invoke_subagent's own step closes (ACTIVE -> DONE) as soon as the
  // hand-off succeeds, long before the children it dispatched finish. If the
  // close/heartbeat decisions look only at that step's activeTool, a
  // disconnect arriving after DONE reads as an ordinary idle turn and kills
  // agy out from under still-running children. These assertions pin the
  // wiring that folds the spawn tracker's openSpawnCount() into the
  // delegation state both decisions read.
  const source = read("scripts/codex-antigravity-cli-responses-proxy.mjs");
  assert.match(source, /pendingChildren: 0,/);
  assert.match(source, /delegation\.pendingChildren = openSpawnCount\(\);/);
  assert.match(source, /function isDelegationActive\(delegation\)/);
  assert.match(source, /return Number\(delegation\.pendingChildren\) > 0;/);
  // Both the close/error decision and the heartbeat gate read that combined
  // signal, not activeTool alone.
  assert.match(source, /if \(isDelegationActive\(delegation\)\) \{/);
  assert.match(source, /if \(!isDelegationActive\(delegation\) \|\| !streamStarted \|\| !isWritable\(\)\) return;/);
  // The heartbeat only stops once the tracker agrees no dispatched child is
  // still open -- not merely because the dispatch step itself closed.
  assert.match(source, /if \(transition\.kind === "exited" && !isDelegationActive\(delegation\)\) stopDelegationHeartbeat\(\);/);

  // Telemetry reporting still requires a router-authorized reporter, but
  // recognizing agy's own spawn tool for lifecycle tracking does not -- that
  // is what keeps the kill decision correct when the router sent no
  // telemetry headers at all.
  assert.match(source, /const ANTIGRAVITY_SPAWN_TOOL_NAMES = new Set\(\[ "invoke_subagent" \]\);/);
  assert.match(source, /function isSpawnToolName\(agentEvents, toolName\) \{/);
  assert.match(source, /if \(agentEvents\) return agentEvents\.isSpawnTool\(toolName\);/);
  assert.match(source, /isSpawnToolName\(agentEvents, name\)/);

  // A child closing deletes it from the tracker's own map, which is what
  // makes closing it a second time (a stray flush on another exit path) a
  // no-op instead of a second telemetry post.
  assert.match(source, /if \(agentEvents\) void agentEvents\.reportResults\(/);
  assert.match(source, /if \(agentEvents\) void agentEvents\.reportSpawns\(/);
});

test("the shim tool is not counted as a bridge-native spawn", () => {
  // A shim spawn becomes an `autodev/<role>` router request, which the router
  // already records as router_alias. Reporting it over /v1/agent-events as well
  // would count the same child twice.
  const contract = JSON.parse(read("scripts/codex/execution-contract.json"));
  for (const [ provider, config ] of Object.entries(contract.providers)) {
    const tools = config.spawnTools ?? [];
    assert.equal(tools.includes("spawn_subagent"), false, `${provider} must not treat the shim tool as an in-CLI spawn`);
  }
});

test("the Antigravity bridge observes and reports tool requests, executions, and denials", async () => {
  const events = [];
  const fakeReporter = {
    reportToolRequested: async (e) => events.push({ type: "tool_requested", ...e }),
    reportToolExecuted: async (e) => events.push({ type: "tool_executed", ...e }),
    reportToolUnavailable: async (e) => events.push({ type: "tool_unavailable", ...e }),
  };

  const { observeToolStep, reportPermissionDenial } = createToolObserver(fakeReporter);

  // 1. ACTIVE step reports tool_requested
  observeToolStep({
    step_index: 1,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "read_file",
    tool_info: { name: "read_file" },
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[ 0 ], { type: "tool_requested", tool: "read_file", callId: "s1", server: null });

  // Repeated ACTIVE does not duplicate
  observeToolStep({
    step_index: 1,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "read_file",
  });
  assert.equal(events.length, 1);

  // 2. DONE step reports tool_executed
  observeToolStep({
    step_index: 1,
    state: "DONE",
    step_type: "tool",
    tool_name: "read_file",
    duration_seconds: 0.125,
  });
  assert.equal(events.length, 2);
  assert.deepEqual(events[ 1 ], { type: "tool_executed", tool: "read_file", callId: "s1", status: "ok", durationMs: 125, server: null });

  // 3. MCP tool extracts server from name or args
  assert.equal(antigravityToolServer(null, "mcp__cocoindex-code__search"), "cocoindex-code");
  assert.equal(antigravityToolServer(null, "mcp_lsp_goto_definition"), "lsp");
  assert.equal(antigravityToolServer({ tool_info: { args: { ServerName: "openaiDeveloperDocs" } } }, "call_mcp_tool"), "openaiDeveloperDocs");

  // 4. Terminal ERROR with output proves execution (status: error)
  observeToolStep({
    step_index: 2,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "mcp__lsp__lsp_diagnostics",
  });
  observeToolStep({
    step_index: 2,
    state: "ERROR",
    step_type: "tool",
    tool_name: "mcp__lsp__lsp_diagnostics",
    tool_info: { output: "failed to connect", duration_seconds: 0.5 },
  });
  assert.equal(events.length, 4);
  assert.deepEqual(events[ 2 ], { type: "tool_requested", tool: "mcp__lsp__lsp_diagnostics", callId: "s2", server: "lsp" });
  assert.deepEqual(events[ 3 ], { type: "tool_executed", tool: "mcp__lsp__lsp_diagnostics", callId: "s2", status: "error", durationMs: 500, server: "lsp" });

  // 5. Denied tool step reports tool_unavailable
  observeToolStep({
    step_index: 3,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "exec_command",
  });
  observeToolStep({
    step_index: 3,
    state: "ERROR",
    step_type: "tool",
    tool_name: "exec_command",
    error: "permission denied for exec_command",
  });
  assert.equal(events.length, 6);
  assert.deepEqual(events[ 4 ], { type: "tool_requested", tool: "exec_command", callId: "s3", server: null });
  assert.deepEqual(events[ 5 ], { type: "tool_unavailable", tool: "exec_command", callId: "s3", reason: "permission_denied", server: null });

  // 6. Permission denial from agy stderr reports tool_unavailable
  reportPermissionDenial({ failureCode: "AGY_PERMISSION_DENIED", failureTool: "read_file" });
  assert.equal(events.length, 7);
  assert.deepEqual(events[ 6 ], { type: "tool_unavailable", tool: "read_file", reason: "permission_denied", server: null });
});

test("the Antigravity bridge reports skill exposure from actual role contract", () => {
  assert.equal(ANTIGRAVITY_SKILL_EXPOSURE_SOURCE, "role_contract");
  const source = read("scripts/codex-antigravity-cli-responses-proxy.mjs");
  assert.match(source, /for \(const skill of bootstrapContract\.skills \?\? \[\]\)/);
  assert.match(source, /agentEvents\.reportSkillExposed\(\{ skill, source: ANTIGRAVITY_SKILL_EXPOSURE_SOURCE \}\)/);
});

test("the Copilot bridge evaluates tool outcomes and reports telemetry", () => {
  // Output present -> executed
  assert.deepEqual(copilotToolOutcome({ output: "done", success: true }), { kind: "executed", status: "ok" });
  assert.deepEqual(copilotToolOutcome({ output: "fail", success: false }), { kind: "executed", status: "error" });
  assert.deepEqual(copilotToolOutcome({ exitCode: 1, output: "error" }), { kind: "executed", status: "error" });

  // Denied / cancelled -> unavailable
  assert.deepEqual(copilotToolOutcome({ permissionDenied: true }), { kind: "unavailable", reason: "denied" });
  assert.deepEqual(copilotToolOutcome({ status: "cancelled" }), { kind: "unavailable", reason: "cancelled" });
  assert.deepEqual(copilotToolOutcome({ status: "rejected by user" }), { kind: "unavailable", reason: "denied" });

  // No output -> none
  assert.deepEqual(copilotToolOutcome({}), { kind: "none" });

  // Source assertions for Copilot bridge telemetry wiring
  const source = read("scripts/codex-copilot-cli-responses-proxy.mjs");
  assert.equal(COPILOT_SKILL_EXPOSURE_SOURCE, "role_contract");
  assert.match(source, /for \(const skill of bootstrapContract\.skills \?\? \[\]\)/);
  assert.match(source, /agentEvents\.reportSkillExposed\(\{ skill, source: SKILL_EXPOSURE_SOURCE \}\)/);
  assert.match(source, /agentEvents\.reportToolRequested\(\{ tool: event\.tool, callId: event\.callId, server: event\.server \}\)/);
  assert.match(source, /agentEvents\.reportToolExecuted\(\{ tool: event\.tool, callId: event\.callId, status: event\.status, durationMs: event\.durationMs, server: event\.server \}\)/);
  assert.match(source, /agentEvents\.reportToolUnavailable\(\{ tool: event\.tool, callId: event\.callId, reason: event\.reason, server: event\.server \}\)/);
});

test("the Claude bridge exposes telemetry API methods and wires tool reporting", () => {
  const source = read("scripts/codex-claude-cli-responses-proxy.py");
  assert.match(source, /reportToolExecuted = report_tool_executed_async/);
  assert.match(source, /reportToolRequested = report_tool_requested_async/);
  assert.match(source, /reportToolUnavailable = report_tool_unavailable_async/);
  assert.match(source, /reportSkillExposed = report_skill_exposed_async/);

  // Skill exposure from role contract
  assert.match(source, /CLAUDE_SKILL_EXPOSURE_SOURCE = "claude_skill_view"/);
  assert.match(source, /for exposed_skill in contract\.get\("skills", \[\]\) or \[\]:/);
  assert.match(source, /agent_events\.report_skill_exposed_async\(exposed_skill, source=CLAUDE_SKILL_EXPOSURE_SOURCE\)/);

  // Tool requested on tool_use, unavailable if not offered
  assert.match(source, /if offered_tools and name not in offered_tools:/);
  assert.match(source, /agent_events\.report_tool_unavailable_async\(name, call_id=call_id, reason="not_offered", server=tool_server\(name\)\)/);
  assert.match(source, /agent_events\.report_tool_requested_async\(name, call_id=call_id, server=tool_server\(name\)\)/);

  // Tool executed or unavailable on tool_result
  assert.match(source, /kind, detail = classify_tool_result\(block\)/);
  assert.match(source, /if kind == "unavailable":/);
  assert.match(source, /agent_events\.report_tool_unavailable_async\(name, call_id=call_id, reason=detail, server=tool_server\(name\)\)/);
  assert.match(source, /agent_events\.report_tool_executed_async\(/);
});

test("the MiniMax proxy reports tool calls requested and executed or unavailable", () => {
  // Outcome classification
  assert.deepEqual(minimaxToolOutputOutcome({ output: JSON.stringify({ result: "done" }) }), { kind: "executed", status: "ok", durationMs: null });
  assert.deepEqual(minimaxToolOutputOutcome({ output: JSON.stringify({ metadata: { exit_code: 1, duration_seconds: 0.2 } }) }), { kind: "executed", status: "error", durationMs: 200 });
  assert.deepEqual(minimaxToolOutputOutcome({ status: "denied" }), { kind: "unavailable", reason: "denied" });
  assert.deepEqual(minimaxToolOutputOutcome({ output: "Permission denied by workspace" }), { kind: "unavailable", reason: "denied" });

  // Reporting requested tool call from upstream event
  const events = [];
  const fakeReporter = {
    reportToolRequested: async (e) => events.push({ type: "tool_requested", ...e }),
    reportToolExecuted: async (e) => events.push({ type: "tool_executed", ...e }),
    reportToolUnavailable: async (e) => events.push({ type: "tool_unavailable", ...e }),
  };

  reportRequestedToolCall(fakeReporter, {
    type: "function_call",
    name: "read_file",
    call_id: "call_mm_1",
    namespace: "builtin",
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[ 0 ], { type: "tool_requested", tool: "read_file", callId: "call_mm_1", server: "builtin" });

  // Reporting executed tool call from input payload
  reportExecutedToolCalls(fakeReporter, {
    input: [
      { type: "function_call", name: "read_file", call_id: "call_mm_1", namespace: "builtin" },
      { type: "function_call_output", call_id: "call_mm_1", output: "file contents" },
    ],
  });
  assert.equal(events.length, 2);
  assert.deepEqual(events[ 1 ], { type: "tool_executed", tool: "read_file", callId: "call_mm_1", status: "ok", durationMs: null, server: "builtin" });
});

test("the Claude bridge AgentEventReporter posts tool and skill telemetry to the router", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
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
  const port = server.address().port;
  try {
    const pythonScript = `
import importlib.util
from pathlib import Path

bridge_path = Path("scripts/codex-claude-cli-responses-proxy.py").resolve()
spec = importlib.util.spec_from_file_location("claude_bridge", bridge_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

reporter = mod.AgentEventReporter("http://127.0.0.1:${port}/v1/agent-events", "req-claude-1", frozenset(["Agent"]))
reporter.reportToolRequested("read_file", callId="c1", server="builtin")
reporter.reportToolExecuted("read_file", callId="c1", status="ok", durationMs=120, server="builtin")
reporter.reportToolUnavailable("write_file", callId="c2", reason="denied", server="builtin")
reporter.reportSkillExposed("ccc", source="claude_skill_view")
reporter.reportToolExecuted({"tool": "bash", "callId": "c3", "status": "error", "durationMs": 45})
reporter.reportSkillExposed({"skill": "lsp-mcp-server", "source": "claude_skill_view"})
reporter.flush()
`;
    await execFileAsync("python3", [ "-c", pythonScript ], { cwd: repoRoot });
    assert.equal(received.length, 6);
    assert.deepEqual(received[ 0 ], {
      requestId: "req-claude-1",
      events: [ { type: "tool_requested", tool: "read_file", callId: "c1", server: "builtin" } ],
    });
    assert.deepEqual(received[ 1 ], {
      requestId: "req-claude-1",
      events: [ { type: "tool_executed", tool: "read_file", callId: "c1", status: "ok", durationMs: 120, server: "builtin" } ],
    });
    assert.deepEqual(received[ 2 ], {
      requestId: "req-claude-1",
      events: [ { type: "tool_unavailable", tool: "write_file", callId: "c2", reason: "denied", server: "builtin" } ],
    });
    assert.deepEqual(received[ 3 ], {
      requestId: "req-claude-1",
      events: [ { type: "skill_exposed", skill: "ccc", source: "claude_skill_view", pluginId: null } ],
    });
    assert.deepEqual(received[ 4 ], {
      requestId: "req-claude-1",
      events: [ { type: "tool_executed", tool: "bash", callId: "c3", status: "error", durationMs: 45, server: null } ],
    });
    assert.deepEqual(received[ 5 ], {
      requestId: "req-claude-1",
      events: [ { type: "skill_exposed", skill: "lsp-mcp-server", source: "claude_skill_view", pluginId: null } ],
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
