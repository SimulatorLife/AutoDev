import "@simulatorlife/autodev-runtime/router/http";

import assert from "node:assert/strict";
import test from "node:test";

import { trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  InstrumentType
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  recordBridgeSkillExposure,
  recordBridgeSkillFailed,
  recordBridgeSkillUsed
} from "@simulatorlife/autodev-runtime/router/correlation";
import type { Candidate } from "@simulatorlife/autodev-runtime/router/routing";
import {
  ATTR_AUTODEV_GIT_ATTRIBUTION,
  ATTR_AUTODEV_GIT_PARTIAL,
  createOtlpMetricExporter,
  endAttemptSpan,
  endLogicalRequestSpan,
  flushTelemetryMetrics,
  getFinishedSpans,
  METRIC_GIT_COMMITS,
  METRIC_GIT_FILES_ADDED,
  METRIC_GIT_FILES_CHANGED,
  METRIC_GIT_FILES_DELETED,
  METRIC_GIT_LINES_ADDED,
  METRIC_GIT_LINES_REMOVED,
  recordGitCommit,
  resetTelemetryExporter,
  resetTrackedGitCommitsForTest,
  sanitizeCategoricalLabel,
  setTelemetryExporter,
  setTelemetryMetricExporterForTest,
  startAttemptSpan,
  startLogicalRequestSpan,
  withLogicalSpan
} from "@simulatorlife/autodev-runtime/router/telemetry";

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "content-type": "application/json" }
  });
}

function responseRecorder(): any {
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    body: "",
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    writeHead(status: number, headers: Record<string, string | number>) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.body = Buffer.concat(chunks).toString("utf8");
      this.writableEnded = true;
    },
    on() {
      return this;
    },
    removeListener() {
      return this;
    }
  };
}

const route = (provider: string, envKey: string): Candidate => ({
  provider,
  pattern: /.*/,
  baseUrl: `http://${provider}.test/v1`,
  model: provider === "claude" ? "sonnet" : "MiniMax-M3",
  envKey
});

interface SpanRecord {
  name: string;
  spanId: string;
  traceId: string;
  attributes: Record<string, unknown>;
  status: { code: number };
  parentSpanContext: { spanId: string; traceId: string } | undefined;
  kind: number;
}

function snapshotSpans(): SpanRecord[] {
  return getFinishedSpans().map((span) => {
    const parent = span.parentSpanContext;
    return {
      name: span.name,
      spanId: span.spanContext().spanId,
      traceId: span.spanContext().traceId,
      attributes: { ...span.attributes } as Record<string, unknown>,
      status: { code: span.status.code as number },
      parentSpanContext: parent
        ? { spanId: parent.spanId, traceId: parent.traceId }
        : undefined,
      kind: span.kind as number
    };
  });
}

function findLogical(spans: SpanRecord[]): SpanRecord[] {
  return spans.filter((s) => s.name === "autodev.routed_request");
}

function findAttemptSpans(spans: SpanRecord[]): SpanRecord[] {
  return spans.filter((s) => s.name === "gen_ai.client_operation");
}

function findMetricPoints(metricName: string): Array<{
  attributes: Record<string, unknown>;
  value: number | { count: number; sum: number };
}> {
  return telemetryMetricExporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === metricName)
    .flatMap((metric) => {
      const points = metric.dataPoints as Array<{
        attributes: Record<string, unknown>;
        value: unknown;
      }>;
      return points.map((point) => {
        const value = point.value as number | { count: number; sum: number };
        return {
          attributes: point.attributes,
          value:
            typeof value === "object" && value !== null
              ? { count: value.count, sum: value.sum }
              : value
        };
      });
    });
}

test("physical attempt spans retain only a source-confirmed conversation thread id", () => {
  installExporter();
  const attempt = startAttemptSpan({
    provider: "thread-provider",
    model: "thread-model",
    selection: "primary",
    attemptNumber: 1,
    sessionId: "session-identity-is-not-the-thread",
    threadId: "codex-thread-123"
  });
  endAttemptSpan(attempt, { status: "ok" });

  const [span] = findAttemptSpans(snapshotSpans());
  assert.equal(span?.attributes["gen_ai.conversation.id"], "codex-thread-123");
  assert.equal(
    span?.attributes["autodev.session.id"],
    "session-identity-is-not-the-thread"
  );

  const unattributed = startAttemptSpan({
    provider: "thread-provider",
    model: "thread-model",
    selection: "primary",
    attemptNumber: 2,
    threadId: null
  });
  endAttemptSpan(unattributed, { status: "ok" });
  const attempts = findAttemptSpans(snapshotSpans());
  assert.equal(attempts[1]?.attributes["gen_ai.conversation.id"], undefined);
});

