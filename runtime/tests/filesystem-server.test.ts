import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { filesystemMcpServer } from "../src/mcp/filesystem-server.ts";
import { filesystemDirectoryArgs as filesystemDirectoryArguments } from "../src/mcp/launcher.ts";

const LAUNCHER = fileURLToPath(
  new URL("../src/mcp/launcher.ts", import.meta.url)
);

test("a bridge's filesystem server runs the typed launcher, scoped to the turn", () => {
  const writable = filesystemMcpServer({
    workspace: "/work/repo",
    readOnly: false,
    codexHome: "/codex",
    userHome: "/home/user"
  });
  assert.equal(writable.command, process.execPath);
  assert.deepEqual(writable.args, [LAUNCHER, "filesystem"]);
  assert.equal(writable.env.AUTODEV_MCP_WORKSPACE, "/work/repo");
  assert.equal(writable.env.CODEX_HOME, "/codex");
  assert.equal(writable.env.HOME, "/home/user");
  assert.equal(writable.env.AUTODEV_MCP_READ_ONLY, undefined);

  const readOnly = filesystemMcpServer({
    workspace: "/work/repo",
    readOnly: true
  });
  assert.equal(readOnly.env.AUTODEV_MCP_READ_ONLY, "1");
});

test("a relative workspace is refused rather than resolved against the bridge's own directory", () => {
  assert.throws(
    () => filesystemMcpServer({ workspace: "repo", readOnly: false }),
    /needs an absolute workspace/
  );
});

test("skill roots outside the workspace are read-only directories; ones inside it stay with the workspace", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fs-dirs-")));
  const savedHome = process.env.HOME;
  try {
    const home = path.join(root, "home");
    const workspace = path.join(root, "work");
    mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(path.join(workspace, ".agents", "skills"), { recursive: true });
    process.env.HOME = home;
    const arguments_ = filesystemDirectoryArguments(workspace, workspace);
    assert.equal(arguments_[0], "--confine-roots");
    assert.deepEqual(arguments_.slice(-2), ["--", workspace]);
    const readOnly = arguments_.flatMap((argument, index) =>
      arguments_[index - 1] === "--read-only-dir" ? [argument] : []
    );
    assert.ok(readOnly.includes(path.join(home, ".agents", "skills")));
    assert.ok(
      readOnly.every((dir) => !dir.startsWith(workspace)),
      "the workspace's own skills stay writable"
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
});
