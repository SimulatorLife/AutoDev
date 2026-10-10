import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = join(import.meta.dirname, "..");
const patchesDirectory = join(repositoryRoot, "patches", "openlit");
const buildScript = join(
  repositoryRoot,
  "scripts",
  "openlit",
  "build-local.sh"
);
const pinnedCommit = "9938c66638666ca5d3bcb850350faa82e510924b";
const imageId = `sha256:${"a".repeat(64)}`;

function patchSetHash(): string {
  const patchFiles = readdirSync(patchesDirectory)
    .filter((name) => name.endsWith(".patch"))
    .sort()
    .map((name) => readFileSync(join(patchesDirectory, name)));
  return createHash("sha256")
    .update(Buffer.concat(patchFiles))
    .digest("hex")
    .slice(0, 16);
}

test("build-local reuses only a locked image matching current source, patches, tag and platform", () => {
  const temp = mkdtempSync(join(tmpdir(), "autodev-openlit-build-cache-"));
  const binDirectory = join(temp, "bin");
  const codexHome = join(temp, "codex-home");
  const dockerLog = join(temp, "docker.log");
  const lockFile = join(codexHome, "openlit-patched.lock");
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  const currentPatchHash = patchSetHash();
  const imageTag = `autodev-openlit:openlit-${pinnedCommit.slice(0, 12)}-p${currentPatchHash}`;
  const dockerPath = join(binDirectory, "docker");
  writeFileSync(
    dockerPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOCKER_CALL_LOG"\ncase "$1" in\n  info) printf 'linux/arm64\\n' ;;\n  inspect) printf '${imageId}|linux/arm64\\n' ;;\n  *) exit 97 ;;\nesac\n`,
    { mode: 0o755 }
  );
  chmodSync(dockerPath, 0o755);
  writeFileSync(
    lockFile,
    [
      "# fixture lock",
      `AUTODEV_OPENLIT_PINNED_COMMIT=${pinnedCommit}`,
      `AUTODEV_OPENLIT_PATCH_SET_HASH=${currentPatchHash}`,
      `AUTODEV_OPENLIT_IMAGE_TAG=${imageTag}`,
      `AUTODEV_OPENLIT_IMAGE_ID=${imageId}`,
      ""
    ].join("\n")
  );

  try {
    const result = spawnSync("bash", [buildScript], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        CODEX_HOME: codexHome,
        AUTODEV_OPENLIT_LOCK_FILE: lockFile,
        DOCKER_CALL_LOG: dockerLog
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Reusing the already-built, locked OpenLIT image/u
    );
    const dockerCalls = readFileSync(dockerLog, "utf8");
    assert.match(dockerCalls, /^info /mu);
    assert.match(dockerCalls, /^inspect /mu);
    assert.doesNotMatch(dockerCalls, /build/u);
    assert.doesNotMatch(result.stdout, /Applying the local patch set/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("build-local rebuilds when the cached patch set is stale", () => {
  const temp = mkdtempSync(join(tmpdir(), "autodev-openlit-build-stale-"));
  const repo = join(temp, "repo");
  const binDirectory = join(temp, "bin");
  const codexHome = join(temp, "codex-home");
  const tempPatchesDirectory = join(repo, "patches", "openlit");
  const runnerDirectory = join(repo, "scripts", "openlit");
  const dockerLog = join(temp, "docker.log");
  const lockFile = join(codexHome, "openlit-patched.lock");
  mkdirSync(tempPatchesDirectory, { recursive: true });
  mkdirSync(runnerDirectory, { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  writeFileSync(
    join(tempPatchesDirectory, "01-current.patch"),
    "current patch\n"
  );
  const currentPatchHash = createHash("sha256")
    .update(readFileSync(join(tempPatchesDirectory, "01-current.patch")))
    .digest("hex")
    .slice(0, 16);
  const applyScript = join(runnerDirectory, "apply-patches.sh");
  writeFileSync(applyScript, "#!/bin/sh\nprintf 'patches applied\\n'\n", {
    mode: 0o755
  });
  chmodSync(applyScript, 0o755);
  const dockerPath = join(binDirectory, "docker");
  writeFileSync(
    dockerPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOCKER_CALL_LOG"\ncase "$1" in\n  info) printf 'linux/arm64\\n' ;;\n  build|images) exit 0 ;;\n  inspect)\n    case "$*" in\n      *RepoDigests*) exit 0 ;;\n      *) printf '${imageId}\\n' ;;\n    esac\n    ;;\n  *) exit 97 ;;\nesac\n`,
    { mode: 0o755 }
  );
  chmodSync(dockerPath, 0o755);
  writeFileSync(
    lockFile,
    [
      "# stale fixture lock",
      `AUTODEV_OPENLIT_PINNED_COMMIT=${pinnedCommit}`,
      "AUTODEV_OPENLIT_PATCH_SET_HASH=stale-patch-hash",
      `AUTODEV_OPENLIT_IMAGE_TAG=autodev-openlit:openlit-${pinnedCommit.slice(0, 12)}-pstale-patch-hash`,
      `AUTODEV_OPENLIT_IMAGE_ID=${imageId}`,
      ""
    ].join("\n")
  );

  try {
    const result = spawnSync("bash", [buildScript], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        REPO_ROOT: repo,
        CODEX_HOME: codexHome,
        AUTODEV_OPENLIT_LOCK_FILE: lockFile,
        AUTODEV_OPENLIT_PATCHES_DIR: tempPatchesDirectory,
        DOCKER_CALL_LOG: dockerLog
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /patches applied/u);
    assert.match(readFileSync(dockerLog, "utf8"), /^build /mu);
    assert.match(
      readFileSync(lockFile, "utf8"),
      new RegExp(`AUTODEV_OPENLIT_PATCH_SET_HASH=${currentPatchHash}`, "u")
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
