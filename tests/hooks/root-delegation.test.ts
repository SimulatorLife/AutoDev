import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type HookOutput = {
  hookSpecificOutput?: { additionalContext?: string };
};

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const hookModule = fileURLToPath(
  new URL("../../src/hooks/root-delegation.ts", import.meta.url)
);

function runHook(model: string, sessionId?: string): string {
  const home = mkdtempSync(join(tmpdir(), "autodev-root-delegation-"));
  const codexHome = join(home, ".codex");
  const hooksRoot = join(codexHome, "hooks");
  const promptRoot = join(hooksRoot, "codex", "prompts");
  try {
    mkdirSync(promptRoot, { recursive: true });
    mkdirSync(join(codexHome, ".rulesync", "skills", "orchestration"), {
      recursive: true
    });
    writeFileSync(
      join(promptRoot, "orchestrator.md"),
      "# Root orchestrator bootstrap\n"
    );
    writeFileSync(
      join(promptRoot, "code-search.md"),
      "## Shared codebase navigation\n"
    );
    writeFileSync(
      join(codexHome, ".rulesync", "skills", "orchestration", "SKILL.md"),
      "## Canonical orchestration skill\n"
    );
    const input = JSON.stringify({
      model,
      ...(sessionId === undefined ? {} : { session_id: sessionId })
    });
    return execFileSync(process.execPath, [hookModule], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        AUTODEV_REPO_ROOT: repositoryRoot
      },
      input,
      encoding: "utf8"
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("root delegation injects the typed policy and canonical sources for a parent model", () => {
  const output = JSON.parse(
    runHook("gpt-5.6-luna", "parent-test-1")
  ) as HookOutput;
  const context = output.hookSpecificOutput?.additionalContext ?? "";
  assert.match(context, /# Root orchestrator bootstrap/);
  assert.match(context, /## Canonical orchestration skill/);
  assert.match(context, /## Shared codebase navigation/);
  assert.match(context, /parent-test-1/);
});

test("root delegation injects the typed policy for autodev/orchestrator alias", () => {
  const output = JSON.parse(
    runHook("autodev/orchestrator", "orchestrator-test-1")
  ) as HookOutput;
  const context = output.hookSpecificOutput?.additionalContext ?? "";
  assert.match(context, /# Root orchestrator bootstrap/);
  assert.match(context, /## Canonical orchestration skill/);
  assert.match(context, /## Shared codebase navigation/);
  assert.match(context, /orchestrator-test-1/);
});

test("root delegation suppresses policy for leaf models", () => {
  assert.equal(runHook("autodev/explorer"), "");
  assert.equal(runHook("autodev/worker"), "");
  assert.equal(runHook("sonnet"), "");
});

test("root delegation logs hook input without putting it in the injected policy", () => {
  const home = mkdtempSync(join(tmpdir(), "autodev-root-delegation-log-"));
  const codexHome = join(home, ".codex");
  const hooksRoot = join(codexHome, "hooks");
  const promptRoot = join(hooksRoot, "codex", "prompts");
  try {
    mkdirSync(promptRoot, { recursive: true });
    mkdirSync(join(codexHome, ".rulesync", "skills", "orchestration"), {
      recursive: true
    });
    writeFileSync(
      join(promptRoot, "orchestrator.md"),
      "# Root orchestrator bootstrap\n"
    );
    writeFileSync(
      join(promptRoot, "code-search.md"),
      "## Shared codebase navigation\n"
    );
    writeFileSync(
      join(codexHome, ".rulesync", "skills", "orchestration", "SKILL.md"),
      "## Canonical orchestration skill\n"
    );
    execFileSync(process.execPath, [hookModule], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        AUTODEV_REPO_ROOT: repositoryRoot
      },
      input: JSON.stringify({
        model: "gpt-5.6-luna",
        session_id: "session-for-log",
        hook_event_name: "UserPromptSubmit",
        turn_id: "turn-1"
      }),
      encoding: "utf8"
    });
    const log = readFileSync(join(hooksRoot, "hooks.log"), "utf8");
    assert.match(log, /"session":"session-for-log"/);
    assert.doesNotMatch(log, /Root orchestrator bootstrap/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("root delegation emits a runtime-agnostic recovery preflight that names the native tools", () => {
  const output = JSON.parse(
    runHook("autodev/orchestrator", "orchestrator-runtime-agnostic-1")
  ) as HookOutput;
  const context = output.hookSpecificOutput?.additionalContext ?? "";
  // The runtime-agnostic summary names the native tools the orchestrator
  // must call directly. The previous code-mode-only JavaScript snippet made
  // the model conclude the spawn surface was unavailable when the
  // orchestrator turn was running in native function-call mode.
  assert.match(context, /## Current-parent recovery preflight/);
  assert.match(context, /mcp__codex_app__read_thread/);
  assert.match(context, /multi_agent_v1__wait_agent/);
  assert.match(context, /multi_agent_v1__close_agent/);
  assert.match(context, /Do not infer child ids/);
  // The natural-language instruction tells the model to call the tools
  // itself, not to assume a code-mode `exec` runtime.
  assert.match(context, /adapt the invocations to the surface your tools/);
});

