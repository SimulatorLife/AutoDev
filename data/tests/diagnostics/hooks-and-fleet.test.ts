import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { scanRecentSessions } from "../../src/diagnostics/fleet-scan.ts";
import {
  hookDenialsResponse,
  summarizeHookDenials
} from "../../src/diagnostics/hook-denials.ts";
import { fixture, hookLine, OTHER } from "./fixture.ts";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");

test("the PreToolUse denials in the window are aggregated by policy, role and reason", () => {
  const { home, cleanup } = fixture();
  try {
    const logFile = path.join(home, "hooks", "hooks.log");
    writeFileSync(
      logFile,
      [
        hookLine({
          time: "2026-09-18T21:00:00.000Z",
          event: "UserPromptSubmit"
        }),
        hookLine({
          time: "2026-09-18T21:01:00.000Z",
          event: "PreToolUse",
          decision: "deny",
          policy: "no-secrets",
          role: "worker",
          reason: "reads a .env file",
          commandHead: "cat .env"
        }),
        hookLine({
          time: "2026-09-18T21:02:00.000Z",
          event: "PreToolUse",
          decision: "deny",
          policy: "no-secrets",
          role: "worker",
          reason: "reads a .env file",
          commandHead: "cat .env"
        }),
        hookLine({
          time: "2026-09-18T21:03:00.000Z",
          event: "PreToolUse",
          decision: "allow",
          policy: "no-secrets",
          role: "worker"
        }),
        hookLine({
          time: "2026-08-01T00:00:00.000Z",
          event: "PreToolUse",
          decision: "deny",
          policy: "old-policy",
          role: "worker"
        })
      ].join("\n")
    );
    const summary = summarizeHookDenials(home, 7, NOW);
    assert.equal(summary.preToolUseDenials, 2);
    assert.equal(summary.byPolicy["no-secrets"], 2);
    assert.equal(summary.byRole.worker, 2);
    assert.deepEqual(summary.byReason, [
      { reason: "reads a .env file", count: 2 }
    ]);
    assert.deepEqual(summary.topCommands, [
      { commandHead: "cat .env", policy: "no-secrets", count: 2 }
    ]);
  } finally {
    cleanup();
  }
});

test("a window with no hook log is empty, not an error", () => {
  const { home, cleanup } = fixture();
  try {
    const summary = summarizeHookDenials(home, 7, NOW);
    assert.equal(summary.preToolUseDenials, 0);
    assert.equal(summary.totalLines, 0);
  } finally {
    cleanup();
  }
});

test("the hook denial response carries the contract's schema", () => {
  const { home, cleanup } = fixture();
  try {
    const response = hookDenialsResponse(home, 30, NOW);
    assert.equal(response.schema, "autodev-session-hook-denials-v1");
    assert.equal(response.summary.sinceDays, 30);
  } finally {
    cleanup();
  }
});

test("the fleet scan aggregates the newest sessions into one row each", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const scan = await scanRecentSessions({
      codexHome: home,
      routerLog,
      limit: 10
    });
    assert.equal(scan.schema, "autodev-session-fleet-scan-v1");
    assert.ok(scan.totals.sessions >= 2);
    const root = scan.sessions.find(
      (session) => session.id === "01a0b662-0000-7000-8000-000000000001"
    );
    assert.ok(root);
    assert.equal(root.threads, 2);
    assert.equal(root.toolFailures, 1);
    assert.equal(root.topFailureCategory, "transport-closed");
    assert.equal(root.routerRequests, 2);
    assert.equal(root.routerFailures, 1);
    assert.equal(root.clientSurface, "codex_desktop");
    const other = scan.sessions.find((session) => session.id === OTHER);
    assert.equal(other?.clientSurface, null);
  } finally {
    cleanup();
  }
});

test("the fleet scan's totals are the sum of its rows", async () => {
  const { home, routerLog, cleanup } = fixture();
  try {
    const scan = await scanRecentSessions({
      codexHome: home,
      routerLog,
      limit: 10
    });
    const totalTokens = scan.sessions.reduce(
      (sum, session) => sum + session.totalTokens,
      0
    );
    assert.equal(scan.totals.totalTokens, totalTokens);
    assert.equal(
      scan.totals.threads,
      scan.sessions.reduce((sum, session) => sum + session.threads, 0)
    );
  } finally {
    cleanup();
  }
});
