import assert from "node:assert/strict";
import test from "node:test";

import * as agents from "@simulatorlife/autodev-runtime/agents";
import {
  EXEC_TOOL,
  MULTI_AGENT_SPAWN_TOOL
} from "@simulatorlife/autodev-runtime/shared/tool-names";

import { createAgentActivityTracker } from "../src/agents/agent-activity.ts";
import {
  buildSpawnScript,
  carriesPendingSpawnResult,
  execToolCallSseEvents,
  mintCallId,
  mintCallItemId,
  pendingToolCallOutputs
} from "../src/agents/spawn-tools.ts";
import {
  ConcurrencyManager,
  getDefaultConcurrencyManager,
  setDefaultConcurrencyManager
} from "../src/router/concurrency/index.ts";

type ScriptTask = {
  agent_type?: string;
  message: string;
};

function scriptTasks(source: string): ScriptTask[] {
  const match = source.match(/^const tasks = (.+);$/m);
  assert.ok(match, "spawn script contains a serialized task array");
  return JSON.parse(match[1]!) as ScriptTask[];
}

// The literals below are not style choices -- each was read off a live Codex
// 0.153.1 or a recorded rollout of a GPT-served turn that spawned successfully.
// A change here is a change to what Codex accepts, so pin them.
test("the spawn call targets Codex's own code-mode tools", () => {
  assert.equal(EXEC_TOOL, "exec");
  assert.equal(MULTI_AGENT_SPAWN_TOOL, "multi_agent_v1__spawn_agent");
});

test("the agents facade exports bridge operations, not spawn internals", () => {
  assert.equal(typeof agents.buildRecoveryScript, "function");
  assert.equal(typeof agents.buildSpawnToolCallOutput, "function");
  for (const name of [
    "buildSpawnScript",
    "carriesPendingSpawnResult",
    "execToolCallSseEvents",
    "mintCallId",
    "mintCallItemId",
    "parseSpawnResults",
    "pendingToolCallOutputs"
  ]) {
    assert.equal(
      Object.hasOwn(agents, name),
      false,
      `${name} remains an implementation detail of spawn-tools`
    );
  }
});

test("a batch settles through one Promise.allSettled so one rejection preserves siblings", () => {
  const source = buildSpawnScript([
    { agentType: "explorer", message: "audit the catalogue" },
    { agentType: "validator", message: "run the focused tests" }
  ]);
  assert.deepEqual(scriptTasks(source), [
    { agent_type: "explorer", message: "audit the catalogue" },
    { agent_type: "validator", message: "run the focused tests" }
  ]);
  assert.match(source, /^\/\/ @exec: \{"yield_time_ms":60000\}\n/);
  assert.match(
    source,
    /const out = await Promise\.allSettled\(tasks\.map\(\(t\) => tools\.multi_agent_v1__spawn_agent\(t\)\)\);/
  );
  assert.match(source, /result\.status === "fulfilled"/);
  assert.match(source, /spawn_status: "created"/);
  assert.match(source, /spawn_status: "rejected"/);
  // One `tasks` array, not one call per child: a twelve-way fan-out must stay a
  // single tool call.
  assert.equal(source.match(/tools\.multi_agent_v1__spawn_agent/g)?.length, 1);
});

test("a rejected child is reported without hiding successfully created siblings", async () => {
  const source = buildSpawnScript([
    { agentType: "explorer", message: "first" },
    { agentType: "validator", message: "second" }
  ]);
  const values: unknown[] = [];
  const tools = {
    [MULTI_AGENT_SPAWN_TOOL]: async ({ message }: { message: string }) => {
      if (message === "second") throw new Error("thread limit reached");
      return { agent_id: "child-1", nickname: "Explorer" };
    }
  };
  const run = new Function(
    "tools",
    "text",
    `return (async () => {\n${source}\n})();`
  );
  await run(tools, (value: string) => values.push(JSON.parse(value)));
  assert.deepEqual(values, [
    { spawn_status: "created", agent_id: "child-1", nickname: "Explorer" },
    { spawn_status: "rejected", agent_id: null, error: "thread limit reached" }
  ]);
});

test("the role travels as agent_type, because `agent` is silently ignored by Codex", () => {
  const source = buildSpawnScript([{ agentType: "explorer", message: "x" }]);
  assert.deepEqual(scriptTasks(source), [
    { agent_type: "explorer", message: "x" }
  ]);
});

