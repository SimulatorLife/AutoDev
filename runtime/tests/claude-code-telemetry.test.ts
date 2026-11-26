import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claudeCodeHeadersHelperCommand,
  claudeCodeTelemetryDrift,
  MANAGED_ENVIRONMENT,
  planClaudeCodeTelemetry,
  reconcileClaudeCodeTelemetry
} from "../src/platform/claude-code-telemetry.ts";
import { renderOtlpHeaders } from "../src/telemetry/otel-headers-helper.ts";

const HELPER = claudeCodeHeadersHelperCommand("/Users/operator/.autodev");

test("the headers helper runs the installed helper through the hook launcher", () => {
  assert.equal(
    HELPER,
    "'/Users/operator/.autodev/hooks/run-autodev-hook.sh' '/Users/operator/.autodev/src/telemetry/otel-headers-helper.ts'"
  );
});

test("an empty settings file gains the native exporter and nothing content-bearing", () => {
  const plan = planClaudeCodeTelemetry(undefined, HELPER);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.settings.env, MANAGED_ENVIRONMENT);
  assert.equal(plan.settings.otelHeadersHelper, HELPER);
  const serialized = JSON.stringify(plan.settings);
  assert.ok(!serialized.includes("Bearer"), "a credential was written");
  for (const key of [
    "OTEL_LOG_USER_PROMPTS",
    "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_TOOL_CONTENT",
    "OTEL_LOG_RAW_API_BODIES"
  ])
    assert.ok(!serialized.includes(key), key);
});

test("operator settings are preserved and operator values are reported, not overwritten", () => {
  const existing = {
    theme: "dark",
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
      OTEL_LOG_USER_PROMPTS: "1",
      OTEL_LOG_TOOL_DETAILS: "0",
      UNRELATED: "kept"
    }
  };
  const plan = planClaudeCodeTelemetry(existing, HELPER);
  assert.equal(plan.settings.theme, "dark");
  const environment = plan.settings.env as Record<string, string>;
  assert.equal(environment.UNRELATED, "kept");
  assert.equal(
    environment.OTEL_EXPORTER_OTLP_ENDPOINT,
    "http://collector.example:4318"
  );
  assert.equal(environment.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  assert.deepEqual(new Set(plan.conflicts), new Set([
    "env.OTEL_EXPORTER_OTLP_ENDPOINT",
    "env.OTEL_LOG_USER_PROMPTS"
  ]));
  // The input object itself is not mutated.
  assert.equal(
    (existing.env as Record<string, string>).CLAUDE_CODE_ENABLE_TELEMETRY,
    undefined
  );
});

test("a malformed settings document is refused rather than replaced", () => {
  assert.throws(() => planClaudeCodeTelemetry([], HELPER));
  assert.throws(() => planClaudeCodeTelemetry({ env: "x" }, HELPER));
});

test("reconcile writes once, then the drift check is clean and idempotent", () => {
  const home = mkdtempSync(path.join(tmpdir(), "claude-telemetry-"));
  const settingsPath = path.join(home, ".claude", "settings.json");
  try {
    assert.deepEqual(claudeCodeTelemetryDrift(settingsPath, HELPER).missing, [
      ...Object.keys(MANAGED_ENVIRONMENT).map((key) => `env.${key}`),
      "otelHeadersHelper"
    ]);
    assert.deepEqual(reconcileClaudeCodeTelemetry(settingsPath, HELPER), []);
    const first = readFileSync(settingsPath, "utf8");
    assert.deepEqual(claudeCodeTelemetryDrift(settingsPath, HELPER), {
      missing: [],
      conflicts: []
    });
    reconcileClaudeCodeTelemetry(settingsPath, HELPER);
    assert.equal(readFileSync(settingsPath, "utf8"), first);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the headers helper reads the receiver key from the private secret file only", () => {
  const home = mkdtempSync(path.join(tmpdir(), "otel-headers-"));
  try {
    const secretFile = path.join(home, "openlit-secrets.env");
    assert.equal(
      renderOtlpHeaders({ HOME: home, AUTODEV_OPENLIT_SECRET_FILE: secretFile }),
      null
    );
    writeFileSync(secretFile, "OPENLIT_OTLP_API_KEY=fixture-receiver-key\n", {
      mode: 0o600
    });
    assert.deepEqual(
      JSON.parse(
        renderOtlpHeaders({
          HOME: home,
          AUTODEV_OPENLIT_SECRET_FILE: secretFile
        }) ?? "null"
      ),
      { Authorization: "Bearer fixture-receiver-key" }
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