test(
  "source metrics count one logical request and one physical GenAI operation with reported token and cache usage",
  { concurrency: false },
  async () => {
    installExporter();
    const logical = startLogicalRequestSpan({
      requestId: "must-not-be-a-metric-dimension",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "workspace-metrics" },
      subject: "metric fixture",
      requestedModel: "metric-model"
    });
    await withLogicalSpan(logical, async () => {
      const attempt = startAttemptSpan({
        provider: "metric-provider",
        model: "metric-model",
        selection: "primary",
        attemptNumber: 1,
        role: "worker",
        workspace: { key: "workspace-metrics" }
      });
      endAttemptSpan(attempt, {
        status: "ok",
        usage: { input: 100, output: 25, cacheRead: 40 },
        responseModel: "metric-model-response"
      });
    });
    endLogicalRequestSpan(logical, { status: "ok" });
    await flushTelemetryMetrics();

    const input = findMetricPoints("gen_ai.client.token.usage").find(
      (point) =>
        point.attributes["gen_ai.provider.name"] === "metric-provider" &&
        point.attributes["gen_ai.request.model"] === "metric-model" &&
        point.attributes["gen_ai.token.type"] === "input"
    );
    const output = findMetricPoints("gen_ai.client.token.usage").find(
      (point) =>
        point.attributes["gen_ai.provider.name"] === "metric-provider" &&
        point.attributes["gen_ai.token.type"] === "output"
    );
    const cache = findMetricPoints(
      "autodev.gen_ai.cache_read.input_tokens"
    ).find(
      (point) => point.attributes["gen_ai.provider.name"] === "metric-provider"
    );
    const logicalRequests = findMetricPoints(
      "autodev.router.logical_requests"
    ).find(
      (point) =>
        point.attributes["autodev.workspace"] === "workspace-metrics" &&
        point.attributes["autodev.router.outcome"] === "success"
    );
    const attemptDuration = findMetricPoints(
      "gen_ai.client.operation.duration"
    ).find(
      (point) => point.attributes["gen_ai.provider.name"] === "metric-provider"
    );

    assert.equal(
      input?.value && typeof input.value === "object"
        ? input.value.sum
        : input?.value,
      100
    );
    assert.equal(
      output?.value && typeof output.value === "object"
        ? output.value.sum
        : output?.value,
      25
    );
    assert.equal(
      cache?.value && typeof cache.value === "object"
        ? cache.value.sum
        : cache?.value,
      40
    );
    assert.equal(logicalRequests?.value, 1);
    assert.equal(
      Object.hasOwn(logicalRequests?.attributes ?? {}, "requestId"),
      false,
      "request IDs must never become metric dimensions"
    );
    assert.ok(
      attemptDuration?.value && typeof attemptDuration.value === "object"
    );
    assert.equal(attemptDuration?.value.count, 1);
  }
);

test(
  "accepted bridge skill exposure and use are distinct AutoDev spans with bounded metric dimensions",
  { concurrency: false },
  async () => {
    installExporter();
    const context = {
      workspace: "skill-contract-workspace",
      role: "worker"
    };
    assert.equal(
      recordBridgeSkillExposure({
        event: {
          type: "skill_exposed",
          skill: "workspace-audit",
          source: "role_contract",
          pluginId: "private-plugin-id"
        },
        context
      }),
      true
    );
    assert.equal(
      recordBridgeSkillUsed({
        event: {
          type: "skill_used",
          skill: "workspace-audit",
          source: "skill_read",
          eventId: "private-event-id"
        },
        context
      }),
      true
    );
    assert.equal(
      recordBridgeSkillUsed({
        event: {
          type: "skill_used",
          skill: "workspace-audit",
          source: "skill_read",
          eventId: "private-event-id"
        },
        context
      }),
      false,
      "deduplicated bridge use must not double-count the OTel observation"
    );

    const skillSpans = snapshotSpans().filter(
      (span) => span.name === "autodev.skill"
    );
    assert.deepEqual(
      skillSpans.map((span) => span.attributes["autodev.skill.event"]),
      ["exposed", "used"]
    );
    for (const span of skillSpans) {
      assert.equal(span.attributes["autodev.skill.name"], "workspace-audit");
      assert.equal(span.attributes["autodev.workspace"], context.workspace);
      assert.equal(span.attributes["autodev.agent.role"], context.role);
      assert.equal(Object.hasOwn(span.attributes, "private-plugin-id"), false);
      assert.equal(Object.hasOwn(span.attributes, "private-event-id"), false);
    }

    await flushTelemetryMetrics();
    const skillPoints = findMetricPoints("autodev.skill.events");
    assert.equal(skillPoints.length, 2);
    for (const point of skillPoints) {
      assert.equal(point.value, 1);
      assert.equal(point.attributes["autodev.workspace"], context.workspace);
      assert.equal(point.attributes["autodev.agent.role"], context.role);
      assert.equal(
        Object.hasOwn(point.attributes, "autodev.skill.name"),
        false
      );
    }
  }
);

