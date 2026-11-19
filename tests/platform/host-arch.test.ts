import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyNativeNodeLoginProfileContent,
  codexCliVersion,
  executableArch,
  foreignArchSystemNodePath,
  hostArch,
  NATIVE_NODE_PROFILE_BEGIN,
  NATIVE_NODE_PROFILE_END,
  nativeNodeLoginProfileDir,
  nativeNodeLoginProfileMatches,
  resolveServiceCodex,
  resolveServiceNode,
  runsNatively,
  syncNativeNodeLoginProfile
} from "@simulatorlife/autodev-runtime/platform/host-arch";

import { executableHeader } from "./executable-header.ts";

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-host-arch-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeExecutable(
  directory: string,
  name: string,
  header: Buffer
): string {
  const file = join(directory, name);
  writeFileSync(file, header);
  chmodSync(file, 0o755);
  return file;
}

test("a Rosetta process on Apple Silicon still reports the machine as arm64", () => {
  assert.equal(
    hostArch("darwin", "x64", () => true),
    "arm64",
    "process.arch is x64 under Rosetta; choosing binaries by it picks Intel builds"
  );
  assert.equal(
    hostArch("darwin", "x64", () => false),
    "amd64"
  );
  assert.equal(
    hostArch("linux", "arm64", () => false),
    "arm64"
  );
  assert.equal(
    hostArch("linux", "x64", () => false),
    "amd64"
  );
  assert.throws(() => hostArch("linux", "ia32", () => false), /unsupported/);
});

test("executable architecture is read from the Mach-O or ELF header", () =>
  withTempDir((directory) => {
    for (const [arch, expected] of [
      ["arm64", "arm64"],
      ["amd64", "amd64"],
      ["universal", "universal"],
      ["elf-arm64", "arm64"],
      ["elf-amd64", "amd64"]
    ] as const)
      assert.equal(
        executableArch(
          writeExecutable(directory, arch, executableHeader(arch))
        ),
        expected,
        arch
      );
    assert.equal(
      executableArch(
        writeExecutable(directory, "script", Buffer.from("#!/bin/sh\n"))
      ),
      null
    );
    assert.equal(executableArch(join(directory, "missing")), null);
  }));

test("a universal binary runs natively on either architecture", () =>
  withTempDir((directory) => {
    const universal = writeExecutable(
      directory,
      "universal",
      executableHeader("universal")
    );
    assert.equal(runsNatively(universal, "arm64"), true);
    assert.equal(runsNatively(universal, "amd64"), true);
    const intel = writeExecutable(
      directory,
      "intel",
      executableHeader("amd64")
    );
    assert.equal(runsNatively(intel, "arm64"), false);
  }));

test("services run on the first native Node, not the first one on PATH", () =>
  withTempDir((directory) => {
    const intel = writeExecutable(
      directory,
      "intel-node",
      executableHeader("amd64")
    );
    const native = writeExecutable(
      directory,
      "native-node",
      executableHeader("arm64")
    );
    assert.equal(
      resolveServiceNode(directory, "arm64", [intel, null, native]),
      native
    );
    assert.equal(
      resolveServiceNode(directory, "arm64", [join(directory, "gone"), intel]),
      intel,
      "with no native Node, a usable one still beats none"
    );
  }));

test("services run on the newest Codex CLI, not an old one on PATH", () =>
  withTempDir((directory) => {
    const home = join(directory, "home");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    const current = join(home, ".local/bin/codex");
    writeFileSync(current, "#!/bin/sh\necho 'codex-cli 0.154.0'\n");
    chmodSync(current, 0o755);
    const stale = join(directory, "usr-local-bin");
    mkdirSync(stale, { recursive: true });
    const staleCodex = join(stale, "codex");
    writeFileSync(staleCodex, "#!/bin/sh\necho 'codex-cli 0.42.0'\n");
    chmodSync(staleCodex, 0o755);

    assert.equal(
      resolveServiceCodex(home, { PATH: stale }),
      current,
      "a stale CLI on the default PATH must not shadow the current one"
    );
    assert.equal(
      resolveServiceCodex(home, {
        PATH: stale,
        CODEX_BIN: staleCodex
      }),
      staleCodex,
      "an explicitly configured CLI is the operator's decision and wins"
    );
  }));

