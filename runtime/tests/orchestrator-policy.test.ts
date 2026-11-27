import assert from "node:assert/strict";
import test from "node:test";

import {
  copilotOrchestratorDenyToolArgs as copilotOrchestratorDenyToolArguments,
  evaluateOrchestratorToolCall,
  GIT_HISTORY_SUBCOMMANDS,
  isRootOrchestratorModel
} from "../src/agents/orchestrator-policy.ts";

const shell = (command: unknown) =>
  evaluateOrchestratorToolCall({
    toolName: "exec_command",
    toolInput: { cmd: command }
  });

test("only the explicit AutoDev root alias identifies root model policy", () => {
  assert.equal(isRootOrchestratorModel("autodev/orchestrator"), true);
  for (const model of [
    "",
    "gpt-5.5",
    "gpt-5.3-codex",
    "unrecognized-native-model",
    "autodev/worker",
    "autodev/explorer",
    "claude-opus-5-5",
    "opus",
    "gemini-3.8-flash",
    "MiniMax-M3",
    "copilot",
    "opencli-chatgpt"
  ])
    assert.equal(isRootOrchestratorModel(model), false, model);
});

test("every history subcommand is refused, however the command is wrapped", () => {
  for (const subcommand of GIT_HISTORY_SUBCOMMANDS)
    assert.equal(shell(`git ${subcommand}`).allowed, false, subcommand);
  for (const command of [
    "/usr/bin/git log",
    "git --no-pager log -p",
    "env GIT_PAGER=cat git show HEAD",
    "timeout 30 git log",
    "echo abc | xargs git show",
    'zsh -lc "git blame a.ts"',
    "ls; git rev-list --count HEAD"
  ])
    assert.equal(shell(command).allowed, false, command);
});

test("current-state git, other commands, and unreadable input run", () => {
  for (const command of [
    "git status",
    "git diff",
    "git diff --stat",
    "git rev-parse HEAD",
    "git add -A",
    "git commit -m 'git log'",
    "git grep needle",
    "rg 'git show' docs",
    "pnpm lint"
  ])
    assert.equal(shell(command).allowed, true, command);
  assert.equal(shell(undefined).allowed, true);
  assert.equal(
    evaluateOrchestratorToolCall({
      toolName: "read_file",
      toolInput: { path: "git log" }
    }).allowed,
    true
  );
});

test("Copilot deny rules name the same history subcommands", () => {
  assert.deepEqual(
    copilotOrchestratorDenyToolArguments(),
    GIT_HISTORY_SUBCOMMANDS.map((s) => `--deny-tool=shell(git ${s})`)
  );
});

test("denial message directs the root to current-state git alternatives", () => {
  const decision = shell("git log --oneline -n 5");
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /git status/u);
  assert.match(decision.reason ?? "", /git diff/u);
  assert.match(decision.reason ?? "", /git rev-parse --short HEAD/u);
});
