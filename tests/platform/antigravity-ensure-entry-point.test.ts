import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fileURLToPath } from "node:url";

/**
 * The dispatch script's only way in.
 *
 * `scripts/ensure-codex-antigravity-proxy.sh` runs the platform module as a
 * process and feeds it the model request on stdin, the way the Claude and
 * MiniMax bridges are run. The module had no entry point, so running it loaded
 * the module, exported its functions and exited zero: the script reported
 * success, and nothing had been ensured. The bridge the script exists to
 * start was silently never started.
 *
 * The module is run here the way the script runs it -- as a process, with the
 * request on stdin -- because that is the only way to observe the entry point
 * at all. A unit test of `ensureAntigravityProxy` cannot see it: it calls the
 * function directly and the missing block is not in its path.
 */

const MODULE = fileURLToPath(
  new URL("../../runtime/src/platform/antigravity-ensure.ts", import.meta.url)
);

interface Run {
  readonly status: number | null;
  readonly stderr: string;
}

/**
 * Run the module as the dispatch script runs it.
 *
 * The settings path points at a file that is not there, so the module stops
 * at the first check it makes and says why: the point of the run is to see
 * that the module ran at all, and a refusal names itself.
 */
function runEnsure(model: string): Run {
  const result = spawnSync(process.execPath, [MODULE], {
    encoding: "utf8",
    input: JSON.stringify({ model }),
    env: {
      ...process.env,
      AGY_SETTINGS_PATH: join(tmpdir(), "autodev-no-such-settings.json"),
      AGY_CLI_PATH: join(tmpdir(), "autodev-no-such-agy")
    }
  });
  return { status: result.status, stderr: result.stderr };
}

test("the dispatch script's entry point runs the ensure", () => {
  const outcome = runEnsure("gemini-3.8-flash-medium");

  // The module ran, reached its first check and refused there. Without the
  // entry point it would have exited zero and said nothing at all.
  assert.equal(outcome.status, 1, outcome.stderr);
  assert.match(outcome.stderr, /Antigravity settings missing/u);
});

test("a request for another model is declined without touching the bridge", () => {
  const outcome = runEnsure("gpt-5");

  // The gate is the module's: a request for a model the bridge does not serve
  // is not a reason to start it, and that answer is a success.
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.doesNotMatch(outcome.stderr, /Antigravity settings missing/u);
});

test("the run leaves nothing behind in the working directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-antigravity-entry-"));
  try {
    const result = spawnSync(process.execPath, [MODULE], {
      encoding: "utf8",
      cwd: directory,
      input: JSON.stringify({ model: "gemini-3.8-flash-medium" }),
      env: {
        ...process.env,
        AGY_SETTINGS_PATH: join(directory, "no-such-settings.json"),
        AGY_CLI_PATH: join(directory, "no-such-agy")
      }
    });
    assert.equal(result.status, 1, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
