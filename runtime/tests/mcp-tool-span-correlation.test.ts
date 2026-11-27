import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";

import {
  getFinishedSpans,
  recordToolCallSpan,
  resetTelemetryForTest,
  setTestExporter,
  shutdownTelemetryForTest
} from "../src/mcp/mcp-telemetry.ts";

const exporter = new InMemorySpanExporter();

test.before(async () => {
  await shutdownTelemetryForTest();
  setTestExporter(exporter);
});

test.afterEach(() => resetTelemetryForTest());

test.after(async () => {
  await shutdownTelemetryForTest();
  setTestExporter(null);
});

test("a gateway tools/call span carries the verified role, workspace and session", async () => {
  await recordToolCallSpan(
    "read_text_file",
    async () => ({ status: "ok" }),
    { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
    {
      server: "filesystem",
      role: "explorer",
      workspace: "owner/repository",
      sessionId: "019a-session_1"
    }
  );
  const [span] = getFinishedSpans();
  assert.ok(span);
  assert.equal(span.name, "tools/call read_text_file");
  assert.equal(span.attributes["autodev.mcp.server"], "filesystem");
  assert.equal(span.attributes["autodev.agent.role"], "explorer");
  assert.equal(span.attributes["autodev.workspace"], "owner/repository");
  assert.equal(span.attributes["autodev.session.id"], "019a-session_1");
  // The propagated parent is honoured, so the span joins the caller's trace.
  assert.equal(span.spanContext().traceId, "0af7651916cd43dd8448eb211c80319c");
});

test("unverifiable correlation is Not observed, never a placeholder or a raw path", async () => {
  await recordToolCallSpan(
    "write_file",
    async () => ({ status: "ok" }),
    undefined,
    {
      role: "unknown",
      workspace: "/Users/someone/private-project",
      sessionId: "process-fallback"
    }
  );
  await recordToolCallSpan("write_file", async () => ({ status: "ok" }));
  const spans = getFinishedSpans();
  assert.equal(spans.length, 2);
  for (const span of spans) {
    for (const key of [
      "autodev.agent.role",
      "autodev.workspace",
      "autodev.session.id"
    ])
      assert.equal(Object.hasOwn(span.attributes, key), false, key);
    assert.ok(
      !JSON.stringify(span.attributes).includes("private-project"),
      "a raw workspace path reached the span"
    );
  }
});

test("correlation never changes the call's outcome or adds its content", async () => {
  const outcome = await recordToolCallSpan(
    "search",
    async () => ({ status: "error", errorType: "tool_error" }),
    { arguments: "private-arguments" },
    { role: "worker", workspace: "owner/repository", sessionId: "session-2" }
  );
  assert.deepEqual(outcome, { status: "error", errorType: "tool_error" });
  const [span] = getFinishedSpans();
  assert.ok(span);
  assert.equal(span.attributes["error.type"], "tool_error");
  assert.ok(!JSON.stringify(span.attributes).includes("private-arguments"));
});
