import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  agyArgs,
  agyErrorDetails,
  agyFailureMessage,
  agyPermissionFailure,
  ANTIGRAVITY_MCP_EXPOSURE_SOURCE,
  ANTIGRAVITY_SKILL_EXPOSURE_SOURCE,
  antigravityToolServer,
  createSpawnTracker,
  createToolObserver,
  extractSkillReadPath as agySkillReadPath,
  matchSkillReadPath as agyMatchSkillReadPath,
  modelEffort,
  resolveEffort,
  resolveModel,
  spawnedChildren,
  subagentModel
} from "@simulatorlife/autodev-runtime/providers/antigravity";
import {
  copilotToolOutcome,
  extractSkillReadPath as copilotSkillReadPath,
  matchSkillReadPath as copilotMatchSkillReadPath,
  MCP_EXPOSURE_SOURCE as COPILOT_MCP_EXPOSURE_SOURCE,
  reportCopilotToolOutcome,
  reportToolObservation,
  SKILL_EXPOSURE_SOURCE as COPILOT_SKILL_EXPOSURE_SOURCE,
  skillReadEvent
} from "@simulatorlife/autodev-runtime/providers/copilot";
import {
  AGENT_EVENTS_URL_HEADER,
  type AgentEventReporter,
  REQUEST_ID_HEADER,
  resolveAgentEventReporter,
  resolveSkillReadReporter,
  SESSION_ID_HEADER,
  SKILL_READ_SOURCE,
  SUBAGENT_SPAWN_TOOLS_HEADER,
  VALID_ACTIVITY_STATES
} from "@simulatorlife/autodev-runtime/telemetry";

import { normalizedSource } from "./source-text.ts";

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const read = (path: string) => {
  const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  return path.endsWith(".ts") ? normalizedSource(text) : text;
};

const routerHeaders: Record<string, string | undefined> = {
  [AGENT_EVENTS_URL_HEADER]: "http://127.0.0.1:4100/v1/agent-events",
  [REQUEST_ID_HEADER]: "request-1",
  [SUBAGENT_SPAWN_TOOLS_HEADER]: "invoke_subagent,Agent"
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
  assert.ok(
    resolveAgentEventReporter({
      "X-Autodev-Agent-Events-Url": routerHeaders[AGENT_EVENTS_URL_HEADER],
      "X-Autodev-Request-Id": "request-1",
      "X-Autodev-Subagent-Spawn-Tools": "Agent,Task"
    })
  );

  // A caller that is not the router gets no reporter at all rather than a
  // reporter that posts nowhere.
  assert.equal(resolveAgentEventReporter({}), null);
  assert.equal(
    resolveAgentEventReporter(null as unknown as Record<string, unknown>),
    null
  );
  for (const missing of [AGENT_EVENTS_URL_HEADER, REQUEST_ID_HEADER]) {
    const partial: Record<string, string | undefined> = { ...routerHeaders };
    delete partial[missing];
    assert.equal(
      resolveAgentEventReporter(partial),
      null,
      `missing ${missing} must disable reporting`
    );
  }
  // Missing or empty spawn tools still yields a reporter for providers without
  // delegation (copilot, minimax) so they can report tool and skill observations.
  const noSpawnTools: Record<string, string | undefined> = { ...routerHeaders };
  delete noSpawnTools[SUBAGENT_SPAWN_TOOLS_HEADER];
  const noSpawnReporter = resolveAgentEventReporter(noSpawnTools);
  assert.ok(noSpawnReporter);
  assert.equal(noSpawnReporter.isSpawnTool("invoke_subagent"), false);
  const emptySpawnReporter = resolveAgentEventReporter({
    ...routerHeaders,
    [SUBAGENT_SPAWN_TOOLS_HEADER]: " , "
  });
  assert.ok(emptySpawnReporter);
  assert.equal(emptySpawnReporter.isSpawnTool("invoke_subagent"), false);
});

test("a reported spawn names the request that authorizes it", async () => {
  const received: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const port = await listen(server);
  try {
    const reporter = resolveAgentEventReporter({
      ...routerHeaders,
      [AGENT_EVENTS_URL_HEADER]: `http://127.0.0.1:${port}/v1/agent-events`
    });
    await reporter!.reportSpawn({ tool: "invoke_subagent", role: "explorer" });
    assert.deepEqual(received, [
      {
        requestId: "request-1",
        events: [
          {
            type: "subagent_spawn",
            tool: "invoke_subagent",
            role: "explorer",
            status: "started",
            count: 1,
            children: [{ id: "c1" }]
          }
        ]
      }
    ]);
  } finally {
    await close(server);
  }
});

