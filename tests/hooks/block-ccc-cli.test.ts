import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePreToolUse,
  isCccInvocation,
  REDIRECTION_MESSAGE,
  runBlockCccCli
} from "../../src/hooks/block-ccc-cli.ts";

test("isCccInvocation identifies direct and compound ccc CLI invocations", () => {
  const blocked = [
    "ccc",
    "ccc index",
    'ccc search "some query"',
    'ccc search --limit 20 "foo"',
    "~/.local/bin/ccc search foo",
    "/usr/local/bin/ccc init",
    "./ccc status",
    "ENV_VAR=1 ccc search foo",
    'FOO="bar baz" ccc index',
    "echo hi && ccc index",
    "echo hi || ccc search",
    "echo hi; ccc index",
    "cat file | ccc search",
    "xargs ccc",
    "sudo ccc index",
    "nohup ccc index &",
    "exec ccc search foo",
    "time ccc index"
  ];

  for (const cmd of blocked) {
    assert.equal(
      isCccInvocation(cmd),
      true,
      `expected "${cmd}" to be identified as ccc invocation`
    );
  }
});

test("isCccInvocation ignores non-ccc commands and harmless substrings", () => {
  const allowed = [
    "git status",
    "ls -la",
    "pnpm test",
    "npm run build",
    "success",
    "access",
    "accept",
    "echo ccc",
    "cat /path/to/ccc.txt",
    'git commit -m "ccc is cool"',
    "npm run ccc-test",
    "grep ccc file.txt"
  ];

  for (const cmd of allowed) {
    assert.equal(
      isCccInvocation(cmd),
      false,
      `expected "${cmd}" NOT to be identified as ccc invocation`
    );
  }
});

test("evaluatePreToolUse blocks command tools executing ccc", () => {
  const payload = JSON.stringify({
    tool_name: "exec_command",
    arguments: { cmd: 'ccc index && ccc search "racing line"' }
  });

  const result = evaluatePreToolUse(payload);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, REDIRECTION_MESSAGE);
});

test("evaluatePreToolUse handles bash tool variant", () => {
  const payload = JSON.stringify({
    toolName: "bash",
    toolInput: { command: "ccc search foo" }
  });

  const result = evaluatePreToolUse(payload);
  assert.equal(result.blocked, true);
});

test("evaluatePreToolUse allows non-ccc command tools", () => {
  const payload = JSON.stringify({
    tool_name: "exec_command",
    arguments: { cmd: "git status" }
  });

  const result = evaluatePreToolUse(payload);
  assert.equal(result.blocked, false);
});

test("evaluatePreToolUse ignores read_file tools", () => {
  const payload = JSON.stringify({
    tool_name: "read_file",
    arguments: { file_path: "/path/to/ccc" }
  });

  const result = evaluatePreToolUse(payload);
  assert.equal(result.blocked, false);
});

test("evaluatePreToolUse handles malformed or empty inputs gracefully", () => {
  assert.equal(evaluatePreToolUse("").blocked, false);
  assert.equal(evaluatePreToolUse("not json").blocked, false);
  assert.equal(evaluatePreToolUse("{}").blocked, false);
});

test("runBlockCccCli exits with code 2 on ccc command and 0 on allowed command", () => {
  const blockedPayload = JSON.stringify({
    tool_name: "exec_command",
    arguments: { cmd: "ccc index" }
  });
  assert.equal(runBlockCccCli(blockedPayload), 2);

  const allowedPayload = JSON.stringify({
    tool_name: "exec_command",
    arguments: { cmd: "pnpm test" }
  });
  assert.equal(runBlockCccCli(allowedPayload), 0);
});
