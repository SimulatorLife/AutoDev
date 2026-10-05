/**
 * Isolated `$CODEX_HOME` for router tests.
 *
 * The router reads Codex state from `$CODEX_HOME` when its modules load: the
 * ChatGPT credential (`auth.json`), the per-session concurrency cap
 * (`config.toml`), and workspace paths named in turn metadata, which only
 * count once they exist on disk. Import this module for its side effect
 * before any router module so those reads see this fixture rather than the
 * developer's own Codex installation, whatever the host.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const codexHome = mkdtempSync(join(tmpdir(), "autodev-router-codex-home-"));
process.on("exit", () => rmSync(codexHome, { recursive: true, force: true }));

writeFileSync(
  join(codexHome, "auth.json"),
  JSON.stringify({
    tokens: {
      access_token: "fixture-access-token",
      account_id: "fixture-account"
    }
  })
);
writeFileSync(
  join(codexHome, "config.toml"),
  "[agents]\nmax_concurrent_threads_per_session = 2\n"
);

/** A workspace directory whose label is `AutoDev`. */
export const FIXTURE_AUTODEV_WORKSPACE = join(
  codexHome,
  "workspaces",
  "AutoDev"
);
mkdirSync(FIXTURE_AUTODEV_WORKSPACE, { recursive: true });

process.env.CODEX_HOME = codexHome;
delete process.env.CODEX_ROUTER_AUTH_FILE;
delete process.env.CODEX_ROUTER_CODEX_CONFIG_FILE;
