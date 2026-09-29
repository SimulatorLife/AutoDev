import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { handle } from "../../src/router/server.ts";

type DashboardReloadHarness = {
  interval(): Promise<void>;
  nextTimeout(): Promise<void>;
  setVersion(version: string | null): void;
  setFetchFailure(fail: boolean): void;
  reloadCount(): number;
  pendingTimeouts(): number;
};

function dashboardReloadHarness(
  html: string,
  initialVersion: string
): DashboardReloadHarness {
  const script = html.match(
    /<script data-autodev-live-reload>([\s\S]*?)<\/script>/
  )?.[1];
  assert.ok(script, "source-mode dashboard must contain its reload checker");

  let version: string | null = initialVersion;
  let fetchFails = false;
  let reloads = 0;
  let intervalCallback: (() => Promise<void>) | null = null;
  const timeouts: Array<() => Promise<void>> = [];
  const context = vm.createContext({
    fetch: async (url: string) => {
      assert.equal(url, "/dashboard/version");
      if (fetchFails) throw new Error("simulated network error");
      return { ok: true, json: async () => ({ version }) };
    },
    setInterval: (callback: unknown, intervalMs: number) => {
      assert.equal(intervalMs, 1000);
      intervalCallback = callback as () => Promise<void>;
    },
    setTimeout: (callback: unknown, delayMs: number) => {
      assert.equal(delayMs, 250);
      timeouts.push(callback as () => Promise<void>);
    },
    window: {
      location: {
        reload: () => {
          reloads += 1;
        }
      }
    }
  });
  vm.runInContext(script, context);

  assert.ok(intervalCallback, "reload checker must poll dashboard version");
  return {
    interval: () => intervalCallback!(),
    nextTimeout: async () => {
      const callback = timeouts.shift();
      assert.ok(callback, "expected a queued stability check");
      await callback();
    },
    setVersion: (next) => {
      version = next;
    },
    setFetchFailure: (fail) => {
      fetchFails = fail;
    },
    reloadCount: () => reloads,
    pendingTimeouts: () => timeouts.length
  };
}

