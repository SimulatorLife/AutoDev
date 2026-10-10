import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:net";

import {
  buildDockerRunArguments,
  localDockerSocket,
  PlaytestSandboxApprovalError,
  PlaytestSandboxUnavailableError,
  preparePlaytestSandbox,
  type PlaytestSandboxApproval
} from "../src/playtesting/docker-sandbox.ts";

function repository(): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-playtest-repo-"));
  writeFileSync(path.join(root, "adapter.py"), "print('adapter')\n");
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "add", "adapter.py"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Playtest test",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  ]);
  return {
    root: realpathSync(root),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function approval(root: string): PlaytestSandboxApproval {
  const buildSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
  return {
    workspaceId: "fixture/game",
    checkoutRoot: root,
    buildSha,
    imageDigest: `ghcr.io/fixture/game@sha256:${"a".repeat(64)}`,
    workingDirectory: ".",
    adapterCommand: ["/usr/bin/python3", "adapter.py"],
    approvedCommand: ["/usr/bin/python3", "adapter.py"],
    limits: {
      cpuCores: 1,
      memoryBytes: 256 * 1024 * 1024,
      processCount: 32,
      wallTimeMs: 10_000,
      artifactBytes: 64 * 1024
    }
  };
}

async function withLocalSocket<T>(
  run: (socket: string) => Promise<T>
): Promise<T> {
  const directory = mkdtempSync(path.join(tmpdir(), "autodev-docker-socket-"));
  const socket = path.join(directory, "engine.sock");
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    return await run(socket);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

test("sandbox approval pins a clean checkout, command, image, and bounded resources", () => {
  const fixture = repository();
  try {
    const prepared = preparePlaytestSandbox(approval(fixture.root));
    assert.equal(prepared.checkoutRoot, fixture.root);
    assert.match(prepared.checkoutSha, /^[a-f\d]{40}$/u);
    assert.deepEqual(prepared.command, ["/usr/bin/python3", "adapter.py"]);
    assert.equal(prepared.workingDirectory, fixture.root);
  } finally {
    fixture.cleanup();
  }
});

test("sandbox refuses a changed build, dirty checkout, and unapproved command", () => {
  const fixture = repository();
  try {
    const approved = approval(fixture.root);
    assert.throws(
      () => preparePlaytestSandbox({ ...approved, buildSha: "f".repeat(40) }),
      PlaytestSandboxApprovalError
    );
    writeFileSync(path.join(fixture.root, "untracked.txt"), "no\n");
    assert.throws(
      () => preparePlaytestSandbox(approved),
      /modified or untracked/u
    );
    rmSync(path.join(fixture.root, "untracked.txt"));
    assert.throws(
      () =>
        preparePlaytestSandbox({
          ...approved,
          adapterCommand: ["/bin/sh", "-c", "touch /tmp/unauthorized"]
        }),
      /operator-approved command/u
    );
  } finally {
    fixture.cleanup();
  }
});

test("sandbox rejects workspace escapes and unpinned container images", () => {
  const fixture = repository();
  const outside = mkdtempSync(path.join(tmpdir(), "autodev-playtest-outside-"));
  try {
    symlinkSync(outside, path.join(fixture.root, "outside"));
    assert.throws(
      () =>
        preparePlaytestSandbox({
          ...approval(fixture.root),
          workingDirectory: "outside"
        }),
      /escapes the approved checkout/u
    );
    assert.throws(
      () =>
        preparePlaytestSandbox({
          ...approval(fixture.root),
          imageDigest: "fixture/game:latest"
        }),
      /pinned by sha256 digest/u
    );
    assert.ok(lstatSync(path.join(fixture.root, "outside")).isSymbolicLink());
  } finally {
    fixture.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("Docker argv enforces a local, read-only, networkless container with hard quotas", async () => {
  const fixture = repository();
  try {
    const prepared = preparePlaytestSandbox(approval(fixture.root));
    await withLocalSocket(async (socket) => {
      const args = buildDockerRunArguments(
        prepared,
        "run-42",
        fixture.root,
        socket
      );
      const joined = args.join(" ");
      assert.equal(args[0], "--host");
      assert.equal(args[1], `unix://${socket}`);
      assert.ok(args.includes("--pull=never"));
      assert.ok(args.includes("--network=none"));
      assert.ok(args.includes("--read-only"));
      assert.ok(args.includes("--cap-drop=ALL"));
      assert.ok(args.includes("--security-opt=no-new-privileges"));
      assert.ok(args.includes("--log-driver=none"));
      assert.ok(args.includes("--pids-limit"));
      assert.ok(args.includes("--memory-swap"));
      assert.ok(args.includes("--cpus"));
      assert.ok(joined.includes("type=bind,source=" + fixture.root));
      assert.ok(joined.includes("target=/workspace,readonly"));
      assert.ok(joined.includes("/artifacts:rw,noexec,nosuid,nodev"));
      assert.ok(joined.includes("ghcr.io/fixture/game@sha256:"));
      assert.ok(joined.includes("--entrypoint /usr/bin/python3"));
      assert.doesNotMatch(joined, /--gpus|DOCKER_HOST=.*tcp/u);
      assert.doesNotMatch(joined, /--env .*API_KEY|--env .*TOKEN/u);
    });
  } finally {
    fixture.cleanup();
  }
});

test("Docker host resolution refuses remote-only platforms", () => {
  assert.equal(
    localDockerSocket("linux", "/home/test"),
    "/var/run/docker.sock"
  );
  assert.equal(
    localDockerSocket("darwin", "/Users/test"),
    "/Users/test/.docker/run/docker.sock"
  );
  assert.throws(
    () => localDockerSocket("win32"),
    PlaytestSandboxUnavailableError
  );
});
