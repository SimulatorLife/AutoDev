import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import {
  AggregationTemporality,
  InMemoryMetricExporter
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { ATTR_AUTODEV_CLIENT_SURFACE } from "@simulatorlife/autodev-core";

import { createAgentActivityTracker } from "../src/agents/agent-activity.ts";
import { RouterEventRecorder } from "../src/router/events.ts";
import { requestClientSurface, requestSession } from "../src/router/http.ts";
import {
  endAttemptSpan,
  endLogicalRequestSpan,
  flushTelemetryMetrics,
  getFinishedSpans,
  resetTelemetryExporter,
  setTelemetryExporter,
  setTelemetryMetricExporterForTest,
  startAttemptSpan,
  startLogicalRequestSpan
} from "../src/router/telemetry.ts";
import { UsageTracker } from "../src/router/usage.ts";

function mockRequest(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("requestClientSurface resolves originator first, then User-Agent, else null", () => {
  assert.equal(
    requestClientSurface(mockRequest({ originator: "Codex Desktop" })),
    "codex_desktop"
  );
  assert.equal(
    requestClientSurface(mockRequest({ originator: "codex_cli_rs" })),
    "codex_cli"
  );
  assert.equal(
    requestClientSurface(mockRequest({ originator: "codex_exec" })),
    "codex_exec"
  );
  assert.equal(
    requestClientSurface(mockRequest({ originator: "codex_vscode" })),
    "codex_vscode"
  );
  // Observed unrecognised originator maps to "other" rather than falling back.
  assert.equal(
    requestClientSurface(
      mockRequest({
        originator: "custom_client",
        "user-agent": "codex_exec/0.154.0 (Mac OS 26.5.2; arm64)"
      })
    ),
    "other"
  );
  // Falls back to User-Agent when originator is absent or blank.
  assert.equal(
    requestClientSurface(
      mockRequest({
        "user-agent":
          "codex_exec/0.154.0 (Mac OS 26.5.2; arm64) dumb (codex_exec; 0.154.0)"
      })
    ),
    "codex_exec"
  );
  assert.equal(
    requestClientSurface(
      mockRequest({
        originator: "   ",
        "user-agent": "codex_vscode/0.154.0 (Mac OS 26.5.2; arm64)"
      })
    ),
    "codex_vscode"
  );
  // Absent evidence stays null.
  assert.equal(requestClientSurface(mockRequest({})), null);

  const session = requestSession(
    mockRequest({
      "session-id": "session-surface-1",
      originator: "codex_exec"
    }),
    null
  );
  assert.equal(session.sessionId, "session-surface-1");
  assert.equal(session.clientSurface, "codex_exec");
});

test("RouterEventRecorder propagates clientSurface and validates on restore", () => {
  const recorder = new RouterEventRecorder({ logger: null });
  recorder.noteRequestIdentity(
    "req-1",
    "thread-1",
    "thread-1",
    "codex_desktop"
  );
  const withSurface = recorder.record({
    phase: "selected",
    requestId: "req-1",
    provider: "codex",
    model: "gpt-5"
  });
  assert.equal(withSurface.clientSurface, "codex_desktop");

  const withoutSurface = recorder.record({
    phase: "selected",
    requestId: "req-2",
    provider: "codex",
    model: "gpt-5"
  });
  assert.equal("clientSurface" in withoutSurface, false);

  // Round-trip through restore: valid surface kept, invalid value stripped.
  const replayed = new RouterEventRecorder({ logger: null });
  replayed.restore([
    structuredClone(withSurface),
    {
      ...structuredClone(withoutSurface),
      clientSurface: "invented_surface"
    },
    {
      ...structuredClone(withoutSurface),
      clientSurface: null
    }
  ]);
  const events = replayed.getRecentEvents();
  assert.equal(events.length, 3);
  assert.equal(events[0]?.clientSurface, "codex_desktop");
  assert.equal("clientSurface" in (events[1] ?? {}), false);
  assert.equal("clientSurface" in (events[2] ?? {}), false);
});

test("router spans omit absent clientSurface while metrics label null as unknown", async () => {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE
  );
  setTelemetryExporter(spanExporter);
  setTelemetryMetricExporterForTest(metricExporter);
  resetTelemetryExporter();

  const observedLogical = startLogicalRequestSpan({
    requestId: "req-observed",
    role: "worker",
    providerRole: "subagent",
    workspace: { key: "SimulatorLife/AutoDev" },
    subject: "worker",
    requestedModel: "autodev/worker",
    sessionId: "session-observed",
    clientSurface: "codex_exec"
  });
  const observedAttempt = startAttemptSpan({
    provider: "codex",
    model: "gpt-5",
    selection: "primary",
    attemptNumber: 1,
    role: "worker",
    workspace: { key: "SimulatorLife/AutoDev" },
    sessionId: "session-observed",
    clientSurface: "codex_exec"
  });
  endAttemptSpan(observedAttempt, {
    status: "ok",
    usage: { input: 10, output: 5 }
  });
  endLogicalRequestSpan(observedLogical, { status: "ok", provider: "codex" });

  const absentLogical = startLogicalRequestSpan({
    requestId: "req-absent",
    role: "worker",
    providerRole: "subagent",
    workspace: { key: "SimulatorLife/AutoDev" },
    subject: "worker",
    requestedModel: "autodev/worker",
    sessionId: "session-absent",
    clientSurface: null
  });
  const absentAttempt = startAttemptSpan({
    provider: "codex",
    model: "gpt-5",
    selection: "primary",
    attemptNumber: 1,
    role: "worker",
    workspace: { key: "SimulatorLife/AutoDev" },
    sessionId: "session-absent",
    clientSurface: null
  });
  endAttemptSpan(absentAttempt, {
    status: "ok",
    usage: { input: 3, output: 2 }
  });
  endLogicalRequestSpan(absentLogical, { status: "ok", provider: "codex" });

  const spans = getFinishedSpans();
  const bySession = (sessionId: string) =>
    spans.filter((s) => s.attributes["autodev.session.id"] === sessionId);
  const observedSpans = bySession("session-observed");
  assert.equal(observedSpans.length, 2);
  for (const span of observedSpans) {
    assert.equal(span.attributes[ATTR_AUTODEV_CLIENT_SURFACE], "codex_exec");
  }
  const absentSpans = bySession("session-absent");
  assert.equal(absentSpans.length, 2);
  for (const span of absentSpans) {
    assert.equal(span.attributes[ATTR_AUTODEV_CLIENT_SURFACE], undefined);
  }

  await flushTelemetryMetrics();
  const metricPoints = metricExporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics)
    .flatMap((sm) => sm.metrics)
    .filter(
      (m) =>
        m.descriptor.name === "autodev.router.logical_requests" ||
        m.descriptor.name === "gen_ai.client.operation.duration" ||
        m.descriptor.name === "gen_ai.client.token.usage"
    )
    .flatMap((m) =>
      m.dataPoints.map((dp) => ({
        name: m.descriptor.name,
        surface: dp.attributes[ATTR_AUTODEV_CLIENT_SURFACE]
      }))
    );

  for (const metricName of [
    "autodev.router.logical_requests",
    "gen_ai.client.operation.duration",
    "gen_ai.client.token.usage"
  ]) {
    const surfaces = new Set(
      metricPoints
        .filter((p) => p.name === metricName)
        .map((p) => p.surface)
    );
    assert.equal(surfaces.has("codex_exec"), true, `${metricName} should record codex_exec`);
    assert.equal(surfaces.has("unknown"), true, `${metricName} should label null as unknown`);
  }
});

test("UsageTracker preserves first observed clientSurface per live session", () => {
  const activity = createAgentActivityTracker({ now: () => 100 });
  const usage = new UsageTracker({ activityTracker: activity });
  usage.noteSessionClientSurface("session-first", "codex_vscode");
  usage.noteSessionClientSurface("session-first", "codex_cli");

  activity.beginRequest("subject-1", {
    requestId: "req-1",
    sessionId: "session-first",
    provider: "codex",
    model: "gpt-5",
    role: "orchestrator",
    timestamp: 100
  });
  activity.beginRequest("subject-2", {
    requestId: "req-2",
    sessionId: "session-none",
    provider: "codex",
    model: "gpt-5",
    role: "worker",
    timestamp: 100
  });

  const live = usage.listLiveSessions(100);
  assert.ok(live);
  assert.deepEqual(
    live.identitiesObserved.map((row) => ({
      sessionId: row.sessionId,
      clientSurface: row.clientSurface
    })),
    [
      { sessionId: "session-first", clientSurface: "codex_vscode" },
      { sessionId: "session-none", clientSurface: null }
    ]
  );
});
