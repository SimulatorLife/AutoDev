import assert from "node:assert/strict";
import test from "node:test";

import {
  type ClaudeEnsureDeps,
  type ClaudeEnsureOptions,
  ensureClaudeBridge,
  isClaudeModel,
  resolveClaudeEnsureOptions
} from "../../src/platform/claude-ensure.ts";

function options(
  overrides: Partial<ClaudeEnsureOptions> = {}
): ClaudeEnsureOptions {
  return {
    host: "127.0.0.1",
    port: 4000,
    label: "com.codex.claude-bridge",
    plist: "/tmp/claude.plist",
    launcher: "/tmp/claude.sh",
    oauthToken: "token",
    readyTimeoutMs: 20,
    logPath: "/tmp/claude.log",
    ...overrides
  };
}

function deps(overrides: Partial<ClaudeEnsureDeps> = {}): ClaudeEnsureDeps {
  return {
    launchd: {
      isLoaded: () => false,
      kickstart: () => {},
      bootstrap: () => {}
    },
    probe: async () => false,
    sleep: async () => {},
    tokenAvailable: () => true,
    plistExists: () => false,
    launcherExists: () => true,
    startFallback: () => {},
    ...overrides
  };
}

test("Claude model gate is strict and case-insensitive for known aliases", () => {
  assert.equal(isClaudeModel('{"model":"sonnet"}'), true);
  assert.equal(isClaudeModel('{"model":"claude-3-7-sonnet"}'), true);
  assert.equal(isClaudeModel('{"model":"MiniMax-M3"}'), false);
  assert.equal(isClaudeModel("{}"), false);
});

test("Claude resolver uses typed runtime paths and OAuth environment", () => {
  const result = resolveClaudeEnsureOptions({
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    CLAUDE_CODE_OAUTH_TOKEN: "secret"
  });
  assert.equal(
    result.launcher,
    "/home/test/.codex/hooks/run-codex-claude-bridge.sh"
  );
  assert.equal(
    result.plist,
    "/home/test/Library/LaunchAgents/com.codex.claude-bridge.plist"
  );
  assert.equal(result.oauthToken, "secret");
});

test("non-Claude subagents do not start the Claude bridge", async () => {
  let starts = 0;
  assert.equal(
    await ensureClaudeBridge(
      '{"model":"MiniMax-M3"}',
      options(),
      deps({
        startFallback: () => {
          starts += 1;
        }
      })
    ),
    0
  );
  assert.equal(starts, 0);
});

test("Claude bridge fails closed without credentials", async () => {
  assert.equal(
    await ensureClaudeBridge(
      '{"model":"sonnet"}',
      options(),
      deps({ tokenAvailable: () => false })
    ),
    1
  );
});

test("Claude bridge uses fallback only when launchd has no plist", async () => {
  let started = "";
  const result = await ensureClaudeBridge(
    '{"model":"sonnet"}',
    options(),
    deps({
      startFallback: (launcher, logPath) => {
        started = `${launcher}:${logPath}`;
      },
      probe: (() => {
        let calls = 0;
        return async () => ++calls > 1;
      })()
    })
  );
  assert.equal(result, 0);
  assert.equal(started, "/tmp/claude.sh:/tmp/claude.log");
});

test("Claude bridge does not create an unmanaged fallback beside a launchd plist", async () => {
  let started = false;
  const result = await ensureClaudeBridge(
    '{"model":"sonnet"}',
    options(),
    deps({
      plistExists: () => true,
      startFallback: () => {
        started = true;
      }
    })
  );
  assert.equal(result, 1);
  assert.equal(started, false);
});
