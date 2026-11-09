import assert from "node:assert/strict";
import test from "node:test";

import {
  openSpawnSession,
  SpawnSessionRegistry,
  UNIDENTIFIED_SESSION_SCOPE
} from "@simulatorlife/autodev-runtime/agents";

const registry = (
  overrides: Record<string, unknown> = {}
): [SpawnSessionRegistry, { advance: (ms: number) => void }] => {
  let clock = 1000;
  const r = new SpawnSessionRegistry({ now: () => clock, ...overrides });
  return [
    r,
    {
      advance: (ms: number) => {
        clock += ms;
      }
    }
  ];
};

test("a session the router could not identify never collects delegation state", () => {
  // The router falls back to one process-wide key when a request carries no
  // session identity. Collecting under that key would attach one Codex
  // conversation's delegation to another conversation's turn.
  assert.equal(
    SpawnSessionRegistry.canHold("real-session", "identified"),
    true
  );
  assert.equal(
    SpawnSessionRegistry.canHold("shared-key", UNIDENTIFIED_SESSION_SCOPE),
    false
  );
  assert.equal(SpawnSessionRegistry.canHold("", "identified"), false);
  assert.equal(SpawnSessionRegistry.canHold(null, "identified"), false);
  assert.equal(SpawnSessionRegistry.canHold(undefined, undefined), false);
});

test("delegation is collected against the turn that asked, and drained by it", () => {
  const [r] = registry();
  r.open("s1", { orchestrator: true });

  const first = r.record("s1", [
    { agent_type: "explorer", message: "audit" },
    { message: "no role" }
  ]);
  assert.equal(first.accepted, true);
  assert.equal(first.count, 2);
  assert.equal(first.roles, "default, explorer");

  // A second call in the same turn adds to the batch rather than replacing it.
  assert.equal(
    r.record("s1", [{ agent_type: "validator", message: "verify" }]).accepted,
    true
  );

  assert.deepEqual(r.close("s1"), [
    { agentType: "explorer", message: "audit" },
    { agentType: null, message: "no role" },
    { agentType: "validator", message: "verify" }
  ]);
  // Closing is what hands the batch to the response, so it must not leave the
  // entry behind for the next turn on the same key.
  assert.deepEqual(r.close("s1"), []);
  assert.equal(r.status().held, 0);
});

test("a refusal is a sentence the model can act on, not a transport error", () => {
  const [r] = registry();
  assert.match(
    r.record("no-such-session", [{ message: "x" }]).message ?? "",
    /no child was created/
  );

  r.open("leaf", { orchestrator: false });
  const leaf = r.record("leaf", [{ message: "x" }]);
  assert.equal(leaf.accepted, false);
  assert.match(leaf.message ?? "", /may not delegate/);

  r.open("orch", { orchestrator: true });
  const empty = r.record("orch", [
    { message: "   " },
    { agent_type: "explorer" }
  ]);
  assert.equal(empty.accepted, false);
  assert.match(empty.message ?? "", /non-empty/);
  assert.deepEqual(r.close("orch"), [], "a refused batch dispatches nothing");
});

test("only an orchestrator turn is offered the tool at all", () => {
  const [r] = registry();
  r.open("orch", { orchestrator: true });
  r.open("leaf", { orchestrator: false });
  assert.equal(r.mayDelegate("orch"), true);
  assert.equal(r.mayDelegate("leaf"), false);
  // A CLI that outlived its request finds nothing to attach to.
  assert.equal(r.mayDelegate("gone"), false);
});

test("re-opening a key starts a fresh turn rather than inheriting the last one", () => {
  // Carrying children forward across turns on the same conversation would
  // spawn the previous turn's delegation a second time.
  const [r] = registry();
  r.open("s1", { orchestrator: true });
  r.record("s1", [{ message: "first turn" }]);
  r.open("s1", { orchestrator: true });
  assert.deepEqual(r.close("s1"), []);
});

test("an entry whose turn died without closing is swept", () => {
  const [r, clock] = registry({ idleMs: 5000 });
  r.open("s1", { orchestrator: true });
  clock.advance(5001);
  assert.deepEqual(r.sweep(), ["s1"]);
  assert.equal(r.mayDelegate("s1"), false);
});

