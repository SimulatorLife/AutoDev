import "@simulatorlife/autodev-runtime/router/http";

import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderRoleAssignment } from "@simulatorlife/autodev-core";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import { getRecentRouterEvents } from "@simulatorlife/autodev-runtime/router/events";
import { proxyRoleResponse } from "@simulatorlife/autodev-runtime/router/proxy";
import { ROUTING_POLICY } from "@simulatorlife/autodev-runtime/router/routing";
import { agentActivity } from "@simulatorlife/autodev-runtime/router/server";
import {
  noteOrchestratorSession,
  resetSubagentTelemetry,
  subagentProviderForThread
} from "@simulatorlife/autodev-runtime/router/subagents";

const CLAUDE_HOST = "127.0.0.1:4000";
const MINIMAX_HOST = "127.0.0.1:18765";

function responseRecorder(): any {
  return {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader() {},
    getHeader() {
      return undefined;
    },
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    write() {
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    once() {
      return this;
    },
    on() {
      return this;
    },
    off() {
      return this;
    },
    removeListener() {
      return this;
    }
  };
}

/**
 * Run `body` with subagent routing reduced to Claude at P1 and MiniMax at P2,
 * every other provider's subagent role disabled, and the given limits; then
 * restore whatever the policy held before.
 */
async function withSubagentRouting(
  limits: Record<
    string,
    { perSession: number | null; acrossSessions: number | null }
  >,
  body: (contacted: string[]) => Promise<void>
): Promise<void> {
  const providers = ROUTING_POLICY.providerIds();
  const previous = new Map<string, ProviderRoleAssignment | undefined>(
    providers.map((provider) => [
      provider,
      ROUTING_POLICY.assignmentFor(provider, "subagent")
    ])
  );
  const previousLimits = new Map(
    providers.map((provider) => [provider, ROUTING_POLICY.limitsFor(provider)])
  );
  const savedEnv = {
    LITELLM_API_KEY: process.env.LITELLM_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
  };
  process.env.LITELLM_API_KEY = "claude-key";
  process.env.MINIMAX_API_KEY = "minimax-key";
  const originalFetch = globalThis.fetch;
  const contacted: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    contacted.push(String(input));
    return Response.json(
      { id: "resp_ok", status: "completed", output: [] },
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  COOLDOWNS.clearAll();
  agentActivity.reset();
  resetSubagentTelemetry();
  try {
    for (const provider of providers) {
      const model = ROUTING_POLICY.configuredModel(provider, "default");
      ROUTING_POLICY.setProviderAssignment(provider, "subagent", {
        priority:
          provider === "claude" ? 1 : provider === "minimax" ? 2 : "disabled",
        model: model ?? provider
      });
      ROUTING_POLICY.clearProviderLimits(provider);
    }
    for (const [provider, value] of Object.entries(limits))
      ROUTING_POLICY.setProviderLimits(provider, value);
    await body(contacted);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [provider, assignment] of previous) {
      if (assignment)
        ROUTING_POLICY.setProviderAssignment(provider, "subagent", assignment);
      else ROUTING_POLICY.clearProviderAssignment(provider, "subagent");
    }
    for (const [provider, value] of previousLimits) {
      if (value) ROUTING_POLICY.setProviderLimits(provider, value);
      else ROUTING_POLICY.clearProviderLimits(provider);
    }
    agentActivity.reset();
    COOLDOWNS.clearAll();
    resetSubagentTelemetry();
  }
}

function servedHosts(contacted: string[]): string[] {
  return contacted
    .filter((url) => url.endsWith("/responses"))
    .map((url) => new URL(url).host);
}

async function spawnRequest(
  root: string,
  thread: string,
  requestId: string
): Promise<void> {
  await proxyRoleResponse(
    responseRecorder(),
    "worker",
    { model: "autodev/worker", input: [], stream: false },
    false,
    requestId,
    null,
    null,
    null,
    { key: root, scope: "identified", thread, sessionId: root }
  );
}

test(
  "a new subagent is routed by priority, not pinned to its orchestrator's or a sibling's provider",
  { concurrency: false },
  async () => {
    await withSubagentRouting({}, async (contacted) => {
      const root = "root-inherit-1";
      // The orchestrator runs on MiniMax and is live in the session.
      noteOrchestratorSession(root, "minimax");
      agentActivity.beginRequest(root, {
        requestId: "req-root",
        provider: "minimax",
        role: "orchestrator",
        origin: "orchestrator",
        sessionId: root
      });

      await spawnRequest(root, "child-a", "req-child-a-1");
      assert.deepEqual(
        servedHosts(contacted),
        [CLAUDE_HOST],
        "the first subagent must go to Claude (P1), not the orchestrator's MiniMax"
      );
      assert.equal(subagentProviderForThread("child-a"), "claude");

      // A sibling that last ran on MiniMax must not pull a new child there.
      agentActivity.beginRequest("thread:child-b", {
        requestId: "req-child-b",
        provider: "minimax",
        role: "worker",
        origin: "subagent",
        sessionId: root
      });
      contacted.length = 0;
      await spawnRequest(root, "child-c", "req-child-c-1");
      assert.deepEqual(servedHosts(contacted), [CLAUDE_HOST]);
    });
  }
);

test(
  "a subagent thread keeps the provider that served it across its own requests",
  { concurrency: false },
  async () => {
    await withSubagentRouting({}, async (contacted) => {
      const root = "root-continuity-1";
      // Claude is the P1 provider, but this thread was already served by
      // MiniMax: its next request stays there.
      const { noteSubagentThread } =
        await import("@simulatorlife/autodev-runtime/router/subagents");
      noteSubagentThread("child-cont", "worker", "minimax");
      await spawnRequest(root, "child-cont", "req-cont-2");
      assert.deepEqual(servedHosts(contacted), [MINIMAX_HOST]);
    });
  }
);

test(
  "a provider's per-session agent limit sends the next agent of that session to the next provider",
  { concurrency: false },
  async () => {
    await withSubagentRouting(
      { claude: { perSession: 1, acrossSessions: null } },
      async (contacted) => {
        const root = "root-limit-session";
        agentActivity.beginRequest("thread:child-1", {
          requestId: "req-child-1",
          provider: "claude",
          role: "worker",
          origin: "subagent",
          sessionId: root
        });
        await spawnRequest(root, "child-2", "req-child-2");
        assert.deepEqual(servedHosts(contacted), [MINIMAX_HOST]);
        const skip = getRecentRouterEvents().find(
          (event) =>
            event.requestId === "req-child-2" &&
            event.phase === "skipped" &&
            event.provider === "claude"
        );
        assert.equal(skip?.failureClass, "agent_limit_per_session");

        // Another session still has its own place on Claude.
        contacted.length = 0;
        await spawnRequest("root-limit-other", "child-x", "req-child-x");
        assert.deepEqual(servedHosts(contacted), [CLAUDE_HOST]);
      }
    );
  }
);

test(
  "a provider's across-sessions agent limit counts every session's live agents",
  { concurrency: false },
  async () => {
    await withSubagentRouting(
      { claude: { perSession: null, acrossSessions: 1 } },
      async (contacted) => {
        agentActivity.beginRequest("thread:elsewhere", {
          requestId: "req-elsewhere",
          provider: "claude",
          role: "worker",
          origin: "subagent",
          sessionId: "root-other-session"
        });
        await spawnRequest("root-limit-across", "child-1", "req-across-1");
        assert.deepEqual(servedHosts(contacted), [MINIMAX_HOST]);
        const skip = getRecentRouterEvents().find(
          (event) =>
            event.requestId === "req-across-1" &&
            event.phase === "skipped" &&
            event.provider === "claude"
        );
        assert.equal(skip?.failureClass, "agent_limit_across_sessions");
      }
    );
  }
);

test(
  "an agent already live on a provider at its limit keeps being served there",
  { concurrency: false },
  async () => {
    await withSubagentRouting(
      { claude: { perSession: 1, acrossSessions: 1 } },
      async (contacted) => {
        const root = "root-limit-continuing";
        await spawnRequest(root, "child-1", "req-cont-a");
        assert.deepEqual(servedHosts(contacted), [CLAUDE_HOST]);
        // The first request settled into a tool wait: the agent is live on
        // Claude, which is now at both limits, and it is the one continuing.
        agentActivity.beginRequest("thread:child-1", {
          requestId: "req-cont-a-open",
          provider: "claude",
          role: "worker",
          origin: "subagent",
          sessionId: root
        });
        contacted.length = 0;
        await spawnRequest(root, "child-1", "req-cont-b");
        assert.deepEqual(servedHosts(contacted), [CLAUDE_HOST]);
      }
    );
  }
);

test("agentLimitReason admits continuing agents and counts per session and across sessions", () => {
  const provider = "claude";
  const previous = ROUTING_POLICY.limitsFor(provider);
  try {
    ROUTING_POLICY.clearProviderLimits(provider);
    assert.equal(
      ROUTING_POLICY.agentLimitReason(provider, { subject: "a" }, [
        { subject: "b" },
        { subject: "c" }
      ]),
      null,
      "no limits set admits everyone"
    );
    ROUTING_POLICY.setProviderLimits(provider, {
      perSession: 2,
      acrossSessions: 3
    });
    const live = [
      { subject: "s1-a", sessionId: "s1" },
      { subject: "s1-b", sessionId: "s1" },
      { subject: "s2-a", sessionId: "s2" }
    ];
    assert.equal(
      ROUTING_POLICY.agentLimitReason(
        provider,
        { subject: "s1-c", sessionId: "s1" },
        live
      ),
      "agent_limit_across_sessions"
    );
    assert.equal(
      ROUTING_POLICY.agentLimitReason(
        provider,
        { subject: "s1-a", sessionId: "s1" },
        live
      ),
      null,
      "a live agent continuing is never refused"
    );
    assert.equal(
      ROUTING_POLICY.agentLimitReason(
        provider,
        { subject: "s1-c", sessionId: "s1" },
        live.slice(0, 2)
      ),
      "agent_limit_per_session"
    );
    assert.equal(
      ROUTING_POLICY.agentLimitReason(
        provider,
        { subject: "s3-a", sessionId: "s3" },
        live.slice(0, 2)
      ),
      null
    );
    assert.equal(
      ROUTING_POLICY.agentLimitReason(
        provider,
        { subject: "lone", sessionId: null },
        live.slice(0, 2)
      ),
      null,
      "an agent with no session id is its own session"
    );
  } finally {
    if (previous) ROUTING_POLICY.setProviderLimits(provider, previous);
    else ROUTING_POLICY.clearProviderLimits(provider);
  }
});
