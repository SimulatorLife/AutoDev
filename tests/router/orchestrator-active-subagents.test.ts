import assert from "node:assert/strict";
import test from "node:test";

import {
  releaseSubagentSlot,
  resetConcurrencyTelemetry,
  touchOpenSubagentSlots,
  tryAcquireSubagentSlot
} from "../../src/router/concurrency.ts";
import { ROUTING_POLICY } from "../../src/router/routing.ts";
import {
  agentActivity,
  resetRouterTelemetry
} from "../../src/router/server.ts";
import {
  closeBridgeSubagentsForRequest,
  closeBridgeSubagentUsage,
  noteOrchestratorSession,
  openBridgeSubagentUsage,
  ORCHESTRATOR_AGENT_ROLE,
  orchestratorProviderForSession,
  orchestratorSessionInfo,
  resetSubagentTelemetry
} from "../../src/router/subagents.ts";
import { countLiveAgentActivity } from "../../src/router/usage.ts";

test("orchestrator-active-subagents: orchestrator remains in subagent_wait while subagents are active", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetSubagentTelemetry();

  try {
    const sessionKey = "orch-session-claude";
    const orchestratorProvider = "claude";
    const orchestratorModel = "claude-opus-5-5";

    // 1. Orchestrator turn 1 begins and registers orchestrator session
    noteOrchestratorSession(sessionKey, orchestratorProvider, {
      model: orchestratorModel,
      workspace: "SimulatorLife/RacingGame",
      requestId: "req-orch-1"
    });

    agentActivity.beginRequest(sessionKey, {
      requestId: "req-orch-1",
      provider: orchestratorProvider,
      model: orchestratorModel,
      role: ORCHESTRATOR_AGENT_ROLE,
      origin: "orchestrator",
      workspace: "SimulatorLife/RacingGame",
      tag: sessionKey
    });

    assert.equal(agentActivity.getState(sessionKey), "active");
    assert.equal(
      orchestratorProviderForSession(sessionKey),
      orchestratorProvider
    );
    assert.deepEqual(orchestratorSessionInfo(sessionKey), {
      provider: orchestratorProvider,
      model: orchestratorModel,
      workspace: "SimulatorLife/RacingGame",
      requestId: "req-orch-1",
      updatedAt: orchestratorSessionInfo(sessionKey)!.updatedAt
    });

    // 2. Orchestrator spawns a subagent and acquires a concurrency slot
    const slotDenial = tryAcquireSubagentSlot(sessionKey);
    assert.equal(slotDenial, null);

    // 3. Orchestrator HTTP turn 1 finishes (waiting on child)
    agentActivity.endRequest(sessionKey, {
      requestId: "req-orch-1",
      outcome: "success",
      hasToolCalls: false,
      inputRequired: false,
      hasActiveSubagents: true
    });

    // Verify: Orchestrator session is in subagent_wait, NOT finished
    assert.equal(agentActivity.getState(sessionKey), "subagent_wait");
    const rec = agentActivity.getRecord(sessionKey);
    assert.ok(rec, "expected record to exist");
    assert.equal(rec.provider, orchestratorProvider);
    assert.equal(rec.model, orchestratorModel);
    assert.equal(rec.role, ORCHESTRATOR_AGENT_ROLE);

    // Verify: countLiveAgentActivity counts this orchestrator under its provider
    const claudeLive = countLiveAgentActivity({
      provider: orchestratorProvider
    });
    assert.equal(
      claudeLive,
      1,
      "claude provider must have 1 active orchestrator"
    );

    // 4. Subagent turn executes under its own thread's subject, tagged with sessionKey
    const subagentRequestId = "req-sub-turn-1";
    const subagentSubject = "thread:child-thread-1";
    const subagentProvider = "minimax";
    const subagentModel = "MiniMax-M3";

    agentActivity.beginRequest(subagentSubject, {
      requestId: subagentRequestId,
      provider: subagentProvider,
      model: subagentModel,
      role: "worker",
      origin: "subagent",
      workspace: "SimulatorLife/RacingGame",
      tag: sessionKey
    });

    // Subagent streaming touch touches both subagent and orchestrator session
    agentActivity.touch(subagentSubject);
    touchOpenSubagentSlots(sessionKey);

    // Orchestrator session must NOT have its provider or role overwritten by the child
    assert.equal(agentActivity.getState(sessionKey), "subagent_wait");
    assert.equal(
      agentActivity.getRecord(sessionKey)!.provider,
      orchestratorProvider
    );
    assert.equal(
      agentActivity.getRecord(sessionKey)!.role,
      ORCHESTRATOR_AGENT_ROLE
    );

    // Subagent finishes its HTTP turn
    agentActivity.endRequest(subagentSubject, {
      requestId: subagentRequestId,
      outcome: "success",
      hasToolCalls: false
    });

    // Subagent request is finished, but orchestrator is still in subagent_wait (slot still held)
    assert.equal(agentActivity.getState(subagentSubject), "finished");
    assert.equal(agentActivity.getState(sessionKey), "subagent_wait");
    assert.equal(countLiveAgentActivity({ provider: orchestratorProvider }), 1);

    // 5. Router load balancing check: A new orchestrator request should prefer an idle provider
    // over claude because claude has liveProviderCount === 1
    const candidateList = ROUTING_POLICY.orchestratorCandidates(() => 0.5);
    const firstCandidate = candidateList[0];
    assert.ok(firstCandidate);
    assert.notEqual(
      firstCandidate.provider,
      orchestratorProvider,
      `New orchestrator should pick an idle provider instead of ${orchestratorProvider} which is busy waiting on subagents`
    );

    // 6. Subagent slot is released
    releaseSubagentSlot(sessionKey);

    // Orchestrator transitions from subagent_wait to resumed
    assert.equal(agentActivity.getState(sessionKey), "resumed");

    // 7. Orchestrator turn 2 begins (continuation)
    agentActivity.beginRequest(sessionKey, {
      requestId: "req-orch-2",
      provider: orchestratorProvider,
      model: orchestratorModel,
      role: ORCHESTRATOR_AGENT_ROLE,
      origin: "orchestrator",
      workspace: "SimulatorLife/RacingGame"
    });

    assert.equal(agentActivity.getState(sessionKey), "active");

    // Turn 2 finishes without spawning subagents
    agentActivity.endRequest(sessionKey, {
      requestId: "req-orch-2",
      outcome: "success",
      hasToolCalls: false,
      inputRequired: false,
      hasActiveSubagents: false
    });

    assert.equal(agentActivity.getState(sessionKey), "finished");
  } finally {
    resetRouterTelemetry();
    agentActivity.reset();
    resetConcurrencyTelemetry();
    resetSubagentTelemetry();
  }
});

