/**
 * Focused telemetry tests for the source-owned observation of the MCP
 * `tools/call` operation in `runtime/src/mcp/codex-tools-shim.ts`.
 *
 * The shim is the producer that owns the operation. These tests pin:
 * 1. Exactly one `tools/call <tool_name>` span per `tools/call`,
 *    regardless of success, HTTP failure, bridge throw, or tool-level
 *    `isError=true` outcome.
 * 2. Privacy: arguments, results, prompts, session/request/JSON-RPC ids
 *    are never attached as span attributes or metric dimensions.
 * 3. `initialize` and `tools/list` never emit operation spans.
 * 4. A telemetry-side failure cannot fail or block the `tools/call`
 *    operation; the JSON-RPC response is still emitted.
 * 5. The OTLP HTTP exporter is only installed when
 *    `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`)
 *    is configured.
 *
 * The MCP conventions are pinned to
 * open-telemetry/semantic-conventions-genai@bcc7f9c2856fa7f4feb753f54d4ebba9455cc3dc.
 * They are Development and untagged. The tests pin that revision and the
 * incubating package attributes this producer emits.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  ensureOtelInitialized,
  getFinishedSpans,
  handleMessage,
  isOtlpExporterInstalled,
  MCP_SEMCONV_GENAI_REVISION,
  resetTelemetryForTest,
  setTestExporter,
  shutdownTelemetryForTest
} from "@simulatorlife/autodev-runtime/mcp";

type JsonObject = Record<string, unknown>;

interface CapturedMessage extends JsonObject {
  id: JsonObject["id"];
  result?: JsonObject;
  error?: JsonObject;
}

function makeEmitter(): {
  messages: CapturedMessage[];
  emit: (message: JsonObject) => void;
} {
  const messages: CapturedMessage[] = [];
  return {
    messages,
    emit(message) {
      messages.push(message as CapturedMessage);
    }
  };
}

function okBridge(body: JsonObject): (
  path: string,
  payload: JsonObject
) => Promise<{
  status: number;
  body: JsonObject | null;
}> {
  return async () => ({ status: 200, body });
}

function failingBridge(
  status: number,
  body: JsonObject | null = null
): (
  path: string,
  payload: JsonObject
) => Promise<{
  status: number;
  body: JsonObject | null;
}> {
  return async () => ({ status, body });
}

function throwingBridge(): (
  path: string,
  payload: JsonObject
) => Promise<{ status: number; body: JsonObject | null }> {
  return async () => {
    throw new Error("bridge unreachable");
  };
}

const exporter = new InMemorySpanExporter();
const originalTraceEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const originalOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

test.before(async () => {
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  setTestExporter(exporter);
  // Force the SDK to install its processors once so each test exercises
  // the real recording path rather than a no-op tracer.
  ensureOtelInitialized();
});

test.beforeEach(() => {
  exporter.reset();
});

test.after(async () => {
  resetTelemetryForTest();
  await shutdownTelemetryForTest();
  setTestExporter(null);
  if (originalTraceEndpoint !== undefined) {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = originalTraceEndpoint;
  }
  if (originalOtlpEndpoint !== undefined) {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOtlpEndpoint;
  }
});

test("pins the Development MCP semantic-convention source revision", () => {
  assert.equal(
    MCP_SEMCONV_GENAI_REVISION,
    "bcc7f9c2856fa7f4feb753f54d4ebba9455cc3dc"
  );
});

test("successful tools/call emits exactly one tools/call <name> span with OK status", async () => {
  const emitter = makeEmitter();
  await handleMessage(
    {
      id: "call-success",
      method: "tools/call",
      params: {
        name: "read_file",
        arguments: {
          path: "/private/secret/secret.txt",
          contents: "do not capture this"
        }
      }
    },
    emitter.emit,
    okBridge({
      content: [{ type: "text", text: "ok" }],
      isError: false
    })
  );

  const spans = getFinishedSpans();
  const callSpans = spans.filter(
    (span) => span.name === "tools/call read_file"
  );
  assert.equal(
    callSpans.length,
    1,
    "exactly one tools/call span per successful call"
  );
  const span = callSpans[0];
  assert.ok(span);
  assert.equal(
    span.kind,
    1,
    "span kind is SERVER (value 1) for the MCP server"
  );
  assert.equal(
    span.status.code,
    1,
    "successful call is recorded with OK status"
  );
  assert.equal(span.attributes["mcp.method.name"], "tools/call");
  assert.equal(span.attributes["gen_ai.tool.name"], "read_file");
  assert.equal(span.attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(span.attributes["network.transport"], "pipe");

  // Privacy: no arguments, results, prompts, ids, paths, or content.
  for (const forbidden of [
    "arguments",
    "args",
    "params",
    "result",
    "output",
    "content",
    "prompt",
    "session_id",
    "session.id",
    "sessionId",
    "request_id",
    "requestId",
    "jsonrpc",
    "id",
    "path",
    "contents",
    "turn"
  ]) {
    assert.equal(
      Object.hasOwn(span.attributes, forbidden),
      false,
      `${forbidden} must never appear as a span attribute`
    );
  }

  assert.equal(emitter.messages.length, 1);
  assert.deepEqual(emitter.messages[0]?.id, "call-success");
  assert.ok(emitter.messages[0]?.result);
});

test("tools/call HTTP failure emits exactly one tools/call <name> span with ERROR status", async () => {
  const emitter = makeEmitter();
  await handleMessage(
    {
      id: 7,
      method: "tools/call",
      params: {
        name: "fetch_url",
        arguments: { url: "https://private.example/x", token: "secret" }
      }
    },
    emitter.emit,
    failingBridge(503, { error: "Codex upstream overloaded" })
  );

  const callSpans = getFinishedSpans().filter(
    (span) => span.name === "tools/call fetch_url"
  );
  assert.equal(
    callSpans.length,
    1,
    "exactly one tools/call span per HTTP failure"
  );
  const span = callSpans[0];
  assert.ok(span);
  assert.equal(
    span.status.code,
    2,
    "HTTP failure is recorded with ERROR status"
  );
  assert.equal(span.attributes["mcp.method.name"], "tools/call");
  assert.equal(span.attributes["gen_ai.tool.name"], "fetch_url");
  assert.equal(span.attributes["error.type"], "tool_error");
  assert.equal(span.status.message, undefined);
  assert.equal(
    Object.hasOwn(span.attributes, "http.response.status_code"),
    false,
    "the internal bridge HTTP response is not presented as MCP transport status"
  );
  assert.equal(
    Object.hasOwn(span.attributes, "arguments"),
    false,
    "arguments must never appear as a span attribute on HTTP failure"
  );
  assert.equal(
    Object.hasOwn(span.attributes, "url"),
    false,
    "argument keys must never appear as span attributes"
  );
  assert.equal(
    Object.hasOwn(span.attributes, "token"),
    false,
    "secret keys must never appear as span attributes"
  );

  // The shim must still emit a model-readable error response, proving
  // the call path was not blocked by telemetry.
  assert.equal(emitter.messages.length, 1);
  const errorText = (
    (emitter.messages[0]?.result as JsonObject | undefined)?.content as
      JsonObject[] | undefined
  )?.[0]?.text;
  assert.equal(typeof errorText, "string");
});

test("tools/call bridge throw emits exactly one tools/call <name> span with ERROR status", async () => {
  const emitter = makeEmitter();
  await handleMessage(
    {
      id: "throw-1",
      method: "tools/call",
      params: { name: "any_tool", arguments: { secret: "do-not-leak" } }
    },
    emitter.emit,
    throwingBridge()
  );

  const callSpans = getFinishedSpans().filter(
    (span) => span.name === "tools/call any_tool"
  );
  assert.equal(callSpans.length, 1, "exactly one tools/call span per throw");
  const span = callSpans[0];
  assert.ok(span);
  assert.equal(span.status.code, 2, "thrown bridge call is recorded as ERROR");
  assert.equal(span.attributes["mcp.method.name"], "tools/call");
  assert.equal(span.attributes["error.type"], "tool_error");
  assert.equal(
    span.status.message,
    undefined,
    "free-form errors are not exported"
  );
  assert.equal(
    Object.hasOwn(span.attributes, "http.response.status_code"),
    false,
    "no http status is recorded when the bridge never responds"
  );
  assert.equal(
    Object.hasOwn(span.attributes, "secret"),
    false,
    "argument keys must never appear as span attributes on thrown calls"
  );

  assert.equal(emitter.messages.length, 1);
  const errorText = (
    (emitter.messages[0]?.result as JsonObject | undefined)?.content as
      JsonObject[] | undefined
  )?.[0]?.text;
  assert.equal(typeof errorText, "string");
  assert.match(String(errorText), /bridge unreachable/);
});

test("initialize and tools/list do not emit any operation spans", async () => {
  const emitter = makeEmitter();
  await handleMessage(
    {
      id: "init-1",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" }
    },
    emitter.emit,
    okBridge({})
  );
  await handleMessage(
    {
      id: "list-1",
      method: "tools/list"
    },
    emitter.emit,
    okBridge({ tools: [{ name: "x" }] })
  );
  await handleMessage(
    {
      method: "notifications/cancelled"
    },
    emitter.emit,
    okBridge({})
  );

  const callSpans = getFinishedSpans().filter((span) =>
    span.name.startsWith("tools/call")
  );
  assert.equal(
    callSpans.length,
    0,
    "non-call methods must not produce any MCP operation spans"
  );
  assert.equal(
    emitter.messages.length,
    2,
    "initialize and tools/list each emit one response; the notification expects no reply"
  );
});

test("tools/call with isError=true response emits a tools/call span with error.type=tool_error", async () => {
  const emitter = makeEmitter();
  await handleMessage(
    {
      id: "tool-error-1",
      method: "tools/call",
      params: {
        name: "run_command",
        arguments: { cmd: "rm -rf /" }
      }
    },
    emitter.emit,
    okBridge({
      content: [{ type: "text", text: "command failed" }],
      isError: true
    })
  );

  const callSpans = getFinishedSpans().filter((span) =>
    span.name.startsWith("tools/call")
  );
  assert.equal(callSpans.length, 1, "exactly one tools/call span");
  const span = callSpans[0];
  assert.ok(span);
  assert.equal(span.name, "tools/call run_command");
  assert.equal(
    span.status.code,
    2,
    "tool-level isError=true is recorded as ERROR status"
  );
  assert.equal(span.attributes["mcp.method.name"], "tools/call");
  assert.equal(span.attributes["gen_ai.tool.name"], "run_command");
  assert.equal(span.attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(
    span.attributes["error.type"],
    "tool_error",
    "tool-level failures use the Development MCP convention error tag"
  );
  assert.equal(
    Object.hasOwn(span.attributes, "cmd"),
    false,
    "argument keys must never appear as span attributes"
  );
  assert.equal(
    Object.hasOwn(span.attributes, "content"),
    false,
    "result content must never appear as a span attribute"
  );

  // The shim still emits the model-readable response (transport succeeded;
  // the tool result is what Claude reads).
  assert.equal(emitter.messages.length, 1);
  const result = emitter.messages[0]?.result as JsonObject | undefined;
  assert.equal(result?.isError, true);
});

test("extracts W3C context only from MCP params._meta", async () => {
  const emitter = makeEmitter();
  await handleMessage(
    {
      id: "trace-context-call",
      method: "tools/call",
      params: {
        name: "inspect",
        arguments: { path: "/private/path" },
        _meta: {
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "vendor=value",
          baggage: "operation=tool-call",
          unrelated: "must-not-be-exported"
        }
      }
    },
    emitter.emit,
    okBridge({ content: [{ type: "text", text: "ok" }] })
  );

  const span = getFinishedSpans().find(
    (finished) => finished.name === "tools/call inspect"
  );
  assert.ok(span);
  assert.equal(span.spanContext().traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(span.parentSpanContext?.spanId, "00f067aa0ba902b7");
  assert.equal(Object.hasOwn(span.attributes, "baggage"), false);
  assert.equal(Object.hasOwn(span.attributes, "unrelated"), false);
  assert.equal(Object.hasOwn(span.attributes, "path"), false);
});

test("resource identity always carries autodev-codex-tools-mcp and never inherits router service.name", async () => {
  const previousService = process.env.OTEL_SERVICE_NAME;
  const previousResourceAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  process.env.OTEL_SERVICE_NAME = "autodev-router";
  process.env.OTEL_RESOURCE_ATTRIBUTES =
    "service.name=autodev-router,autodev.workspace=fallback-accounting-workspace,autodev.agent.role=worker,deployment.environment=local";
  // Tear down the SDK installed in test.before so this test can install
  // a fresh one with the env vars above and observe the merged resource
  // on the span it actually emits.
  await shutdownTelemetryForTest();
  const freshExporter = new InMemorySpanExporter();
  setTestExporter(freshExporter);
  try {
    const tracer = ensureOtelInitialized();
    assert.ok(tracer);
    const span = tracer.startSpan("verify-resource", { kind: 1 });
    span.end();
    // Allow the SimpleSpanProcessor microtask flush to settle.
    await new Promise((resolve) => setImmediate(resolve));
    const finished = freshExporter.getFinishedSpans();
    const observed = finished.find((entry) => entry.name === "verify-resource");
    assert.ok(observed, "span must be observed by the exporter");
    assert.equal(
      observed.resource.attributes["service.name"],
      "autodev-codex-tools-mcp",
      "shim producer identity must always win over an inherited OTEL_SERVICE_NAME"
    );
    assert.equal(
      observed.resource.attributes["autodev.workspace"],
      "fallback-accounting-workspace",
      "validated per-turn workspace context inherited from Claude CLI must reach the shim's spans"
    );
    assert.equal(
      observed.resource.attributes["autodev.agent.role"],
      "worker",
      "validated per-turn agent role context inherited from Claude CLI must reach the shim's spans"
    );
    assert.equal(
      observed.resource.attributes["deployment.environment"],
      "local",
      "non-AutoDev env attributes pass through"
    );
  } finally {
    if (previousService === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = previousService;
    if (previousResourceAttrs === undefined)
      delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = previousResourceAttrs;
    await shutdownTelemetryForTest();
    setTestExporter(exporter);
    ensureOtelInitialized();
  }
});

test("unsafe or unknown AutoDev context inherited via OTEL_RESOURCE_ATTRIBUTES is rejected", async () => {
  const previousResourceAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  process.env.OTEL_RESOURCE_ATTRIBUTES =
    "autodev.workspace=/Users/private/AutoDev,autodev.workspace=fallback-accounting-workspace,autodev.agent.role=unknown,autodev.agent.role=worker";
  await shutdownTelemetryForTest();
  const freshExporter = new InMemorySpanExporter();
  setTestExporter(freshExporter);
  try {
    const tracer = ensureOtelInitialized();
    assert.ok(tracer);
    const span = tracer.startSpan("verify-validation", { kind: 1 });
    span.end();
    const observed = freshExporter
      .getFinishedSpans()
      .find((entry) => entry.name === "verify-validation");
    assert.ok(observed);
    assert.equal(
      observed.resource.attributes["autodev.workspace"],
      "fallback-accounting-workspace",
      "unsafe path-shaped workspace must be dropped; the validated value passes through"
    );
    assert.equal(
      observed.resource.attributes["autodev.agent.role"],
      "worker",
      "'unknown' role must be dropped; a bounded role passes through"
    );
  } finally {
    if (previousResourceAttrs === undefined)
      delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = previousResourceAttrs;
    await shutdownTelemetryForTest();
    setTestExporter(exporter);
    ensureOtelInitialized();
  }
});

test("the exporter actually receives the merged resource on emitted tools/call spans", async () => {
  const previousResourceAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  process.env.OTEL_RESOURCE_ATTRIBUTES =
    "autodev.workspace=fallback-accounting-workspace,autodev.agent.role=worker,deployment.environment=ci";
  await shutdownTelemetryForTest();
  const freshExporter = new InMemorySpanExporter();
  setTestExporter(freshExporter);
  try {
    const emitter = makeEmitter();
    await handleMessage(
      {
        id: "resource-flow-1",
        method: "tools/call",
        params: { name: "inspect", arguments: { x: 1 } }
      },
      emitter.emit,
      okBridge({ content: [{ type: "text", text: "ok" }] })
    );
    const callSpan = freshExporter
      .getFinishedSpans()
      .find((span) => span.name.startsWith("tools/call"));
    assert.ok(callSpan, "tools/call span must have been emitted");
    assert.equal(
      callSpan.resource.attributes["service.name"],
      "autodev-codex-tools-mcp",
      "the exporter must observe the shim's own service.name on the emitted span"
    );
    assert.equal(
      callSpan.resource.attributes["autodev.workspace"],
      "fallback-accounting-workspace",
      "the exporter must observe validated workspace inherited from the parent env"
    );
    assert.equal(
      callSpan.resource.attributes["autodev.agent.role"],
      "worker",
      "the exporter must observe validated agent role inherited from the parent env"
    );
    assert.equal(
      callSpan.resource.attributes["deployment.environment"],
      "ci",
      "the exporter must observe non-AutoDev env attributes passed through"
    );
  } finally {
    if (previousResourceAttrs === undefined)
      delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = previousResourceAttrs;
    await shutdownTelemetryForTest();
    setTestExporter(exporter);
    ensureOtelInitialized();
  }
});

test("tools/call still responds when telemetry has no configured exporter", async () => {
  // Drop the endpoint that may already be set in the developer shell so
  // the SDK does not attempt to reach an OTLP endpoint during this test.
  const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const previousTraces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  // Force the exporter path to be torn down and rebuilt so the test
  // exercises the real production shape: an absent endpoint yields a
  // no-op tracer and an unchanged call path.
  await shutdownTelemetryForTest();
  setTestExporter(exporter);
  try {
    const tracer = ensureOtelInitialized();
    assert.ok(tracer, "ensureOtelInitialized must return a tracer");
    assert.equal(
      isOtlpExporterInstalled(),
      false,
      "no exporter must be installed without an OTLP endpoint"
    );

    const emitter = makeEmitter();
    await handleMessage(
      {
        id: "no-otel-call",
        method: "tools/call",
        params: { name: "tool_without_otel", arguments: { secret: "x" } }
      },
      emitter.emit,
      okBridge({ content: [{ type: "text", text: "still works" }] })
    );
    assert.equal(emitter.messages.length, 1);
    const text = (
      (emitter.messages[0]?.result as JsonObject | undefined)?.content as
        JsonObject[] | undefined
    )?.[0]?.text;
    assert.equal(text, "still works");
  } finally {
    if (previousEndpoint !== undefined)
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
    if (previousTraces !== undefined)
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = previousTraces;
  }
});
