import assert from "node:assert/strict";
import test from "node:test";

import {
  autodevEnrichOtlpPayload,
  codexTelemetryStatus,
  getDefaultOtelTracker,
  isAutodevAttributesEnabled,
  isDeltaTemporality,
  numberAttribute,
  OTEL_LOOKBACK_EVENT_LIMIT,
  OTEL_PERSISTENCE_SCHEMA_VERSION,
  otelAttributes,
  otelAttributeValue,
  otelDurationMs,
  otelLogRecordIdentity,
  otelNanoTimestamp,
  otelPersistenceSnapshot,
  otelSeriesKey,
  otelSpanIdentity,
  otelTimestamp,
  OtelTracker,
  setDefaultOtelTracker,
  sqliteKey,
  toolStatusAttribute
} from "../../src/router/otel.ts";
import { CONFIGURED_ORCHESTRATOR_MODEL } from "../../src/router/routing.ts";
import { UsageTracker } from "../../src/router/usage.ts";

function createMockUsageTracker(): UsageTracker {
  return new UsageTracker();
}

test("zeroed initial state", () => {
  const tracker = new OtelTracker({ usageTracker: createMockUsageTracker() });
  const status = tracker.codexTelemetryStatus();

  assert.equal(status.receiver.logs, 0);
  assert.equal(status.receiver.traces, 0);
  assert.equal(status.receiver.metrics, 0);
  assert.equal(status.receiver.invalid, 0);
  assert.equal(status.receiver.lastReceivedAt, null);
  assert.equal(status.turns.prompts, 0);
  assert.equal(status.turns.completed, 0);
  assert.equal(status.tokens.total, 0);
  assert.equal(status.mcpServers.length, 0);
  assert.equal(status.tools.byTool.length, 0);
  assert.equal(status.hooks.byHook.length, 0);
  assert.equal(status.threads.started.total, 0);
  assert.equal(status.threads.spawns.total, 0);
});

test("attribute parsing and pure utilities", () => {
  assert.equal(otelAttributeValue(null), null);
  assert.equal(otelAttributeValue(undefined), undefined);
  assert.equal(otelAttributeValue("plain-string"), "plain-string");
  assert.equal(otelAttributeValue({ stringValue: "hello" }), "hello");
  assert.equal(otelAttributeValue({ intValue: "42" }), 42);
  assert.equal(otelAttributeValue({ doubleValue: 3.14 }), 3.14);
  assert.equal(otelAttributeValue({ boolValue: true }), true);
  assert.deepEqual(
    otelAttributeValue({
      arrayValue: { values: [{ stringValue: "a" }, { intValue: "1" }] }
    }),
    ["a", 1]
  );

  const rawAttrs = [
    { key: "str", value: { stringValue: "val" } },
    { key: "num", value: { intValue: 10 } },
    { key: "empty" }
  ];
  const parsedAttrs = otelAttributes(rawAttrs);
  assert.equal(parsedAttrs.str, "val");
  assert.equal(parsedAttrs.num, 10);
  assert.equal(parsedAttrs.empty, undefined);

  assert.equal(otelTimestamp(null), null);
  assert.equal(otelTimestamp("invalid-nanos"), null);
  const fixedIso = "2026-09-16T12:00:00.000Z";
  const fixedNanos = BigInt(Date.parse(fixedIso)) * 1_000_000n;
  assert.equal(otelTimestamp(fixedNanos.toString()), fixedIso);

  assert.equal(otelNanoTimestamp("1000"), 1000n);
  assert.equal(otelNanoTimestamp("invalid"), 0n);

  assert.equal(
    otelDurationMs({
      startTimeUnixNano: "1000000",
      endTimeUnixNano: "5000000"
    }),
    4
  );
  assert.equal(otelDurationMs({ startTimeUnixNano: "invalid" }), 0);

  assert.equal(numberAttribute({ a: "123" }, "a"), 123);
  assert.equal(numberAttribute({ b: 456 }, "a", "b"), 456);
  assert.equal(numberAttribute({}, "a"), 0);

  assert.equal(isDeltaTemporality(1), true);
  assert.equal(isDeltaTemporality("1"), true);
  assert.equal(isDeltaTemporality("AGGREGATION_TEMPORALITY_DELTA"), true);
  assert.equal(isDeltaTemporality(2), false);
  assert.equal(isDeltaTemporality("CUMULATIVE"), false);

  assert.equal(toolStatusAttribute({ success: true }), "ok");
  assert.equal(toolStatusAttribute({ success: "false" }), "error");
  assert.equal(toolStatusAttribute({ status: "completed" }), "completed");
  assert.equal(toolStatusAttribute({}), "unknown");

  assert.equal(sqliteKey({ db: "state_5", status: "ok" }), "state_5::ok");
  assert.ok(
    otelSeriesKey("my_metric", { a: "1", b: "2" }, 1000n).startsWith(
      "my_metric::"
    )
  );
});

