import assert from "node:assert/strict";
import test from "node:test";

import {
  copilotOrchestratorDenyToolArgs,
  evaluateOrchestratorToolCall,
  GIT_HISTORY_SUBCOMMANDS,
  isRootOrchestratorModel
} from "../src/agents/orchestrator-policy.ts";

const shell = (cmd: unknown) =>
  evaluateOrchestratorToolCall({
    toolName: "exec_command",
    toolInput: { cmd }
  });

test("the root orchestrator model is the root alias or a Codex-native model", () => {
  for (const model of ["autodev/orchestrator", "gpt-5.5", "gpt-5.3-codex"])
    assert.equal(isRootOrchestratorModel(model), true, model);
  for (const model of [
    "",
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
  for (const cmd of [
    "/usr/bin/git log",
    "git --no-pager log -p",
    "env GIT_PAGER=cat git show HEAD",
    "timeout 30 git log",
    "echo abc | xargs git show",
    'zsh -lc "git blame a.ts"',
    "ls; git rev-list --count HEAD"
  ])
    assert.equal(shell(cmd).allowed, false, cmd);
});

test("current-state git, other commands, and unreadable input run", () => {
  for (const cmd of [
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
    assert.equal(shell(cmd).allowed, true, cmd);
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
    copilotOrchestratorDenyToolArgs(),
    GIT_HISTORY_SUBCOMMANDS.map((s) => `--deny-tool=shell(git ${s})`)
  );
});