test(
  "a skill operation that did not succeed is its own observation, not a use",
  { concurrency: false },
  async () => {
    installExporter();
    const context = {
      workspace: "skill-failure-workspace",
      role: "worker"
    };
    assert.equal(
      recordBridgeSkillFailed({
        event: {
          type: "skill_failed",
          skill: "workspace-audit",
          source: "skill_read",
          eventId: "failed-read-1",
          outcome: "error"
        },
        context
      }),
      true
    );
    assert.equal(
      recordBridgeSkillFailed({
        event: {
          type: "skill_failed",
          skill: "workspace-audit",
          source: "skill_read",
          eventId: "failed-read-1",
          outcome: "error"
        },
        context
      }),
      false,
      "deduplicated bridge failure must not double-count the OTel observation"
    );
    assert.equal(
      recordBridgeSkillFailed({
        event: {
          type: "skill_failed",
          skill: "workspace-audit",
          source: "skill_read",
          eventId: "failed-read-2",
          outcome: "unavailable"
        },
        context
      }),
      true
    );
    assert.equal(
      recordBridgeSkillFailed({
        event: {
          type: "skill_failed",
          skill: "workspace-audit",
          source: "skill_read",
          eventId: "failed-read-3",
          outcome: "something-else"
        },
        context
      }),
      false,
      "an outcome the router cannot name must not be rounded to one it can"
    );

    const skillSpans = snapshotSpans().filter(
      (span) => span.name === "autodev.skill"
    );
    assert.deepEqual(
      skillSpans.map((span) => span.attributes["autodev.skill.event"]),
      ["error", "unavailable"]
    );
    for (const span of skillSpans) {
      assert.equal(span.attributes["autodev.skill.name"], "workspace-audit");
      assert.equal(span.attributes["autodev.workspace"], context.workspace);
      assert.equal(span.attributes["autodev.agent.role"], context.role);
    }
    // The failed operation is an errored span; the refused one is not.
    assert.equal(skillSpans[0]?.status.code, 2);
    assert.equal(skillSpans[1]?.status.code, 1);

    await flushTelemetryMetrics();
    // The counter is cumulative, so the points this test added are told apart
    // from the ones earlier tests left behind by their event value.
    const skillPoints = findMetricPoints("autodev.skill.events").filter(
      (point) =>
        point.attributes["autodev.skill.event"] === "error" ||
        point.attributes["autodev.skill.event"] === "unavailable"
    );
    assert.equal(skillPoints.length, 2);
    for (const point of skillPoints) {
      assert.equal(point.value, 1);
      assert.equal(point.attributes["autodev.workspace"], context.workspace);
      assert.equal(point.attributes["autodev.agent.role"], context.role);
      assert.equal(
        Object.hasOwn(point.attributes, "autodev.skill.name"),
        false
      );
    }
  }
);

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
const telemetryTestExporter = new InMemorySpanExporter();
const telemetryMetricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE
);
setTelemetryExporter(telemetryTestExporter);
setTelemetryMetricExporterForTest(telemetryMetricExporter);

function installExporter(): InMemorySpanExporter {
  resetTelemetryExporter();
  telemetryMetricExporter.reset();
  return telemetryTestExporter;
}

function findLogicalSpanId(): string | null {
  for (const span of getFinishedSpans()) {
    if (span.name === "autodev.routed_request") {
      return span.spanContext().spanId;
    }
  }
  return null;
}

function findLogicalTraceId(): string | null {
  for (const span of getFinishedSpans()) {
    if (span.name === "autodev.routed_request") {
      return span.spanContext().traceId;
    }
  }
  return null;
}

