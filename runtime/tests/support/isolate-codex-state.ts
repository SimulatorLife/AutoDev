/**
 * Keeps every test run away from the maintainer's live `~/.codex`.
 *
 * The router persists its routing policy -- every provider's role
 * assignments, disabled providers, model disables and limits -- to
 * `$CODEX_HOME/codex-router-state.json`, and `CODEX_HOME` defaults to
 * `~/.codex`, where the installed router keeps the same file. A test that
 * persisted without setting its own state file therefore overwrote the live
 * router's policy: 91 empty 94-byte snapshots from test processes were found
 * beside it, and a router that restarted before saving again came back with
 * every role at its default.
 *
 * Loaded with `--import` by every test script, before any test module, so
 * each test process gets its own state file unless the test sets one.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
