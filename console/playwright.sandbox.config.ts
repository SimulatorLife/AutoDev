import { defineConfig, devices } from "@playwright/test";

/**
 * The sandbox configuration: the repository's own e2e configuration, pointed
 * at a Console that is already running.
 *
 * The repository's configuration builds and starts a Console of its own, which
 * is right for CI and wrong for a sandbox where a build takes minutes and the
 * Console is already up. Everything else -- the projects, the expectations,
 * the timeouts -- is the repository's, so a spec that passes here is a spec
 * that passes there.
 */
const consoleUrl = process.env.SANDBOX_CONSOLE_URL ?? "http://localhost:50100";
// The state proxy's port, so the state spec finds the proxy the running
// Console reads through.
process.env.AUTODEV_STATE_PROXY_PORT =
  process.env.AUTODEV_STATE_PROXY_PORT ?? "4371";
// The fixture's port, so the specs that reach the fixture's own control
// routes find it.
process.env.AUTODEV_PLAYTEST_FIXTURE_PORT =
  process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4368";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  expect: {
    timeout: 15_000
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: consoleUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: consoleUrl,
        launchOptions: {
          executablePath:
            process.env.SANDBOX_CHROMIUM_PATH ??
            "/Users/henrykirk/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
          args: ["--single-process", "--no-sandbox"]
        }
      }
    }
  ],
  webServer: []
});
