/**
 * Keeps every test run away from the maintainer's live AutoDev/provider state under `$CODEX_HOME`.
 *
 * The router, opencli, and default workspace repositories persist state beneath
 * `$CODEX_HOME`, which defaults to `~/.codex` on an operator's machine. Tests
 * that use those default owners must not chmod or write the operator's live
 * workspace approvals, playtest targets, or router policy.
 *
 * Loaded with `--import` by every test script, before any test module, so
 * each test process gets an isolated AutoDev state home and router state file
 * unless the test explicitly supplies its own.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.CODEX_HOME?.trim()) {
  process.env.CODEX_HOME = realpathSync(
    mkdtempSync(join(tmpdir(), "autodev-test-codex-home-"))
  );
}

if (process.env.CODEX_ROUTER_STATE_FILE === undefined) {
  process.env.CODEX_ROUTER_STATE_FILE = join(
    mkdtempSync(join(tmpdir(), "autodev-test-router-state-")),
    "codex-router-state.json"
  );
}

// The live router's bearer token, exported by an operator's shell profile so
// the installed router and bridges share it. A test process that inherits it
// turns on request authentication for every router handler it imports, so
// a request the test builds without credentials is refused with 401. Tests
// that exercise authentication set their own token.
delete process.env.CODEX_ROUTER_AUTH_TOKEN;

// Keep unit tests isolated from the operator's live macOS Keychain items;
// tests that exercise Keychain integration explicitly opt back in.
if (process.env.AUTODEV_DISABLE_KEYCHAIN === undefined) {
  process.env.AUTODEV_DISABLE_KEYCHAIN = "1";
}