test(
  "Router metric export stays cumulative for Usage window deltas despite a global delta preference",
  { concurrency: false },
  async () => {
    const previousPreference =
      process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE;
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = "delta";
    const exporter = createOtlpMetricExporter(
      "http://127.0.0.1:4318/v1/metrics",
      {}
    );
    try {
      assert.equal(
        exporter.selectAggregationTemporality(InstrumentType.COUNTER),
        AggregationTemporality.CUMULATIVE
      );
    } finally {
      await exporter.shutdown();
      if (previousPreference === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE;
      } else {
        process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE =
          previousPreference;
      }
    }
  }
);

test("the OTLP exporter is not installed when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
  const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  try {
    const { ensureOtelInitialized, isOtlpExporterInstalled } =
      await import("@simulatorlife/autodev-runtime/router/telemetry");
    const tracer = ensureOtelInitialized();
    assert.ok(tracer, "tracer must be returned even without an endpoint");
    assert.equal(isOtlpExporterInstalled(), false);
  } finally {
    if (previousEndpoint !== undefined)
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
  }
});

test("privacy protection sanitizes IDs, paths, prompt content, and high-cardinality values", () => {
  // Valid categorical values pass
  assert.equal(sanitizeCategoricalLabel("threshold"), "threshold");
  assert.equal(
    sanitizeCategoricalLabel("context_window_exceeded"),
    "context_window_exceeded"
  );
  assert.equal(sanitizeCategoricalLabel("drop_middle"), "drop_middle");
  assert.equal(sanitizeCategoricalLabel("pre_turn"), "pre_turn");
  assert.equal(sanitizeCategoricalLabel("summarize"), "summarize");

  // Prohibited IDs and prefixes are stripped
  assert.equal(sanitizeCategoricalLabel("session-12345"), null);
  assert.equal(sanitizeCategoricalLabel("thread_abc123"), null);
  assert.equal(sanitizeCategoricalLabel("turn.001"), null);
  assert.equal(sanitizeCategoricalLabel("window_id_99"), null);
  assert.equal(sanitizeCategoricalLabel("req-4567"), null);
  assert.equal(sanitizeCategoricalLabel("conv-789"), null);

  // UUIDs are stripped
  assert.equal(
    sanitizeCategoricalLabel("123e4567-e89b-12d3-a456-426614174000"),
    null
  );

  // Paths and URLs are stripped
  assert.equal(sanitizeCategoricalLabel("/Users/project/path"), null);
  assert.equal(sanitizeCategoricalLabel("http://example.com"), null);

  // Content with whitespace is stripped
  assert.equal(sanitizeCategoricalLabel("Summarize this context please"), null);

  // Oversized (>64 chars) is stripped
  assert.equal(sanitizeCategoricalLabel("a".repeat(65)), null);

  // Unattributed and unknown are stripped
  assert.equal(sanitizeCategoricalLabel("unattributed"), null);
  assert.equal(sanitizeCategoricalLabel("unknown"), null);

  // Non-string is stripped
  assert.equal(sanitizeCategoricalLabel(123), null);
  assert.equal(sanitizeCategoricalLabel(null), null);
  assert.equal(sanitizeCategoricalLabel(undefined), null);

  // Hex hashes are stripped
  assert.equal(
    sanitizeCategoricalLabel(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    ),
    null
  );
});

