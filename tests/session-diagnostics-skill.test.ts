import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildReport, findSessionRollouts, hasOpenTurn, recentSessions, renderReport } from "../.rulesync/skills/autodev-session-diagnostics/scripts/session-trace.ts";
import { probe } from "../.rulesync/skills/autodev-session-diagnostics/scripts/mcp-probe.ts";

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
    line("2026-09-18T21:25:04.000Z", "response_item", { type: "custom_tool_call", name: "exec", call_id: "call_lsp", input: "const r = await tools.mcp__lsp__lsp_index_files({ files: [] }); text(r);" }),
    line("2026-09-18T21:25:05.000Z", "response_item", { type: "custom_tool_call_output", call_id: "call_lsp", output: [ { type: "input_text", text: "Script completed" }, { type: "input_text", text: "tool call error: tool call failed for `lsp/lsp_index_files`\n\nCaused by:\n Transport closed" } ] }),
    line("2026-09-18T21:32:48.000Z", "event_msg", { type: "turn_aborted", turn_id: "t-child", reason: "interrupted" }),
  ]);
  rollout(OTHER, [ line("2026-09-18T21:21:00.000Z", "session_meta", { id: OTHER, session_id: OTHER, thread_source: "user" }) ]);
  const event = (timestamp: string, fields: Record<string, unknown>) => JSON.stringify({ schema: "autodev-router-event-v1", timestamp, ...fields });
  writeFileSync(join(home, "run", "codex-model-router.launchd.err.log"), [
    "router starting (plain text line)",
    event("2026-09-18T21:20:00.500Z", { requestId: "req-a", phase: "selected", role: "worker", requestedModel: "autodev/worker", provider: "antigravity", model: "gemini" }),
    event("2026-09-18T21:25:01.000Z", { requestId: "req-a", phase: "result", role: "worker", requestedModel: "autodev/worker", provider: "antigravity", outcome: "failure", status: 502, failureClass: "unavailable", elapsedMs: 300500, toolCalls: 0 }),
    event("2026-09-18T21:25:02.000Z", { requestId: "req-b", phase: "selected", role: "worker", requestedModel: "autodev/worker", provider: "claude", model: "sonnet" }),
    event("2026-09-18T21:32:00.000Z", { requestId: "req-b", phase: "result", role: "worker", requestedModel: "autodev/worker", provider: "claude", outcome: "success", status: 200, elapsedMs: 418000, toolCalls: 0 }),
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

test("the report surfaces gaps, aborted turns, tool failures, and provider hops", async () => {
  const { home, cleanup } = fixture();
  try {
    const report = await buildReport({ id: CHILD, codexHome: home, routerLog: join(home, "run", "codex-model-router.launchd.err.log"), items: true, events: true, offline: true });
    const child = report.threads.find((thread) => thread.id === CHILD);
    assert.ok(child);
    assert.equal(child.role, "worker");
    assert.equal(child.model, "autodev/worker");
    assert.deepEqual(child.turns.map((turn) => turn.outcome), [ "aborted:interrupted" ]);
    assert.deepEqual(child.gaps.map((gap) => gap.seconds), [ 463, 302 ]);
    // A tool called inside `exec` is counted under its own MCP name, and its failure is surfaced.
    assert.equal(child.tools["mcp__lsp__lsp_index_files"], 1);
    assert.equal(child.toolFailures.length, 1);
    assert.equal(child.toolFailures[0]?.tool, "mcp__lsp__lsp_index_files");
    assert.match(child.toolFailures[0]?.detail ?? "", /Transport closed/);
    const router = report.router.find((entry) => entry.thread === CHILD);
    assert.ok(router);
    // Old events carry no thread: matched by model and window, so the explorer and the next-day request are excluded.
    assert.equal(router.matchedBy, "model-window");
    assert.equal(router.requests, 2);
    assert.deepEqual(router.providerSequence, [ "antigravity", "claude" ]);
    assert.deepEqual(router.failures.map((failure) => `${failure.provider}:${failure.status}:${failure.failureClass}`), [ "antigravity:502:unavailable" ]);
    assert.deepEqual(router.events?.map((row) => `${row.requestId}:${row.phase}`), [ "req-a:selected", "req-a:result", "req-b:selected", "req-b:result" ]);
    assert.equal(report.live, null, "offline reads no live state");
    const text = renderReport(report);
    assert.match(text, /== thread 01a0b664-0000-7000-8000-000000000002 \(ImplementationCoder\) role=worker model=autodev\/worker/);
    assert.match(text, /GAP 463s after custom_tool_call_output/);
    assert.match(text, /TOOL FAILED 21:25:05 mcp__lsp__lsp_index_files call=call_lsp :: .*Transport closed/);
    assert.match(text, /PROVIDER HOPS antigravity → claude/);
    assert.match(text, /ROUTER FAILURE .* antigravity 502 unavailable 300500ms/);
  } finally {
    cleanup();
  }
});

test("router events that name their thread are matched exactly, not by model and window", async () => {
  const { home, cleanup } = fixture();
  try {
    const log = join(home, "run", "codex-model-router.launchd.err.log");
    const event = (timestamp: string, fields: Record<string, unknown>) => JSON.stringify({ schema: "autodev-router-event-v1", timestamp, ...fields });
    // Two workers on the same model at once: only the thread field tells them apart.
    writeFileSync(log, [
      event("2026-09-18T21:21:00.000Z", { requestId: "mine", thread: CHILD, phase: "selected", requestedModel: "autodev/worker", provider: "claude" }),
      event("2026-09-18T21:21:01.000Z", { requestId: "theirs", thread: "another-worker", phase: "selected", requestedModel: "autodev/worker", provider: "minimax" }),
    ].join("\n"));
    const report = await buildReport({ id: CHILD, codexHome: home, routerLog: log, items: false, offline: true });
    const router = report.router.find((entry) => entry.thread === CHILD);
    assert.equal(router?.matchedBy, "thread");
    assert.deepEqual(router?.providerSequence, [ "claude" ]);
    assert.equal(router?.requests, 1);

    // A log spanning a router upgrade: the older events have no thread and are still found.
    writeFileSync(log, [
      event("2026-09-18T21:20:30.000Z", { requestId: "before-upgrade", phase: "selected", requestedModel: "autodev/worker", provider: "antigravity" }),
      event("2026-09-18T21:21:00.000Z", { requestId: "mine", thread: CHILD, phase: "selected", requestedModel: "autodev/worker", provider: "claude" }),
    ].join("\n"));
    const mixed = (await buildReport({ id: CHILD, codexHome: home, routerLog: log, items: false, offline: true })).router.find((entry) => entry.thread === CHILD);
    assert.equal(mixed?.matchedBy, "model-window");
    assert.deepEqual(mixed?.providerSequence, [ "antigravity", "claude" ]);
  } finally {
    cleanup();
  }
});

test("--recent lists the newest sessions with their thread counts", () => {
  const { home, cleanup } = fixture();
  try {
    const sessions = recentSessions(join(home, "sessions"), 5);
    const root = sessions.find((session) => session.id === ROOT);
    assert.equal(root?.threads, 2);
    assert.equal(root?.cwd, "/tmp/repo");
    assert.ok(sessions.some((session) => session.id === OTHER));
  } finally {
    cleanup();
  }
});

test("the MCP probe reports the tools, each call, and the stderr of a server that dies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autodev-mcp-probe-"));
  try {
    // A tiny MCP server: one tool that works, one that makes it exit like lsp-mcp-server did.
    const server = join(dir, "server.mjs");
    writeFileSync(server, `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [ { name: "ok_tool" }, { name: "crash_tool" } ] } });
  else if (m.method === "tools/call" && m.params.name === "ok_tool") send({ jsonrpc: "2.0", id: m.id, result: { content: [ { type: "text", text: "fine" } ] } });
  else if (m.method === "tools/call") { process.stderr.write("spawn typescript-language-server ENOENT\\n"); process.exit(1); }
});
`);
    const launcher = join(dir, "launcher.sh");
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`);
    chmodSync(launcher, 0o755);
    const result = await probe({ server: "fake", cwd: dir, launcher, calls: [ { tool: "ok_tool", args: {} }, { tool: "crash_tool", args: {} } ], timeoutMs: 5000 });
    assert.deepEqual(result.tools, [ "ok_tool", "crash_tool" ]);
    assert.deepEqual(result.calls.map((call) => [ call.tool, call.ok ]), [ [ "ok_tool", true ], [ "crash_tool", false ] ]);
    assert.match(result.calls[1]?.text ?? "", /server exited/);
    assert.equal(result.exited?.code, 1);
    assert.match(result.stderrTail, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI documents its usage and emits JSON on request", () => {
  const usage = spawnSync(process.execPath, [ SCRIPT ], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: session-trace\.ts <session-or-thread-id>/);
  const { home, cleanup } = fixture();
  try {
    const run = spawnSync(process.execPath, [ SCRIPT, ROOT, "--json", "--offline", "--codex-home", home ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.threads.length, 2);
    assert.equal(report.live, null);
  } finally {
    cleanup();
  }
});

test("an open turn is one that started and has not completed or aborted", () => {
  const { home, cleanup } = fixture();
  try {
    const [ root, child ] = findSessionRollouts(join(home, "sessions"), ROOT).sort((a, b) => (a.includes(ROOT) ? -1 : 1) - (b.includes(ROOT) ? -1 : 1));
    assert.equal(hasOpenTurn(root!), false, "completed");
    assert.equal(hasOpenTurn(child!), false, "aborted");
    writeFileSync(child!, `${JSON.stringify({ timestamp: "2026-09-18T21:40:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t-next" } })}\n`, { flag: "a" });
    assert.equal(hasOpenTurn(child!), true, "a new turn started");
    // A turn whose start lies beyond the tail that is read first (a long orchestrator turn).
    const filler = `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [ { type: "output_text", text: "x".repeat(4096) } ] } })}\n`.repeat(80);
    writeFileSync(child!, filler, { flag: "a" });
    assert.equal(hasOpenTurn(child!), true, "still open after 300 KB of items");
  } finally {
    cleanup();
  }
});
