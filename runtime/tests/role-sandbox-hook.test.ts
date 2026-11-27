import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sanitizeCommandHead } from "../src/hooks/hook-log.ts";
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
  readonly model?: string;
  readonly toolName: string;
  readonly toolInput?: unknown;
}): string {
  return JSON.stringify({
    session_id: "session",
    cwd: "/Users/henrykirk/AutoDev",
    hook_event_name: "PreToolUse",
    model: input.model ?? "autodev/explorer",
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

/** The environment the Runtime gives a provider process it launched. */
function runtimeEnvironment(role: string): NodeJS.ProcessEnv {
  return {
    AUTODEV_SESSION_ID: "runtime-session",
    AUTODEV_AGENT_ROLE: role,
    AUTODEV_PROVIDER: "claude"
  };
}

test("explicit orchestrator roles and the AutoDev root alias may not read git history", () => {
  // The root alias is served through the AutoDev router; a concrete model is
  // an orchestrator only in a process the Runtime launched as one.
  for (const [agentType, model, environment] of [
    [undefined, "autodev/orchestrator", {}],
    ["orchestrator", "gpt-5.5", runtimeEnvironment("orchestrator")],
    ["orchestrator", "claude-opus", runtimeEnvironment("orchestrator")],
    [undefined, "claude-opus", runtimeEnvironment("orchestrator")]
  ] as const) {
    for (const cmd of [
      "git log -p -- src/a.ts",
      "git show abc123",
      "git -C /repo blame src/a.ts",
      "cd /repo && git log --oneline | head -40",
      "GIT_PAGER=cat git log",
      "bash -lc 'git reflog'"
    ]) {
      const outcome = evaluateRoleSandboxHook(
        payload({
          ...(agentType === undefined ? {} : { agentType }),
          model,
          toolName: "exec_command",
          toolInput: { cmd }
        }),
        environment
      );
      assert.equal(outcome.denied, true, `${model}: ${cmd} was allowed`);
      assert.match(outcome.reason ?? "", /does not read git history/u);
      assert.match(outcome.reason ?? "", /delegate/u);
    }
  }
});

test("the root orchestrator still integrates and delegates", () => {
  for (const [toolName, toolInput] of [
    ["exec_command", { cmd: "git status --short && git diff --stat" }],
    ["exec_command", { cmd: "git add -A && git commit -m 'fix: lint'" }],
    ["exec_command", { cmd: "pnpm test" }],
    ["exec_command", { cmd: "grep -rn 'git log' docs" }],
    [
      "multi_agent_v1__spawn_agent",
      { agent_type: "worker", message: "git log -p" }
    ],
    ["exec", { code: "await tools.multi_agent_v1__spawn_agent({})" }]
  ] as const) {
    const outcome = evaluateRoleSandboxHook(
      payload({ model: "autodev/orchestrator", toolName, toolInput })
    );
    assert.equal(
      outcome.denied,
      false,
      `${toolName} ${JSON.stringify(toolInput)} was denied`
    );
  }
});

test("children and unrelated standalone sessions may read git history", () => {
  // A concrete native model, or no model at all, is not an AutoDev role.
  for (const [agentType, model] of [
    ["worker", "autodev/worker"],
    ["explorer", "autodev/explorer"],
    [undefined, ""],
    [undefined, "gpt-5.5"],
    [undefined, "unrecognized-native-model"]
  ] as const) {
    const outcome = evaluateRoleSandboxHook(
      payload({
        ...(agentType === undefined ? {} : { agentType }),
        model,
        toolName: "exec_command",
        toolInput: { cmd: "git log -p -5 -- src/a.ts" }
      })
    );
    assert.equal(outcome.denied, false, `${agentType ?? "root"} was denied`);
  }
});

test("unrelated native chats sharing the projected hooks are never governed", () => {
  // A Claude Code or Copilot chat in this repository: no Runtime environment
  // and no AutoDev-routed model. Its agent types are the host's own subagent
  // names, including ones that collide with AutoDev role names.
  for (const agentType of [
    undefined,
    "Explore",
    "general-purpose",
    "explorer",
    "orchestrator"
  ]) {
    for (const command of ["rm -rf build", "git log -p -5"]) {
      const raw = JSON.stringify({
        session_id: "native-session",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        ...(agentType && { agent_type: agentType })
      });
      assert.equal(
        evaluateRoleSandboxHook(raw, {}).denied,
        false,
        `${agentType ?? "root"}: ${command} was denied`
      );
    }
  }
});

test("a Runtime-assigned read-only role is enforced without a host-reported role", () => {
  const outcome = evaluateRoleSandboxHook(
    JSON.stringify({
      session_id: "host-session",
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" }
    }),
    runtimeEnvironment("explorer")
  );
  assert.equal(outcome.denied, true);
});

test("a child thread cannot widen a Runtime-launched read-only session", () => {
  const outcome = evaluateRoleSandboxHook(
    payload({
      agentType: "worker",
      model: "claude-opus",
      toolName: "exec_command",
      toolInput: { cmd: "rm -rf build" }
    }),
    runtimeEnvironment("explorer")
  );
  assert.equal(outcome.denied, true);
});

test("a Runtime-assigned role the contract does not describe fails closed", () => {
  const outcome = evaluateRoleSandboxHook(
    JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" }
    }),
    runtimeEnvironment("no-such-role")
  );
  assert.equal(outcome.denied, true);
});

test("a payload that cannot be read is left alone rather than refused blindly", () => {
  for (const raw of ["", "not json", "[]", "null", '"text"']) {
    const outcome = evaluateRoleSandboxHook(raw);
    assert.equal(outcome.denied, false, `"${raw}" was denied`);
  }
});

test("a role the contract does not describe fails closed as read-only", () => {
  const outcome = evaluateRoleSandboxHook(
    payload({
      agentType: "no-such-role",
      toolName: "exec_command",
      toolInput: { cmd: "rm -rf build" }
    })
  );
  assert.equal(outcome.denied, true);
});

/**
 * Run the hook and capture what it wrote.
 *
 * The hook writes its decision to stdout and its reason to stderr, so both
 * are captured; the status is the hook's exit code, which is what Codex reads
 * as a blocking refusal.
 */
function runHookCapturing(
  raw: string,
  codexHome?: string
): {
  readonly status: number;
  readonly output: string;
} {
  const ownedTemp = codexHome
    ? null
    : mkdtempSync(path.join(tmpdir(), "autodev-hook-test-"));
  const targetHome = codexHome ?? ownedTemp!;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = targetHome;
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
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (ownedTemp) rmSync(ownedTemp, { recursive: true, force: true });
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

test("the hook denies a root orchestrator's git-history call with the reason Codex reads", () => {
  const { status, output } = runHookCapturing(
    payload({
      model: "autodev/orchestrator",
      toolName: "exec_command",
      toolInput: { cmd: "git show HEAD~3" }
    })
  );
  assert.equal(status, 2);
  assert.match(output, /"deny"/u);
  assert.match(output, /git show/u);
});

test("PreToolUse denials append structured records to hooks.log and allowed calls stay silent", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-hook-denial-log-"));
  try {
    const allowed = runHookCapturing(
      payload({
        agentType: "explorer",
        toolName: "exec_command",
        toolInput: { cmd: "ls -la" }
      }),
      home
    );
    assert.equal(allowed.status, 0);
    const logPath = path.join(home, "hooks", "hooks.log");
    assert.equal(existsSync(logPath), false);

    runHookCapturing(
      payload({
        agentType: "explorer",
        toolName: "exec_command",
        toolInput: { cmd: "python3 -c 'print(1)'" }
      }),
      home
    );
    runHookCapturing(
      payload({
        agentType: "explorer",
        toolName: "apply_patch",
        toolInput: { input: "*** Begin Patch\nSECRET PATCH BODY" }
      }),
      home
    );
    runHookCapturing(
      payload({
        model: "autodev/orchestrator",
        toolName: "exec_command",
        toolInput: { cmd: "git show HEAD~3" }
      }),
      home
    );

    const entries = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(entries.length, 3);

    assert.equal(entries[0]?.event, "PreToolUse");
    assert.equal(entries[0]?.hook, "role-sandbox");
    assert.equal(entries[0]?.decision, "deny");
    assert.equal(entries[0]?.policy, "read-only");
    assert.equal(entries[0]?.role, "explorer");
    assert.equal(entries[0]?.commandHead, "python3 -c 'print(1)'");

    assert.equal(entries[1]?.policy, "read-only");
    assert.equal(entries[1]?.tool, "apply_patch");
    assert.equal("commandHead" in (entries[1] ?? {}), false);

    assert.equal(entries[2]?.policy, "orchestrator-git-history");
    assert.equal(entries[2]?.role, "root");
    assert.equal(entries[2]?.commandHead, "git show HEAD~3");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sanitizeCommandHead redacts credentials and truncates long commands", () => {
  const sanitized = sanitizeCommandHead(
    "API_KEY=supersecretvalue curl -H 'Authorization: Bearer tok_123.abc' --token=mysecret123 https://example.com/sk-abcdefghijklmno " +
      "x".repeat(150)
  );
  assert.doesNotMatch(sanitized, /supersecretvalue/u);
  assert.doesNotMatch(sanitized, /tok_123\.abc/u);
  assert.doesNotMatch(sanitized, /mysecret123/u);
  assert.doesNotMatch(sanitized, /sk-abcdefghijklmno/u);
  assert.match(sanitized, /API_KEY=\[REDACTED\]/u);
  assert.match(sanitized, /Bearer \[REDACTED\]/u);
  assert.match(sanitized, /--token=\[REDACTED\]/u);
  assert.ok(sanitized.length <= 120);
});
