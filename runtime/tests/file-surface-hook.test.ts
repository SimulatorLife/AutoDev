import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateFileSurfaceHook } from "../src/hooks/file-surface.ts";

const hookPath = fileURLToPath(
  new URL("../src/hooks/file-surface.ts", import.meta.url)
);

function payload(toolName: string, agentType?: string): string {
  return JSON.stringify({
    session_id: "session",
    turn_id: "turn",
    hook_event_name: "PreToolUse",
    model: "autodev/worker",
    tool_name: toolName,
    tool_input: { path: "a.png" },
    ...(agentType !== undefined && { agent_type: agentType })
  });
}

test("Codex's native file tools are refused with the filesystem tool to use instead", () => {
  const image = evaluateFileSurfaceHook(payload("view_image", "worker"));
  assert.equal(image.denied, true);
  assert.match(image.reason ?? "", /`filesystem` MCP server/u);
  assert.match(image.reason ?? "", /read_media_file/u);

  const patch = evaluateFileSurfaceHook(payload("apply_patch"));
  assert.equal(patch.denied, true);
  assert.match(patch.reason ?? "", /edit_file/u);
  assert.match(patch.reason ?? "", /write_file/u);
});

test("every other tool, and an unreadable payload, is left to the other policies", () => {
  for (const tool of [
    "exec_command",
    "mcp__filesystem__read_media_file",
    "wait"
  ])
    assert.equal(evaluateFileSurfaceHook(payload(tool)).denied, false, tool);
  assert.equal(evaluateFileSurfaceHook("not json").denied, false);
});

test("an unrelated native chat keeps its host's own file tools", () => {
  // No Runtime environment and no AutoDev-routed model: a native Claude Code,
  // Copilot or Antigravity chat that only shares the projected hooks.
  for (const tool of ["apply_patch", "write_to_file", "view_image"]) {
    const raw = JSON.stringify({
      session_id: "native-session",
      hook_event_name: "PreToolUse",
      tool_name: tool,
      tool_input: { path: "a.ts" }
    });
    assert.equal(evaluateFileSurfaceHook(raw, {}).denied, false, tool);
    assert.equal(
      evaluateFileSurfaceHook(raw, {
        AUTODEV_SESSION_ID: "runtime-session",
        AUTODEV_AGENT_ROLE: "worker"
      }).denied,
      true,
      tool
    );
  }
});

test("the installed hook answers Codex with a deny decision and logs it", () => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "file-surface-hook-"));
  try {
    const result = spawnSync(process.execPath, [hookPath], {
      input: payload("view_image", "explorer"),
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    const log = JSON.parse(
      readFileSync(path.join(codexHome, "hooks", "hooks.log"), "utf8").trim()
    ) as Record<string, unknown>;
    assert.equal(log.hook, "file-surface");
    assert.equal(log.policy, "file-surface");
    assert.equal(log.role, "explorer");
    assert.equal(log.origin, "autodev_routed");
    assert.equal(log.tool, "view_image");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