test("record identity and deduplication within window limit", () => {
  const tracker = new OtelTracker({ usageTracker: createMockUsageTracker() });
  const logRecord = {
    timeUnixNano: "1726500000000000000",
    severityNumber: 9,
    body: "test log body",
    attributes: [{ key: "attr1", value: { stringValue: "val1" } }]
  };
  const identity = otelLogRecordIdentity(logRecord, [], {
    name: "test-scope",
    version: "1.0"
  });
  assert.ok(identity);

  assert.equal(
    tracker.firstOtelRecordObservation(
      tracker.telemetry.recordIdentities.logs,
      identity
    ),
    true
  );
  assert.equal(
    tracker.firstOtelRecordObservation(
      tracker.telemetry.recordIdentities.logs,
      identity
    ),
    false
  );

  const span = {
    traceId: "trace-abc",
    spanId: "span-123",
    name: "test-span"
  };
  const spanId = otelSpanIdentity(span, [], null);
  assert.equal(spanId, "span:trace-abc:span-123");
  assert.equal(
    tracker.firstOtelRecordObservation(
      tracker.telemetry.recordIdentities.spans,
      spanId
    ),
    true
  );
  assert.equal(
    tracker.firstOtelRecordObservation(
      tracker.telemetry.recordIdentities.spans,
      spanId
    ),
    false
  );
});

