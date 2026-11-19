/**
 * The rollout fixtures the diagnostics engine tests read.
 *
 * The shapes are the ones Codex actually writes: a `session_meta` head, a
 * `turn_context`, `event_msg` turn boundaries, `response_item` calls and
 * `token_count` usage records. The engine reads untrusted JSON, so the
 * fixtures are deliberately allowed to be malformed in the places where the
 * engine has to survive them.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const ROOT = "01a0b662-0000-7000-8000-000000000001";
export const CHILD = "01a0b664-0000-7000-8000-000000000002";
export const OTHER = "01a0b699-0000-7000-8000-000000000003";

/** One rollout line, in the shape Codex writes it. */
export function rolloutLine(
  timestamp: string,
  type: string,
  payload: unknown
): string {
  return JSON.stringify({ timestamp, type, payload });
}

/** One router event line, in the shape the router writes it. */
export function routerEvent(
  timestamp: string,
  fields: Record<string, unknown>
): string {
  return JSON.stringify({
    schema: "autodev-router-event-v1",
    timestamp,
    ...fields
  });
}

/** One hook-log line, in the shape the hooks runtime writes it. */
export function hookLine(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

export interface Fixture {
  readonly home: string;
  readonly sessionsRoot: string;
  readonly archivedRoot: string;
  readonly routerLog: string;
  readonly cleanup: () => void;
}

/**
 * A codex home with one session of three threads, a router log and a hook log.
 */
export function fixture(): Fixture {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-diagnostics-"));
  const day = path.join(home, "sessions", "2026", "09", "18");
  const archived = path.join(home, "archived_sessions", "2026", "09", "19");
  mkdirSync(day, { recursive: true });
  mkdirSync(archived, { recursive: true });
  mkdirSync(path.join(home, "run"), { recursive: true });
  mkdirSync(path.join(home, "hooks"), { recursive: true });

  const write = (dir: string, id: string, lines: string[]): void => {
    writeFileSync(
      path.join(dir, `rollout-2026-09-18T17-00-00-${id}.jsonl`),
      `${lines.join("\n")}\n`
    );
  };

  write(day, ROOT, [
    rolloutLine("2026-09-18T21:18:00.000Z", "session_meta", {
      id: ROOT,
      session_id: ROOT,
      thread_source: "user",
      model_provider: "local_model_router",
      cli_version: "0.169.0",
      cwd: "/tmp/repo",
      timestamp: "2026-09-18T21:18:00.000Z"
    }),
    rolloutLine("2026-09-18T21:18:00.100Z", "turn_context", {
      model: "autodev/orchestrator"
    }),
    rolloutLine("2026-09-18T21:18:00.200Z", "event_msg", {
      type: "task_started",
      turn_id: "t-root"
    }),
    rolloutLine("2026-09-18T21:18:05.000Z", "response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_1",
      input: "tools.multi_agent_v1__spawn_agent({})"
    }),
    rolloutLine("2026-09-18T21:18:06.000Z", "event_msg", {
      type: "task_complete",
      turn_id: "t-root",
      last_agent_message: "done"
    })
  ]);

  write(day, CHILD, [
    rolloutLine("2026-09-18T21:20:00.000Z", "session_meta", {
      id: CHILD,
      session_id: ROOT,
      parent_thread_id: ROOT,
      thread_source: "subagent",
      agent_role: "worker",
      agent_nickname: "ImplementationCoder",
      cwd: "/tmp/repo",
      timestamp: "2026-09-18T21:20:00.000Z"
    }),
    rolloutLine("2026-09-18T21:20:00.100Z", "turn_context", {
      model: "autodev/worker"
    }),
    rolloutLine("2026-09-18T21:20:00.200Z", "event_msg", {
      type: "task_started",
      turn_id: "t-child"
    }),
    rolloutLine("2026-09-18T21:20:01.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "implement it" }]
    }),
    rolloutLine("2026-09-18T21:21:01.000Z", "response_item", {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_lsp",
      input:
        "const r = await tools.mcp__lsp__lsp_index_files({ files: [] }); text(r);"
    }),
    rolloutLine("2026-09-18T21:21:02.000Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "call_lsp",
      output: [
        { type: "input_text", text: "Script completed" },
        {
          type: "input_text",
          text: "tool call error: tool call failed for `lsp/lsp_index_files`\n\nCaused by:\n Transport closed"
        }
      ]
    }),
    rolloutLine("2026-09-18T21:32:48.000Z", "event_msg", {
      type: "turn_aborted",
      turn_id: "t-child",
      reason: "interrupted"
    })
  ]);

  write(day, OTHER, [
    rolloutLine("2026-09-18T21:21:00.000Z", "session_meta", {
      id: OTHER,
      session_id: OTHER,
      thread_source: "user",
      cwd: "/tmp/other",
      timestamp: "2026-09-18T21:21:00.000Z"
    })
  ]);

  write(archived, "01a0b6aa-0000-7000-8000-000000000004", [
    rolloutLine("2026-09-19T09:00:00.000Z", "session_meta", {
      id: "01a0b6aa-0000-7000-8000-000000000004",
      session_id: "01a0b6aa-0000-7000-8000-000000000004",
      thread_source: "user",
      cwd: "/tmp/archived",
      timestamp: "2026-09-19T09:00:00.000Z"
    })
  ]);

  const routerLog = path.join(
    home,
    "run",
    "codex-model-router.launchd.err.log"
  );
  writeFileSync(
    routerLog,
    [
      "router starting (plain text line)",
      routerEvent("2026-09-18T21:20:00.500Z", {
        requestId: "req-a",
        phase: "selected",
        role: "worker",
        requestedModel: "autodev/worker",
        provider: "antigravity",
        model: "gemini"
      }),
      routerEvent("2026-09-18T21:25:01.000Z", {
        requestId: "req-a",
        phase: "result",
        role: "worker",
        requestedModel: "autodev/worker",
        provider: "antigravity",
        outcome: "failure",
        status: 502,
        failureClass: "unavailable",
        elapsedMs: 300_500,
        toolCalls: 0
      }),
      routerEvent("2026-09-18T21:25:02.000Z", {
        requestId: "req-b",
        phase: "selected",
        role: "worker",
        requestedModel: "autodev/worker",
        provider: "claude",
        model: "sonnet"
      }),
      routerEvent("2026-09-18T21:32:00.000Z", {
        requestId: "req-b",
        phase: "result",
        role: "worker",
        requestedModel: "autodev/worker",
        provider: "claude",
        outcome: "success",
        status: 200,
        elapsedMs: 418_000,
        toolCalls: 0
      })
    ].join("\n")
  );

  return {
    home,
    sessionsRoot: path.join(home, "sessions"),
    archivedRoot: path.join(home, "archived_sessions"),
    routerLog,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}