test("a git commit's change output is recorded once, with no identity in dimensions", async () => {
  installExporter();
  resetTrackedGitCommitsForTest();

  const commit = "a".repeat(40);
  const recorded = recordGitCommit({
    commit,
    filesChanged: 3,
    filesAdded: 1,
    filesDeleted: 1,
    linesAdded: 42,
    linesRemoved: 7,
    workspace: { key: "workspace-a" },
    role: "worker",
    // Established by the commit's own committer identity, not by the observer.
    actorFromCommitIdentity: true
  });
  assert.equal(recorded, true, "a first observation must be recorded");

  // A second producer observing the same commit must not double-count it.
  assert.equal(
    recordGitCommit({
      commit,
      filesChanged: 3,
      filesAdded: 1,
      filesDeleted: 1,
      linesAdded: 42,
      linesRemoved: 7
    }),
    false,
    "an already-recorded commit must be refused"
  );

  await flushTelemetryMetrics();

  const value = (name: string): number => {
    const [point] = findMetricPoints(name);
    assert.ok(point, `${name} must be emitted`);
    return typeof point.value === "number" ? point.value : point.value.sum;
  };

  // Every requested signal is its own instrument.
  assert.equal(value(METRIC_GIT_COMMITS), 1);
  // Added and deleted are subsets of changed: three instruments, three
  // different numbers, and no total that adds them together.
  assert.equal(value(METRIC_GIT_FILES_CHANGED), 3);
  assert.equal(value(METRIC_GIT_FILES_ADDED), 1);
  assert.equal(value(METRIC_GIT_FILES_DELETED), 1);
  assert.equal(value(METRIC_GIT_LINES_ADDED), 42);
  assert.equal(value(METRIC_GIT_LINES_REMOVED), 7);

  const [point] = findMetricPoints(METRIC_GIT_COMMITS);
  assert.ok(point);
  // The existing `autodev.workspace` dimension, by its wire name.
  assert.equal(point.attributes["autodev.workspace"], "workspace-a");
  assert.equal(
    point.attributes[ATTR_AUTODEV_GIT_ATTRIBUTION],
    "commit_identity",
    "a commit-sourced actor is labelled as such"
  );
  assert.equal(point.attributes[ATTR_AUTODEV_GIT_PARTIAL], undefined);

  // The commit id is used for idempotency and must never become a dimension.
  const serialized = JSON.stringify(point.attributes);
  assert.equal(serialized.includes(commit), false);
  for (const forbidden of ["commit", "sha", "path", "branch", "repository"]) {
    assert.equal(
      Object.keys(point.attributes).some((key) =>
        key.toLowerCase().includes(forbidden)
      ),
      false,
      `${forbidden} must not appear in metric dimensions`
    );
  }
});

test("an actor the observer merely guessed is dropped, not blended onto a role", async () => {
  installExporter();
  resetTrackedGitCommitsForTest();

  // An actor the observing Runtime merely guessed is dropped, so a commit made
  // in a workspace shared with subagents cannot be blended onto the root role.
  recordGitCommit({
    commit: "d".repeat(40),
    filesChanged: 1,
    filesAdded: 1,
    filesDeleted: 0,
    linesAdded: 5,
    linesRemoved: 0,
    // Supplied by the observer, NOT read from the commit:
    actorFromCommitIdentity: false,
    role: "orchestrator",
    provider: "antigravity",
    // Distinct workspace so this point is selected by identity rather than by
    // being the first "unattributed" one -- the partial-commit test produces an
    // unattributed point too, and matching on that alone would assert against
    // the wrong commit and stay green no matter what.
    workspace: { key: "workspace-multi-actor" }
  });
  await flushTelemetryMetrics();
  const unattributed = findMetricPoints(METRIC_GIT_COMMITS).find(
    (point) => point.attributes["autodev.workspace"] === "workspace-multi-actor"
  );
  assert.ok(
    unattributed,
    "a commit with no source-confirmed actor is labelled"
  );
  assert.equal(unattributed.attributes["autodev.agent.role"], undefined);
  assert.equal(unattributed.attributes["gen_ai.provider.name"], undefined);
  // The workspace is still certain, so it survives.
  assert.equal(
    unattributed.attributes["autodev.workspace"],
    "workspace-multi-actor"
  );
});

test("a partially measurable commit is labelled rather than silently shrunk", async () => {
  installExporter();
  resetTrackedGitCommitsForTest();

  recordGitCommit({
    commit: "b".repeat(40),
    filesChanged: 2,
    filesAdded: 1,
    filesDeleted: 0,
    linesAdded: 0,
    linesRemoved: 0,
    partial: true,
    workspace: { key: "workspace-a" }
  });
  await flushTelemetryMetrics();

  // Cumulative temporality keeps one point per attribute set, so the partial
  // one is found by its attribute rather than assumed to be the first.
  const partialPoint = findMetricPoints(METRIC_GIT_COMMITS).find(
    (point) => point.attributes[ATTR_AUTODEV_GIT_PARTIAL] === "true"
  );
  assert.ok(
    partialPoint,
    "a commit with an unsummarizable diff must carry the partial label"
  );
});

test("an unmeasurable commit is refused rather than recorded as zero changes", async () => {
  installExporter();
  resetTrackedGitCommitsForTest();
  await flushTelemetryMetrics();
  const totalBefore = totalGitCommits();

  // Negative counts cannot come from git, so they are rejected instead of
  // being clamped into a plausible-looking zero.
  assert.equal(
    recordGitCommit({
      commit: "c".repeat(40),
      filesChanged: -1,
      filesAdded: 0,
      filesDeleted: 0,
      linesAdded: 0,
      linesRemoved: 0
    }),
    false
  );
  assert.equal(
    recordGitCommit({
      commit: "",
      filesChanged: 1,
      filesAdded: 1,
      filesDeleted: 0,
      linesAdded: 1,
      linesRemoved: 0
    }),
    false
  );

  // Re-measure the same way: the exporter keeps every collection snapshot, so
  // clearing it first means both readings cover exactly one snapshot rather
  // than summing an accumulating buffer.
  telemetryMetricExporter.reset();
  await flushTelemetryMetrics();
  // Nothing was emitted: the two refused calls left the running total exactly
  // where it was, rather than adding a zero-change commit.
  assert.equal(totalGitCommits(), totalBefore);
});