test("log ingestion: turns, prompts, TTFT, tokens, and tool results", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new OtelTracker({ usageTracker });

  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "conversation.id", value: { stringValue: "conv-101" } },
            {
              key: "model",
              value: { stringValue: CONFIGURED_ORCHESTRATOR_MODEL }
            }
          ]
        },
        scopeLogs: [
          {
            scope: { name: "codex-core" },
            logRecords: [
              {
                timeUnixNano: "1726500001000000000",
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "codex.user_prompt" }
                  },
                  { key: "prompt_length", value: { intValue: 120 } }
                ]
              },
              {
                timeUnixNano: "1726500002000000000",
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "codex.turn_ttft" }
                  },
                  { key: "duration_ms", value: { intValue: 350 } }
                ]
              },
              {
                timeUnixNano: "1726500003000000000",
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "codex.sse_event" }
                  },
                  {
                    key: "event.kind",
                    value: { stringValue: "response.completed" }
                  },
                  { key: "input_token_count", value: { intValue: 200 } },
                  { key: "output_token_count", value: { intValue: 50 } },
                  { key: "cached_token_count", value: { intValue: 30 } },
                  { key: "reasoning_token_count", value: { intValue: 10 } },
                  { key: "tool_token_count", value: { intValue: 5 } }
                ]
              },
              {
                timeUnixNano: "1726500004000000000",
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "codex.tool_result" }
                  },
                  { key: "tool_name", value: { stringValue: "read_file" } },
                  { key: "call_id", value: { stringValue: "call-1" } },
                  { key: "status", value: { stringValue: "ok" } },
                  { key: "duration_ms", value: { intValue: 45 } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  tracker.ingestOtelSignal("logs", payload);

  const status = tracker.codexTelemetryStatus();
  assert.equal(status.receiver.logs, 1);
  assert.equal(status.turns.prompts, 1);
  assert.equal(status.turns.promptLength, 120);
  assert.equal(status.turns.ttftMs, 350);
  assert.equal(status.turns.ttftCount, 1);
  assert.equal(status.turns.averageTtftMs, 350);
  assert.equal(status.turns.completed, 1);
  assert.equal(status.tokens.input, 200);
  assert.equal(status.tokens.output, 50);
  assert.equal(status.tokens.cached, 30);
  assert.equal(status.tokens.reasoning, 10);
  assert.equal(status.tokens.tool, 5);
  assert.equal(status.tokens.total, 295);
  assert.equal(
    status.lookbackEvents.filter(
      (event) => event.family === "turn" && event.type !== "delta"
    ).length,
    3
  );
  assert.deepEqual(
    status.lookbackEvents
      .filter((event) => event.family === "token")
      .map((event) => [event.name, event.countDelta]),
    [
      ["input", 200],
      ["output", 50],
      ["cached", 30],
      ["reasoning", 10],
      ["tool", 5]
    ]
  );
  assert.ok(
    status.lookbackEvents.some(
      (event) => event.family === "receiver" && event.name === "logs"
    )
  );
  const toolResultEvent = status.lookbackEvents.find(
    (event) => event.family === "tool_result"
  );
  assert.ok(toolResultEvent);
  assert.equal(toolResultEvent.name, "read_file");
  assert.equal(toolResultEvent.resolvedCall, true);

  assert.equal(status.toolResults.total, 1);
  assert.equal(status.toolResults.executed, 1);
  assert.equal(status.toolResults.causeResolved, 1);
  assert.equal(status.toolResults.byStatus.ok, 1);
});