test("the role TOML is the child capability selector, not per-call skill metadata", () => {
  for (const agentType of ["worker", "browser-tester", "docs-researcher"]) {
    const source = buildSpawnScript([{ agentType, message: "x" }]);
    assert.deepEqual(scriptTasks(source), [
      { agent_type: agentType, message: "x" }
    ]);
  }
});

test("a child with no role spawns without one rather than inventing a default", () => {
  const source = buildSpawnScript([{ message: "just do it" }]);
  assert.deepEqual(scriptTasks(source), [{ message: "just do it" }]);
});

test("a prompt cannot break out of the generated script", () => {
  // The script is source text, so a prompt carrying quotes, newlines, a closing
  // brace or a comment terminator could end the string and append statements of
  // its own. What makes that safe is confinement: the prompt has to come back
  // out as one string value, with the array's shape intact. Grepping the source
  // for the injected call would not prove that -- the call appears either way,
  // inert inside the literal -- so evaluate the data instead.
  const nasty = 'he said "hi"\n*/ } ]; await tools.evil(); //';
  const source = buildSpawnScript([
    { agentType: "explorer", message: nasty },
    { agentType: "validator", message: "benign" }
  ]);

  const tasks = scriptTasks(source);
  assert.deepEqual(tasks, [
    { agent_type: "explorer", message: nasty },
    { agent_type: "validator", message: "benign" }
  ]);

  // And the surrounding script still has exactly the one spawn call it wrote.
  assert.equal(source.match(/tools\.multi_agent_v1__spawn_agent/g)?.length, 1);
  assert.doesNotThrow(
    () => new Function(`return (async () => {\n${source}\n});`)
  );
});

test("an empty batch is a caller bug, not an empty script", () => {
  assert.throws(() => buildSpawnScript([]), /at least one child/);
});

test("the yield budget covers a slow batch, not a child's lifetime", () => {
  assert.match(
    buildSpawnScript([{ message: "x" }], { yieldTimeMs: 120_000 }),
    /"yield_time_ms":120000/
  );
});

test("call ids are stable per session and unique per call", () => {
  assert.equal(mintCallId("sess-a", 1), mintCallId("sess-a", 1));
  assert.notEqual(mintCallId("sess-a", 1), mintCallId("sess-a", 2));
  assert.notEqual(mintCallId("sess-a", 1), mintCallId("sess-b", 1));
  // The raw session key must not travel back through the model's context.
  assert.doesNotMatch(mintCallId("sess-a", 1), /sess-a/);
  assert.notEqual(mintCallItemId(), mintCallItemId());
});

test("a collected batch becomes one indexed Codex spawn tool call", () => {
  const output = agents.buildSpawnToolCallOutput(
    [{ agentType: "explorer", message: "audit" }, { message: "verify" }],
    "parent-1",
    4
  );

  assert.ok(output);
  assert.equal(output.childCount, 2);
  const [, completed] = output.events[3];
  assert.equal(completed.output_index, 4);
  assert.equal(completed.item.call_id, mintCallId("parent-1", 4));
  assert.deepEqual(scriptTasks(completed.item.input), [
    { agent_type: "explorer", message: "audit" },
    { message: "verify" }
  ]);
  assert.equal(agents.buildSpawnToolCallOutput([], "parent-1", 4), null);
});

test("the exec call is emitted as a complete custom_tool_call", () => {
  const source = buildSpawnScript([{ agentType: "explorer", message: "x" }]);
  const events = execToolCallSseEvents({
    itemId: "ctc_1",
    callId: "call_1",
    source,
    outputIndex: 1
  });
  assert.deepEqual(
    events.map(([name]) => name),
    [
      "response.output_item.added",
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "response.output_item.done"
    ]
  );
  const [, added] = events[0];
  assert.equal(added.item.type, "custom_tool_call");
  assert.equal(added.item.name, "exec");
  assert.equal(added.item.call_id, "call_1");
  assert.equal(added.item.status, "in_progress");
  // The arguments are known up front, so the call is never half-written: a
  // truncated script would still be executed by Codex.
  assert.equal(added.item.input, "");
  const [, done] = events[3];
  assert.equal(done.item.status, "completed");
  assert.equal(done.item.input, source);
  assert.equal(done.output_index, 1);
  assert.equal(
    events.every(
      ([, payload]) =>
        payload.output_index === 1 ||
        ("item_id" in payload && payload.item_id === "ctc_1")
    ),
    true
  );
});

