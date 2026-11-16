import assert from "node:assert/strict";
import test from "node:test";

import {
  curlCommandIsReadOnly,
  evaluateReadOnlyCommand,
  evaluateReadOnlyToolCall,
  ghCommandIsReadOnly,
  gitCommandIsReadOnly,
  shellCommandFromToolInput
} from "../src/agents/read-only-policy.ts";

/**
 * The policy is an allowlist, so a test asserts both sides of every rule: the
 * command that reads is allowed, and the command that writes next to it is
 * refused. A test that only asserted the refusal would pass against a policy
 * that refused everything.
 */
function assertAllowed(command: string): void {
  const decision = evaluateReadOnlyCommand(command);
  assert.equal(
    decision.allowed,
    true,
    `expected "${command}" to be allowed: ${decision.reason ?? ""}`
  );
}

function assertRefused(command: string): void {
  const decision = evaluateReadOnlyCommand(command);
  assert.equal(
    decision.allowed,
    false,
    `expected "${command}" to be refused, but it was allowed`
  );
  assert.match(decision.reason ?? "", /read-only sandbox/u);
}

test("the commands that read are allowed", () => {
  for (const command of [
    "ls -la",
    "cat README.md",
    "rg -n 'pattern' core/src",
    "git status --short",
    "git log --oneline -20",
    "git diff HEAD~1",
    "git show HEAD:package.json",
    "git branch",
    "git branch --all",
    "git tag",
    "git remote -v",
    "git stash list",
    "git notes list",
    "git worktree list",
    "git submodule status",
    "git reflog",
    "git reflog show HEAD",
    "git config user.name",
    "git config --list",
    "gh pr list",
    "gh pr view 42",
    "gh issue list --limit 5",
    "gh repo view",
    "gh search pr 'sandbox'",
    "gh api repos/openai/codex",
    "curl https://example.com",
    "head -20 file",
    "tail -20 file",
    "jq .name package.json",
    "wc -l file",
    "find . -name '*.ts'",
    "find . -name '*.ts' -type f"
  ]) {
    assertAllowed(command);
  }
});

test("the commands that write are refused", () => {
  for (const command of [
    "rm file",
    "cp a b",
    "mv a b",
    "touch file",
    "mkdir dir",
    "tee file",
    "dd if=/dev/zero of=file",
    "sed -i s/a/b/ file",
    "npm install",
    "pnpm add left-pad",
    "python3 script.py",
    "node -e 'console.log(1)'",
    "make build",
    "sh -c 'rm file'",
    "bash script.sh",
    "env FOO=bar ls"
  ]) {
    assertRefused(command);
  }
});

test("a shell's own command is judged by its script", () => {
  // The shell is the wrapper, not the command: what runs is the script.
  assertAllowed("bash -c 'ls -la'");
  assertRefused("bash -c 'rm file'");
  assertAllowed("/bin/zsh -lc 'cat README.md'");
  assertRefused("/bin/zsh -lc 'cat README.md > copy.md'");
  // A shell nested in a shell is judged the same way, to a depth.
  assertAllowed("bash -c \"bash -c 'ls'\"");
  assertRefused(String.raw`bash -c "bash -c 'bash -c \"rm file\"'"`);
});

test("the write-capable shell constructs are refused", () => {
  assertRefused("cat file > copy");
  assertRefused("cat file >> copy");
  assertRefused("echo hi | tee file");
  assertRefused("echo $(rm file)");
  assertRefused("echo `rm file`");
  assertRefused("ls; rm file");
  assertRefused("ls && rm file");
  assertRefused("ls | rm file");
});

test("an environment override is refused", () => {
  assertRefused("PATH=/tmp ls");
  assertRefused("LD_PRELOAD=/tmp/x.so ls");
  assertRefused("GIT_PAGER='rm -rf /' git log");
});

test("a command run by path must come from a system directory", () => {
  assertAllowed("/bin/cat README.md");
  assertAllowed("/usr/bin/git status");
  assertRefused("./script.sh");
  assertRefused("/tmp/script.sh");
  assertRefused("/Users/henrykirk/AutoDev/scripts/script.sh");
});

test("a git subcommand that writes is refused", () => {
  assertRefused("git commit -m 'message'");
  assertRefused("git add file");
  assertRefused("git push origin main");
  assertRefused("git reset --hard HEAD");
  assertRefused("git checkout main");
  assertRefused("git merge main");
  assertRefused("git rebase main");
  assertRefused("git stash");
  assertRefused("git stash push");
  assertRefused("git branch new-branch");
  assertRefused("git branch -d main");
  assertRefused("git tag v1.0.0");
  assertRefused("git tag -d v1.0.0");
  assertRefused("git config user.name Someone");
  assertRefused("git config --global user.name Someone");
  assertRefused("git remote add origin https://example.com/repo");
  assertRefused("git remote set-url origin https://example.com/repo");
  assertRefused("git notes add -m 'note'");
  assertRefused("git worktree add ../other");
  assertRefused("git submodule update");
  assertRefused("git reflog delete HEAD@{1}");
  assertRefused("git symbolic-ref HEAD refs/heads/main");
  assertRefused("git update-ref refs/heads/main HEAD");
});

test("a git option that runs another program is refused", () => {
  assertRefused("git -c core.pager='rm -rf /' log");
  assertRefused("git -ccore.pager='rm -rf /' log");
  assertRefused("git --exec-path=/tmp log");
  assertRefused("git --config-env=core.pager=rm log");
  assertRefused("git log --ext-diff");
  assertRefused("git diff --output=file.patch");
  assertRefused("git diff --output file.patch");
});

test("a git option that names a directory is allowed", () => {
  assertAllowed("git -C /Users/henrykirk/AutoDev status");
  assertAllowed("git --git-dir=/Users/henrykirk/AutoDev/.git log");
});

