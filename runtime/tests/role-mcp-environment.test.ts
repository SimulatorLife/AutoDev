import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { roleMcpEnvironment } from "@simulatorlife/autodev-runtime/agents";

function secretFile(content: string): { root: string; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-role-mcp-env-"));
  const file = path.join(root, "openlit-secrets.env");
  writeFileSync(file, content, { mode: 0o600 });
  return { root, file };
}

test("playtester MCP env binds trusted session identity but never the runner token", () => {
  const { root, file } = secretFile(
    "AUTODEV_PLAYTEST_CONTROL_API_TOKEN=" + "a".repeat(64) + "\n"
  );
  try {
    const env = roleMcpEnvironment(
      {
        role: "playtester",
        server: "playtest",
        requestId: "req-1",
        workspaceId: "SimulatorLife/RacingGame",
        workspaceRoot: "/tmp/RacingGame",
        repositoryRoot: "/repo",
        codeHome: "/codex"
      },
      {
        HOME: root,
        AUTODEV_OPENLIT_SECRET_FILE: file,
        AUTODEV_PLAYTEST_WORKSPACE_ID: "Other/Workspace",
        AUTODEV_PLAYTEST_REPOSITORY_ROOT: "/tmp/other-game",
        AUTODEV_CONTROL_API_TOKEN: "general-secret",
        OPENAI_API_KEY: "provider-secret"
      }
    );
    assert.equal(env.AUTODEV_PLAYTEST_WORKSPACE_ID, "SimulatorLife/RacingGame");
    assert.equal(env.AUTODEV_PLAYTEST_ROLE, "playtester");
    assert.equal(env.AUTODEV_PLAYTEST_CONTROL_API_ROLE, "playtester");
    assert.equal(env.AUTODEV_PLAYTEST_TASK_ID, "provider-task-req-1");
    assert.equal(env.AUTODEV_PLAYTEST_REPOSITORY_ROOT, "/tmp/RacingGame");
    assert.equal(env.AUTODEV_OPENLIT_SECRET_FILE, file);
    assert.equal(env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN, undefined);
    assert.equal(env.AUTODEV_CONTROL_API_TOKEN, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("playtester MCP env fails closed without the runner credential or workspace", () => {
  const { root, file } = secretFile("AUTODEV_CONTROL_API_TOKEN=general\n");
  try {
    const context = {
      role: "playtester",
      server: "playtest",
      workspaceId: "SimulatorLife/RacingGame",
      workspaceRoot: "/tmp/RacingGame",
      repositoryRoot: "/repo",
      codeHome: "/codex"
    };
    assert.throws(
      () =>
        roleMcpEnvironment(context, {
          HOME: root,
          AUTODEV_OPENLIT_SECRET_FILE: file
        }),
      /runner credential is unavailable/u
    );
    writeFileSync(
      file,
      "AUTODEV_PLAYTEST_CONTROL_API_TOKEN=" + "b".repeat(64) + "\n"
    );
    assert.throws(
      () =>
        roleMcpEnvironment(
          { ...context, workspaceId: "not-canonical" },
          { HOME: root, AUTODEV_OPENLIT_SECRET_FILE: file }
        ),
      /canonical workspace identity/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser-tester MCP env exposes only its declared allowlist", () => {
  const env = roleMcpEnvironment(
    {
      role: "browser-tester",
      server: "playwright",
      repositoryRoot: "/repo",
      codeHome: "/codex"
    },
    {
      PATH: "/usr/bin",
      HOME: "/home/test",
      AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "runner",
      AUTODEV_CONTROL_API_TOKEN: "general"
    }
  );
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CODEX_HOME, "/codex");
  assert.equal(env.AUTODEV_PLAYTEST_CONTROL_API_TOKEN, undefined);
  assert.equal(env.AUTODEV_CONTROL_API_TOKEN, undefined);
  assert.deepEqual(
    roleMcpEnvironment(
      {
        role: "worker",
        server: "playwright",
        repositoryRoot: "/r",
        codeHome: "/c"
      },
      { PATH: "/usr/bin" }
    ),
    {}
  );
});