test("Codex's returned tool output is matched back by call id", () => {
  const input = [
    { type: "message", role: "user", content: [] },
    {
      type: "custom_tool_call_output",
      call_id: "call_1",
      output: [{ type: "input_text", text: "{}" }]
    },
    { type: "function_call_output", call_id: "call_2", output: "plain" }
  ];
  const outputs = pendingToolCallOutputs(input);
  assert.deepEqual([...outputs.keys()], ["call_1", "call_2"]);
  assert.equal(outputs.get("call_2"), "plain");
  assert.equal(carriesPendingSpawnResult({ input }), true);
});

test("Codex tool outputs must be records, not array-shaped objects", () => {
  const arrayOutput = Object.assign([], {
    type: "custom_tool_call_output",
    call_id: "call_1",
    output: "not a record"
  });

  assert.deepEqual(pendingToolCallOutputs([arrayOutput]), new Map());
  assert.equal(carriesPendingSpawnResult({ input: [arrayOutput] }), false);
});

test("a turn with no pending result is not mistaken for a continuation", () => {
  assert.equal(
    carriesPendingSpawnResult({
      input: [{ type: "message", role: "user", content: [] }]
    }),
    false
  );
  assert.equal(carriesPendingSpawnResult({}), false);
  assert.equal(carriesPendingSpawnResult(null), false);
  // An output with no call id cannot be paired, so it must not count.
  assert.equal(
    carriesPendingSpawnResult({
      input: [{ type: "custom_tool_call_output", output: "x" }]
    }),
    false
  );
});

test("reusing a parked session generates send_input and reports reused status", async () => {
  const source = buildSpawnScript([
    { target: "parked-worker-1", message: "continue next test step" }
  ]);
  assert.match(source, /multi_agent_v1__send_input/);
  const values: unknown[] = [];
  const tools = {
    multi_agent_v1__send_input: async ({
      target,
      message
    }: {
      target: string;
      message: string;
    }) => {
      assert.equal(target, "parked-worker-1");
      assert.equal(message, "continue next test step");
      return { status: "accepted", thread_id: target };
    }
  };
  const run = new Function(
    "tools",
    "text",
    `return (async () => {\n${source}\n})();`
  );
  await run(tools, (value: string) => values.push(JSON.parse(value)));
  assert.deepEqual(values, [
    {
      spawn_status: "reused",
      agent_id: "parked-worker-1",
      status: "accepted",
      thread_id: "parked-worker-1"
    }
  ]);
});

test("buildSpawnToolCallItem derives authoritative capacity and emits no preflight without pressure", () => {
  const previousManager = getDefaultConcurrencyManager();
  const manager = new ConcurrencyManager({
    agentActivity: createAgentActivityTracker(),
    initialConfig: {
      file: "/test/codex-concurrency.json",
      maxConcurrentThreadsPerSession: 2
    }
  });
  setDefaultConcurrencyManager(manager);

  try {
    const item = agents.buildSpawnToolCallItem(
      [{ agentType: "explorer", message: "explore" }],
      "parent-call-item",
      "call-item-1"
    );
    assert.ok(item);
    // "parent-call-item" owns no open handle, so the batch fits and no
    // preflight is emitted.
    assert.doesNotMatch(item.input, /recoveryOwned/);
  } finally {
    setDefaultConcurrencyManager(previousManager);
  }
});

type ChildStatus = string | { completed: string | null } | { errored: string };

/** Run a generated script against fake code-mode tools. */
async function runScript(
  source: string,
  statuses: Record<string, ChildStatus>,
  spawnResult: () => unknown = () => ({ agent_id: "fresh" })
) {
  const closed: string[] = [];
  const waited: string[] = [];
  const spawned: unknown[] = [];
  const output: Record<string, unknown>[] = [];
  const tools = {
    multi_agent_v1__wait_agent: async ({
      targets,
      timeout_ms
    }: {
      targets: string[];
      timeout_ms: number;
    }) => {
      assert.ok(timeout_ms >= 10_000, "wait_agent rejects timeouts below 10s");
      waited.push(targets[0]!);
      return { status: { [targets[0]!]: statuses[targets[0]!] ?? "running" } };
    },
    multi_agent_v1__close_agent: async ({ target }: { target: string }) => {
      closed.push(target);
      return { previous_status: statuses[target] };
    },
    multi_agent_v1__spawn_agent: async (payload: unknown) => {
      spawned.push(payload);
      return spawnResult();
    },
    multi_agent_v1__send_input: async ({ target }: { target: string }) => ({
      submission_id: `sent-${target}`
    })
  };
  delete (globalThis as { __autodev_capacity_refusal?: boolean })
    .__autodev_capacity_refusal;
  const run = new Function(
    "tools",
    "text",
    `return (async () => {\n${source}\n})();`
  );
  await run(tools, (value: string) => output.push(JSON.parse(value)));
  delete (globalThis as { __autodev_capacity_refusal?: boolean })
    .__autodev_capacity_refusal;
  return { closed, waited, spawned, output };
}