test("a gh subcommand that writes is refused", () => {
  assertRefused("gh pr create --title x");
  assertRefused("gh pr merge 42");
  assertRefused("gh pr close 42");
  assertRefused("gh issue create --title x");
  assertRefused("gh issue close 42");
  assertRefused("gh label create --name x");
  assertRefused("gh release create v1");
  assertRefused("gh release download v1");
  assertRefused("gh repo clone owner/repo");
  assertRefused("gh repo delete owner/repo");
  assertRefused("gh run rerun 42");
  assertRefused("gh run download 42");
  assertRefused("gh secret set NAME value");
  assertRefused("gh workflow run build.yml");
  assertRefused("gh api -X POST repos/openai/codex/issues");
  assertRefused("gh api -f title=x repos/openai/codex/issues");
  assertRefused("gh auth login");
});

test("a curl that writes is refused and a curl that reads is allowed", () => {
  assertAllowed("curl https://example.com");
  assertAllowed("curl -X GET https://example.com");
  assertAllowed("curl -H 'Accept: application/json' https://example.com");
  assertRefused("curl -o page.html https://example.com");
  assertRefused("curl --output=page.html https://example.com");
  assertRefused("curl -X POST https://example.com");
  assertRefused("curl -d 'a=b' https://example.com");
  assertRefused("curl --json '{}' https://example.com");
  assertRefused("curl -T file https://example.com");
});

test("a command that runs another command is refused", () => {
  assertRefused("rg --pre 'rm file' pattern");
  assertRefused("fd -x rm");
  assertRefused("find . -delete");
  assertRefused("find . -exec rm {} +");
  assertRefused("find . -name '*.ts' -exec grep -l x {} +");
  assertRefused("sort -o out.txt file");
  assertRefused("man -P 'rm file' ls");
  assertRefused("less +'!rm file' README.md");
});

test("the shell tool names are all judged by their command", () => {
  for (const toolName of [
    "exec_command",
    "shell",
    "unified_exec",
    "bash",
    "write_stdin",
    "run_command"
  ]) {
    assert.equal(
      evaluateReadOnlyToolCall({
        toolName,
        toolInput: { cmd: "ls" }
      }).allowed,
      true
    );
    assert.equal(
      evaluateReadOnlyToolCall({
        toolName,
        toolInput: { cmd: "rm file" }
      }).allowed,
      false
    );
  }
});

test("the tool names that write are refused whatever they carry", () => {
  for (const toolName of [
    "apply_patch",
    "applyPatch",
    "write",
    "write_file",
    "edit",
    "multi_edit",
    "notebook_edit"
  ]) {
    const decision = evaluateReadOnlyToolCall({
      toolName,
      toolInput: { input: "*** Begin Patch" }
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? "", /may not change files/u);
  }
});

test("a tool that neither writes nor runs a shell is left to the role's contract", () => {
  assert.equal(
    evaluateReadOnlyToolCall({
      toolName: "web_search",
      toolInput: { query: "codex sandbox" }
    }).allowed,
    true
  );
  assert.equal(
    evaluateReadOnlyToolCall({
      toolName: "mcp__lsp__lsp_goto_definition",
      toolInput: { file: "a.ts" }
    }).allowed,
    true
  );
});

test("a shell call whose command cannot be read is refused", () => {
  const decision = evaluateReadOnlyToolCall({
    toolName: "exec_command",
    toolInput: { workdir: "/tmp" }
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /could not be read/u);
});

test("the command is read from the shape the tool carries", () => {
  assert.equal(shellCommandFromToolInput({ cmd: "ls" }), "ls");
  assert.equal(shellCommandFromToolInput({ command: "ls" }), "ls");
  assert.equal(shellCommandFromToolInput("ls"), "ls");
  assert.equal(
    shellCommandFromToolInput({ command: ["/bin/zsh", "-lc", "ls -la"] }),
    "ls -la"
  );
  assert.equal(shellCommandFromToolInput({ command: ["ls", "-la"] }), "ls -la");
  assert.equal(shellCommandFromToolInput({}), null);
  assert.equal(shellCommandFromToolInput(null), null);
});

test("the git, gh and curl rules answer on their own", () => {
  assert.equal(gitCommandIsReadOnly(["status"]), true);
  assert.equal(gitCommandIsReadOnly(["commit", "-m", "x"]), false);
  assert.equal(ghCommandIsReadOnly(["pr", "list"]), true);
  assert.equal(ghCommandIsReadOnly(["pr", "create"]), false);
  assert.equal(curlCommandIsReadOnly(["https://example.com"]), true);
  assert.equal(curlCommandIsReadOnly(["-X", "POST", "https://example.com"]), false);
});

test("an MCP server's tools are left to the role's own contract", () => {
  // The execution contract says which servers a role may reach; the server
  // says what its tools do. The policy governs Codex's own tools.
  for (const toolName of [
    "mcp__playtest__playtest_run",
    "mcp__lsp__lsp_goto_definition",
    "mcp__playwright__browser_file_upload"
  ]) {
    assert.equal(
      evaluateReadOnlyToolCall({
        toolName,
        toolInput: { cmd: "rm -rf build" }
      }).allowed,
      true,
      `${toolName} was denied`
    );
  }
});

test("a native tool the policy does not know is refused when its name says it writes", () => {
  assert.equal(
    evaluateReadOnlyToolCall({ toolName: "file_write", toolInput: {} }).allowed,
    false
  );
  assert.equal(
    evaluateReadOnlyToolCall({ toolName: "replaceInFile", toolInput: {} })
      .allowed,
    false
  );
  assert.equal(
    evaluateReadOnlyToolCall({ toolName: "view_image", toolInput: {} }).allowed,
    true
  );
});
