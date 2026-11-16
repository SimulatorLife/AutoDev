import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRoleSandboxHook,
  runRoleSandboxHook
} from "../src/hooks/role-sandbox.ts";

/**
 * A `PreToolUse` payload as Codex sends it.
 *
 * Codex sends the tool name, the tool's own input, and the role the thread
 * that made the call is: the role is what the policy is read under.
 */
function payload(input: {
  readonly agentType?: string | null;
  readonly toolName: string;
  readonly toolInput?: unknown;
}): string {
  return JSON.stringify({
    session_id: "session",
    cwd: "/Users/henrykirk/AutoDev",
    hook_event_name: "PreToolUse",
    model: "autodev/explorer",
    permission_mode: "default",
    tool_name: input.toolName,
    tool_input: input.toolInput ?? {},
    tool_use_id: "call",
    transcript_path: null,
    turn_id: "turn",
    ...(input.agentType === undefined ? {} : { agent_type: input.agentType })
  });
}

test("a read-only role may not write a file", () => {
  const outcome = evaluateRoleSandboxHook(
    payload({
      agentType: "explorer",
      toolName: "apply_patch",
      toolInput: { input: "*** Begin Patch" }
    })
  );
  assert.equal(outcome.denied, true);
  assert.match(outcome.reason ?? "", /read-only sandbox/u);
});

test("a read-only role may not run a command that writes", () => {
  const outcome = evaluateRoleSandboxHook(
    payload({
      agentType: "explorer",
      toolName: "exec_command",
      toolInput: { cmd: "rm -rf build" }
    })
  );
  assert.equal(outcome.denied, true);
});

test("a read-only role may read", () => {
  const outcome = evaluateRoleSandboxHook(
    payload({
      agentType: "explorer",
      toolName: "exec_command",
      toolInput: { cmd: "ls -la" }
    })
  );
  assert.equal(outcome.denied, false);
  assert.equal(outcome.reason, null);
});

test("a role that declares no read-only sandbox is left to the session's own", () => {
  for (const agentType of ["worker", "orchestrator", "smart", "validator"]) {
    const outcome = evaluateRoleSandboxHook(
      payload({
        agentType,
        toolName: "exec_command",
        toolInput: { cmd: "rm -rf build" }
      })
    );
    assert.equal(outcome.denied, false, `${agentType} was denied`);
  }
});

test("the root session's own turns are left to the session's sandbox", () => {
  // The root session runs in the policy's sandbox, and nothing here narrows
  // it. A payload with no role at all is the root session's.
  const outcome = evaluateRoleSandboxHook(
    payload({
      toolName: "exec_command",
      toolInput: { cmd: "rm -rf build" }
    })
  );
  assert.equal(outcome.denied, false);
});

test("a payload that cannot be read is left alone rather than refused blindly", () => {
  for (const raw of ["", "not json", "[]", "null", '"text"']) {
    const outcome = evaluateRoleSandboxHook(raw);
    assert.equal(outcome.denied, false, `"${raw}" was denied`);
  }
});

test("a role the contract does not describe is left to the session's sandbox", () => {
  const outcome = evaluateRoleSandboxHook(
    payload({
      agentType: "no-such-role",
      toolName: "exec_command",
      toolInput: { cmd: "rm -rf build" }
    })
  );
  assert.equal(outcome.denied, false);
});

/**
 * Run the hook and capture what it wrote.
 *
 * The hook writes its decision to stdout and its reason to stderr, so both
 * are captured; the status is the hook's exit code, which is what Codex reads
 * as a blocking refusal.
 */
function runHookCapturing(raw: string): {
  readonly status: number;
  readonly output: string;
} {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalError = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { status: runRoleSandboxHook(raw), output: chunks.join("") };
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalError;
  }
}

test("the hook denies the call with the reason Codex reads", () => {
  const { status, output } = runHookCapturing(
    payload({
      agentType: "explorer",
      toolName: "apply_patch",
      toolInput: { input: "*** Begin Patch" }
    })
  );
  assert.equal(status, 2);
  assert.match(output, /permissionDecision/u);
  assert.match(output, /"deny"/u);
  assert.match(output, /read-only sandbox/u);
});

test("the hook allows the call silently when the role may make it", () => {
  const { status, output } = runHookCapturing(
    payload({
      agentType: "explorer",
      toolName: "exec_command",
      toolInput: { cmd: "ls" }
    })
  );
  assert.equal(status, 0);
  assert.equal(output, "");
});
