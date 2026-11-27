import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AggregationTemporality,
  InMemoryMetricExporter
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";

import {
  AGENT_METHODS,
  AgentApp,
  PROTOCOL_VERSION
} from "@agentclientprotocol/sdk";

import { ensureLocalAdmission } from "../src/mcp/gateway-admission.ts";
import {
  flushTelemetryMetrics,
  METRIC_AGENT_LAUNCHES,
  setTelemetryExporter,
  setTelemetryMetricExporterForTest
} from "../src/router/telemetry.ts";
import { XacpxSessionManager } from "../src/xacpx/manager.ts";
import { startXacpxOrchestrationIpcServer } from "../src/xacpx/orchestration-ipc.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const metricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE
);
setTelemetryMetricExporterForTest(metricExporter);
setTelemetryExporter(new InMemorySpanExporter());

/**
The cumulative launch counter, keyed `kind stage [reason]`. Counters keep
every earlier test's points, so each test compares a before and after.
*/
async function launchCounts(): Promise<Map<string, number>> {
  await flushTelemetryMetrics();
  const counts = new Map<string, number>();
  const points = metricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === METRIC_AGENT_LAUNCHES)
    .flatMap(
      (metric) =>
        metric.dataPoints as unknown as readonly {
          readonly attributes: Readonly<Record<string, unknown>>;
          readonly value: number;
        }[]
    );
  for (const { attributes, value } of points) {
    const key = [
      attributes["autodev.launch.kind"],
      attributes["autodev.launch.stage"],
      attributes["autodev.launch.reason"]
    ]
      .filter(Boolean)
      .join(" ");
    counts.set(key, (counts.get(key) ?? 0) + value);
  }
  metricExporter.reset();
  return counts;
}

async function launchStagesDuring(
  body: () => Promise<void>
): Promise<Record<string, number>> {
  const before = await launchCounts();
  await body();
  const after = await launchCounts();
  const added: Record<string, number> = {};
  for (const [key, value] of after) {
    const delta = value - (before.get(key) ?? 0);
    if (delta) added[key] = delta;
  }
  return added;
}

function answeringAgent(): AgentApp {
  return new AgentApp({ name: "answering-agent" })
    .onRequest(AGENT_METHODS.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false }
    }))
    .onRequest(AGENT_METHODS.session_new, async () => ({
      sessionId: "acp-answering-agent"
    }))
    .onRequest(AGENT_METHODS.session_prompt, async () => ({
      stopReason: "end_turn"
    }))
    .onRequest(AGENT_METHODS.session_close, async () => ({}));
}

const turn = (sessionId: string, extra: object = {}) => ({
  sessionId,
  role: "worker",
  cwd: REPO_ROOT,
  systemPrompt: "Worker prompt",
  promptOrTask: "do the work",
  ...extra
});

test("a root launch reaches each stage once, and a follow-up turn on its live executor is not another launch", async () => {
  ensureLocalAdmission(process.env.CODEX_HOME!);
  const manager = new XacpxSessionManager({
    acpTransportFactory: () => ({ target: answeringAgent() })
  });
  try {
    const stages = await launchStagesDuring(async () => {
      await manager.executeTurn(turn("launch-root"));
      await manager.promptSession("launch-root", "and again");
    });
    assert.deepEqual(stages, {
      "root attempted": 1,
      "root admitted": 1,
      "root started": 1,
      "root succeeded": 1
    });
  } finally {
    await manager.closeAllSessions();
  }
});

test("a child whose executor never starts is admitted and failed before start, with no work outcome", async () => {
  const manager = new XacpxSessionManager({
    acpTransportFactory: () => {
      throw new Error("ACP executor is not installed.");
    }
  });
  const stages = await launchStagesDuring(async () => {
    await assert.rejects(
      manager.executeTurn(
        turn("launch-child", { parentSessionId: "launch-coordinator" })
      ),
      /not installed/u
    );
  });
  assert.deepEqual(stages, {
    "child attempted": 1,
    "child admitted": 1,
    "child failed_before_start": 1
  });
});

test("a launch the session manager cannot dispatch is rejected", async () => {
  const manager = new XacpxSessionManager();
  const stages = await launchStagesDuring(async () => {
    await assert.rejects(
      manager.executeTurn(turn("launch-unknown-role", { role: "no-such-role" })),
      /Unknown agent role/u
    );
  });
  assert.deepEqual(stages, {
    "root attempted": 1,
    "root rejected dispatch_refused": 1
  });
});

test("a delegation the orchestration IPC refuses is a rejected child launch with its category", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-launch-ipc-"));
  const socketPath = path.join(root, "orchestration.sock");
  const handle = await startXacpxOrchestrationIpcServer({
    socketPath,
    manager: new XacpxSessionManager(),
    authorizedWorkspaceRoot: REPO_ROOT,
    repositoryRoot: REPO_ROOT
  });
  try {
    const stages = await launchStagesDuring(async () => {
      const socket = createConnection(socketPath);
      await once(socket, "connect");
      socket.write(
        `${JSON.stringify({
          id: "refused",
          method: "delegate.request",
          params: {
            sourceHandle: "launch-coordinator",
            targetAgent: "no-such-role",
            task: "do the work"
          }
        })}\n`
      );
      const [chunk] = (await once(socket, "data")) as [Buffer];
      socket.end();
      const response = JSON.parse(chunk.toString("utf8")) as {
        readonly ok: boolean;
      };
      assert.equal(response.ok, false);
    });
    assert.deepEqual(stages, {
      "child attempted": 1,
      "child rejected invalid_role": 1
    });
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