test("an invalid observation does not consume the commit's idempotency claim", async () => {
  installExporter();
  resetTrackedGitCommitsForTest();
  await flushTelemetryMetrics();
  const totalBefore = totalGitCommits();
  const commit = "e".repeat(40);

  assert.equal(
    recordGitCommit({
      commit,
      filesChanged: -1,
      filesAdded: 0,
      filesDeleted: 0,
      linesAdded: 0,
      linesRemoved: 0
    }),
    false
  );
  assert.equal(
    recordGitCommit({
      commit,
      filesChanged: 1,
      filesAdded: 1,
      filesDeleted: 0,
      linesAdded: 1,
      linesRemoved: 0,
      actorFromCommitIdentity: true,
      role: "worker",
      provider: "codex"
    }),
    true,
    "a valid remeasurement must be recordable after an invalid attempt"
  );

  telemetryMetricExporter.reset();
  await flushTelemetryMetrics();
  assert.equal(totalGitCommits(), totalBefore + 1);
});

/** Cumulative temporality keeps one point per attribute set, so sum them. */
function totalGitCommits(): number {
  return findMetricPoints(METRIC_GIT_COMMITS).reduce(
    (sum, point) =>
      sum + (typeof point.value === "number" ? point.value : point.value.sum),
    0
  );
}

test("a source-confirmed session is published on the request and its attempts", async () => {
  installExporter();
  const sessionId = "01a0ba14-d54c-78f2-9367-3f80e9a8f75f";
  const logical = startLogicalRequestSpan({
    requestId: "session-attribution-request",
    role: "worker",
    providerRole: "subagent",
    workspace: { key: "session-workspace" },
    subject: "session fixture",
    requestedModel: "session-model",
    sessionId
  });
  await withLogicalSpan(logical, async () => {
    const attempt = startAttemptSpan({
      provider: "session-provider",
      model: "session-model",
      selection: "primary",
      attemptNumber: 1,
      role: "worker",
      workspace: { key: "session-workspace" },
      sessionId
    });
    endAttemptSpan(attempt, { status: "ok", responseModel: "session-model" });
  });
  endLogicalRequestSpan(logical, { status: "ok" });

  const spans = snapshotSpans();
  const logicalSpans = findLogical(spans);
  assert.equal(logicalSpans.length, 1);
  assert.equal(logicalSpans[0]?.attributes["autodev.session.id"], sessionId);
  const attempts = findAttemptSpans(spans);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.attributes["autodev.session.id"], sessionId);

  await flushTelemetryMetrics();
  const metricAttributes: Array<Record<string, unknown>> = [];
  for (const resource of telemetryMetricExporter.getMetrics()) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) {
        for (const point of metric.dataPoints) {
          metricAttributes.push(point.attributes);
        }
      }
    }
  }
  assert.ok(
    metricAttributes.length > 0,
    "the routed operation records metrics"
  );
  for (const attributes of metricAttributes) {
    assert.equal(
      Object.hasOwn(attributes, "autodev.session.id"),
      false,
      "session identity is trace context, never a metric dimension"
    );
  }
});

test("an unidentified session is not published as a session identity", () => {
  installExporter();
  for (const sessionId of [
    null,
    undefined,
    "",
    "   ",
    "unknown",
    "process-scope",
    "/Users/someone/workspace",
    "https://example.test/session",
    "x".repeat(129)
  ]) {
    const logical = startLogicalRequestSpan({
      requestId: "session-attribution-rejected",
      role: "worker",
      providerRole: "subagent",
      workspace: { key: "session-workspace" },
      subject: "session fixture",
      requestedModel: "session-model",
      sessionId
    });
    endLogicalRequestSpan(logical, { status: "ok" });
  }

  const logicalSpans = findLogical(snapshotSpans());
  assert.equal(logicalSpans.length, 9);
  for (const span of logicalSpans) {
    assert.equal(
      span.attributes["autodev.session.id"],
      undefined,
      "an unidentified session must not become a session identity"
    );
  }
});