test("the registry is capped so a leak cannot grow without bound", () => {
  const [r, clock] = registry({ maxSessions: 2 });
  r.open("s1", { orchestrator: true });
  clock.advance(10);
  r.open("s2", { orchestrator: true });
  clock.advance(10);
  r.open("s3", { orchestrator: true });
  assert.equal(r.status().held, 2);
  assert.equal(
    r.mayDelegate("s1"),
    false,
    "the least recently used entry was dropped"
  );
  assert.equal(r.mayDelegate("s3"), true);
});

test("status is a count, not a transcript", () => {
  const [r] = registry({ maxSessions: 8 });
  r.open("s1", { orchestrator: true });
  r.record("s1", [
    { agent_type: "explorer", message: "a secret task in /private/path" }
  ]);
  const status = r.status();
  assert.deepEqual(status, { held: 1, maxSessions: 8 });
  assert.doesNotMatch(JSON.stringify(status), /secret|private/);
});

test("reusing an existing parked session records target and surfaces reuse in roles", () => {
  const [r] = registry();
  r.registerChildSession({
    childId: "child-parked-123",
    parentId: "s-reuse",
    role: "worker",
    workspace: "/test/workspace",
    status: "parked"
  });
  r.open("s-reuse", { orchestrator: true, workspace: "/test/workspace" });
  const res = r.record("s-reuse", [
    {
      target: "child-parked-123",
      agent_type: "worker",
      message: "apply second edit wave"
    }
  ]);
  assert.equal(res.accepted, true);
  assert.equal(res.count, 1);
  assert.equal(res.roles, "reuse:child-parked-123 (worker)");
  assert.deepEqual(r.close("s-reuse"), [
    {
      target: "child-parked-123",
      agentType: "worker",
      message: "apply second edit wave"
    }
  ]);
  // Reused child is marked running
  assert.equal(r.getChildSession("child-parked-123")?.status, "running");
});

test("negative: reusing arbitrary or unverified child identifier is rejected", () => {
  const [r] = registry();
  r.open("s-unverified", { orchestrator: true });
  const res = r.record("s-unverified", [
    { target: "unverified-child-999", message: "attempt unverified reuse" }
  ]);
  assert.equal(res.accepted, false);
  assert.match(
    res.message ?? "",
    /not a verified subagent owned by this session/
  );
});

test("negative: reusing child owned by a different parent is rejected", () => {
  const [r] = registry();
  r.registerChildSession({
    childId: "child-other-parent",
    parentId: "parent-alpha",
    role: "worker",
    workspace: "/test/workspace",
    status: "parked"
  });
  r.open("parent-beta", { orchestrator: true, workspace: "/test/workspace" });
  const res = r.record("parent-beta", [
    { target: "child-other-parent", message: "attempt cross-parent hijack" }
  ]);
  assert.equal(res.accepted, false);
  assert.match(res.message ?? "", /belongs to a different parent session/);
});

test("negative: reusing child from a different workspace is rejected", () => {
  const [r] = registry();
  r.registerChildSession({
    childId: "child-diff-ws",
    parentId: "parent-ws",
    role: "worker",
    workspace: "/repo/frontend",
    status: "parked"
  });
  r.open("parent-ws", { orchestrator: true, workspace: "/repo/backend" });
  const res = r.record("parent-ws", [
    { target: "child-diff-ws", message: "attempt cross-workspace reuse" }
  ]);
  assert.equal(res.accepted, false);
  assert.match(
    res.message ?? "",
    /subagent workspace.*does not match requesting parent workspace/
  );
});

test("negative: reusing child with incompatible role is rejected", () => {
  const [r] = registry();
  r.registerChildSession({
    childId: "child-explorer",
    parentId: "parent-role",
    role: "explorer",
    workspace: "/test/workspace",
    status: "parked"
  });
  r.open("parent-role", { orchestrator: true, workspace: "/test/workspace" });
  const res = r.record("parent-role", [
    {
      target: "child-explorer",
      agent_type: "worker",
      message: "attempt role mismatch"
    }
  ]);
  assert.equal(res.accepted, false);
  assert.match(
    res.message ?? "",
    /subagent role.*is incompatible with requested role/
  );
});

test("negative: reusing child that is currently running is rejected", () => {
  const [r] = registry();
  r.registerChildSession({
    childId: "child-running",
    parentId: "parent-running",
    role: "worker",
    workspace: "/test/workspace",
    status: "running"
  });
  r.open("parent-running", {
    orchestrator: true,
    workspace: "/test/workspace"
  });
  const res = r.record("parent-running", [
    { target: "child-running", message: "attempt concurrent reuse" }
  ]);
  assert.equal(res.accepted, false);
  assert.match(
    res.message ?? "",
    /subagent is currently running and cannot accept follow-up input/
  );
});