test("traces ingestion: mcpServer tracking, discovery spans, and status", () => {
  const usageTracker = createMockUsageTracker();
  usageTracker.registerWorkspaceId("ws-test", "AutoDev/Core");

  const tracker = new OtelTracker({ usageTracker });

  const now = Date.now();
  const baseNanos = BigInt(now) * 1_000_000n;
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "conversation.id", value: { stringValue: "conv-trace" } },
            { key: "workspace", value: { stringValue: "AutoDev/Core" } }
          ]
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "tr-1",
                spanId: "sp-1",
                name: "make_rmcp_client",
                startTimeUnixNano: (baseNanos - 5_000_000_000n).toString(),
                endTimeUnixNano: (baseNanos - 4_000_000_000n).toString(),
                attributes: [
                  { key: "server_name", value: { stringValue: "filesystem" } }
                ]
              },
              {
                traceId: "tr-1",
                spanId: "sp-2",
                name: "list_tools_for_client_uncached",
                startTimeUnixNano: (baseNanos - 3_000_000_000n).toString(),
                endTimeUnixNano: (baseNanos - 1_000_000_000n).toString(),
                attributes: [
                  { key: "server_name", value: { stringValue: "filesystem" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  tracker.ingestOtelSignal("traces", payload);

  const status = tracker.codexTelemetryStatus(now);
  assert.equal(status.receiver.traces, 1);
  assert.equal(status.mcpServers.length, 1);
  const server = status.mcpServers[0];
  assert.equal(server.name, "filesystem");
  assert.equal(server.initAttempts, 1);
  assert.equal(server.toolDiscoveryAttempts, 1);
  assert.equal(server.lastStatus, "ready");
  assert.equal(server.health, "ready");

  const wsBucket = usageTracker.workspaceBucket(
    usageTracker.usageTelemetry.byWorkspace,
    "AutoDev/Core"
  );
  assert.equal(wsBucket.mcpCapable, true);
  assert.equal(wsBucket.byMcp.filesystem, 1);
});

test("cumulative metrics series delta calculation and counter reset", () => {
  const tracker = new OtelTracker({ usageTracker: createMockUsageTracker() });

  const metricName = "test.counter";
  const seriesKey = otelSeriesKey(metricName, { source: "test" }, "1000000");

  // First export: cumulative value 10 -> delta 10
  const delta1 = tracker.otelSeriesDelta(seriesKey, "1000", 10, "CUMULATIVE");
  assert.equal(delta1, 10);

  // Redelivery of same timestamp: delta 0
  const deltaRedelivered = tracker.otelSeriesDelta(
    seriesKey,
    "1000",
    10,
    "CUMULATIVE"
  );
  assert.equal(deltaRedelivered, 0);

  // Next cumulative export at later timestamp: value 25 -> delta 15
  const delta2 = tracker.otelSeriesDelta(seriesKey, "2000", 25, "CUMULATIVE");
  assert.equal(delta2, 15);

  // Process restart / counter reset: value drops to 5 -> delta reported in full (5)
  const deltaReset = tracker.otelSeriesDelta(
    seriesKey,
    "3000",
    5,
    "CUMULATIVE"
  );
  assert.equal(deltaReset, 5);

  // Delta temporality: reports value directly without subtraction
  const deltaTempSeriesKey = otelSeriesKey(
    "test.delta",
    { source: "test" },
    "1000000"
  );
  const deltaFromDeltaTemp = tracker.otelSeriesDelta(
    deltaTempSeriesKey,
    "4000",
    8,
    1
  );
  assert.equal(deltaFromDeltaTemp, 8);
});

test("lookback history records only accepted semantic deltas and persists bounded events", () => {
  const tracker = new OtelTracker({ usageTracker: createMockUsageTracker() });
  const context = {
    workspace: "AutoDev/Core",
    role: "orchestrator",
    model: "gpt-6-luna",
    agent: "agent-1",
    agentKind: "orchestrator",
    timestamp: "2026-09-27T17:00:00.000Z",
    timestampSource: "source" as const
  };
  const toolAttributes = {
    tool_name: "read_file",
    source: "codex",
    server: "filesystem",
    status: "success",
    workspace: context.workspace,
    role: context.role,
    model: context.model
  };
  const toolPoint = {
    startTimeUnixNano: "1000000000",
    timeUnixNano: "2000000000",
    asInt: 3
  };

  tracker.noteToolCounter(
    "codex.tool.call",
    toolAttributes,
    toolPoint,
    "CUMULATIVE"
  );
  tracker.noteToolCounter(
    "codex.tool.call",
    toolAttributes,
    toolPoint,
    "CUMULATIVE"
  );
  tracker.noteToolDuration(
    "codex.tool.duration_ms",
    toolAttributes,
    {
      startTimeUnixNano: "1000000000",
      timeUnixNano: "3000000000",
      count: 2,
      sum: 18
    },
    "DELTA"
  );
  tracker.noteHookHistogramCount(
    "codex.hooks.run.duration_ms",
    {
      hook_name: "PreToolUse",
      source: "codex",
      status: "ok",
      workspace: context.workspace,
      role: context.role,
      model: context.model
    },
    {
      startTimeUnixNano: "1000000000",
      timeUnixNano: "4000000000",
      count: 4
    },
    "DELTA"
  );
  tracker.recordSkillUse("lsp-mcp-server", context, 2, context.timestamp);
  tracker.noteSkillInjected(
    "codex.skill.injected",
    {
      skillName: "lsp-mcp-server",
      status: "success",
      invoke_type: "automatic",
      workspace: context.workspace,
      role: context.role,
      model: context.model
    },
    {
      startTimeUnixNano: "1000000000",
      timeUnixNano: "5000000000",
      asInt: 5
    },
    "DELTA"
  );
  tracker.noteMcpServer(
    "filesystem",
    {
      name: "initialize",
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "6000000000",
      status: { code: 1 }
    },
    {
      server_name: "filesystem",
      workspace: context.workspace,
      role: context.role,
      model: context.model
    }
  );

  const events = tracker.codexTelemetryStatus().lookbackEvents;
  assert.equal(events.length, 6, "duplicate cumulative point has no second event");
  assert.deepEqual(
    events.map(({ family, type }) => [family, type]),
    [
      ["tool", "counter"],
      ["tool", "duration"],
      ["hook", "counter"],
      ["skill", "used"],
      ["skill", "injected"],
      ["mcp", "observation"]
    ]
  );
  assert.equal(events[0]?.timestamp, "1970-01-01T00:00:02.000Z");
  assert.equal(events[0]?.countDelta, 3);
  assert.equal(events[0]?.workspace, context.workspace);
  assert.equal(events[0]?.role, context.role);
  assert.equal(events[1]?.durationCount, 2);
  assert.equal(events[1]?.durationSumMs, 18);
  assert.equal(events[4]?.countDelta, 5);
  assert.equal(events[5]?.name, "filesystem");

  tracker.noteThreadSkillsHistogram(
    { count: 0, sum: 0 },
    "codex.thread.skills.kept_total",
    {},
    {
      startTimeUnixNano: "1000000000",
      timeUnixNano: "7000000000",
      count: 3,
      sum: 12
    },
    "DELTA",
    { "conversation.id": "agent-1" }
  );
  const skillHistogramEvent = tracker
    .codexTelemetryStatus()
    .lookbackEvents.find(
      (event) => event.name === "codex.thread.skills.kept_total"
    );
  assert.equal(skillHistogramEvent?.family, "skill");
  assert.equal(skillHistogramEvent?.type, "duration");
  assert.equal(skillHistogramEvent?.countDelta, 3);
  assert.equal(skillHistogramEvent?.sumDelta, 12);
  assert.equal(skillHistogramEvent?.agent, "agent-1");

  tracker.noteThreadStarted(
    "codex.thread.started",
    { source: "codex", "conversation.id": "agent-1" },
    {
      startTimeUnixNano: "1000000000",
      timeUnixNano: "8000000000",
      asInt: 4
    },
    "DELTA"
  );
  tracker.noteThreadSpawn(
    "codex.multi_agent.spawn",
    {
      role: "orchestrator",
      requested_model: "gpt-5",
      status: "started",
      "conversation.id": "agent-1"
    },
    {
      startTimeUnixNano: "1000000000",
      timeUnixNano: "9000000000",
      asInt: 2
    },
    "DELTA"
  );
  const threadStartedEvent = tracker
    .codexTelemetryStatus()
    .lookbackEvents.find((event) => event.type === "thread_started");
  const threadSpawnEvent = tracker
    .codexTelemetryStatus()
    .lookbackEvents.find((event) => event.type === "thread_spawn");
  assert.equal(threadStartedEvent?.countDelta, 4);
  assert.equal(threadStartedEvent?.agent, "agent-1");
  assert.equal(threadSpawnEvent?.countDelta, 2);
  assert.equal(threadSpawnEvent?.status, "started");
  assert.equal(threadSpawnEvent?.agent, "agent-1");

  const snapshot = tracker.otelPersistenceSnapshot();
  const restored = new OtelTracker({ usageTracker: createMockUsageTracker() });
  restored.restoreOtelTelemetry(snapshot);
  assert.deepEqual(
    restored.codexTelemetryStatus().lookbackEvents,
    tracker.codexTelemetryStatus().lookbackEvents
  );

  const bounded = new OtelTracker({ usageTracker: createMockUsageTracker() });
  for (let index = 0; index <= OTEL_LOOKBACK_EVENT_LIMIT; index += 1) {
    bounded.recordSkillUse(`skill-${index}`, context, 1, context.timestamp);
  }
  const boundedEvents = bounded.codexTelemetryStatus().lookbackEvents;
  assert.equal(boundedEvents.length, OTEL_LOOKBACK_EVENT_LIMIT);
  assert.equal(boundedEvents[0]?.name, "skill-1");
  assert.equal(boundedEvents.at(-1)?.name, `skill-${OTEL_LOOKBACK_EVENT_LIMIT}`);
});

test("deferred MCP model attribution retroactively attributes when conversation model arrives", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new OtelTracker({ usageTracker });

  // Trace arrives first with no model known yet: conversationId='conv-defer'
  const tracePayload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "conversation.id", value: { stringValue: "conv-defer" } }
          ]
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "tr-defer",
                spanId: "sp-defer",
                name: "list_tools_for_client_uncached",
                startTimeUnixNano: "1726500030000000000",
                endTimeUnixNano: "1726500032000000000",
                attributes: [
                  { key: "server_name", value: { stringValue: "custom-mcp" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
  tracker.ingestOtelSignal("traces", tracePayload);

  // Before log arrives, status views pending observation as unattributed
  let status = tracker.codexTelemetryStatus();
  const mcpServerPre = status.mcpServers.find(
    (s: any) => s.name === "custom-mcp"
  );
  assert.ok(mcpServerPre);
  assert.equal(mcpServerPre.byModel.unattributed.observed, 1);

  // Now conversation start log arrives specifying model 'gpt-6-luna'
  const logPayload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "conversation.id", value: { stringValue: "conv-defer" } },
            {
              key: "model",
              value: { stringValue: CONFIGURED_ORCHESTRATOR_MODEL }
            }
          ]
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1726500035000000000",
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "codex.conversation_starts" }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
  tracker.ingestOtelSignal("logs", logPayload);

  // Post-log status: model has been committed to CONFIGURED_ORCHESTRATOR_MODEL
  status = tracker.codexTelemetryStatus();
  const mcpServerPost = status.mcpServers.find(
    (s: any) => s.name === "custom-mcp"
  );
  assert.ok(mcpServerPost);
  assert.equal(
    mcpServerPost.byModel[CONFIGURED_ORCHESTRATOR_MODEL]?.observed,
    1
  );
});