test("a report travels with the session it belongs to", async () => {
  // The router's registry of live requests is in memory, so a restart loses
  // it while a long CLI turn keeps reporting against the request it started
  // with. The session outlives the restart, so the post carries it and the
  // router can still attribute the report.
  const received: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const port = await listen(server);
  try {
    const reporter = resolveAgentEventReporter({
      ...routerHeaders,
      [AGENT_EVENTS_URL_HEADER]: `http://127.0.0.1:${port}/v1/agent-events`,
      [SESSION_ID_HEADER]: "session-1"
    });
    await reporter!.reportSpawn({ tool: "invoke_subagent", role: "explorer" });
    assert.equal(received.length, 1);
    assert.equal(received[0].sessionId, "session-1");
    assert.equal(received[0].requestId, "request-1");
  } finally {
    await close(server);
  }
});

test("a batch of children is reported as a batch, grouped by role", async () => {
  const received: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const port = await listen(server);
  try {
    const reporter = resolveAgentEventReporter({
      ...routerHeaders,
      [AGENT_EVENTS_URL_HEADER]: `http://127.0.0.1:${port}/v1/agent-events`
    });
    // One `invoke_subagent` call, four children, two roles: the router must see
    // four spawns, not one, and must be able to tell the roles apart.
    await reporter!.reportSpawns({
      tool: "invoke_subagent",
      children: [
        { id: "s3.0", role: "explorer" },
        {
          id: "s3.1",
          role: "explorer",
          model: "gemini-3.8-flash-high",
          logUri: null
        },
        { id: "s3.2", role: "validator" },
        { id: "s3.3", role: null }
      ]
    });
    assert.deepEqual(received.at(-1), {
      requestId: "request-1",
      events: [
        {
          type: "subagent_spawn",
          tool: "invoke_subagent",
          role: "explorer",
          status: "started",
          count: 2,
          children: [
            { id: "s3.0" },
            { id: "s3.1", model: "gemini-3.8-flash-high" }
          ]
        },
        {
          type: "subagent_spawn",
          tool: "invoke_subagent",
          role: "validator",
          status: "started",
          count: 1,
          children: [{ id: "s3.2" }]
        },
        {
          type: "subagent_spawn",
          tool: "invoke_subagent",
          role: null,
          status: "started",
          count: 1,
          children: [{ id: "s3.3" }]
        }
      ]
    });

    // The close names the same children the open did, which is what lets the
    // router measure each child's own turn instead of the whole parent turn.
    await reporter!.reportResults({
      tool: "invoke_subagent",
      children: [
        { id: "s3.0", role: "explorer" },
        { id: "s3.2", role: "validator" }
      ],
      outcome: "success",
      durationMs: 41_230
    });
    assert.deepEqual(received.at(-1).events, [
      {
        type: "subagent_result",
        tool: "invoke_subagent",
        role: "explorer",
        status: "success",
        count: 1,
        children: [{ id: "s3.0" }],
        outcome: "success",
        durationMs: 41_230
      },
      {
        type: "subagent_result",
        tool: "invoke_subagent",
        role: "validator",
        status: "success",
        count: 1,
        children: [{ id: "s3.2" }],
        outcome: "success",
        durationMs: 41_230
      }
    ]);

    // No children at all still reports the call, so a CLI that stops exporting
    // its tool arguments degrades to the old count rather than to silence. The
    // router still gets an id, so even that child can be closed individually.
    await reporter!.reportSpawns({ tool: "invoke_subagent", children: [] });
    const [degraded] = received.at(-1).events;
    assert.equal(degraded.count, 1);
    assert.equal(degraded.role, null);
    assert.equal(degraded.children.length, 1);
    assert.match(
      degraded.children[0].id,
      /^c\d+$/,
      "a caller with no id of its own is given one"
    );
  } finally {
    await close(server);
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
          {
            TypeName: "explorer",
            Model: "inherit",
            Prompt: "You are an explorer agent investigating build issues"
          },
          {
            TypeName: "explorer",
            Model: "inherit",
            Prompt: "Catalog the lint failures"
          },
          {
            TypeName: "validator",
            Model: "inherit",
            Prompt: "Re-run the suites"
          }
        ]
      })
    }
  };
  // Each child is addressable, so its own turn can be opened and closed rather
  // than measured against the whole parent turn.
  assert.deepEqual(spawnedChildren(batch), [
    { id: "s3.0", role: "explorer", model: "inherit", logUri: null },
    { id: "s3.1", role: "explorer", model: "inherit", logUri: null },
    { id: "s3.2", role: "validator", model: "inherit", logUri: null }
  ]);
  // `inherit` is agy naming the parent's model, not choosing one; resolving
  // that is the router's job, so the bridge reports what the step said.
  assert.equal(
    subagentModel({ Model: "gemini-3.8-flash-high" }),
    "gemini-3.8-flash-high"
  );
  assert.equal(subagentModel({ TypeName: "explorer" }), null);

  // agy has carried the arguments as a nested object and at other paths across
  // versions, so the batch is found by shape rather than by one pinned path.
  assert.deepEqual(
    spawnedChildren({
      tool_name: "invoke_subagent",
      tool_info: { args: { Subagents: [{ TypeName: "worker" }] } }
    }).map(({ role, model }) => ({ role, model })),
    [{ role: "worker", model: null }]
  );
  assert.deepEqual(
    spawnedChildren({
      tool_name: "invoke_subagent",
      tool_input: '{"subagents":[{"name":"docs-researcher"},{}]}'
    }).map(({ role }) => ({ role })),
    [{ role: "docs-researcher" }, { role: null }]
  );

  // A child that names only a model names no role: `byRole` must not fill up
  // with model ids.
  assert.deepEqual(
    spawnedChildren({
      tool_info: { args: { Subagents: [{ Model: "inherit" }] } }
    }).map(({ role }) => role),
    [null]
  );

  // `self` is agy's back-reference to the caller's own archetype, not the name
  // of one. Recorded verbatim it becomes a `self` row sitting beside real roles
  // in `byRole` as though it were one, and every self-dispatched child collapses
  // under a label that describes nothing. It declares no archetype, which is
  // what the unattributed bucket is for.
  for (const declared of ["self", "Self", "SELF", " self "]) {
    assert.deepEqual(
      spawnedChildren({
        tool_info: { args: { Subagents: [{ TypeName: declared }] } }
      }).map(({ role }) => role),
      [null],
      `TypeName ${JSON.stringify(declared)} must not become a role`
    );
  }
  // A batch mixing the two keeps the one that named an archetype.
  assert.deepEqual(
    spawnedChildren({
      tool_info: {
        args: { Subagents: [{ TypeName: "self" }, { TypeName: "explorer" }] }
      }
    }).map(({ role }) => role),
    [null, "explorer"]
  );
  // Only the exact token: a real archetype whose name merely contains it stays.
  assert.deepEqual(
    spawnedChildren({
      tool_info: { args: { Subagents: [{ TypeName: "self-review" }] } }
    }).map(({ role }) => role),
    ["self-review"]
  );

  // A step that exports no arguments is still one spawn, never zero.
  const roleless = [
    { tool_name: "invoke_subagent", state: "ACTIVE" },
    { tool_info: { args: "not json" } },
    { tool_info: { args: { Subagents: [] } } },
    undefined,
    // Free text that happens to mention the tool is not a batch.
    { text_delta: "I will call invoke_subagent with Subagents" }
  ];
  const rolelessIds = new Set();
  for (const update of roleless) {
    const [child, ...rest] = spawnedChildren(update);
    assert.ok(child);
    assert.equal(rest.length, 0);
    assert.equal(child.role, null);
    // A step with no index still gets a distinct id: keying every one of them
    // the same would let one step's close settle another step's children.
    assert.equal(
      rolelessIds.has(child.id),
      false,
      `duplicate child id ${child.id}`
    );
    rolelessIds.add(child.id);
  }
});

