/**
 * Keeps every test run away from the maintainer's live `~/.codex`.
 *
 * The router and default workspace repositories persist state beneath
 * `$CODEX_HOME`, which defaults to `~/.codex` on an operator's machine. Tests
 * that use those default owners must not chmod or write the operator's live
 * workspace approvals, playtest targets, or router policy.
 *
 * Loaded with `--import` by every test script, before any test module, so
 * each test process gets a temporary Codex home and state files unless the test
 * explicitly supplies its own.
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

// The opencli browser setting lives beside the live router's state too: a
// test that switches the browser must not switch the maintainer's bridge.
if (process.env.OPENCLI_BROWSER_SETTING_FILE === undefined) {
  process.env.OPENCLI_BROWSER_SETTING_FILE = join(
    mkdtempSync(join(tmpdir(), "autodev-test-opencli-browser-")),
    "opencli-browser.json"
  );
}