test("additive AutoDev attribute enrichment contract", () => {
  assert.equal(isAutodevAttributesEnabled(), false);

  const basePayload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "role", value: { stringValue: "orchestrator" } },
            { key: "workspace", value: { stringValue: "AutoDev" } },
            { key: "provider", value: { stringValue: "codex" } },
            {
              key: "model",
              value: { stringValue: CONFIGURED_ORCHESTRATOR_MODEL }
            }
          ]
        },
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "codex.subagent_spawn" }
                  },
                  {
                    key: "spawn_mechanism",
                    value: { stringValue: "codex_native" }
                  },
                  { key: "skill", value: { stringValue: "code-search" } },
                  { key: "server", value: { stringValue: "playwright" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  // When flag is not enabled, autodevEnrichOtlpPayload is not automatically applied
  // Explicitly calling autodevEnrichOtlpPayload produces enriched clone without mutating original
  const enriched = autodevEnrichOtlpPayload("logs", basePayload);
  assert.ok(enriched);
  assert.notEqual(enriched, basePayload);

  const resAttrs = enriched.resourceLogs[0].resource.attributes;
  assert.ok(
    resAttrs.some(
      (a: any) =>
        a.key === "autodev.role" && a.value.stringValue === "orchestrator"
    )
  );
  assert.ok(
    resAttrs.some(
      (a: any) =>
        a.key === "autodev.workspace" && a.value.stringValue === "AutoDev"
    )
  );
  assert.ok(
    resAttrs.some(
      (a: any) =>
        a.key === "autodev.provider" && a.value.stringValue === "codex"
    )
  );
  assert.ok(
    resAttrs.some(
      (a: any) =>
        a.key === "autodev.model" &&
        a.value.stringValue === CONFIGURED_ORCHESTRATOR_MODEL
    )
  );

  const recAttrs =
    enriched.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  assert.ok(
    recAttrs.some(
      (a: any) =>
        a.key === "autodev.spawn.mechanism" &&
        a.value.stringValue === "codex_native"
    )
  );
  assert.ok(
    recAttrs.some(
      (a: any) =>
        a.key === "autodev.skill" && a.value.stringValue === "code-search"
    )
  );
  assert.ok(
    recAttrs.some(
      (a: any) =>
        a.key === "autodev.mcp.server" && a.value.stringValue === "playwright"
    )
  );

  // Ensure original payload was not modified
  assert.equal(basePayload.resourceLogs![0]!.resource.attributes.length, 4);
});