test("a failed report costs a count, never the model turn", async () => {
  // Nothing is listening on this port; the reporter must resolve anyway.
  const reporter = resolveAgentEventReporter({
    ...routerHeaders,
    [AGENT_EVENTS_URL_HEADER]: "http://127.0.0.1:1/v1/agent-events"
  });
  assert.ok(reporter);
  await reporter!.reportSpawn({ tool: "invoke_subagent" });
});

test("Antigravity permission failures become structured diagnostics", () => {
  const stderr =
    'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.';
  assert.deepEqual(agyPermissionFailure(stderr), {
    failureCode: "AGY_PERMISSION_DENIED",
    failurePhase: "tool_permission",
    failureTool: "read_file"
  });
  assert.deepEqual(agyPermissionFailure("ordinary provider stderr"), {});
  assert.deepEqual(
    agyErrorDetails(
      {
        message:
          "stderr: permission denied while reading /private/workspace/secret.txt",
        failureCode: "AGY_PERMISSION_DENIED",
        failurePhase: "tool_permission",
        failureTool: "read_file"
      },
      "gemini-3.8-flash-medium",
      "explorer",
      "/workspace"
    ),
    {
      type: "AGY_PERMISSION_DENIED",
      message:
        "Antigravity denied a required tool permission in headless mode.",
      provider: "antigravity-gemini",
      role: "explorer",
      workspace: "/workspace",
      requestId: null,
      code: "AGY_PERMISSION_DENIED",
      phase: "tool_permission",
      tool: "read_file"
    }
  );

  const safeError = agyErrorDetails(
    {
      message:
        "stderr: permission denied while reading /private/workspace/secret.txt",
      failureCode: "AGY_PERMISSION_DENIED",
      failurePhase: "tool_permission",
      failureTool: "read_file"
    },
    "gemini-3.8-flash-medium",
    "explorer",
    "/workspace"
  );
  assert.doesNotMatch(safeError.message, /stderr:|\/private\/workspace/);

  // The router-generated request id is what lets an AGY_PERMISSION_DENIED
  // failure be correlated back to the router request that produced it,
  // without carrying any prompt text.
  assert.deepEqual(
    agyErrorDetails(
      {
        message:
          "stderr: permission denied while reading /private/workspace/secret.txt",
        failureCode: "AGY_PERMISSION_DENIED",
        failurePhase: "tool_permission",
        failureTool: "read_file"
      },
      "gemini-3.8-flash-medium",
      "explorer",
      "/workspace",
      "req-abc123"
    ),
    {
      type: "AGY_PERMISSION_DENIED",
      message:
        "Antigravity denied a required tool permission in headless mode.",
      provider: "antigravity-gemini",
      role: "explorer",
      workspace: "/workspace",
      requestId: "req-abc123",
      code: "AGY_PERMISSION_DENIED",
      phase: "tool_permission",
      tool: "read_file"
    }
  );
});

