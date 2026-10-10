import assert from "node:assert/strict";
import test from "node:test";

import * as agents from "@simulatorlife/autodev-runtime/agents";
import {
  EXEC_TOOL,
  MULTI_AGENT_SPAWN_TOOL
} from "@simulatorlife/autodev-runtime/shared/tool-names";
import {
  buildSpawnScript,
  carriesPendingSpawnResult,
  execToolCallSseEvents,
  mintCallId,
  mintCallItemId,
  parseSpawnResults,
  pendingToolCallOutputs
} from "../runtime/src/agents/spawn-tools.ts";

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

test("recovery script closes only terminal children owned by the parent", async () => {
  const source = agents.buildRecoveryScript("parent-1");
  const closed: string[] = [];
  const output: unknown[] = [];
  const tools = {
    mcp__codex_app__read_thread: async () => ({
      content: [
        {
          text: JSON.stringify({
            turns: [
              {
                items: [
                  {
                    type: "collabAgentToolCall",
                    senderThreadId: "other-parent",
                    receiverThreadIds: ["foreign"]
                  },
                  {
                    type: "collabAgentToolCall",
                    senderThreadId: "parent-1",
                    receiverThreadIds: ["done", "running"]
                  }
                ]
              }
            ]
          })
        }
      ]
    }),
    multi_agent_v1__wait_agent: async ({ targets }: { targets: string[] }) => ({
      status: {
        [targets[0]!]: targets[0] === "done" ? { completed: null } : "running"
      }
    }),
    multi_agent_v1__close_agent: async ({ target }: { target: string }) => {
      closed.push(target);
      return { status: "closed" };
    }
  };
  const run = new Function(
    "tools",
    "text",
    `return (async () => {\n${source}\n})();`
  );
  await run(tools, (value: string) => output.push(JSON.parse(value)));
  assert.deepEqual(closed, ["done"]);
  assert.deepEqual(output, [
    {
      recovery_status: "closed",
      child_id: "done",
      previous_status: { completed: null }
    }
  ]);
});

test("a bridge spawn batch runs owner-scoped terminal-handle recovery first", () => {
  const source = buildSpawnScript([{ message: "x" }], {
    recoverParentId: "parent-1"
  });
  assert.match(source, /mcp__codex_app__read_thread/);
  assert.match(source, /senderThreadId === recoveryParentId/);
  assert.match(source, /multi_agent_v1__close_agent/);
  assert.match(source, /recoveryParentId = "parent-1"/);
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

test("spawn results are read out of the observed custom_tool_call_output shape", () => {
  // Verbatim from a live run: a preamble part, then one part per text() call.
  const results = parseSpawnResults([
    {
      type: "input_text",
      text: "Script completed\nWall time 0.2 seconds\nOutput:\n"
    },
    {
      type: "input_text",
      text: '{"agent_id":"01a07e99-adb4-7103-beb0-7ff796cf237b","nickname":"CodebaseFinder"}'
    },
    {
      type: "input_text",
      text: '{"agent_id":"01a07e99-ad5f-7053-9b2d-d66107178e2a","nickname":"VerificationAuditor"}'
    }
  ]);
  assert.deepEqual(results, [
    {
      agentId: "01a07e99-adb4-7103-beb0-7ff796cf237b",
      nickname: "CodebaseFinder"
    },
    {
      agentId: "01a07e99-ad5f-7053-9b2d-d66107178e2a",
      nickname: "VerificationAuditor"
    }
  ]);
});

test("several results in one part are read, and non-result lines cost nothing", () => {
  const results = parseSpawnResults([
    {
      type: "input_text",
      text: 'Script completed\n{"agent_id":"a","nickname":"One"}\nnot json\n{"unrelated":true}\n{"agent_id":"b"}'
    }
  ]);
  assert.deepEqual(results, [
    { agentId: "a", nickname: "One" },
    { agentId: "b", nickname: null }
  ]);
});

test("a failed script yields no results rather than throwing", () => {
  assert.deepEqual(
    parseSpawnResults([
      { type: "input_text", text: "Script failed\nScript error:\nboom" }
    ]),
    []
  );
  assert.deepEqual(parseSpawnResults(undefined), []);
  assert.deepEqual(parseSpawnResults("plain string"), []);
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
  assert.match(completed.item.input, /recoveryParentId = "parent-1"/);
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
