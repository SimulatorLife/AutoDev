import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { withXacpxLaunchEnvironment } from "../src/xacpx/mcp-launch-environment.ts";

test("simultaneous launch scopes do not share workspace projections or vendor state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "xacpx-launch-test-"));
  try {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const alias = path.join(root, "alias");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, alias, "dir");
    const oldConfig = path.join(root, "old-config.json");
    const oldState = path.join(root, "old-state.json");
    writeFileSync(oldConfig, "stale-config");
    writeFileSync(oldState, "stale-state");
    const inherited = {
      XACPX_CONFIG: oldConfig,
      XACPX_STATE: oldState,
      XACPX_ORCHESTRATION_SOCKET: "/tmp/fixture.sock",
      AUTODEV_XACPX_COORDINATOR_SESSION: "fixture:coordinator",
      AUTODEV_XACPX_WORKSPACE: second
    };
    const roles = ["explorer", "validator"];
    let directoryA = "";
    let directoryB = "";
    await withXacpxLaunchEnvironment(alias, inherited, roles, async (a) => {
      directoryA = path.dirname(a.XACPX_CONFIG!);
      assert.equal(statSync(directoryA).mode & 0o777, 0o700);
      assert.equal(statSync(a.XACPX_CONFIG!).mode & 0o777, 0o600);
      assert.equal(a.AUTODEV_XACPX_WORKSPACE, realpathSync(first));
      assert.equal(
        a.XACPX_ORCHESTRATION_SOCKET,
        inherited.XACPX_ORCHESTRATION_SOCKET
      );
      assert.equal(
        a.AUTODEV_XACPX_COORDINATOR_SESSION,
        inherited.AUTODEV_XACPX_COORDINATOR_SESSION
      );
      assert.equal(existsSync(a.XACPX_STATE!), false);
      const initial = readFileSync(a.XACPX_CONFIG!, "utf8");
      const config = JSON.parse(initial);
      assert.deepEqual(Object.keys(config.agents), roles);
      assert.deepEqual(config.workspaces, {
        [realpathSync(first)]: { cwd: realpathSync(first) }
      });
      await withXacpxLaunchEnvironment(second, inherited, roles, (b) => {
        directoryB = path.dirname(b.XACPX_CONFIG!);
        assert.notEqual(directoryA, directoryB);
        assert.notEqual(a.XACPX_STATE, b.XACPX_STATE);
        assert.deepEqual(
          JSON.parse(readFileSync(b.XACPX_CONFIG!, "utf8")).workspaces,
          { [realpathSync(second)]: { cwd: realpathSync(second) } }
        );
        writeFileSync(b.XACPX_STATE!, "vendor-state");
        assert.equal(existsSync(a.XACPX_STATE!), false);
        assert.equal(readFileSync(a.XACPX_CONFIG!, "utf8"), initial);
      });
      assert.equal(existsSync(directoryB), false);
      assert.equal(existsSync(directoryA), true);
    });
    assert.equal(existsSync(directoryA), false);
    assert.equal(readFileSync(oldConfig, "utf8"), "stale-config");
    assert.equal(readFileSync(oldState, "utf8"), "stale-state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed launcher removes its own private projection", async () => {
  let directory = "";
  await assert.rejects(
    () => withXacpxLaunchEnvironment(process.cwd(), {}, ["worker"], (env) => {
      directory = path.dirname(env.XACPX_CONFIG!);
      throw new Error("fixture startup failure");
    }),
    /fixture startup failure/u
  );
  assert.ok(directory);
  assert.equal(existsSync(directory), false);
});