function createDashboardServer(): Server {
  return createServer((request, response) => {
    void handle(request, response);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function assertNoPathLeak(value: unknown, path: string): void {
  assert.equal(JSON.stringify(value).includes(path), false);
}

test("default dashboard mode serves the installed file without reload polling", async () => {
  const previousSource = process.env.AUTODEV_DASHBOARD_SOURCE;
  delete process.env.AUTODEV_DASHBOARD_SOURCE;
  const server = createDashboardServer();

  try {
    const port = await listen(server);
    const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get("cache-control"), "no-store");
    const html = await dashboard.text();
    assert.match(html, /Codex model router/);
    assert.doesNotMatch(html, /data-autodev-live-reload/);
    assert.doesNotMatch(html, /autodev-dashboard-version/);

    const version = await fetch(`http://127.0.0.1:${port}/dashboard/version`);
    assert.equal(version.status, 404);
  } finally {
    if (previousSource === undefined)
      delete process.env.AUTODEV_DASHBOARD_SOURCE;
    else process.env.AUTODEV_DASHBOARD_SOURCE = previousSource;
    await close(server);
  }
});

test("source mode serves the configured file and returns its changing hash without exposing its path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-dashboard-test-"));
  const source = join(directory, "dashboard.html");
  const previousSource = process.env.AUTODEV_DASHBOARD_SOURCE;
  const server = createDashboardServer();

  try {
    const firstHtml =
      "<!doctype html><html><head></head><body>first</body></html>";
    await writeFile(source, firstHtml, "utf8");
    process.env.AUTODEV_DASHBOARD_SOURCE = source;
    const port = await listen(server);

    const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`);
    const dashboardHtml = await dashboard.text();
    const firstVersion = createHash("sha256").update(firstHtml).digest("hex");
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get("cache-control"), "no-store");
    assert.match(dashboardHtml, /<body>first/);
    assert.match(dashboardHtml, new RegExp(`content="${firstVersion}"`));
    assert.match(dashboardHtml, /data-autodev-live-reload/);
    assertNoPathLeak(dashboardHtml, source);

    const versionResponse = await fetch(
      `http://127.0.0.1:${port}/dashboard/version`
    );
    assert.equal(versionResponse.status, 200);
    assert.equal(versionResponse.headers.get("cache-control"), "no-store");
    const versionJson = await versionResponse.json();
    assert.deepEqual(versionJson, { version: firstVersion });
    assertNoPathLeak(versionJson, source);

    const updatedHtml =
      "<!doctype html><html><head></head><body>updated</body></html>";
    await writeFile(source, updatedHtml, "utf8");
    const secondVersion = createHash("sha256")
      .update(updatedHtml)
      .digest("hex");
    assert.notEqual(secondVersion, firstVersion);
    const updatedResponse = await fetch(
      `http://127.0.0.1:${port}/dashboard/version`
    );
    assert.deepEqual(await updatedResponse.json(), { version: secondVersion });
    const updatedDashboard = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.match(await updatedDashboard.text(), /<body>updated/);
  } finally {
    if (previousSource === undefined)
      delete process.env.AUTODEV_DASHBOARD_SOURCE;
    else process.env.AUTODEV_DASHBOARD_SOURCE = previousSource;
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid dashboard source paths fail visibly without changing /status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-dashboard-test-"));
  const previousSource = process.env.AUTODEV_DASHBOARD_SOURCE;
  const server = createDashboardServer();

  try {
    const port = await listen(server);
    for (const [source, expectedCode] of [
      ["relative/dashboard.html", "router_dashboard_source_invalid"],
      [join(directory, "missing.html"), "router_dashboard_source_unreadable"]
    ] as const) {
      process.env.AUTODEV_DASHBOARD_SOURCE = source;
      for (const route of ["/dashboard", "/dashboard/version"]) {
        const response = await fetch(`http://127.0.0.1:${port}${route}`);
        assert.equal(response.status, 500);
        const payload = await response.json();
        assert.equal(payload.error?.code, expectedCode);
        assertNoPathLeak(payload, source);
      }
    }

    const status = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(status.status, 200);
    assert.match(status.headers.get("content-type")!, /application\/json/);
    assert.equal((await status.json()).schema, "autodev-router-status-v2");
  } finally {
    if (previousSource === undefined)
      delete process.env.AUTODEV_DASHBOARD_SOURCE;
    else process.env.AUTODEV_DASHBOARD_SOURCE = previousSource;
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard reload script ignores unchanged versions and reloads once after a stable change", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "autodev-dashboard-reload-test-")
  );
  const source = join(directory, "dashboard.html");
  const previousSource = process.env.AUTODEV_DASHBOARD_SOURCE;
  const initialHtml =
    "<!doctype html><html><head></head><body>initial</body></html>";
  const initialVersion = createHash("sha256").update(initialHtml).digest("hex");
  const server = createDashboardServer();
  let servedHtml: string;

  try {
    await writeFile(source, initialHtml, "utf8");
    process.env.AUTODEV_DASHBOARD_SOURCE = source;
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(response.status, 200);
    servedHtml = await response.text();
  } finally {
    if (previousSource === undefined)
      delete process.env.AUTODEV_DASHBOARD_SOURCE;
    else process.env.AUTODEV_DASHBOARD_SOURCE = previousSource;
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }

  const harness = dashboardReloadHarness(servedHtml, initialVersion);
  await harness.interval();
  await harness.interval();
  assert.equal(harness.reloadCount(), 0);

  harness.setFetchFailure(true);
  await harness.interval();
  harness.setFetchFailure(false);
  assert.equal(harness.reloadCount(), 0);

  // A partially written file that keeps changing is not considered stable.
  harness.setVersion("partial-v1");
  await harness.interval();
  harness.setVersion("partial-v2");
  await harness.nextTimeout();
  assert.equal(harness.reloadCount(), 0);

  // The final version is confirmed by a second poll before one page reload.
  harness.setVersion("stable-v3");
  await harness.nextTimeout();
  assert.equal(harness.reloadCount(), 0);
  await harness.nextTimeout();
  assert.equal(harness.reloadCount(), 1);
  await harness.interval();
  assert.equal(harness.reloadCount(), 1);
});
