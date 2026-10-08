import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  endAttemptSpan,
  getFinishedSpans,
  resetTelemetryExporter,
  setTelemetryExporter,
  startAttemptSpan
} from "../src/router/telemetry.ts";

const exporter = new InMemorySpanExporter();
setTelemetryExporter(exporter);

test("provider-attempt spans carry only validated workspace and role context", () => {
  const valid = startAttemptSpan({
    provider: "openai",
    model: "gpt-6-luna",
    requestedModel: "gpt-6-luna",
    selection: "primary",
    attemptNumber: 1,
    workspace: { key: "SimulatorLife/AutoDev" },
    role: "orchestrator"
  });
  endAttemptSpan(valid, { status: "ok" });

  const validAttributes = getFinishedSpans()[0]?.attributes;
  assert.equal(validAttributes?.["autodev.workspace"], "SimulatorLife/AutoDev");
  assert.equal(validAttributes?.["autodev.agent.role"], "orchestrator");

  resetTelemetryExporter();
  const unsafe = startAttemptSpan({
    provider: "openai",
    model: "gpt-6-luna",
    selection: "primary",
    attemptNumber: 2,
    workspace: { key: "/Users/private/repo" },
    role: "unattributed"
  });
  endAttemptSpan(unsafe, { status: "ok" });

  const unsafeAttributes = getFinishedSpans()[0]?.attributes;
  assert.equal(unsafeAttributes?.["autodev.workspace"], undefined);
  assert.equal(unsafeAttributes?.["autodev.agent.role"], undefined);
});
