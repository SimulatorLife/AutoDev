import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

import {
  AGENT_EVENTS_URL_HEADER,
  REQUEST_ID_HEADER,
  SESSION_ID_HEADER,
  SKILL_READ_SOURCE,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  VALID_ACTIVITY_STATES,
  resolveAgentEventReporter,
  resolveSkillReadReporter,
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
  extractSkillReadPath as agySkillReadPath,
  matchSkillReadPath as agyMatchSkillReadPath,
  modelEffort,
  resolveEffort,
  resolveModel,
  spawnedChildren,
  subagentModel,
  toolStepEvidence,
} from "../scripts/codex-antigravity-cli-responses-proxy.mjs";
import {
  copilotToolOutcome,
  extractSkillReadPath as copilotSkillReadPath,
  matchSkillReadPath as copilotMatchSkillReadPath,
  reportToolObservation,
  skillReadEvent,
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
  assert.match(source, /import \{ REQUEST_ID_HEADER, SKILL_READ_SOURCE, resolveAgentEventReporter \} from "\.\/codex\/lib\/agent-events\.mjs";/);
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

test("AgentEventReporter posts skill_used events with the same request-correlated shape as skill_exposed", async () => {
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
    await reporter.reportSkillUsed({ skill: "ccc", source: "role_contract" });
    await reporter.reportSkillUsed({ skill: "ccc", eventId: "explicit-call-1", pluginId: "autodev" });
    await reporter.reportSkillUsed({ skill: "   " });
    assert.equal(received.length, 2);
    assert.deepEqual(received[ 0 ], {
      requestId: "request-1",
      events: [ { type: "skill_used", skill: "ccc", source: "role_contract", pluginId: null } ],
    });
    assert.deepEqual(received[ 1 ], {
      requestId: "request-1",
      events: [ { type: "skill_used", skill: "ccc", source: null, pluginId: "autodev", eventId: "explicit-call-1" } ],
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("resolveSkillReadReporter resolves a session-keyed reporter only when both URL and session are present", () => {
  const url = "http://127.0.0.1:4100/v1/agent-events";
  assert.equal(resolveSkillReadReporter({}), null);
  assert.equal(resolveSkillReadReporter({ [ AGENT_EVENTS_URL_HEADER ]: url }), null);
  // Session id is required because a hook without one cannot be tied to a
  // router-issued request, and the router fails closed on unattributed posts.
  assert.equal(resolveSkillReadReporter({ [ SESSION_ID_HEADER ]: "session-only" }), null);
  const reporter = resolveSkillReadReporter({
    [ AGENT_EVENTS_URL_HEADER ]: url,
    [ SESSION_ID_HEADER ]: "session-1",
  });
  assert.ok(reporter);
});

test("resolveSkillReadReporter posts skill_used with the SKILL_READ_SOURCE tag and the session id as request id", async () => {
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
    const reporter = resolveSkillReadReporter({
      [ AGENT_EVENTS_URL_HEADER ]: `http://127.0.0.1:${server.address().port}/v1/agent-events`,
      [ SESSION_ID_HEADER ]: "session-1",
    });
    assert.equal(SKILL_READ_SOURCE, "skill_read");
    await reporter.reportSkillUsed({ skill: "ccc", source: SKILL_READ_SOURCE, eventId: "read:session-1:t1" });
    assert.equal(received.length, 1);
    assert.deepEqual(received[ 0 ], {
      requestId: "session-1",
      events: [ { type: "skill_used", skill: "ccc", source: "skill_read", pluginId: null, eventId: "read:session-1:t1" } ],
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the skill-read telemetry hook dedupes per turn and emits one skill_used per skill", async () => {
  const tempHome = await import("node:fs/promises").then(({ mkdtemp, rm }) => mkdtemp(`${import.meta.dirname}/skill-read-home-`).then(async (dir) => ({ dir, rm })));
  process.env.HOME = tempHome.dir;
  // Force the hook to read fresh roots via a stable repo root.
  process.env.AUTODEV_REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
  try {
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
    process.env.AUTODEV_AGENT_EVENTS_URL = `http://127.0.0.1:${port}/v1/agent-events`;
    try {
      const scriptPath = fileURLToPath(new URL("../scripts/codex/skill-read-telemetry.mjs", import.meta.url));
      const skillPath = `${process.env.AUTODEV_REPO_ROOT}/scripts/codex/skills/orchestration/SKILL.md`;
      const otherSkillPath = `${process.env.AUTODEV_REPO_ROOT}/scripts/codex/skills/ccc/SKILL.md`;
      const sessionId = `session-${Date.now()}`;
      const turnId = "turn-1";
      const input = JSON.stringify({
        session_id: sessionId,
        turn_id: turnId,
        tool_name: "read_file",
        tool_input: { file_path: skillPath },
      });
      const run = (customInput = input) => new Promise((resolve, reject) => {
        const child = execFile("node", [ scriptPath ], { env: process.env }, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr || error.message)); else resolve({ stdout, stderr });
        });
        child.stdin.end(typeof customInput === "string" ? customInput : JSON.stringify(customInput));
      });
      // First read of `orchestration` in turn-1 emits a skill_used.
      await run();
      // Second read of the same skill in the same turn is deduped (no extra post).
      await run();
      // A different skill in the same turn still posts.
      await run({ session_id: sessionId, turn_id: turnId, tool_name: "read_file", arguments: { file_path: otherSkillPath } });
      // Same skill in a fresh turn re-emits because turnId was different.
      await run({ session_id: sessionId, turn_id: "turn-2", tool_name: "read_file", arguments: { file_path: skillPath } });
      // Arbitrary mentions, writes, and non-canonical paths must not post.
      await run({ session_id: sessionId, turn_id: "turn-3", tool_name: "read_file", arguments: { file_path: `${process.env.AUTODEV_REPO_ROOT}/AGENTS.md` } });
      assert.equal(received.length, 3, `expected 3 posts (orchestration turn-1, ccc turn-1, orchestration turn-2); got ${received.length}`);
      assert.deepEqual(received[ 0 ].events[ 0 ], { type: "skill_used", skill: "orchestration", source: "skill_read", pluginId: null, eventId: received[ 0 ].events[ 0 ].eventId });
      assert.equal(received[ 0 ].events[ 0 ].eventId.startsWith("read:"), true);
      assert.equal(received[ 0 ].requestId, sessionId);
      assert.equal(received[ 1 ].events[ 0 ].skill, "ccc");
      assert.equal(received[ 2 ].events[ 0 ].skill, "orchestration");
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  } finally {
    delete process.env.HOME;
    delete process.env.AUTODEV_AGENT_EVENTS_URL;
    delete process.env.AUTODEV_REPO_ROOT;
    await tempHome.rm(tempHome.dir, { recursive: true, force: true });
  }
});

test("AgentEventReporter posts normalized activity events with requestId", async () => {
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
    const reporter = resolveAgentEventReporter({
      [ AGENT_EVENTS_URL_HEADER ]: `http://127.0.0.1:${port}/v1/agent-events`,
      [ REQUEST_ID_HEADER ]: "req-activity-1",
      [ SUBAGENT_SPAWN_TOOLS_HEADER ]: "invoke_subagent",
    });
    assert.ok(reporter);

    await reporter.reportActivity({ state: "tool_wait" });
    await reporter.reportActivity({ state: "subagent_wait", childIds: [ "c1", "c2" ] });
    await reporter.reportActivity("resumed");
    await reporter.reportActivity({ state: "finished" });

    assert.equal(received.length, 4);
    assert.deepEqual(received[ 0 ], {
      requestId: "req-activity-1",
      events: [ { type: "activity", state: "tool_wait" } ],
    });
    assert.deepEqual(received[ 1 ], {
      requestId: "req-activity-1",
      events: [ { type: "activity", state: "subagent_wait", childIds: [ "c1", "c2" ] } ],
    });
    assert.deepEqual(received[ 2 ], {
      requestId: "req-activity-1",
      events: [ { type: "activity", state: "resumed" } ],
    });
    assert.deepEqual(received[ 3 ], {
      requestId: "req-activity-1",
      events: [ { type: "activity", state: "finished" } ],
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("activity reporting rejects invalid states and drops unapproved names", async () => {
  assert.deepEqual(Array.from(VALID_ACTIVITY_STATES).sort(), [
    "failed",
    "finished",
    "heartbeat",
    "resumed",
    "subagent_wait",
    "tool_wait",
    "user_wait",
  ]);

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
    const reporter = resolveAgentEventReporter({
      [ AGENT_EVENTS_URL_HEADER ]: `http://127.0.0.1:${port}/v1/agent-events`,
      [ REQUEST_ID_HEADER ]: "req-activity-2",
      [ SUBAGENT_SPAWN_TOOLS_HEADER ]: "invoke_subagent",
    });

    await reporter.reportActivity({ state: "invalid_state" });
    await reporter.reportActivity({ state: "running" });
    await reporter.reportActivity({ state: "" });
    await reporter.reportActivity(null);
    await reporter.reportActivity(undefined);

    assert.equal(received.length, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("activity reporting is idempotent against duplicate transitions and terminal states", async () => {
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
    const reporter = resolveAgentEventReporter({
      [ AGENT_EVENTS_URL_HEADER ]: `http://127.0.0.1:${port}/v1/agent-events`,
      [ REQUEST_ID_HEADER ]: "req-activity-3",
      [ SUBAGENT_SPAWN_TOOLS_HEADER ]: "invoke_subagent",
    });

    // Duplicate non-resumed transitions are dropped
    await reporter.reportActivity({ state: "tool_wait" });
    await reporter.reportActivity({ state: "tool_wait" });
    assert.equal(received.length, 1);

    // Resumed transition can re-occur
    await reporter.reportActivity({ state: "resumed" });
    await reporter.reportActivity({ state: "resumed" });
    assert.equal(received.length, 3);

    // Terminal state stops any further transitions
    await reporter.reportActivity({ state: "finished" });
    assert.equal(received.length, 4);

    await reporter.reportActivity({ state: "tool_wait" });
    await reporter.reportActivity({ state: "resumed" });
    await reporter.reportActivity({ state: "failed" });
    assert.equal(received.length, 4);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the Claude bridge AgentEventReporter posts activity telemetry to the router", async () => {
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

reporter = mod.AgentEventReporter("http://127.0.0.1:${port}/v1/agent-events", "req-claude-act", frozenset(["Agent"]))
reporter.reportActivity("tool_wait")
reporter.reportActivity("tool_wait")
reporter.reportActivity({"state": "subagent_wait", "childIds": ["sub-1", "sub-2"]})
reporter.reportActivity("resumed")
reporter.reportActivity("finished")
reporter.reportActivity("resumed")
reporter.flush()
`;
    await execFileAsync("python3", [ "-c", pythonScript ], { cwd: repoRoot });
    assert.equal(received.length, 4);
    assert.deepEqual(received[ 0 ], {
      requestId: "req-claude-act",
      events: [ { type: "activity", state: "tool_wait" } ],
    });
    assert.deepEqual(received[ 1 ], {
      requestId: "req-claude-act",
      events: [ { type: "activity", state: "subagent_wait", childIds: [ "sub-1", "sub-2" ] } ],
    });
    assert.deepEqual(received[ 2 ], {
      requestId: "req-claude-act",
      events: [ { type: "activity", state: "resumed" } ],
    });
    assert.deepEqual(received[ 3 ], {
      requestId: "req-claude-act",
      events: [ { type: "activity", state: "finished" } ],
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("AgentEventReporter delivers repeated heartbeat activity events without dropping them", async () => {
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
    const reporter = resolveAgentEventReporter({
      [ AGENT_EVENTS_URL_HEADER ]: `http://127.0.0.1:${port}/v1/agent-events`,
      [ REQUEST_ID_HEADER ]: "req-heartbeat-js",
      [ SUBAGENT_SPAWN_TOOLS_HEADER ]: "invoke_subagent",
    });

    await reporter.reportActivity({ state: "tool_wait" });
    // Repeated heartbeats are delivered
    await reporter.reportHeartbeat({ minIntervalMs: 0 });
    await reporter.reportHeartbeat({ minIntervalMs: 0 });
    // Throttled heartbeat with minIntervalMs > 0 drops immediate repeat
    await reporter.reportHeartbeat({ minIntervalMs: 60000 });
    // Resumed still works after heartbeats because heartbeat did not overwrite lifecycle state
    await reporter.reportActivity("resumed");
    await reporter.reportActivity({ state: "finished" });

    assert.equal(received.length, 5);
    assert.deepEqual(received[ 0 ].events[ 0 ], { type: "activity", state: "tool_wait" });
    assert.deepEqual(received[ 1 ].events[ 0 ], { type: "activity", state: "heartbeat" });
    assert.deepEqual(received[ 2 ].events[ 0 ], { type: "activity", state: "heartbeat" });
    assert.deepEqual(received[ 3 ].events[ 0 ], { type: "activity", state: "resumed" });
    assert.deepEqual(received[ 4 ].events[ 0 ], { type: "activity", state: "finished" });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the Claude bridge AgentEventReporter delivers repeated heartbeats to the router", async () => {
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

reporter = mod.AgentEventReporter("http://127.0.0.1:${port}/v1/agent-events", "req-claude-hb", frozenset(["Agent"]))
reporter.reportActivity("tool_wait")
reporter.reportHeartbeat(min_interval_seconds=0.0)
reporter.reportHeartbeat(min_interval_seconds=0.0)
reporter.reportHeartbeat(min_interval_seconds=60.0)
reporter.reportActivity("resumed")
reporter.reportActivity("finished")
reporter.flush()
`;
    await execFileAsync("python3", [ "-c", pythonScript ], { cwd: repoRoot });
    assert.equal(received.length, 5);
    assert.deepEqual(received[ 0 ].events[ 0 ], { type: "activity", state: "tool_wait" });
    assert.deepEqual(received[ 1 ].events[ 0 ], { type: "activity", state: "heartbeat" });
    assert.deepEqual(received[ 2 ].events[ 0 ], { type: "activity", state: "heartbeat" });
    assert.deepEqual(received[ 3 ].events[ 0 ], { type: "activity", state: "resumed" });
    assert.deepEqual(received[ 4 ].events[ 0 ], { type: "activity", state: "finished" });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the provider bridges wire activity lifecycle telemetry", () => {
  // Antigravity bridge source assertions
  const agySource = read("scripts/codex-antigravity-cli-responses-proxy.mjs");
  assert.match(agySource, /tool === "ask_question"\) void agentEvents\.reportActivity\(\{ state: "user_wait" \}\)/);
  assert.match(agySource, /void agentEvents\.reportActivity\(\{ state: "tool_wait" \}\)/);
  assert.match(agySource, /void agentEvents\.reportActivity\(\{ state: "subagent_wait", childIds: children\.map\(/);
  assert.match(agySource, /void agentEvents\.reportActivity\(\{ state: "resumed" \}\)/);
  assert.match(agySource, /void agentEvents\.reportActivity\(\{ state: "finished" \}\)/);
  assert.match(agySource, /void agentEvents\.reportActivity\(\{ state: "failed" \}\)/);

  // Copilot bridge source assertions
  const copilotSource = read("scripts/codex-copilot-cli-responses-proxy.mjs");
  assert.match(copilotSource, /reportActivity\(\{ state: String\(event\.tool/);
  assert.match(copilotSource, /void agentEvents\.reportActivity\(\{ state: "resumed" \}\)/);
  assert.match(copilotSource, /void agentEvents\.reportActivity\(\{ state: "finished" \}\)/);
  assert.match(copilotSource, /void agentEvents\.reportActivity\(\{ state: "failed" \}\)/);

  // Claude bridge source assertions
  const claudeSource = read("scripts/codex-claude-cli-responses-proxy.py");
  assert.match(claudeSource, /agent_events\.report_activity_async\("subagent_wait"\)/);
  assert.match(claudeSource, /agent_events\.report_activity_async\("tool_wait"\)/);
  assert.match(claudeSource, /ask_question/);
  assert.match(claudeSource, /agent_events\.report_activity_async\("resumed"\)/);
  assert.match(claudeSource, /agent_events\.report_activity_async\("finished"\)/);
  assert.match(claudeSource, /agent_events\.report_activity_async\("failed"\)/);

  // MiniMax bridge source assertions
  const minimaxSource = read("scripts/codex-minimax-responses-proxy.mjs");
  assert.match(minimaxSource, /reportActivity\(\{ state: tool\.toLowerCase\(\) === "ask_question"/);
  assert.match(minimaxSource, /void agentEvents\.reportActivity\(\{ state: "resumed" \}\)/);
  assert.match(minimaxSource, /void agentEvents\.reportActivity\(\{ state: "finished" \}\)/);
  assert.match(minimaxSource, /void agentEvents\.reportActivity\(\{ state: "failed" \}\)/);
});

// A canonical SKILL.md this checkout actually ships, so the matching logic
// below is exercised against a real approved root instead of a synthetic one.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CANONICAL_SKILL_PATH = join(REPO_ROOT, "scripts", "codex", "skills", "ccc", "SKILL.md");
const OTHER_FILE_PATH = join(REPO_ROOT, "AGENTS.md");

test("the Antigravity bridge detects a successful canonical SKILL.md read", async () => {
  assert.equal(SKILL_READ_SOURCE, "skill_read");
  // A read_file call naming the canonical path resolves to the skill name.
  assert.equal(agySkillReadPath("read_file", { file_path: CANONICAL_SKILL_PATH }), CANONICAL_SKILL_PATH);
  assert.equal(agyMatchSkillReadPath(CANONICAL_SKILL_PATH), "ccc");
  // A shell read of the same file is recognised too.
  assert.equal(agySkillReadPath("exec_command", { command: `cat ${CANONICAL_SKILL_PATH}` }), CANONICAL_SKILL_PATH);
  // A write-shaped tool and an arbitrary file are not reads of a skill.
  assert.equal(agySkillReadPath("write_file", { file_path: CANONICAL_SKILL_PATH }), null);
  assert.equal(agyMatchSkillReadPath(OTHER_FILE_PATH), null);

  const events = [];
  const fakeReporter = {
    reportToolRequested: async () => {},
    reportToolExecuted: async () => {},
    reportToolUnavailable: async () => {},
    reportSkillUsed: async (e) => events.push(e),
  };
  const { observeToolStep } = createToolObserver(fakeReporter);

  // A successful read reports skill_used, correlated to the tool call id.
  observeToolStep({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "read_file", tool_info: { args: { file_path: CANONICAL_SKILL_PATH } } });
  observeToolStep({ step_index: 1, state: "DONE", step_type: "tool", tool_name: "read_file", tool_info: { args: { file_path: CANONICAL_SKILL_PATH }, output: "skill body" } });
  await Promise.resolve();
  assert.equal(events.length, 1);
  assert.deepEqual(events[ 0 ], { skill: "ccc", source: "skill_read", eventId: "skill_read:s1:ccc" });

  // A denied read of the same file never counts as a use.
  observeToolStep({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "read_file", tool_info: { args: { file_path: CANONICAL_SKILL_PATH } } });
  observeToolStep({ step_index: 2, state: "ERROR", step_type: "tool", tool_name: "read_file", tool_info: { args: { file_path: CANONICAL_SKILL_PATH } }, error: "permission denied" });
  await Promise.resolve();
  assert.equal(events.length, 1);

  // A second successful read of the same skill in the same turn is deduped.
  observeToolStep({ step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "read_file", tool_info: { args: { file_path: CANONICAL_SKILL_PATH } } });
  observeToolStep({ step_index: 3, state: "DONE", step_type: "tool", tool_name: "read_file", tool_info: { args: { file_path: CANONICAL_SKILL_PATH }, output: "skill body" } });
  await Promise.resolve();
  assert.equal(events.length, 1);

  // A successful read of an arbitrary, non-skill file reports nothing.
  observeToolStep({ step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "read_file", tool_info: { args: { file_path: OTHER_FILE_PATH } } });
  observeToolStep({ step_index: 4, state: "DONE", step_type: "tool", tool_name: "read_file", tool_info: { args: { file_path: OTHER_FILE_PATH }, output: "not a skill" } });
  await Promise.resolve();
  assert.equal(events.length, 1);
});

test("the Copilot bridge detects a successful canonical SKILL.md read", () => {
  assert.equal(copilotSkillReadPath("read_file", { file_path: CANONICAL_SKILL_PATH }), CANONICAL_SKILL_PATH);
  assert.equal(copilotMatchSkillReadPath(CANONICAL_SKILL_PATH), "ccc");
  assert.equal(copilotSkillReadPath("bash", { command: `cat ${CANONICAL_SKILL_PATH}` }), CANONICAL_SKILL_PATH);
  assert.equal(copilotSkillReadPath("write_file", { file_path: CANONICAL_SKILL_PATH }), null);
  assert.equal(copilotMatchSkillReadPath(OTHER_FILE_PATH), null);

  const seenSkills = new Set();
  const first = skillReadEvent({ seenSkills, toolName: "read_file", args: { file_path: CANONICAL_SKILL_PATH }, callId: "call_1" });
  assert.deepEqual(first, { type: "skill_used", skill: "ccc", eventId: "skill_read:call_1:ccc" });
  // A second read of the same skill, from a different call id, is deduped.
  const second = skillReadEvent({ seenSkills, toolName: "read_file", args: { file_path: CANONICAL_SKILL_PATH }, callId: "call_2" });
  assert.equal(second, null);
  // A read of a non-skill file reports nothing.
  const third = skillReadEvent({ seenSkills, toolName: "read_file", args: { file_path: OTHER_FILE_PATH }, callId: "call_3" });
  assert.equal(third, null);

  // A denied/failed call never reaches skillReadEvent at all: the bridge only
  // calls it from the `executed`+`ok` branch of copilotToolOutcome.
  assert.deepEqual(copilotToolOutcome({ permissionDenied: true }), { kind: "unavailable", reason: "denied" });
  assert.deepEqual(copilotToolOutcome({ output: "fail", success: false }), { kind: "executed", status: "error" });

  // Wiring: a skill_used event is forwarded to the router with the read source.
  const events = [];
  const fakeReporter = { reportSkillUsed: async (e) => events.push(e) };
  reportToolObservation(fakeReporter, { type: "skill_used", skill: "ccc", eventId: "skill_read:call_1:ccc" });
  assert.deepEqual(events, [ { skill: "ccc", source: "skill_read", eventId: "skill_read:call_1:ccc" } ]);

  const source = read("scripts/codex-copilot-cli-responses-proxy.mjs");
  assert.match(source, /if \(outcome\.kind === "executed" && outcome\.status === "ok"\) \{/);
  assert.match(source, /const skillEvent = skillReadEvent\(\{ seenSkills, toolName, args: open\?\.args \?\? data\.arguments, callId \}\);/);
});

test("the Claude bridge detects a successful canonical SKILL.md read", async () => {
  const source = read("scripts/codex-claude-cli-responses-proxy.py");
  assert.match(source, /CLAUDE_SKILL_READ_SOURCE = "skill_read"/);
  assert.match(source, /if detail == "ok":/);
  assert.match(source, /skill = match_skill_read_path\(_normalise_skill_read_path\(extract_skill_read_path\(name, tool_input\)\)\)/);
  assert.match(source, /if skill is not None and skill not in seen_skill_reads:/);
  assert.match(source, /reportSkillUsed = report_skill_used_async/);

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

skill_path = str(Path("${CANONICAL_SKILL_PATH}"))
other_path = str(Path("${OTHER_FILE_PATH}"))

# Only Claude's own Read tool -- and a shell read of the same path -- counts.
assert mod.extract_skill_read_path("Read", {"file_path": skill_path}) == skill_path
assert mod.extract_skill_read_path("Bash", {"command": f"cat {skill_path}"}) == skill_path
assert mod.extract_skill_read_path("Write", {"file_path": skill_path}) is None
assert mod.match_skill_read_path(mod._normalise_skill_read_path(skill_path)) == "ccc"
assert mod.match_skill_read_path(mod._normalise_skill_read_path(other_path)) is None

reporter = mod.AgentEventReporter("http://127.0.0.1:${port}/v1/agent-events", "req-claude-skill-read", frozenset(["Agent"]))
reporter.reportSkillUsed("ccc", source=mod.CLAUDE_SKILL_READ_SOURCE, eventId="skill_read:c1:ccc")
reporter.flush()
`;
    await execFileAsync("python3", [ "-c", pythonScript ], { cwd: repoRoot });
    assert.equal(received.length, 1);
    assert.deepEqual(received[ 0 ], {
      requestId: "req-claude-skill-read",
      events: [ { type: "skill_used", skill: "ccc", source: "skill_read", pluginId: null, eventId: "skill_read:c1:ccc" } ],
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