test("the router's request id reaches agyErrorDetails and logTurnEnd without any prompt content", () => {
  // An AGY_PERMISSION_DENIED failure used to surface at the router as a bare
  // `upstream_error`, with nothing in either the error body or the bridge log
  // that could be matched back to the router request that produced it. The
  // request id the router already issues on every request (the same header
  // AgentEventReporter is authorized from) is what closes that gap -- it
  // carries no prompt text, only an id the router itself assigned.
  const source = read("runtime/src/providers/antigravity.ts");
  assert.match(source, /from "@simulatorlife\/autodev-runtime\/telemetry"/);
  assert.match(
    source,
    /const requestId = contextHeaderValue\(request\.headers, REQUEST_ID_HEADER\);/
  );
  // Both places agyErrorDetails is called for an upstream failure (the
  // non-streaming 502 path and the stream-not-yet-started 429/503 path) pass
  // it through, alongside the model that names the failing provider.
  const errorDetailsCallSites = [
    ...source.matchAll(
      /agyErrorDetails\(\s*error,\s*(?:this\.)?turn\.responseModel,\s*agentRole,\s*cwd,\s*requestId\s*\)/g
    )
  ];
  assert.equal(
    errorDetailsCallSites.length,
    2,
    "both agyErrorDetails call sites must thread the router request id"
  );
  // logTurnEnd names the request alongside the outcome, so a turn's end can be
  // matched to the router's own log of the same request.
  assert.match(
    source,
    /agy turn \$\{outcome\} after \$\{elapsed\(\)\} request=\$\{requestId \?\? "none"\}/
  );
});

