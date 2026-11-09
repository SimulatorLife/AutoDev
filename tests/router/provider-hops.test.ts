import assert from "node:assert/strict";
import test from "node:test";

import {
  getDefaultProviderHopTracker,
  ProviderHopTracker,
  setDefaultProviderHopTracker
} from "@simulatorlife/autodev-runtime/router/provider-hops";

function tracker(options: { maxTrackedAgents?: number } = {}): ProviderHopTracker {
  return new ProviderHopTracker({
    ...options,
    now: () => new Date("2026-11-09T12:00:00.000Z")
  });
}

test("the first provider an agent is served by is not a hop", () => {
  const hops = tracker();
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "orchestrator",
    workspace: "autodev",
    provider: "claude"
  });

  assert.equal(hop, null);
});

test("the same provider serving an agent again is not a hop", () => {
  const hops = tracker();
  hops.observeServed({
    subject: "thread-1",
    role: "orchestrator",
    workspace: "autodev",
    provider: "claude"
  });
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "orchestrator",
    workspace: "autodev",
    provider: "claude"
  });

  assert.equal(hop, null);
});

test("a different provider serving the agent is a hop that names both sides", () => {
  const hops = tracker();
  hops.observeServed({
    subject: "thread-1",
    role: "orchestrator",
    workspace: "autodev",
    provider: "claude"
  });
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "orchestrator",
    workspace: "autodev",
    provider: "minimax"
  });

  assert.ok(hop);
  assert.equal(hop.fromProvider, "claude");
  assert.equal(hop.toProvider, "minimax");
  assert.equal(hop.role, "orchestrator");
  assert.equal(hop.workspace, "autodev");
  assert.equal(hop.timestamp, "2026-11-09T12:00:00.000Z");
});

test("a provider that failed while serving the request explains the hop as a fallback", () => {
  const hops = tracker();
  hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "claude"
  });
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "minimax",
    passedOver: [
      { provider: "claude", kind: "failed", failureClass: "quota_exhausted" }
    ]
  });

  assert.ok(hop);
  assert.equal(hop.reason, "fallback");
  assert.equal(hop.failureClass, "quota_exhausted");
});

test("a provider that was passed over explains the hop as a skip", () => {
  const hops = tracker();
  hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "claude"
  });
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "minimax",
    passedOver: [
      { provider: "claude", kind: "skipped", failureClass: "provider_disabled" }
    ]
  });

  assert.ok(hop);
  assert.equal(hop.reason, "skipped");
  assert.equal(hop.failureClass, "provider_disabled");
});

test("a change nothing observed explains is a reselection", () => {
  const hops = tracker();
  hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "claude"
  });
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "minimax"
  });

  assert.ok(hop);
  assert.equal(hop.reason, "reselection");
  assert.equal(hop.failureClass, null);
});

test("a provider the request never reached does not explain the hop", () => {
  const hops = tracker();
  hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "claude"
  });
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "minimax",
    passedOver: [
      { provider: "antigravity", kind: "failed", failureClass: "timeout" }
    ]
  });

  assert.ok(hop);
  assert.equal(hop.fromProvider, "claude");
  assert.equal(hop.reason, "reselection");
  assert.equal(hop.failureClass, null);
});

test("an agent with no provider yet reports the hop from the provider the route intended", () => {
  const hops = tracker();
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "minimax",
    passedOver: [
      { provider: "claude", kind: "failed", failureClass: "timeout" }
    ]
  });

  assert.ok(hop);
  assert.equal(hop.fromProvider, "claude");
  assert.equal(hop.toProvider, "minimax");
  assert.equal(hop.reason, "fallback");
  assert.equal(hop.failureClass, "timeout");
});

test("a role change is not a provider hop", () => {
  const hops = tracker();
  hops.observeServed({
    subject: "thread-1",
    role: "orchestrator",
    workspace: null,
    provider: "claude"
  });
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "minimax"
  });

  assert.equal(hop, null);
});

test("two agents on the same provider are tracked separately", () => {
  const hops = tracker();
  hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "claude"
  });
  const hop = hops.observeServed({
    subject: "thread-2",
    role: "worker",
    workspace: null,
    provider: "minimax"
  });

  assert.equal(hop, null);
});

test("a failure class outside the bounded vocabulary is not carried by the hop", () => {
  const hops = tracker();
  hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "claude"
  });
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "minimax",
    passedOver: [
      { provider: "claude", kind: "failed", failureClass: "upstream said no" }
    ]
  });

  assert.ok(hop);
  assert.equal(hop.reason, "fallback");
  assert.equal(hop.failureClass, null);
});

test("the tracker forgets the oldest agents beyond its bound", () => {
  const hops = tracker({ maxTrackedAgents: 1 });
  hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "claude"
  });
  hops.observeServed({
    subject: "thread-2",
    role: "worker",
    workspace: null,
    provider: "claude"
  });
  const hop = hops.observeServed({
    subject: "thread-1",
    role: "worker",
    workspace: null,
    provider: "minimax"
  });

  // The first agent was forgotten, so the router cannot claim it moved from
  // Claude: it has no record of what served it.
  assert.equal(hop, null);
});

test("the default tracker can be replaced and restored", () => {
  const previous = getDefaultProviderHopTracker();
  const replacement = tracker();
  setDefaultProviderHopTracker(replacement);
  try {
    assert.equal(getDefaultProviderHopTracker(), replacement);
  } finally {
    setDefaultProviderHopTracker(previous);
  }
});