test("openSpawnSession scans turn payload to discover and verify spawned children for reuse", () => {
  const [r] = registry();
  const headers = {
    "x-autodev-session-id": "parent-turn-123",
    "x-autodev-session-scope": "session"
  };
  const payload = {
    input: [
      {
        type: "CollabAgentToolCall",
        tool: "spawn_agent",
        sender_thread_id: "parent-turn-123",
        receiver_agents: [
          { thread_id: "child-from-payload-1", agent_role: "explorer" }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: '<subagent_notification>\n{"agent_path":"child-from-payload-1","status":{"completed":"Found all files"}}\n</subagent_notification>'
          }
        ]
      }
    ]
  };

  const opened = openSpawnSession(headers, r, {
    orchestrator: true,
    role: "orchestrator",
    workspace: "/workspace/repo",
    payload
  });
  assert.equal(opened, "parent-turn-123");

  const child = r.getChildSession("child-from-payload-1");
  assert.ok(child, "child must be discovered from payload");
  assert.equal(child?.role, "explorer");
  assert.equal(child?.status, "completed");
  assert.equal(child?.parentId, "parent-turn-123");
  assert.equal(child?.workspace, "/workspace/repo");

  // Follow-up reuse succeeds without manual registerChildSession
  const res = r.record("parent-turn-123", [
    {
      target: "child-from-payload-1",
      agent_type: "explorer",
      message: "investigate line 40"
    }
  ]);
  assert.equal(res.accepted, true);
  assert.equal(res.roles, "reuse:child-from-payload-1 (explorer)");
});

test("newly spawned child from CollabAgentToolCall starts as running until notification", () => {
  const [r] = registry();
  const headers = {
    "x-autodev-session-id": "parent-active-1",
    "x-autodev-session-scope": "session"
  };
  const payload = {
    input: [
      {
        type: "CollabAgentToolCall",
        tool: "spawn_agent",
        sender_thread_id: "parent-active-1",
        receiver_agents: [
          { thread_id: "child-running-1", agent_role: "explorer" }
        ]
      }
    ]
  };

  openSpawnSession(headers, r, {
    orchestrator: true,
    role: "orchestrator",
    workspace: "/workspace/repo",
    payload
  });

  const child = r.getChildSession("child-running-1");
  assert.ok(child, "child must be discovered");
  assert.equal(
    child?.status,
    "running",
    "spawned child must start running, not completed"
  );

  // Attempting to reuse a running subagent is rejected
  const res = r.record("parent-active-1", [
    {
      target: "child-running-1",
      agent_type: "explorer",
      message: "do more work"
    }
  ]);
  assert.equal(res.accepted, false);
  assert.match(res.message ?? "", /subagent is currently running/);
});

test("notification with agent_role sets role and completed child with default role can adopt requested role on reuse", () => {
  const [r] = registry();
  const headers = {
    "x-autodev-session-id": "parent-adopt-1",
    "x-autodev-session-scope": "session"
  };
  const payload = {
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: '<subagent_notification>\n{"agent_path":"child-notif-role","agent_role":"explorer","status":{"completed":"Done!"}}\n</subagent_notification>'
          },
          {
            type: "input_text",
            text: '<subagent_notification>\n{"agent_path":"child-generic-role","status":{"completed":"Done!"}}\n</subagent_notification>'
          }
        ]
      }
    ]
  };

  openSpawnSession(headers, r, {
    orchestrator: true,
    role: "orchestrator",
    workspace: "/workspace/repo",
    payload
  });

  const child1 = r.getChildSession("child-notif-role");
  assert.ok(child1);
  assert.equal(child1?.role, "explorer");
  assert.equal(child1?.status, "completed");

  const child2 = r.getChildSession("child-generic-role");
  assert.ok(child2);
  assert.equal(child2?.role, "default");
  assert.equal(child2?.status, "completed");

  // child2 with default role can be reused as a worker and adopts worker
  const res = r.record("parent-adopt-1", [
    {
      target: "child-generic-role",
      agent_type: "worker",
      message: "implement step 1"
    }
  ]);
  assert.equal(res.accepted, true);
  assert.equal(res.roles, "reuse:child-generic-role (worker)");
  assert.equal(child2?.role, "worker");
});