test("the Codex CLI version is read from the binary itself", () =>
  withTempDir((directory) => {
    const binary = join(directory, "codex");
    writeFileSync(binary, "#!/bin/sh\necho 'codex-cli 0.154.0'\n");
    chmodSync(binary, 0o755);
    assert.equal(codexCliVersion(binary), "0.154.0");
    assert.equal(codexCliVersion(join(directory, "missing")), null);
  }));

test("nativeNodeLoginProfileDir detects Rosetta system node shadowing a native node", () =>
  withTempDir((directory) => {
    const home = join(directory, "home");
    const sysDir = join(directory, "usr-local-bin");
    const nvmDir = join(directory, "nvm-arm64-bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(sysDir, { recursive: true });
    mkdirSync(nvmDir, { recursive: true });

    const intel = writeExecutable(sysDir, "node", executableHeader("amd64"));
    const native = writeExecutable(nvmDir, "node", executableHeader("arm64"));

    assert.equal(foreignArchSystemNodePath("arm64", [intel]), intel);
    assert.equal(foreignArchSystemNodePath("amd64", [intel]), null);
    assert.equal(
      nativeNodeLoginProfileDir(home, {
        host: "arm64",
        systemCandidates: [intel],
        nodeCandidates: [native]
      }),
      nvmDir
    );
    assert.equal(
      nativeNodeLoginProfileDir(home, {
        host: "arm64",
        systemCandidates: [native],
        nodeCandidates: [native]
      }),
      null,
      "no login profile rewrite is needed when system node already runs natively"
    );
    assert.equal(
      nativeNodeLoginProfileDir(home, {
        host: "arm64",
        systemCandidates: [intel],
        nodeCandidates: [intel]
      }),
      null,
      "no rewrite when no native node is installed"
    );
  }));

test("syncNativeNodeLoginProfile idempotently maintains .zprofile and preserves operator lines", () =>
  withTempDir((directory) => {
    const home = join(directory, "home");
    const sysDir = join(directory, "usr-local-bin");
    const nvmDir = join(directory, "nvm-arm64-bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(sysDir, { recursive: true });
    mkdirSync(nvmDir, { recursive: true });

    const intel = writeExecutable(sysDir, "node", executableHeader("amd64"));
    const native = writeExecutable(nvmDir, "node", executableHeader("arm64"));
    const options = {
      host: "arm64" as const,
      systemCandidates: [intel],
      nodeCandidates: [native]
    };

    const profilePath = join(home, ".zprofile");
    writeFileSync(profilePath, 'eval "$(/opt/homebrew/bin/brew shellenv)"\n\n');
    assert.equal(nativeNodeLoginProfileMatches(home, options), false);

    const first = syncNativeNodeLoginProfile(home, options);
    assert.equal(first.changed, true);
    assert.equal(first.nodeDir, nvmDir);
    assert.equal(nativeNodeLoginProfileMatches(home, options), true);

    const content = readFileSync(profilePath, "utf8");
    assert.ok(content.startsWith('eval "$(/opt/homebrew/bin/brew shellenv)"'));
    assert.ok(content.includes(NATIVE_NODE_PROFILE_BEGIN));
    assert.ok(content.includes(`export PATH="${nvmDir}:$PATH"`));
    assert.ok(content.includes(NATIVE_NODE_PROFILE_END));

    const second = syncNativeNodeLoginProfile(home, options);
    assert.equal(second.changed, false);

    const removed = applyNativeNodeLoginProfileContent(content, null);
    assert.equal(removed, 'eval "$(/opt/homebrew/bin/brew shellenv)"\n');

    const cleaned = syncNativeNodeLoginProfile(home, {
      host: "arm64",
      systemCandidates: [native],
      nodeCandidates: [native]
    });
    assert.equal(cleaned.changed, true);
    assert.equal(
      readFileSync(profilePath, "utf8"),
      'eval "$(/opt/homebrew/bin/brew shellenv)"\n'
    );

    const emptyHome = join(directory, "empty-home");
    mkdirSync(emptyHome, { recursive: true });
    const noop = syncNativeNodeLoginProfile(emptyHome, {
      host: "arm64",
      systemCandidates: [native],
      nodeCandidates: [native]
    });
    assert.equal(noop.changed, false);
    assert.equal(existsSync(join(emptyHome, ".zprofile")), false);
  }));