test("bridge observation events: tool, skill, and mcp exposure", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new OtelTracker({ usageTracker });

  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_executed",
      tool: "view_file",
      server: "file-tools",
      status: "ok",
      callId: "c-1"
    },
    context: { workspace: "AutoDev/Platform" }
  });
  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_unavailable",
      tool: "write_file",
      server: "file-tools",
      reason: "policy_denied"
    },
    context: { workspace: "AutoDev/Platform" }
  });

  tracker.recordMcpExposure({
    server: "playwright",
    source: "role_contract",
    context: { workspace: "AutoDev/Platform" },
    requestId: "req-1"
  });

  tracker.recordBridgeSkillExposure({
    event: { skill: "diagnosing-bugs", source: "builtin", pluginId: "core" },
    context: { workspace: "AutoDev/Platform" }
  });

  const skillUsedResult = tracker.recordBridgeSkillUsed({
    event: { skill: "diagnosing-bugs", eventId: "evt-skill-1" },
    context: { workspace: "AutoDev/Platform" }
  });
  assert.equal(skillUsedResult, true);

  const status = tracker.codexTelemetryStatus();
  assert.equal(status.bridgeEvents.toolExecuted.total, 1);
  assert.equal(status.bridgeEvents.toolUnavailable.total, 1);
  assert.equal(status.bridgeEvents.toolUnavailable.byReason.policy_denied, 1);
  assert.equal(status.bridgeEvents.mcpExposed.total, 1);
  assert.equal(status.bridgeEvents.skillExposed.total, 1);
  assert.equal(status.bridgeEvents.skillUsed.total, 1);

  const wsBucket = usageTracker.workspaceBucket(
    usageTracker.usageTelemetry.byWorkspace,
    "AutoDev/Platform"
  );
  assert.equal(wsBucket.toolsExecuted, 1);
  assert.equal(wsBucket.toolsUnavailable, 1);
  assert.equal(wsBucket.mcpCapable, true);
  assert.equal(wsBucket.skillsCapable, true);
  assert.equal(wsBucket.skillUses, 1);
});

