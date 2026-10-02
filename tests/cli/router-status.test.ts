import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const statusPayload = {
  schema: "autodev-router-status-v2",
  router: "test-router",
  pid: 17,
  routerInstanceId: "test-instance",
  startedAt: "2026-09-30T00:00:00.000Z",
  authentication: { responseRequests: true, credential: "do-not-expose" },
  routing: {
    enabledOrchestratorProviders: ["openai"],
    disabledOrchestratorProviders: [],
    enabledSubagentProviders: ["openai"],
    disabledSubagentProviders: [],
    providerGroups: { normal: [["openai"]] },
    priorities: {}
  },
  limits: {
    providerCooldownMs: 1000,
    providerCooldownMaxMs: 2000,
    hardCooldownMs: 1000,
    hardCooldownMaxMs: 2000,
    probeCooldownMs: 500,
    probeCooldownMaxMs: 1000,
    probeTimeoutMs: 700,
    exhaustionWaitMs: 0,
    lastResortMaxAttempts: 2,
    chainSelectionDeadlineMs: 5000,
    maxConcurrentThreadsPerSession: 4
  },
  providers: {
    openai: {
      orchestratorEnabled: true,
      subagentEnabled: true,
      status: "ready",
      orchestratorStatus: "ready",
      subagentStatus: "ready",
      routingPriority: "normal: P1",
      active: 1,
      inFlightRequests: 1,
      attempts: 20,
      successes: 18,
      failures: 2,
      failureStreak: 0,
      probeFailureStreak: 0,
      lastFailure: { class: "rate_limit", status: 429 },
      configuredModels: { "gpt-6": {} },
      capabilities: { streaming: true }
    }
  },
  concurrency: {
    effectivePerSessionLimit: 4,
    activeSessions: 2,
    activeSubagentThreads: 1,
    denials: 1,
    denialsByReason: { session_limit: 1 },
    lastDenial: { reason: "session_limit", sessionScope: "session" },
    processFallbackEnforcement: false
  },
  inFlightRequests: { openai: 1 },
  liveActivity: 1,
  agents: { canonicalLiveCount: 1, liveByRole: { root: 1 } },
  usage: { byOrigin: { orchestrator: { attempts: 5 } } },
  codexTelemetry: { tokens: { total: 100 } },
  recentEvents: [{ requestId: "private-request" }],
  liveFeed: [{ prompt: "private-prompt" }],
  telemetryPersistence: { source: "/private/path" },
  subagents: { recent: [{ thread: "private-thread" }] },
  spawnFailures: { total: 4 },
  codexState: { recentThreads: ["private-thread"] }
};

async function runStatusCli(
  payload: unknown,
  args: string[] = [],
  entrypoint = "runtime/src/cli/router-status.ts"
): Promise<{ stdout: string; stderr: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("mock status server failed to bind");
  }

  try {
    return await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [entrypoint, ...args], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            CODEX_MODEL_ROUTER_HOST: "127.0.0.1",
            CODEX_MODEL_ROUTER_PORT: String(address.port)
          },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve({ stdout, stderr })
            : reject(new Error(`status CLI exited ${code}: ${stderr}`))
        );
      }
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("router status text reports operational state but not history", async () => {
  const { stdout } = await runStatusCli(statusPayload);

  assert.match(stdout, /Router test-router \(pid 17, instance test-instance\)/);
  assert.match(stdout, /Configured priority groups:/);
  assert.match(stdout, /Provider\s+State\s+Priority/);
  assert.match(stdout, /openai\s+enabled\/enabled/);
  assert.match(stdout, /Concurrency: per-session 4, active sessions 2/);
  assert.doesNotMatch(
    stdout,
    /Usage by origin|Codex OTEL|Recent routing events/
  );
  assert.doesNotMatch(stdout, /private-request|private-prompt|private-thread/);
  assert.doesNotMatch(stdout, /20 attempts|18 successes/);
});

test("router status JSON exposes only the operational runtime contract", async () => {
  const { stdout } = await runStatusCli(statusPayload, ["--json"]);
  const result = JSON.parse(stdout);

  assert.deepEqual(Object.keys(result).sort(), [
    "agents",
    "authentication",
    "concurrency",
    "inFlightRequests",
    "limits",
    "liveActivity",
    "pid",
    "providers",
    "router",
    "routerInstanceId",
    "routing",
    "schema",
    "startedAt"
  ]);
  assert.deepEqual(result.authentication, { responseRequests: true });
  assert.equal(result.providers.openai.active, 1);
  assert.equal("attempts" in result.providers.openai, false);
  assert.equal("usage" in result, false);
  assert.equal("codexTelemetry" in result, false);
  assert.equal("recentEvents" in result, false);
  assert.equal("telemetryPersistence" in result, false);
  assert.equal("codexState" in result, false);
});

test("autodev router status uses the same operational JSON contract", async () => {
  const { stdout } = await runStatusCli(
    statusPayload,
    ["router", "status"],
    "runtime/src/cli/autodev.ts"
  );
  assert.deepEqual(JSON.parse(stdout), {
    schema: statusPayload.schema,
    router: statusPayload.router,
    pid: statusPayload.pid,
    routerInstanceId: statusPayload.routerInstanceId,
    startedAt: statusPayload.startedAt,
    authentication: { responseRequests: true },
    routing: statusPayload.routing,
    limits: statusPayload.limits,
    providers: {
      openai: {
        orchestratorEnabled: true,
        subagentEnabled: true,
        status: "ready",
        orchestratorStatus: "ready",
        subagentStatus: "ready",
        routingPriority: "normal: P1",
        active: 1,
        inFlightRequests: 1,
        failureStreak: 0,
        probeFailureStreak: 0,
        lastFailure: { class: "rate_limit", status: 429 },
        configuredModels: { "gpt-6": {} },
        capabilities: { streaming: true }
      }
    },
    concurrency: statusPayload.concurrency,
    inFlightRequests: statusPayload.inFlightRequests,
    liveActivity: 1,
    agents: statusPayload.agents
  });
});
