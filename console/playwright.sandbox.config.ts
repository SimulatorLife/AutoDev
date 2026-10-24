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
/**
 * A single-process browser, for a machine that cannot register the Mach port
 * rendezvous a multi-process browser needs.
 *
 * It is opt-in because a single-process browser is not stable across specs: it
 * dies between them, and the next spec then fails inside the harness with a
 * browser error rather than on a page. Measured here, the acceptance's first
 * width passed and the second failed in 48ms with "Target page, context or
 * browser has been closed".
 */
const singleProcess = process.env.AUTODEV_ACCEPTANCE_SINGLE_PROCESS === "1";
// One route at a time under a single-process browser, which cannot hold four
// pages at once: the second `newPage()` takes it down. The responsive-layout
// acceptance opens a batch of pages in parallel, so the batch is one page
// there. The multi-process browser holds the default batch of four.
if (singleProcess) {
  process.env.AUTODEV_ACCEPTANCE_ROUTES_PER_BATCH =
    process.env.AUTODEV_ACCEPTANCE_ROUTES_PER_BATCH ?? "1";
}

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
          args: singleProcess
            ? ["--single-process", "--no-sandbox"]
            : ["--no-sandbox"]
        }
      }
    }
  ],
  webServer: []
});
