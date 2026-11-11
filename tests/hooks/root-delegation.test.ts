import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONFIGURED_ORCHESTRATOR_MODEL } from "@simulatorlife/autodev-runtime/router/routing";

type HookOutput = {
  hookSpecificOutput?: { additionalContext?: string };
};

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const hookModule = fileURLToPath(
  new URL("../../runtime/src/hooks/root-delegation.ts", import.meta.url)
);

function runHook(
  model: string,
  sessionId?: string,
  turnId?: string,
  sharedHome?: string,
  timeoutMs?: number
): string {
  const home =
    sharedHome ?? mkdtempSync(join(tmpdir(), "autodev-root-delegation-"));
  const ownsHome = sharedHome === undefined;
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
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      ...(turnId === undefined ? {} : { turn_id: turnId })
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
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      encoding: "utf8"
    });
  } finally {
    if (ownsHome) rmSync(home, { recursive: true, force: true });
  }
}

test("root delegation suppresses duplicate context for the same identified turn", () => {
  const home = mkdtempSync(join(tmpdir(), "autodev-root-delegation-dedup-"));
  try {
    const first = runHook(
      "autodev/orchestrator",
      "same-session",
      "turn-1",
      home
    );
    const duplicate = runHook(
      "autodev/orchestrator",
      "same-session",
      "turn-1",
      home
    );
    const nextTurn = runHook(
      "autodev/orchestrator",
      "same-session",
      "turn-2",
      home
    );
    assert.match(first, /Root orchestrator bootstrap/);
    assert.equal(duplicate, "");
    assert.match(nextTurn, /Root orchestrator bootstrap/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("root delegation atomically suppresses concurrent duplicate submissions", async () => {
  const home = mkdtempSync(join(tmpdir(), "autodev-root-delegation-race-"));
  const codexHome = join(home, ".codex");
  const prompts = join(codexHome, "hooks", "codex", "prompts");
  mkdirSync(prompts, { recursive: true });
  mkdirSync(join(codexHome, ".rulesync", "skills", "orchestration"), {
    recursive: true
  });
  writeFileSync(
    join(prompts, "orchestrator.md"),
    "# Root orchestrator bootstrap\n"
  );
  writeFileSync(
    join(prompts, "code-search.md"),
    "## Shared codebase navigation\n"
  );
  writeFileSync(
    join(codexHome, ".rulesync", "skills", "orchestration", "SKILL.md"),
    "## Canonical orchestration skill\n"
  );
  const input = JSON.stringify({
    model: "autodev/orchestrator",
    session_id: "concurrent-session",
    turn_id: "concurrent-turn"
  });
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [hookModule], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          HOME: home,
          CODEX_HOME: codexHome,
          AUTODEV_REPO_ROOT: repositoryRoot
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(stderr))
      );
      child.stdin.end(input);
    });
  try {
    const outputs = await Promise.all([run(), run()]);
    assert.equal(
      outputs.filter((output) => output.includes("Root orchestrator bootstrap"))
        .length,
      1
    );
    assert.equal(outputs.filter(Boolean).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("root delegation does not deduplicate when turn identity is incomplete", () => {
  assert.match(
    runHook("autodev/orchestrator", "session-without-turn"),
    /Root orchestrator bootstrap/
  );
  assert.match(
    runHook("autodev/orchestrator", undefined, "turn-without-session"),
    /Root orchestrator bootstrap/
  );
});

test("root delegation fails open when deduplication state cannot be created", () => {
  const home = mkdtempSync(join(tmpdir(), "autodev-root-delegation-state-error-"));
  mkdirSync(
    join(home, ".codex", "hooks", "root-delegation-state.json"),
    { recursive: true }
  );
  try {
    assert.match(
      runHook(
        "autodev/orchestrator",
        "session-with-unwritable-state",
        "turn-with-unwritable-state",
        home
      ),
      /Root orchestrator bootstrap/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("root delegation fails open when temporary state cleanup also fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "autodev-root-delegation-temp-cleanup-"));
  const codexHome = join(home, ".codex");
  const hooksDir = join(codexHome, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const child = spawn(process.execPath, [hookModule], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      AUTODEV_REPO_ROOT: repositoryRoot
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.ok(child.pid);
  mkdirSync(join(hooksDir, `root-delegation-state.json.${child.pid}.tmp`));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr))
    );
  });
  child.stdin.end(
    JSON.stringify({
      model: "autodev/orchestrator",
      session_id: "session-with-temp-cleanup-failure",
      turn_id: "turn-with-temp-cleanup-failure"
    })
  );
  try {
    await completed;
    const output = JSON.parse(stdout) as HookOutput;
    assert.match(
      output.hookSpecificOutput?.additionalContext ?? "",
      /Root orchestrator bootstrap/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("root delegation bounds retries when the lock cannot be inspected", () => {
  const home = mkdtempSync(join(tmpdir(), "autodev-root-delegation-bad-lock-"));
  const hooksDir = join(home, ".codex", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  symlinkSync(
    join(hooksDir, "missing-lock-target"),
    join(hooksDir, "root-delegation-state.lock")
  );
  try {
    assert.match(
      runHook(
        "autodev/orchestrator",
        "session-with-uninspectable-lock",
        "turn-with-uninspectable-lock",
        home,
        8_000
      ),
      /Root orchestrator bootstrap/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("root delegation injects the typed policy and canonical sources for a parent model", () => {
  const output = JSON.parse(
    runHook(CONFIGURED_ORCHESTRATOR_MODEL, "parent-test-1")
  ) as HookOutput;
  const context = output.hookSpecificOutput?.additionalContext ?? "";
  assert.match(context, /# Root orchestrator bootstrap/);
  assert.match(context, /## Canonical orchestration skill/);
  assert.match(context, /Read and follow the installed `orchestration` skill/);
  assert.match(context, /\.rulesync\/skills\/orchestration\/SKILL\.md/);
  assert.doesNotMatch(context, /# Agent orchestration/);
  assert.match(context, /## Shared codebase navigation/);
  assert.match(context, /parent-test-1/);
  assert.ok(context.length < 9_500, `root hook context is ${context.length} chars`);
});

test("root delegation injects the typed policy for autodev/orchestrator alias", () => {
  const output = JSON.parse(
    runHook("autodev/orchestrator", "orchestrator-test-1")
  ) as HookOutput;
  const context = output.hookSpecificOutput?.additionalContext ?? "";
  assert.match(context, /# Root orchestrator bootstrap/);
  assert.match(context, /## Canonical orchestration skill/);
  assert.match(context, /Read and follow the installed `orchestration` skill/);
  assert.doesNotMatch(context, /# Agent orchestration/);
  assert.match(context, /## Shared codebase navigation/);
  assert.match(context, /orchestrator-test-1/);
  assert.ok(context.length < 9_500, `root hook context is ${context.length} chars`);
});

test("the root role enables the canonical skill referenced by the compact hook", () => {
  const role = readFileSync(
    join(repositoryRoot, "agents", "roles", "orchestrator.toml"),
    "utf8"
  );
  const skill = readFileSync(
    join(repositoryRoot, ".rulesync", "skills", "orchestration", "SKILL.md"),
    "utf8"
  );
  assert.match(
    role,
    /name = "orchestration"\s*\nenabled = true/
  );
  assert.match(skill, /source of truth for orchestration policy/);
});

test("root delegation suppresses policy for leaf models", () => {
  assert.equal(runHook("autodev/explorer"), "");
  assert.equal(runHook("autodev/worker"), "");
  assert.equal(runHook("sonnet"), "");
  // A web chat site served through opencli is a leaf too.
  assert.equal(runHook("opencli-chatgpt"), "");
  assert.equal(runHook("opencli-gemini"), "");
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
        model: CONFIGURED_ORCHESTRATOR_MODEL,
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

test("root delegation keeps recovery context compact and owner-scoped", () => {
  const output = JSON.parse(
    runHook("autodev/orchestrator", "parent-live-preflight-1", "turn-live-preflight-1")
  ) as HookOutput;
  const context = output.hookSpecificOutput?.additionalContext ?? "";
  assert.match(context, /## Current-parent recovery preflight/);
  assert.match(context, /Current parent session: parent-live-preflight-1/);
  assert.match(context, /own spawn history/);
  assert.match(context, /Preserve running children and useful partial results/);
  assert.match(context, /Never inspect or clean up foreign sessions/);
  assert.doesNotMatch(context, /```js/);
  assert.doesNotMatch(context, /const recoveryObjects/);
  assert.ok(context.length < 9_500, `root hook context is ${context.length} chars`);
});
