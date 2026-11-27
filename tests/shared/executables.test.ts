import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  codexCliVersion,
  findCodexBinary,
  findCopilotBinary,
  findMcodeBinary,
  findPnpmGlobalBinary,
  resolveCodexBinary,
  resolveCopilotBinary
} from "@simulatorlife/autodev-runtime/shared/executables";

/**
 * A home directory with nothing in it, so every lookup in a test starts from
 * a known-empty machine rather than the one the test runs on.
 */
function homeFixture(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "autodev-copilot-home-"));
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

function installExecutable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/**
 * A Codex CLI that reports the given version, or one that reports no version
 * at all when the version is null.
 */
function installCodex(path: string, version: string | null): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const script =
    version === null
      ? `#!/bin/sh\nexit 0\n`
      : `#!/bin/sh\necho 'codex-cli ${version}'\n`;
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/**
 * A Runtime layout holding a private copy of the resolver module, so the test
 * controls the package symlink it resolves through while that one module
 * instance stays loaded -- the way the long-lived bridge does across an install.
 */
function runtimeFixture(): {
  root: string;
  load: () => Promise<
    typeof import("@simulatorlife/autodev-runtime/shared/executables")
  >;
  installPackage: (name: string) => string;
  linkPackage: (name: string) => void;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "autodev-opencli-runtime-"));
  const moduleDir = join(root, "runtime", "src", "shared");
  mkdirSync(moduleDir, { recursive: true });
  const modulePath = join(moduleDir, "executables.ts");
  copyFileSync(
    new URL("../../runtime/src/shared/executables.ts", import.meta.url),
    modulePath
  );
  copyFileSync(
    new URL("../../runtime/src/shared/bundled-plugins.ts", import.meta.url),
    join(moduleDir, "bundled-plugins.ts")
  );
  const scope = join(root, "runtime", "node_modules", "@jackwener");
  return {
    root,
    load: () => import(pathToFileURL(modulePath).href),
    installPackage: (name) => {
      const directory = join(root, "store", name);
      mkdirSync(join(directory, "dist", "src"), { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          name: "@jackwener/opencli",
          type: "module",
          exports: { ".": "./dist/src/main.js" },
          bin: { opencli: "dist/src/main.js" }
        })
      );
      writeFileSync(join(directory, "dist", "src", "main.js"), "");
      return join(directory, "dist", "src", "main.js");
    },
    linkPackage: (name) => {
      mkdirSync(scope, { recursive: true });
      const link = join(scope, "opencli");
      try {
        unlinkSync(link);
      } catch {
        // First link: nothing to replace.
      }
      symlinkSync(join(root, "store", name), link);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test("opencli is resolved through the package symlink as it is now, not as it was first resolved", async (t) => {
  const fixture = runtimeFixture();
  t.after(fixture.cleanup);
  const v1 = fixture.installPackage("v1");
  const v2 = fixture.installPackage("v2");
  const { resolveOpencliCommand } = await fixture.load();

  fixture.linkPackage("v1");
  assert.deepEqual(resolveOpencliCommand({}), {
    command: process.execPath,
    args: [realpathSync(v1)]
  });

  // pnpm install swaps the symlink under the running process.
  fixture.linkPackage("v2");
  assert.deepEqual(resolveOpencliCommand({}), {
    command: process.execPath,
    args: [realpathSync(v2)]
  });
});

test("a missing opencli package is reported as not installed", async (t) => {
  const fixture = runtimeFixture();
  t.after(fixture.cleanup);
  const { resolveOpencliCommand, findOpencliCommand } = await fixture.load();
  assert.throws(() => resolveOpencliCommand({}), /opencli is not installed/);
  assert.equal(findOpencliCommand({}), null);

  // A package whose bin entry was not built is a different, named failure.
  const entry = fixture.installPackage("broken");
  fixture.linkPackage("broken");
  rmSync(entry);
  assert.throws(() => resolveOpencliCommand({}), /entry point is missing/);
});

test("OPENCLI_BIN still wins over the package", async (t) => {
  const fixture = runtimeFixture();
  t.after(fixture.cleanup);
  fixture.installPackage("v1");
  fixture.linkPackage("v1");
  const binary = installExecutable(join(fixture.root, "bin", "opencli"));
  const { resolveOpencliCommand } = await fixture.load();
  assert.deepEqual(resolveOpencliCommand({ OPENCLI_BIN: binary }), {
    command: binary,
    args: []
  });
  assert.throws(
    () => resolveOpencliCommand({ OPENCLI_BIN: join(fixture.root, "nope") }),
    /opencli is not executable/
  );
});

test("an explicit Copilot CLI is used when it is executable", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const binary = installExecutable(join(fixture.home, "bin", "copilot"));
  assert.equal(
    resolveCopilotBinary({ COPILOT_BIN: binary, PATH: "" }, fixture.home),
    binary
  );
});

test("an explicit Copilot CLI that is not executable is reported, not used", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const missing = join(fixture.home, "bin", "copilot");
  assert.throws(
    () =>
      resolveCopilotBinary({ COPILOT_BIN: missing, PATH: "" }, fixture.home),
    /Copilot CLI is not executable/
  );
  assert.equal(
    findCopilotBinary({ COPILOT_BIN: missing, PATH: "" }, fixture.home),
    null
  );
});

test("an explicit Copilot CLI named as a command is resolved on PATH", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const directory = join(fixture.home, "bin");
  const binary = installExecutable(join(directory, "copilot"));
  assert.equal(
    resolveCopilotBinary(
      { COPILOT_BIN: "copilot", PATH: directory },
      fixture.home
    ),
    binary
  );
});

