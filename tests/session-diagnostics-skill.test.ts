import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildReport, findSessionRollouts, renderReport } from "../.rulesync/skills/autodev-session-diagnostics/scripts/session-trace.ts";

const SCRIPT = fileURLToPath(new URL("../.rulesync/skills/autodev-session-diagnostics/scripts/session-trace.ts", import.meta.url));
const ROOT = "01a0b662-0000-7000-8000-000000000001";
const CHILD = "01a0b664-0000-7000-8000-000000000002";
const OTHER = "01a0b699-0000-7000-8000-000000000003";

// A synthetic CODEX_HOME shaped like the 2026-09-18 incident: a worker that
// went silent for five minutes, was interrupted, and hopped providers.
function fixture(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "autodev-diagnostics-"));
  const day = join(home, "sessions", "2026", "09", "18");
  mkdirSync(day, { recursive: true });
  mkdirSync(join(home, "run"), { recursive: true });
  const line = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload });
  const rollout = (id: string, lines: string[]) => writeFileSync(join(day, `rollout-2026-09-18T17-00-00-${id}.jsonl`), `${lines.join("\n")}\n`);
  rollout(ROOT, [
    line("2026-09-18T21:18:00.000Z", "session_meta", { id: ROOT, session_id: ROOT, thread_source: "user", model_provider: "local_model_router", cwd: "/tmp/repo" }),
    line("2026-09-18T21:18:00.100Z", "turn_context", { model: "autodev/orchestrator" }),
    line("2026-09-18T21:18:00.200Z", "event_msg", { type: "task_started", turn_id: "t-root" }),
    line("2026-09-18T21:18:05.000Z", "response_item", { type: "custom_tool_call", name: "exec", call_id: "call_1", input: "tools.multi_agent_v1__spawn_agent({})" }),
    line("2026-09-18T21:18:06.000Z", "event_msg", { type: "task_complete", turn_id: "t-root", last_agent_message: "done" }),
  ]);
  rollout(CHILD, [
    line("2026-09-18T21:20:00.000Z", "session_meta", { id: CHILD, session_id: ROOT, parent_thread_id: ROOT, thread_source: "subagent", agent_role: "worker", agent_nickname: "ImplementationCoder" }),
    line("2026-09-18T21:20:00.100Z", "turn_context", { model: "autodev/worker" }),
    line("2026-09-18T21:20:00.200Z", "event_msg", { type: "task_started", turn_id: "t-child" }),
    line("2026-09-18T21:20:01.000Z", "response_item", { type: "message", role: "user", content: [ { type: "input_text", text: "implement it" } ] }),
    line("2026-09-18T21:25:03.000Z", "response_item", { type: "reasoning", id: "06fcdf5c2897fecf8516745cbeb71597_rs", summary: [], content: [ { type: "reasoning_text", text: "Let me start" } ] }),
    line("2026-09-18T21:32:48.000Z", "event_msg", { type: "turn_aborted", turn_id: "t-child", reason: "interrupted" }),
  ]);
  rollout(OTHER, [ line("2026-09-18T21:21:00.000Z", "session_meta", { id: OTHER, session_id: OTHER, thread_source: "user" }) ]);
  const event = (timestamp: string, fields: Record<string, unknown>) => JSON.stringify({ schema: "autodev-router-event-v1", timestamp, ...fields });
  writeFileSync(join(home, "run", "codex-model-router.launchd.err.log"), [
    "router starting (plain text line)",
    event("2026-09-18T21:20:00.500Z", { requestId: "req-a", phase: "selected", role: "worker", requestedModel: "autodev/worker", provider: "antigravity", model: "gemini" }),
    event("2026-09-18T21:25:01.000Z", { requestId: "req-a", phase: "result", role: "worker", requestedModel: "autodev/worker", provider: "antigravity", outcome: "failure", status: 502, failureClass: "unavailable", elapsedMs: 300500, toolCalls: 0 }),
    event("2026-09-18T21:25:02.000Z", { requestId: "req-b", phase: "selected", role: "worker", requestedModel: "autodev/worker", provider: "claude", model: "sonnet" }),
    event("2026-09-18T21:25:02.000Z", { requestId: "req-x", phase: "selected", role: "explorer", requestedModel: "autodev/explorer", provider: "minimax" }),
    event("2026-09-19T09:00:00.000Z", { requestId: "req-late", phase: "selected", role: "worker", requestedModel: "autodev/worker", provider: "minimax" }),
  ].join("\n"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("a thread id finds its whole session, and a session id finds its subagents", () => {
  const { home, cleanup } = fixture();
  try {
    const sessions = join(home, "sessions");
    const fromChild = findSessionRollouts(sessions, CHILD).map((file) => file.includes(ROOT) ? "root" : file.includes(CHILD) ? "child" : "other");
    assert.deepEqual(fromChild.sort(), [ "child", "root" ]);
    const fromRoot = findSessionRollouts(sessions, ROOT);
    assert.equal(fromRoot.length, 2);
    assert.equal(fromRoot.some((file) => file.includes(OTHER)), false);
  } finally {
    cleanup();
  }
});

test("the report surfaces gaps, aborted turns, and the providers each request used", async () => {
  const { home, cleanup } = fixture();
  try {
    const report = await buildReport({ id: CHILD, codexHome: home, routerLog: join(home, "run", "codex-model-router.launchd.err.log"), items: true, processes: false });
    const child = report.threads.find((thread) => thread.id === CHILD);
    assert.ok(child);
    assert.equal(child.role, "worker");
    assert.equal(child.model, "autodev/worker");
    assert.deepEqual(child.turns.map((turn) => turn.outcome), [ "aborted:interrupted" ]);
    assert.deepEqual(child.gaps.map((gap) => gap.seconds), [ 465, 302 ]);
    assert.equal(child.items?.[1]?.kind, "reasoning");
    const events = report.router.find((entry) => entry.thread === CHILD)?.events ?? [];
    // Only this thread's model, only its window: the explorer and the next-day request are excluded.
    assert.deepEqual(events.map((row) => `${row.requestId}:${row.phase}:${row.provider}`), [ "req-a:selected:antigravity", "req-a:result:antigravity", "req-b:selected:claude" ]);
    assert.equal(events[1]?.failureClass, "unavailable");
    const text = renderReport(report);
    assert.match(text, /== thread 01a0b664-0000-7000-8000-000000000002 \(ImplementationCoder\) role=worker model=autodev\/worker/);
    assert.match(text, /GAP 465s after reasoning/);
    assert.match(text, /req-a result role=worker antigravity\/- failure 502 unavailable 300500ms tools=0/);
  } finally {
    cleanup();
  }
});

test("the CLI documents its usage and emits JSON on request", () => {
  const usage = spawnSync(process.execPath, [ SCRIPT ], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: session-trace\.ts <session-or-thread-id>/);
  const { home, cleanup } = fixture();
  try {
    const run = spawnSync(process.execPath, [ SCRIPT, ROOT, "--json", "--no-processes", "--codex-home", home ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.threads.length, 2);
    assert.deepEqual(report.processes, []);
  } finally {
    cleanup();
  }
});
