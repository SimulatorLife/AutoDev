import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RUNTIME_MODULES } from "../src/platform/install-materializer.ts";
import { renderRuntimeMirrorPackage } from "../src/platform/runtime-mirror-package.ts";

/**
 * The installed tree's own tests.
 *
 * The hook does not run from the repository: the installer copies the Runtime
 * modules into `$CODEX_HOME/src`, writes the mirror manifest beside them, and
 * puts the execution contract in `$CODEX_HOME/config`. A hook that works in
 * the checkout and not in the installed tree enforces nothing, so the
 * installed layout is exercised here.
 */

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Materialize the Runtime into a temporary Codex home.
 *
 * The layout is the one the installer writes: the modules under `src`, the
 * mirror manifest beside them, and the execution contract under `config`.
 */
function installedCodexHome(): string {
  const codexHome = mkdtempSync(path.join(tmpdir(), "autodev-installed-tree-"));
  const source = path.join(codexHome, "src");
  for (const module of RUNTIME_MODULES) {
    const target = path.join(
      codexHome,
      "src",
      module.slice("runtime/src/".length)
    );
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repositoryRoot, module), target);
  }
  writeFileSync(
    path.join(source, "package.json"),
    renderRuntimeMirrorPackage({
      runtimePackage: JSON.parse(
        readFileSync(path.join(repositoryRoot, "runtime/package.json"), "utf8")
      ),
      materialized: new Set(RUNTIME_MODULES)
    }),
    "utf8"
  );
  // The installed modules resolve their workspace packages through the
  // `node_modules` the installer links beside the mirror root.
  symlinkSync(
    path.join(repositoryRoot, "runtime/node_modules"),
    path.join(source, "node_modules"),
    "dir"
  );
  const config = path.join(codexHome, "config");
  mkdirSync(config, { recursive: true });
  copyFileSync(
    path.join(repositoryRoot, "config/execution-contract.json"),
    path.join(config, "execution-contract.json")
  );
  return codexHome;
}

/**
 * Run the installed hook with one tool call.
 */
function runInstalledHook(
  codexHome: string,
  input: {
    readonly agentType?: string;
    readonly toolName: string;
    readonly toolInput: unknown;
  }
): { readonly status: number; readonly output: string } {
  const payload = JSON.stringify({
    session_id: "session",
    cwd: repositoryRoot,
    hook_event_name: "PreToolUse",
    model: "autodev/explorer",
    permission_mode: "default",
    tool_name: input.toolName,
    tool_input: input.toolInput,
    tool_use_id: "call",
    transcript_path: null,
    turn_id: "turn",
    ...(input.agentType === undefined ? {} : { agent_type: input.agentType })
  });
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(codexHome, "src/hooks/role-sandbox.ts")],
      { input: payload, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return { status: 0, output };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: failure.status ?? -1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`
    };
  }
}

test("the installed hook refuses a write in a read-only role", () => {
  const codexHome = installedCodexHome();
  const outcome = runInstalledHook(codexHome, {
    agentType: "explorer",
    toolName: "apply_patch",
    toolInput: { input: "*** Begin Patch" }
  });
  // Codex reads the exit code as a blocking refusal and the reason from the
  // hook's output.
  assert.equal(outcome.status, 2);
  assert.match(outcome.output, /permissionDecision/u);
  assert.match(outcome.output, /"deny"/u);
  assert.match(outcome.output, /read-only sandbox/u);
});

test("the installed hook lets a read-only role read", () => {
  const codexHome = installedCodexHome();
  const outcome = runInstalledHook(codexHome, {
    agentType: "explorer",
    toolName: "exec_command",
    toolInput: { cmd: "ls -la" }
  });
  assert.equal(outcome.status, 0);
  assert.equal(outcome.output, "");
});

test("the installed hook leaves a write-capable role to the session's sandbox", () => {
  const codexHome = installedCodexHome();
  const outcome = runInstalledHook(codexHome, {
    agentType: "worker",
    toolName: "exec_command",
    toolInput: { cmd: "rm -rf build" }
  });
  assert.equal(outcome.status, 0);
});