test("bridge observation events: activitySubject is local active correlation, not an OTel dimension", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new OtelTracker({ usageTracker });

  tracker.recordBridgeToolObservation({
    event: {
      type: "tool_executed",
      tool: "view_file",
      server: "file-tools",
      status: "ok",
      callId: "c-activity-1"
    },
    context: { workspace: "AutoDev/Platform", activitySubject: "child-42" }
  });

  const skillUsedResult = tracker.recordBridgeSkillUsed({
    event: { skill: "racecar-movement", eventId: "evt-skill-activity-1" },
    context: { workspace: "AutoDev/Platform", activitySubject: "child-42" }
  });
  assert.equal(skillUsedResult, true);

  const status = tracker.codexTelemetryStatus() as any;

  // The exact activitySubject belongs to local active correlation; it must
  // not be promoted into the cumulative OTel agent dimension.
  const skillBucket = status.skills.used.bySkill.find(
    (entry: any) => entry.skill === "racecar-movement"
  );
  assert.ok(skillBucket, "expected racecar-movement skill-used bucket");
  assert.equal(skillBucket.byAgent["child-42"], undefined);
  assert.equal(skillBucket.byAgent.unattributed, 1);
  assert.equal(status.skills.used.byAgent["child-42"], undefined);
  assert.equal(status.skills.used.byAgent.unattributed, 1);

  // The lookback event for the skill use must carry the same identity.
  const skillLookback = status.lookbackEvents.find(
    (event: any) =>
      event.family === "skill" &&
      event.type === "used" &&
      event.name === "racecar-movement"
  );
  assert.ok(skillLookback, "expected skill-used lookback event");
  assert.equal(skillLookback.agent, "child-42");

  // The MCP cumulative agent dimension likewise stays unattributed; the
  // bridge's separate live-feed event carries the exact activity subject.
  const mcpServer = status.mcpServers.find(
    (entry: any) => entry.name === "file-tools"
  );
  assert.ok(mcpServer, "expected file-tools mcp server entry");
  assert.equal(mcpServer.byAgent["child-42"], undefined);
  assert.equal(mcpServer.byAgent.unattributed.observed, 1);

  const activeUsage = usageTracker.activeUsageSnapshot(["child-42"]);
  assert.equal(activeUsage.skillUses, 1);
  assert.deepEqual(activeUsage.bySkill, [
    { skill: "racecar-movement", count: 1 }
  ]);
  const activeWorkspace = activeUsage.byWorkspace["AutoDev/Platform"]!;
  assert.equal(activeWorkspace.skillUses, 1);
  assert.deepEqual(activeWorkspace.bySkill, [
    { skill: "racecar-movement", count: 1 }
  ]);
});