test("the first Copilot CLI on PATH is used", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const directory = join(fixture.home, "bin");
  const binary = installExecutable(join(directory, "copilot"));
  assert.equal(resolveCopilotBinary({ PATH: directory }, fixture.home), binary);
});

test("a pnpm-global Copilot CLI is found without a login-shell PATH", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const pnpmHome = join(fixture.home, "pnpm-home");
  const binary = installExecutable(join(pnpmHome, "bin", "copilot"));
  const legacy = installExecutable(
    join(fixture.home, ".nvm", "versions", "node", "v25.0.0", "bin", "copilot")
  );
  assert.equal(
    resolveCopilotBinary({ PATH: "", PNPM_HOME: pnpmHome }, fixture.home),
    binary
  );
  assert.notEqual(binary, legacy);
});

test("a Copilot CLI in ~/.local/bin is found when nothing else is installed", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const binary = installExecutable(
    join(fixture.home, ".local", "bin", "copilot")
  );
  assert.equal(resolveCopilotBinary({ PATH: "" }, fixture.home), binary);
});

test("a missing Copilot CLI is reported as absent rather than guessed", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  assert.equal(findCopilotBinary({ PATH: "" }, fixture.home), null);
  assert.throws(
    () => resolveCopilotBinary({ PATH: "" }, fixture.home),
    /Copilot CLI not found/
  );
});

test("an explicit Codex CLI named as a command is resolved on PATH", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const directory = join(fixture.home, "bin");
  const binary = installExecutable(join(directory, "codex"));
  assert.equal(
    resolveCodexBinary({ CODEX_BIN: "codex", PATH: directory }, fixture.home),
    binary
  );
  assert.equal(
    findCodexBinary({ CODEX_BIN: "codex", PATH: directory }, fixture.home),
    binary
  );
});

test("a pnpm-global Codex CLI is found without a login-shell PATH", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const pnpmHome = join(fixture.home, "pnpm-home");
  const binary = installExecutable(join(pnpmHome, "bin", "codex"));
  assert.equal(
    resolveCodexBinary({ PATH: "", PNPM_HOME: pnpmHome }, fixture.home),
    binary
  );
  assert.equal(
    findCodexBinary({ PATH: "", PNPM_HOME: pnpmHome }, fixture.home),
    binary
  );
  assert.equal(
    findPnpmGlobalBinary("codex", fixture.home, { PNPM_HOME: pnpmHome }),
    binary
  );
});

test("a missing Codex CLI is reported as absent rather than guessed", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  assert.equal(findCodexBinary({ PATH: "" }, fixture.home), null);
  assert.throws(
    () => resolveCodexBinary({ PATH: "" }, fixture.home),
    /Codex CLI not found/
  );
});

test("the newest Codex CLI wins over a stale one on PATH", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const current = installCodex(
    join(fixture.home, ".local", "bin", "codex"),
    "0.154.0"
  );
  const staleDirectory = join(fixture.home, "usr-local-bin");
  installCodex(join(staleDirectory, "codex"), "0.42.0");
  assert.equal(
    resolveCodexBinary({ PATH: staleDirectory }, fixture.home),
    current,
    "a stale CLI on the default PATH must not shadow the current one"
  );
});

test("an explicit Codex CLI wins over the newest one installed", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  installCodex(join(fixture.home, ".local", "bin", "codex"), "0.154.0");
  const chosen = installCodex(join(fixture.home, "chosen", "codex"), "0.42.0");
  assert.equal(
    resolveCodexBinary({ CODEX_BIN: chosen, PATH: "" }, fixture.home),
    chosen,
    "an explicitly configured CLI is the operator's decision and wins"
  );
});

test("a Codex CLI that reports no version does not outrank one that does", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const versioned = installCodex(
    join(fixture.home, ".local", "bin", "codex"),
    "0.154.0"
  );
  const silentDirectory = join(fixture.home, "silent-bin");
  installCodex(join(silentDirectory, "codex"), null);
  assert.equal(
    resolveCodexBinary({ PATH: silentDirectory }, fixture.home),
    versioned,
    "a CLI that does not say which release it is cannot claim to be newer"
  );
});

test("the Codex CLI version is read from the binary itself", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const binary = installCodex(join(fixture.home, "codex"), "0.154.0");
  assert.equal(codexCliVersion(binary), "0.154.0");
  assert.equal(codexCliVersion(join(fixture.home, "missing")), null);
});

test("a CODEX_BIN that names nothing usable is reported as a misconfiguration", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const missing = join(fixture.home, "bin", "codex");
  assert.throws(
    () => findCodexBinary({ CODEX_BIN: missing, PATH: "" }, fixture.home),
    /Codex CLI is not executable/
  );
});

test("the MiniMax CLI is looked for in the environment it was handed", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  // A machine with no mcode CLI installed: an empty PATH and a home with
  // nothing in it. The lookup must answer about that machine, so it must not
  // fall back on the Node this process happens to run under.
  assert.equal(
    findMcodeBinary({ PATH: "", HOME: fixture.home }, fixture.home),
    null
  );
});

test("a MiniMax CLI is found in the home it was asked about", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const binary = installExecutable(
    join(fixture.home, ".local", "bin", "mcode")
  );
  assert.equal(
    findMcodeBinary({ PATH: "", HOME: fixture.home }, fixture.home),
    binary
  );
  const pnpmHome = join(fixture.home, "pnpm-home");
  const versionManaged = installExecutable(join(pnpmHome, "bin", "mcode"));
  assert.equal(
    findMcodeBinary({ PATH: "", PNPM_HOME: pnpmHome }, fixture.home),
    versionManaged
  );
});