test("Antigravity failures retain terminal status, exit details, and bounded stderr", () => {
  const message = agyFailureMessage({
    status: "ERROR",
    error: "timeout waiting for response",
    stderr: "diagnostic\n".repeat(500),
    code: 1
  });
  assert.match(message, /status ERROR/);
  assert.match(message, /timeout waiting for response/);
  assert.match(message, /exit code 1/);
  assert.match(message, /stderr:/);
  assert.ok(
    message.length <= 2100,
    `failure detail must stay bounded (got ${message.length})`
  );

  assert.match(
    agyFailureMessage({ status: "SUCCESS", error: "empty response" }),
    /empty response/
  );
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
  assert.equal(
    modelEffort("claude-sonnet-4-6"),
    null,
    "a model id that fixes no effort"
  );

  for (const effort of ["low", "medium", "high"]) {
    const args = agyArgs("task", "gemini-3.8-flash-high", effort);
    assert.equal(
      args.includes("--effort"),
      false,
      `--effort ${effort} must not accompany a model that fixes one`
    );
    assert.deepEqual(args.slice(0, 4), [
      "-p",
      "task",
      "--model",
      "gemini-3.8-flash-high"
    ]);
  }

  // A model id that fixes no effort still receives the caller's.
  const unsuffixed = agyArgs("task", "claude-sonnet-4-6", "high");
  assert.equal(unsuffixed[unsuffixed.indexOf("--effort") + 1], "high");

  // Unknown/empty models and efforts collapse to the bridge defaults rather
  // than reaching the CLI as arbitrary text.
  assert.equal(
    resolveModel("antigravity-subscription"),
    "gemini-3.8-flash-medium"
  );
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
  for (const role of [
    "explorer",
    "docs-researcher",
    "browser-tester",
    "playtester",
    "playtest-analyst"
  ]) {
    const args = agyArgs("task", "claude-sonnet-4-6", "high", role);
    assert.ok(
      args.includes("--sandbox"),
      `${role} (readOnly) must be sandboxed`
    );
    assert.ok(
      args.includes("--dangerously-skip-permissions"),
      `${role} must receive permission skip in headless mode`
    );
  }

  // Write-capable roles are unaffected: no --sandbox, and their existing
  // AGY_SKIP_PERMISSIONS behavior is unchanged.
  for (const role of [
    "default",
    "orchestrator",
    "smart",
    "worker",
    "validator"
  ]) {
    const args = agyArgs("task", "claude-sonnet-4-6", "high", role);
    assert.equal(
      args.includes("--sandbox"),
      false,
      `${role} (write-capable) must not be sandboxed`
    );
  }

  // No role at all (null) must not be sandboxed either -- it resolves to the
  // "default" contract, which is write-capable.
  assert.equal(
    agyArgs("task", "claude-sonnet-4-6", "high", null).includes("--sandbox"),
    false
  );
});

