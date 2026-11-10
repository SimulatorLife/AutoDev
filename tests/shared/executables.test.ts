import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findCodexBinary,
  findCopilotBinary,
  findMiniMaxBinary,
  findNvmBinary,
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

test("a version-managed Copilot CLI is found when PATH carries no nvm", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const older = installExecutable(
    join(fixture.home, ".nvm", "versions", "node", "v24.11.0", "bin", "copilot")
  );
  const newer = installExecutable(
    join(fixture.home, ".nvm", "versions", "node", "v25.0.0", "bin", "copilot")
  );
  // The launchd PATH the bridge runs with: no version manager's bin
  // directory, so a PATH lookup alone finds nothing to spawn.
  assert.equal(
    resolveCopilotBinary(
      { PATH: join(fixture.home, "empty") },
      fixture.home
    ),
    newer
  );
  assert.notEqual(newer, older);
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
    resolveCodexBinary(
      { CODEX_BIN: "codex", PATH: directory },
      fixture.home
    ),
    binary
  );
  assert.equal(
    findCodexBinary(
      { CODEX_BIN: "codex", PATH: directory },
      fixture.home
    ),
    binary
  );
});

test("a version-managed Codex CLI is found when PATH carries no nvm", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const older = installExecutable(
    join(fixture.home, ".nvm", "versions", "node", "v24.11.0", "bin", "codex")
  );
  const newer = installExecutable(
    join(fixture.home, ".nvm", "versions", "node", "v25.0.0", "bin", "codex")
  );
  assert.equal(
    resolveCodexBinary(
      { PATH: join(fixture.home, "empty") },
      fixture.home
    ),
    newer
  );
  assert.equal(
    findCodexBinary(
      { PATH: join(fixture.home, "empty") },
      fixture.home
    ),
    newer
  );
  assert.equal(findNvmBinary("codex", fixture.home), newer);
  assert.notEqual(newer, older);
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

test("the MiniMax CLI is looked for in the environment it was handed", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  // A machine with no MiniMax CLI installed: an empty PATH and a home with
  // nothing in it. The lookup must answer about that machine, so it must not
  // fall back on the Node this process happens to run under.
  assert.equal(findMiniMaxBinary({ PATH: "", HOME: fixture.home }, fixture.home), null);
});

test("a MiniMax CLI is found in the home it was asked about", (t) => {
  const fixture = homeFixture();
  t.after(fixture.cleanup);
  const binary = installExecutable(join(fixture.home, ".local", "bin", "mmx"));
  assert.equal(
    findMiniMaxBinary({ PATH: "", HOME: fixture.home }, fixture.home),
    binary
  );
  const versionManaged = installExecutable(
    join(fixture.home, ".nvm", "versions", "node", "v25.0.0", "bin", "mmx")
  );
  assert.equal(
    findMiniMaxBinary({ PATH: join(fixture.home, "empty") }, fixture.home),
    versionManaged
  );
});