test("no preflight is emitted while the batch fits the session limit", () => {
  for (const [owned, capacity] of [
    [[], 2],
    [["a"], 2],
    [["a", "b", "c"], null]
  ] as const) {
    assert.equal(
      agents.buildRecoveryScript({
        ownedChildIds: owned,
        maxCapacity: capacity,
        newSlotsNeeded: 1
      }),
      "",
      `owned=${owned.length} capacity=${capacity}`
    );
  }
  assert.equal(
    agents.buildRecoveryScript({
      ownedChildIds: ["a", "b"],
      maxCapacity: 2,
      newSlotsNeeded: 0
    }),
    "",
    "a batch that only reuses handles needs no new slot"
  );
});

test("the preflight never discovers children itself: it acts only on the owned ids it is given", () => {
  const source = agents.buildRecoveryScript({
    ownedChildIds: ["owned-1", "owned-2"],
    maxCapacity: 2,
    newSlotsNeeded: 1
  });
  assert.match(source, /const recoveryOwned = \["owned-1","owned-2"\];/);
  assert.doesNotMatch(source, /read_thread|collabAgentToolCall/);
});

test("a full session evicts its oldest completed child and the spawn proceeds", async () => {
  // The observed lockout: limit 2, a finished worker and a finished validator
  // still open, and a third task to delegate.
  const source = buildSpawnScript(
    [{ agentType: "explorer", message: "next task" }],
    { ownedChildIds: ["worker-old", "validator-new"], maxCapacity: 2 }
  );
  const run = await runScript(source, {
    "worker-old": { completed: "migration done" },
    "validator-new": { completed: "PASS" }
  });
  assert.deepEqual(run.closed, ["worker-old"]);
  assert.equal(run.spawned.length, 1);
  assert.deepEqual(run.output, [
    {
      recovery_status: "partial_result",
      child_id: "worker-old",
      result: "migration done"
    },
    { recovery_status: "evicted", child_id: "worker-old" },
    { recovery_status: "parked", child_id: "validator-new" },
    { spawn_status: "created", agent_id: "fresh" }
  ]);
});

test("errored and shut-down handles are closed before any completed child is evicted", async () => {
  const source = buildSpawnScript([{ message: "x" }], {
    ownedChildIds: ["done", "broken"],
    maxCapacity: 2
  });
  const run = await runScript(source, {
    done: { completed: null },
    broken: { errored: "provider failed" }
  });
  assert.deepEqual(run.closed, ["broken"]);
  assert.equal(run.spawned.length, 1);
});

test("running children are never closed, and a batch that cannot fit is refused without spawning", async () => {
  const source = buildSpawnScript([{ agentType: "worker", message: "x" }], {
    ownedChildIds: ["busy-1", "busy-2"],
    maxCapacity: 2
  });
  const run = await runScript(source, {
    "busy-1": "running",
    "busy-2": "pending_init"
  });
  assert.deepEqual(run.closed, []);
  assert.equal(run.spawned.length, 0);
  assert.deepEqual(run.output, [
    {
      spawn_status: "rejected",
      agent_id: null,
      error: "Concurrency limit reached: no safely evictable capacity exists"
    }
  ]);
});

test("a handle the batch reuses is neither probed nor evicted", async () => {
  const source = buildSpawnScript(
    [
      { target: "reused", message: "follow up" },
      { agentType: "validator", message: "check it" }
    ],
    { ownedChildIds: ["reused", "parked"], maxCapacity: 2 }
  );
  const run = await runScript(source, {
    reused: { completed: null },
    parked: { completed: null }
  });
  assert.deepEqual(run.waited, ["parked"]);
  assert.deepEqual(run.closed, ["parked"]);
  assert.deepEqual(
    run.output.map((line) => line.spawn_status).filter(Boolean),
    ["reused", "created"]
  );
});

test("a child Codex no longer knows holds no slot and is not closed", async () => {
  const source = buildSpawnScript([{ message: "x" }], {
    ownedChildIds: ["gone", "done"],
    maxCapacity: 2
  });
  const run = await runScript(source, {
    gone: "not_found",
    done: { completed: null }
  });
  assert.deepEqual(run.closed, []);
  assert.equal(run.spawned.length, 1);
});