test("the Antigravity bridge reports the subagents its own CLI spawns", () => {
  const source = read("runtime/src/providers/antigravity.ts");
  // Reached only from inside handle(), so this stays a source assertion.
  assert.match(source, /from "@simulatorlife\/autodev-runtime\/telemetry"/);
  assert.match(source, /resolveAgentEventReporter\(request\.headers\)/);
  assert.match(
    source,
    /agentEvents\.reportSpawns\(\{ tool: toolName, children \}\)/
  );
  // A child's own turn is measured only if the step that opened it is closed,
  // and a run that ends without closing every step must not strand any.
  assert.match(
    source,
    /agentEvents\.reportResults\(\{ tool: open\.tool, children: open\.children/
  );
  assert.match(source, /flushSpawns\("failure"\)/);
  // The streaming turn settles the tracker through one quiesce step on both
  // exits; the non-streaming failure path flushes directly.
  assert.match(source, /this\.turn\.spawnTracker\.flushSpawns\(outcome\);/);
  assert.match(source, /this\.quiesce\("success"\);/);
  assert.match(source, /this\.quiesce\("failure"\);/);
  // Only the opening transition is counted, and a step with no index must not
  // key every later spawn out of the count under a shared `undefined`.
  assert.match(
    source,
    /typeof index === "number" && Number\.isFinite\(index\) \? index : null/
  );
  assert.match(source, /stepIndex \?\? children\[0\]\?\.id \?\? "anonymous"/);
});

test("an Antigravity turn that dies names its own cause in the log", () => {
  // 156 of 283 Antigravity turns had failed, every one of them reaching the
  // router as `upstream_error` at HTTP 200 and leaving nothing in the bridge
  // log but the step lines that happened to precede it. The turn logged its
  // start and never its end, so the reason it died was written down nowhere.
  const source = read("runtime/src/providers/antigravity.ts");

  // Every exit from a turn names itself and how long it took.
  assert.match(
    source,
    /function createTurnLog\(requestId: string \| null\): \(outcome: string, detail\?: string\) => void \{/
  );
  assert.match(source, /return \(outcome, detail = ""\) =>/);
  assert.match(source, /logTurnEnd\("succeeded"\)/);
  assert.match(source, /logTurnEnd\("failed"/);
  assert.match(source, /logTurnEnd\("aborted"/);

  // The failure that ends long delegating turns is agy stopping without a
  // terminal result. Whether it was killed, exited, or died on a signal is
  // only recoverable from the exit status and stderr, so both travel with the
  // error rather than being discarded into a bare sentence.
  assert.match(source, /agy exited \$\{how\} without a terminal result event/);
  assert.match(
    source,
    /const how = signal \? `on \$\{signal\}` : `with code \$\{code\}`/
  );
  assert.doesNotMatch(
    source,
    /new Error\("agy exited without a terminal result event"\)/
  );

  // A turn that failed because the client had already gone is exactly the case
  // worth seeing, and the streaming path used to return without a word.
  assert.match(
    source,
    /if \(!this\.settled\) this\.turn\.logTurnEnd\("failed", `\$\{message\}\$\{this\.stream\.isWritable\(\) \? "" : " \(client already gone\)"\}`\)/
  );
  const failBlock = source.slice(
    source.indexOf("fail(error: unknown): void {")
  );
  assert.ok(
    failBlock.indexOf("logTurnEnd(") <
      failBlock.indexOf("if (!this.stream.isWritable()) return;"),
    "the failure must be logged before the writability check returns"
  );

  // The close that always follows a completed stream is not the client hanging
  // up, so only an unsettled turn reports an abort.
  assert.match(source, /private settled = false;/);
  assert.match(source, /this\.settled = true;/);
});

test("a Claude orchestrator delegates through Codex, not inside its CLI", () => {
  // Claude acts only through Codex's tools, so an orchestrator spawns with
  // Codex's own multi_agent_v1__spawn_agent inside an `exec` call, exactly as
  // a Codex-served orchestrator does. The CLI has no Agent/Task tool to spawn
  // invisible children with.
  const source = read("runtime/src/providers/claude.ts");
  assert.match(source, /"--tools",\s*builtIns\.join\(","\)/);
  const contract = JSON.parse(read("config/execution-contract.json"));
  assert.deepEqual(contract.providers.claude, {
    spawnTools: [],
    permissionMode: "native",
    delegation: "codex"
  });
});

test("provider bridges import the Runtime-owned telemetry contract", () => {
  for (const sourcePath of [
    "runtime/src/providers/antigravity.ts",
    "runtime/src/providers/claude.ts",
    "runtime/src/providers/copilot.ts",
    "runtime/src/providers/minimax.ts"
  ]) {
    const source = read(sourcePath);
    assert.match(source, /@simulatorlife\/autodev-runtime\/telemetry/);
    assert.doesNotMatch(source, /from ["']\.\.\/telemetry\//);
  }
});

test("no bridge carries a spawn path of its own", () => {
  // Every provider spawns through Codex's own `exec` tool, mirrored unchanged
  // to the CLI bridges by the codex-tools shim. A bridge-side spawn server,
  // session registry or synthetic exec call is a second surface the model
  // cannot tell apart from its own, so none may come back.
  for (const sourcePath of [
    "runtime/src/providers/antigravity.ts",
    "runtime/src/providers/claude.ts",
    "runtime/src/providers/copilot.ts"
  ]) {
    const source = read(sourcePath);
    for (const obsolete of [
      "autodev_spawn",
      "SpawnSessionRegistry",
      "buildSpawnToolCallOutput",
      "spawnShimMcpServer",
      "bridge-spawn"
    ])
      assert.doesNotMatch(
        source,
        new RegExp(obsolete),
        `${sourcePath}: ${obsolete}`
      );
  }
});

// The two `invoke_subagent` step_updates agy really emitted for one dispatch,
// captured from `agy -p ... --output-format stream-json`. The turn ran 45s and
// the child genuinely did the work; the dispatch step reports 43ms.
const AGY_INVOKE_SUBAGENT_STEPS = JSON.parse(
  readFileSync(
    new URL("fixtures/agy-invoke-subagent-steps.json", import.meta.url),
    "utf8"
  )
);

function recordingReporter() {
  const spawns: any[] = [];
  const results: any[] = [];
  return {
    spawns,
    results,
    isSpawnTool: (name: unknown) => name === "invoke_subagent",
    reportSpawns: async (event: unknown) => {
      spawns.push(event);
    },
    reportResults: async (event: unknown) => {
      results.push(event);
    }
  } as unknown as AgentEventReporter & {
    spawns: any[];
    results: any[];
  };
}

test("a dispatch completing is not the child completing", async () => {
  // agy's own numbers: DONE carries duration_seconds 0.043 for a child that ran
  // inside a 45s turn. Closing on that DONE filled the usage tables with ~40ms
  // durations for children that ran for minutes -- a number that looks like a
  // measurement and is not one.
  const [active, done] = AGY_INVOKE_SUBAGENT_STEPS;
  assert.equal(active.state, "ACTIVE");
  assert.equal(done.state, "DONE");
  assert.ok(
    done.duration_seconds < 0.5,
    "the dispatch step is the hand-off, not the child's work"
  );

  const reporter = recordingReporter();
  const tracker = createSpawnTracker(reporter);
  tracker.observeSpawnStep(active);
  assert.equal(reporter.spawns.length, 1);
  assert.deepEqual(
    reporter.spawns[0].children.map(({ role }: any) => role),
    ["research"]
  );

  tracker.observeSpawnStep(done);
  assert.equal(
    reporter.results.length,
    0,
    "a completed dispatch must not close the child it started"
  );
  assert.equal(tracker.openSpawnCount(), 1);

  // The child closes with the turn that contained it, which bounds its runtime
  // honestly: it ran somewhere inside that window.
  tracker.flushSpawns("success");
  assert.equal(reporter.results.length, 1);
  assert.equal(reporter.results[0].outcome, "success");
  assert.equal(tracker.openSpawnCount(), 0);
});

test("a dispatch that never happened closes immediately as a failure", async () => {
  // Any terminal state other than DONE means the hand-off itself failed. That
  // child was never dispatched, so there is no runtime to bound and nothing to
  // wait for.
  const [active] = AGY_INVOKE_SUBAGENT_STEPS;
  for (const state of ["ERROR", "CANCELLED"]) {
    const reporter = recordingReporter();
    const tracker = createSpawnTracker(reporter);
    tracker.observeSpawnStep(active);
    tracker.observeSpawnStep({ ...active, state });
    assert.equal(reporter.results.length, 1, state);
    assert.equal(reporter.results[0].outcome, "failure", state);
    assert.equal(tracker.openSpawnCount(), 0, state);
  }
});

test("one dispatch is reported once however many updates it emits", async () => {
  const [active, done] = AGY_INVOKE_SUBAGENT_STEPS;
  const reporter = recordingReporter();
  const tracker = createSpawnTracker(reporter);
  for (const update of [active, active, done, active])
    tracker.observeSpawnStep(update);
  assert.equal(
    reporter.spawns.length,
    1,
    "a repeated ACTIVE is the same dispatch, not another one"
  );
  tracker.flushSpawns("success");
  assert.equal(reporter.results.length, 1);
});

test("a tool that is not the spawn tool is ignored entirely", async () => {
  const reporter = recordingReporter();
  const tracker = createSpawnTracker(reporter);
  // `manage_subagents` is how agy tends its children afterwards; it dispatches
  // nothing and must not be counted as a spawn.
  tracker.observeSpawnStep({
    step_index: 9,
    state: "ACTIVE",
    step_type: "tool",
    tool_name: "manage_subagents"
  });
  tracker.observeSpawnStep({
    step_index: 9,
    state: "DONE",
    step_type: "tool",
    tool_name: "manage_subagents"
  });
  assert.equal(reporter.spawns.length, 0);
  assert.equal(reporter.results.length, 0);
});

test("a pending child's telemetry close cannot fire twice", async () => {
  // The request handler's disconnect path and its normal-completion path both
  // can reach flushSpawns for the same turn (a close event racing the
  // response finishing). The Map-delete-on-close in createSpawnTracker is
  // what has to make a second close a no-op instead of a second report.
  const [active] = AGY_INVOKE_SUBAGENT_STEPS;
  const reporter = recordingReporter();
  const tracker = createSpawnTracker(reporter);
  tracker.observeSpawnStep(active);
  tracker.flushSpawns("success");
  assert.equal(reporter.results.length, 1);
  assert.equal(tracker.openSpawnCount(), 0);
  tracker.flushSpawns("success");
  assert.equal(
    reporter.results.length,
    1,
    "closing an already-closed spawn must not report a second time"
  );
});

test("pending-child tracking works even when no AgentEventReporter exists, but reports nothing", async () => {
  // resolveAgentEventReporter returns null whenever the router's telemetry
  // headers are absent (or the caller is not the router). Losing pending-child
  // tracking in that case is exactly what let the bridge kill agy mid-delegation
  // with no explanation, so the tracker must still recognize agy's own spawn
  // tool without a reporter -- while still sending no telemetry anywhere, since
  // nothing authorized a report.
  const [active, done] = AGY_INVOKE_SUBAGENT_STEPS;
  const tracker = createSpawnTracker(null);
  tracker.observeSpawnStep(active);
  assert.equal(
    tracker.openSpawnCount(),
    1,
    "agy's own spawn tool name is recognized without a reporter"
  );
  tracker.observeSpawnStep(done);
  assert.equal(
    tracker.openSpawnCount(),
    1,
    "DONE still does not close the child without a reporter"
  );
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
  const [active, done] = AGY_INVOKE_SUBAGENT_STEPS;
  const opened = spawnedChildren(active);
  const closed = spawnedChildren(done);

  assert.deepEqual(opened, [
    {
      id: "b1655ed9-e48d-4f88-9c51-e8fbf1a8b9b1",
      role: "research",
      model: null,
      logUri:
        "file:///Users/henrykirk/.gemini/antigravity-cli/brain/b1655ed9-e48d-4f88-9c51-e8fbf1a8b9b1/.system_generated/logs/transcript.jsonl"
    }
  ]);
  // The same child, recognised across both steps by identity.
  assert.ok(opened[0] && closed[0]);
  assert.equal(closed[0].id, opened[0].id);
  // The role is the archetype, not the human-facing "Line Counter" label.
  assert.equal(opened[0].role, "research");
});

test("a batch entry with no id of its own still gets a stable positional one", () => {
  // Older agy builds, and any entry that omits the field, must keep working.
  const anonymous = {
    step_index: 7,
    subagent_info: {
      subagents: [{ type_name: "explorer" }, { type_name: "worker" }]
    }
  };
  assert.deepEqual(spawnedChildren(anonymous), [
    { id: "s7.0", role: "explorer", model: null, logUri: null },
    { id: "s7.1", role: "worker", model: null, logUri: null }
  ]);
});

test("a known transcript path travels with the child, and its absence costs nothing", () => {
  // A CLI-delegated child leaves no rollout the router can read, so the CLI's
  // own transcript is the only pointer to what it actually did.
  const reporter = resolveAgentEventReporter({
    "x-autodev-agent-events-url": "http://127.0.0.1:1/v1/agent-events",
    "x-autodev-request-id": "req-1",
    "x-autodev-subagent-spawn-tools": "invoke_subagent"
  });
  assert.ok(reporter);
  const [withUri] = reporter!.childEvents("subagent_spawn", {
    tool: "invoke_subagent",
    children: [{ id: "c1", role: "research", logUri: "file:///tmp/t.jsonl" }],
    status: "started"
  });
  assert.ok(withUri);
  assert.deepEqual(withUri.children, [
    { id: "c1", logUri: "file:///tmp/t.jsonl" }
  ]);

  const [without] = reporter!.childEvents("subagent_spawn", {
    tool: "invoke_subagent",
    children: [{ id: "c1", role: "research" }],
    status: "started"
  });
  assert.ok(without);
  assert.deepEqual(without.children, [{ id: "c1" }]);
});

test("the Antigravity bridge builds the agent environment without spawn identity", () => {
  const source = read("runtime/src/providers/antigravity.ts");
  // agy reads MCP servers from the invocation's HOME; the bridge isolates that
  // registry and no longer threads a spawn session through the environment.
  assert.match(
    source,
    /function agyEnvironment\(isolatedHome: string \| null = null\)/
  );
  // The spawned child's environment must still be built by agyEnvironment and
  // passed through withAutoDevOtelResourceContext with the workspace and role.
  assert.match(
    source,
    /env: withAutoDevOtelResourceContext\(\s*\{[\s\S]{0,600}?agyEnvironment\(isolatedState\.isolatedHome\)[\s\S]{0,600}?\},\s*workspaceKey,\s*agentRole\s*\)/
  );
  // The identity is environment-only: setting it must not write repository
  // configuration, which would persist into a read-only workspace.
  assert.match(source, /\.\.\.gitCommitIdentityEnv\(\{\s*role: agentRole,/u);
});