test("persistence snapshot and restoration (schema v6)", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new OtelTracker({ usageTracker });

  // Record some telemetry
  tracker.ingestOtelSignal("logs", {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1726500050000000000",
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "codex.user_prompt" }
                  },
                  { key: "prompt_length", value: { intValue: 50 } }
                ]
              }
            ]
          }
        ]
      }
    ]
  });

  const snapshot = tracker.otelPersistenceSnapshot();
  assert.equal(snapshot.schemaVersion, OTEL_PERSISTENCE_SCHEMA_VERSION);
  assert.equal(snapshot.turns.prompts, 1);

  // Restore into a fresh tracker
  const freshTracker = new OtelTracker({
    usageTracker: createMockUsageTracker()
  });
  freshTracker.restoreOtelTelemetry(snapshot);

  const restoredStatus = freshTracker.codexTelemetryStatus();
  assert.equal(restoredStatus.turns.prompts, 1);
  assert.equal(restoredStatus.turns.promptLength, 50);
});

test("resetOtelTelemetry clears all telemetry and triggers usageTracker reset", () => {
  const usageTracker = createMockUsageTracker();
  const tracker = new OtelTracker({ usageTracker });
  tracker.recordSkillUse(
    "orchestration",
    {
      workspace: "AutoDev/Core",
      role: "orchestrator",
      model: "gpt-6-luna",
      agent: "agent-1",
      agentKind: "orchestrator",
      timestamp: "2026-09-27T17:00:00.000Z",
      timestampSource: "source"
    },
    1,
    "2026-09-27T17:00:00.000Z"
  );

  tracker.telemetry.receiver.logs = 5;
  tracker.telemetry.turns.prompts = 2;
  tracker.telemetry.recordIdentities.logs.add("some-id");
  tracker.metricSeries.set("metric-key", { timestamp: 100n, value: 5 });

  tracker.resetOtelTelemetry();

  assert.equal(tracker.telemetry.receiver.logs, 0);
  assert.equal(tracker.telemetry.turns.prompts, 0);
  assert.equal(tracker.telemetry.recordIdentities.logs.size, 0);
  assert.equal(tracker.metricSeries.size, 0);
  assert.equal(tracker.codexTelemetryStatus().lookbackEvents.length, 0);
  assert.equal(usageTracker.attributionDiagnostics.total, 0);
});

test("default singleton convenience functions delegate properly", () => {
  const original = getDefaultOtelTracker();
  const custom = new OtelTracker();
  setDefaultOtelTracker(custom);

  try {
    assert.equal(getDefaultOtelTracker(), custom);
    assert.equal(typeof codexTelemetryStatus(), "object");
    assert.equal(typeof otelPersistenceSnapshot(), "object");
  } finally {
    setDefaultOtelTracker(original);
  }
});
