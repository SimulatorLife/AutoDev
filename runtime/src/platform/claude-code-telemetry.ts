/**
Native OpenTelemetry export for operator-started Claude Code sessions.

Claude Code (2.1.x) ships its own OTel exporter for metrics and log events
-- sessions, tokens, cost, active time, tool decisions and API errors --
enabled by `CLAUDE_CODE_ENABLE_TELEMETRY` and configured with the standard
`OTEL_*` variables, which it reads from the `env` block of the user's
`~/.claude/settings.json`. Using that exporter is how a standalone Claude
Code chat becomes observable without AutoDev intercepting it: the host
reports what it actually did, under its own `service.name`, session and
terminal attributes, straight to the same OpenLIT receiver every other
producer uses.

This module owns AutoDev's slice of that file and nothing else:

- the fixed, non-secret exporter selection (`MANAGED_ENVIRONMENT`);
- `otelHeadersHelper`, a command that prints the receiver's bearer header at
  export time, so the key never lands in the settings file;
- the privacy switches Claude Code leaves off by default (prompts, tool
  details and content, raw API bodies), which AutoDev requires to stay off.

Every other key is the operator's and is preserved. A managed key the
operator already set to a different value is a conflict: it is reported,
never overwritten. A privacy switch the operator turned on is likewise
reported rather than silently reverted.
*/

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";

/**
The OpenLIT receiver's OTLP/HTTP base endpoint (see config/openlit/otlp-endpoints.md).
*/
export const OPENLIT_OTLP_HTTP_ENDPOINT = "http://127.0.0.1:4318";

/**
The exporter selection AutoDev manages in Claude Code's `env` block.
*/
export const MANAGED_ENVIRONMENT: Readonly<Record<string, string>> =
  Object.freeze({
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: OPENLIT_OTLP_HTTP_ENDPOINT
  });

/**
Content-bearing switches that must stay off. Claude Code leaves each off
unless it is set truthy; AutoDev never sets them, and reports one that is.
*/
export const CONTENT_SWITCHES: readonly string[] = Object.freeze([
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_RAW_API_BODIES"
]);

const HEADERS_HELPER_KEY = "otelHeadersHelper";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const FALSY_SWITCH_VALUES = new Set(["", "0", "false", "no", "off"]);

/**
The headers-helper command, run through the installed hook launcher.
*/
export function claudeCodeHeadersHelperCommand(autodevHome: string): string {
  return [
    path.join(autodevHome, "hooks", "run-autodev-hook.sh"),
    path.join(autodevHome, "src", "telemetry", "otel-headers-helper.ts")
  ]
    .map((part) => `'${part.replaceAll("'", String.raw`'\''`)}'`)
    .join(" ");
}

export interface ClaudeCodeTelemetryPlan {
  /**
  The settings with every non-conflicting managed key applied.
  */
  readonly settings: Record<string, unknown>;
  /**
  Whether `settings` differs from the input.
  */
  readonly changed: boolean;
  /**
  Managed keys the operator set differently, and enabled content switches.
  */
  readonly conflicts: readonly string[];
}

/**
Plan AutoDev's slice of a parsed `~/.claude/settings.json`. Pure: the
caller decides whether to write the result.
*/
export function planClaudeCodeTelemetry(
  existing: unknown,
  headersHelperCommand: string
): ClaudeCodeTelemetryPlan {
  if (existing !== undefined && !isJsonObject(existing))
    throw new Error("Claude Code settings must be a JSON object");
  const settings: Record<string, unknown> = { ...existing };
  if (settings.env !== undefined && !isJsonObject(settings.env))
    throw new Error("Claude Code settings `env` must be a JSON object");
  const environment: Record<string, unknown> = { ...settings.env };
  const conflicts: string[] = [];
  let isChanged = false;

  for (const [key, value] of Object.entries(MANAGED_ENVIRONMENT)) {
    if (environment[key] === undefined) {
      environment[key] = value;
      isChanged = true;
    } else if (environment[key] !== value) {
      conflicts.push(`env.${key}`);
    }
  }
  for (const key of CONTENT_SWITCHES) {
    const value = environment[key];
    if (
      value !== undefined &&
      !FALSY_SWITCH_VALUES.has(String(value).trim().toLowerCase())
    )
      conflicts.push(`env.${key}`);
  }
  if (settings[HEADERS_HELPER_KEY] === undefined) {
    settings[HEADERS_HELPER_KEY] = headersHelperCommand;
    isChanged = true;
  } else if (settings[HEADERS_HELPER_KEY] !== headersHelperCommand) {
    conflicts.push(HEADERS_HELPER_KEY);
  }
  if (isChanged) settings.env = environment;
  return { settings, changed: isChanged, conflicts };
}

function readSettings(settingsPath: string): unknown {
  return existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as unknown)
    : undefined;
}

/**
Apply AutoDev's slice to the settings file, preserving every other key.
Returns the conflicts it left in place.
*/
export function reconcileClaudeCodeTelemetry(
  settingsPath: string,
  headersHelperCommand: string
): readonly string[] {
  const plan = planClaudeCodeTelemetry(
    readSettings(settingsPath),
    headersHelperCommand
  );
  if (plan.changed) {
    mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    atomicWriteSync(
      settingsPath,
      `${JSON.stringify(plan.settings, null, 2)}\n`,
      { mode: 0o600 }
    );
  }
  return plan.conflicts;
}

/**
Read-only drift check: the managed keys that are missing, and the conflicts
the installer would report. Empty means the native exporter is configured.
*/
export function claudeCodeTelemetryDrift(
  settingsPath: string,
  headersHelperCommand: string
): { readonly missing: readonly string[]; readonly conflicts: readonly string[] } {
  const existing = readSettings(settingsPath);
  const plan = planClaudeCodeTelemetry(existing, headersHelperCommand);
  const current = isJsonObject(existing) ? existing : {};
  const environment = isJsonObject(current.env) ? current.env : {};
  const missing = [
    ...Object.keys(MANAGED_ENVIRONMENT)
      .filter((key) => environment[key] === undefined)
      .map((key) => `env.${key}`),
    ...(current[HEADERS_HELPER_KEY] === undefined ? [HEADERS_HELPER_KEY] : [])
  ];
  return { missing, conflicts: plan.conflicts };
}
