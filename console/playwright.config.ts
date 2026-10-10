import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const fallback = "/Users/henrykirk/Library/Caches/ms-playwright";
  if (existsSync(fallback)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = fallback;
  }
}

const fixturePort = 4311;
const consolePort = 3377;
const serviceToken =
  "playtesting-browser-fixture-token-0000000000000000000000000000000000000000000000000000000000000000";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  expect: {
    timeout: 10_000
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${consolePort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command: `AUTODEV_PLAYTEST_FIXTURE_PORT=${fixturePort} node e2e/playtesting-control-api-fixture.ts`,
      url: `http://127.0.0.1:${fixturePort}/health`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: `AUTODEV_CONSOLE_PORT=${consolePort} AUTODEV_CONTROL_API_BASE_URL=http://127.0.0.1:${fixturePort} AUTODEV_CONTROL_API_TOKEN=${serviceToken} AUTODEV_CONTROL_VIEWERS=autodev-local pnpm start`,
      url: `http://localhost:${consolePort}/playtesting`,
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
