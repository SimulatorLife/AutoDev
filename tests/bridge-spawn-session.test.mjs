import assert from "node:assert/strict";
import test from "node:test";

import { SpawnSessionRegistry, UNIDENTIFIED_SESSION_SCOPE } from "../scripts/codex/lib/bridge-spawn-session.mjs";

const registry = (overrides = {}) => {
  let clock = 1000;
  const r = new SpawnSessionRegistry({ now: () => clock, ...overrides });
  return [ r, { advance: (ms) => { clock += ms; } } ];
};

test("a session the router could not identify never collects delegation state", () => {
  // The router falls back to one process-wide key when a request carries no
  // session identity. Collecting under that key would attach one Codex
  // conversation's delegation to another conversation's turn.
  assert.equal(SpawnSessionRegistry.canHold("real-session", "identified"), true);
  assert.equal(SpawnSessionRegistry.canHold("shared-key", UNIDENTIFIED_SESSION_SCOPE), false);
  assert.equal(SpawnSessionRegistry.canHold("", "identified"), false);
  assert.equal(SpawnSessionRegistry.canHold(null, "identified"), false);
  assert.equal(SpawnSessionRegistry.canHold(undefined, undefined), false);
});

test("delegation is collected against the turn that asked, and drained by it", () => {
  const [ r ] = registry();
  r.open("s1", { orchestrator: true });

  const first = r.record("s1", [ { agent_type: "explorer", message: "audit" }, { message: "no role" } ]);
  assert.equal(first.accepted, true);
  assert.equal(first.count, 2);
  assert.equal(first.roles, "default, explorer");

  // A second call in the same turn adds to the batch rather than replacing it.
  assert.equal(r.record("s1", [ { agent_type: "validator", message: "verify" } ]).accepted, true);

  assert.deepEqual(r.close("s1"), [
    { agentType: "explorer", message: "audit" },
    { agentType: null, message: "no role" },
    { agentType: "validator", message: "verify" },
  ]);
  // Closing is what hands the batch to the response, so it must not leave the
  // entry behind for the next turn on the same key.
  assert.deepEqual(r.close("s1"), []);
  assert.equal(r.status().held, 0);
});

test("a refusal is a sentence the model can act on, not a transport error", () => {
  const [ r ] = registry();
  assert.match(r.record("no-such-session", [ { message: "x" } ]).message, /Do the work directly/);

  r.open("leaf", { orchestrator: false });
  const leaf = r.record("leaf", [ { message: "x" } ]);
  assert.equal(leaf.accepted, false);
  assert.match(leaf.message, /may not delegate/);

  r.open("orch", { orchestrator: true });
  const empty = r.record("orch", [ { message: "   " }, { agent_type: "explorer" } ]);
  assert.equal(empty.accepted, false);
  assert.match(empty.message, /non-empty/);
  assert.deepEqual(r.close("orch"), [], "a refused batch dispatches nothing");
});

test("only an orchestrator turn is offered the tool at all", () => {
  const [ r ] = registry();
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
  const [ r ] = registry();
  r.open("s1", { orchestrator: true });
  r.record("s1", [ { message: "first turn" } ]);
  r.open("s1", { orchestrator: true });
  assert.deepEqual(r.close("s1"), []);
});

test("an entry whose turn died without closing is swept", () => {
  const [ r, clock ] = registry({ idleMs: 5000 });
  r.open("s1", { orchestrator: true });
  clock.advance(5001);
  assert.deepEqual(r.sweep(), [ "s1" ]);
  assert.equal(r.mayDelegate("s1"), false);
});

test("the registry is capped so a leak cannot grow without bound", () => {
  const [ r, clock ] = registry({ maxSessions: 2 });
  r.open("s1", { orchestrator: true });
  clock.advance(10);
  r.open("s2", { orchestrator: true });
  clock.advance(10);
  r.open("s3", { orchestrator: true });
  assert.equal(r.status().held, 2);
  assert.equal(r.mayDelegate("s1"), false, "the least recently used entry was dropped");
  assert.equal(r.mayDelegate("s3"), true);
});

test("status is a count, not a transcript", () => {
  const [ r ] = registry({ maxSessions: 8 });
  r.open("s1", { orchestrator: true });
  r.record("s1", [ { agent_type: "explorer", message: "a secret task in /private/path" } ]);
  const status = r.status();
  assert.deepEqual(status, { held: 1, maxSessions: 8 });
  assert.doesNotMatch(JSON.stringify(status), /secret|private/);
});