test("orchestrator-active-subagents: bridge subagent usage keeps orchestrator session in subagent_wait", () => {
  resetRouterTelemetry();
  agentActivity.reset();
  resetConcurrencyTelemetry();
  resetSubagentTelemetry();

  try {
    const sessionKey = "bridge-orch-session";
    const provider = "antigravity";
    const model = "gemini-3.8-flash-high";

    noteOrchestratorSession(sessionKey, provider, {
      model,
      workspace: "SimulatorLife/RacingGame",
      requestId: "req-bridge-parent"
    });

    agentActivity.beginRequest(sessionKey, {
      requestId: "req-bridge-parent",
      provider,
      model,
      role: ORCHESTRATOR_AGENT_ROLE,
      origin: "orchestrator",
      workspace: "SimulatorLife/RacingGame",
      tag: sessionKey
    });

    assert.equal(agentActivity.getState(sessionKey), "active");

    // Parent turn completes with spawn of bridge subagent
    openBridgeSubagentUsage({
      requestId: "req-bridge-parent",
      context: {
        activitySubject: sessionKey,
        provider,
        model,
        role: ORCHESTRATOR_AGENT_ROLE,
        workspace: "SimulatorLife/RacingGame",
        sessionKey
      },
      role: "explorer",
      childId: "child-1",
      model: "gemini-3.8-flash-medium"
    });

    agentActivity.endRequest(sessionKey, {
      requestId: "req-bridge-parent",
      outcome: "success",
      hasToolCalls: false,
      inputRequired: false
    });

    // Because a live child exists, orchestrator must transition to subagent_wait
    assert.equal(agentActivity.getState(sessionKey), "subagent_wait");
    assert.equal(agentActivity.getState(sessionKey), "subagent_wait");
    assert.ok(countLiveAgentActivity({ provider }) >= 1);

    // When the bridge child closes, orchestrator transitions to resumed
    closeBridgeSubagentsForRequest("req-bridge-parent", "success");
    closeBridgeSubagentUsage("req-bridge-parent\0child-1", {
      outcome: "success"
    });
    assert.equal(agentActivity.getState(sessionKey), "resumed");
  } finally {
    resetRouterTelemetry();
    agentActivity.reset();
    resetConcurrencyTelemetry();
    resetSubagentTelemetry();
  }
});
