import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

import { defineConfig, devices } from "@playwright/test";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const fallback = "/Users/henrykirk/Library/Caches/ms-playwright";
  if (existsSync(fallback)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = fallback;
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Playwright could not reserve an available local port.");
  }
  const port = address.port;
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
}

function configuredPort(
  value: string | undefined,
  name: string
): number | null {
  if (value === undefined) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be between 1 and 65535.`);
  }
  return port;
}

const fixturePort =
  configuredPort(
    process.env.AUTODEV_PLAYTEST_FIXTURE_PORT,
    "AUTODEV_PLAYTEST_FIXTURE_PORT"
  ) ?? (await availablePort());
const consolePort =
  configuredPort(process.env.AUTODEV_CONSOLE_PORT, "AUTODEV_CONSOLE_PORT") ??
  (await availablePort());
const usageFixturePort =
  configuredPort(
    process.env.AUTODEV_OPENLIT_USAGE_FIXTURE_PORT,
    "AUTODEV_OPENLIT_USAGE_FIXTURE_PORT"
  ) ?? (await availablePort());
const stateProxyPort =
  configuredPort(
    process.env.AUTODEV_STATE_PROXY_PORT,
    "AUTODEV_STATE_PROXY_PORT"
  ) ?? (await availablePort());
process.env.AUTODEV_PLAYTEST_FIXTURE_PORT = String(fixturePort);
process.env.AUTODEV_CONSOLE_PORT = String(consolePort);
process.env.AUTODEV_OPENLIT_USAGE_FIXTURE_PORT = String(usageFixturePort);
process.env.AUTODEV_STATE_PROXY_PORT = String(stateProxyPort);
const e2eDistDir = `.next-staging-e2e-${process.pid}-${consolePort}`;
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
      command: `AUTODEV_OPENLIT_USAGE_FIXTURE_PORT=${usageFixturePort} node e2e/openlit-usage-fixture.ts`,
      url: `http://127.0.0.1:${usageFixturePort}/health`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      // The Console reads the Control API through the state proxy, so a spec
      // can put the service into a state it cannot be in otherwise -- down,
      // refusing, failing -- and measure what the Console says about it.
      command: `AUTODEV_STATE_PROXY_PORT=${stateProxyPort} AUTODEV_STATE_PROXY_UPSTREAM=http://127.0.0.1:${fixturePort} node e2e/control-api-state-proxy.ts`,
      url: `http://127.0.0.1:${stateProxyPort}/__state`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: `AUTODEV_CONSOLE_BUILD_DIST_DIR=${e2eDistDir} pnpm build && AUTODEV_CONSOLE_SERVE_DIST_DIR=${e2eDistDir} AUTODEV_CONSOLE_PORT=${consolePort} AUTODEV_CONTROL_API_BASE_URL=http://127.0.0.1:${stateProxyPort} AUTODEV_CONTROL_API_TOKEN=${serviceToken} AUTODEV_OPENLIT_USAGE_URL=http://127.0.0.1:${usageFixturePort} AUTODEV_OPENLIT_USAGE_TOKEN=${serviceToken} AUTODEV_CONTROL_VIEWERS= AUTODEV_CONTROL_OPERATORS=autodev-local pnpm start`,
      // The readiness check waits on a Console-owned route. Waiting on the
      // Playtesting surface instead would make the whole acceptance depend on
      // a page this work does not own: a surface that is being changed
      // elsewhere would fail every spec here, not only its own.
      url: `http://localhost:${consolePort}/providers`,
      reuseExistingServer: false,
      // The acceptance measures a production build, and a production build
      // takes minutes rather than seconds. A timeout that is shorter than the
      // build would fail the acceptance for the length of the build.
      timeout: 600_000
    }
  ]
});
