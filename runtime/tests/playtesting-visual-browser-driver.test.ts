import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspaceVisualPlaytestTargetApproval } from "@simulatorlife/autodev-core";
import { type Browser,chromium } from "playwright-core";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  isPlaytestVisualBrowserDriverAvailable,
  PlaytestVisualBrowserDriver,
  PlaytestVisualBrowserDriverError,
  type PlaytestVisualBrowserDriverOptions,
  resetPlaytestVisualBrowserDriverAvailabilityCache} from "../src/playtesting/visual-browser-driver.ts";

const WORKSPACE = "fixture/visual-game";
const EPISODE_ID = "visual-episode-1";

interface RunningServer {
  readonly server: Server;
  readonly origin: string;
  close(): Promise<void>;
}

/** Wait for a condition the page reports, without assuming how long it takes. */
async function waitFor(
  ready: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

async function listen(
  handler: (
    requestPath: string,
    requestCount: number,
    cookieHeader: string
  ) => string
): Promise<RunningServer> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    const body = handler(
      request.url ?? "/",
      requestCount,
      String(request.headers.cookie ?? "")
    );
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function target(origin: string): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE,
    targetId: "visual-target-1",
    revision: 1,
    approvalId: "visual-approval-1",
    name: "Local visual game",
    entryUrl: origin + "/",
    allowedOrigins: [origin],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "pausable",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 8,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 8,
      smartTokensPerEpisode: 10_000,
      screenshotCountPerEpisode: 8,
      artifactBytesPerEpisode: 16 * 1024 * 1024
    },
    approvedAt: "2026-10-16T12:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
}

function artifacts(): {
  readonly store: PlaytestArtifactStore;
  readonly root: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "visual-playtest-artifacts-"));
  return {
    root,
    store: new PlaytestArtifactStore({
      workspaceId: WORKSPACE,
      rootDirectory: root
    })
  };
}

async function openDriver(input: {
  readonly source: RunningServer;
  readonly store: PlaytestArtifactStore;
  readonly browserType?: PlaytestVisualBrowserDriverOptions["browserType"];
  readonly now?: () => number;
  readonly wallTimeMs?: number;
  readonly actionTimeoutMs?: number;
}): Promise<PlaytestVisualBrowserDriver> {
  const approval = target(input.source.origin);
  return PlaytestVisualBrowserDriver.open({
    target:
      input.wallTimeMs === undefined
        ? approval
        : {
            ...approval,
            limits: { ...approval.limits, wallTimeMs: input.wallTimeMs }
          },
    episodeId: EPISODE_ID,
    artifacts: input.store,
    viewport: { width: 640, height: 480, deviceScaleFactor: 1 },
    actionTimeoutMs: input.actionTimeoutMs ?? 3000,
    maxSteps: 8,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.browserType === undefined
      ? {}
      : { browserType: input.browserType })
  });
}

test("visual browser uses transient context, redacts text fields, stores real frames, and dispatches semantic input", async () => {
  const source = await listen(
    () => `<!doctype html><html><body>
    <button id="start" onclick="this.textContent='Started'">Start race</button>
    <label for="player">Player name</label><input id="player" value="private-player-name">
  </body></html>`
  );
  const { store, root } = artifacts();
  let driver: PlaytestVisualBrowserDriver | null = null;
  let browserEnvironment: NodeJS.ProcessEnv | undefined;
  const browserType = {
    executablePath: () => chromium.executablePath(),
    launch: (launchOptions) => {
      browserEnvironment = launchOptions?.env;
      return chromium.launch(launchOptions);
    }
  } satisfies NonNullable<PlaytestVisualBrowserDriverOptions["browserType"]>;
  try {
    driver = await openDriver({ source, store, browserType });
    assert.ok(browserEnvironment?.HOME);
    assert.notEqual(browserEnvironment.HOME, process.env.HOME);
    assert.equal(browserEnvironment.AUTODEV_CONTROL_API_TOKEN, undefined);
    const captured = await driver.observe();
    assert.equal(captured.status, "observed");
    if (captured.status !== "observed") return;
    assert.equal(captured.observation.privacyState, "redacted");
    assert.ok(captured.observation.frame.bytes > 0);
    assert.equal(
      JSON.stringify(captured.observation).includes("private-player-name"),
      false
    );
    const start = captured.observation.controls.find(
      (control) => control.name === "Start race"
    );
    assert.ok(start);
    const receipt = await driver.act({
      schema: "autodev-playtest-visual-action-v1",
      workspaceId: WORKSPACE,
      targetId: "visual-target-1",
      episodeId: EPISODE_ID,
      observationId: captured.observation.observationId,
      kind: "activate-control",
      controlId: start.controlId
    });
    assert.equal(receipt.status, "dispatched");
    assert.equal(receipt.gameAcknowledgement, "not-observed");
    assert.deepEqual(driver.telemetry(), {
      schema: "autodev-playtest-visual-telemetry-v1",
      version: 1,
      inputAttempts: 1,
      inputValidated: 1,
      inputDispatched: 1,
      inputAcknowledged: 0,
      inputRejected: 0,
      driverToolCalls: { observe: 1, act: 1 },
      captureCount: 1,
      capturedBytes: captured.observation.frame.bytes,
      blockedRequestCount: 0,
      coverage: "complete"
    });
    const closed = await driver.close();
    assert.ok(closed.events);
    assert.equal(closed.eventMissingReason, null);
    assert.equal(closed.browserProfileCleanup, "removed");
    assert.ok(browserEnvironment?.HOME);
    assert.equal(existsSync(browserEnvironment.HOME), false);
    assert.equal(
      store.referenceForId(captured.observation.frame.artifactId)?.sha256,
      captured.observation.frame.sha256
    );
  } finally {
    await driver?.close();
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first frame waits for the game to paint", async () => {
  // A game that draws into a canvas has no DOM to read: the observation is
  // the frame. Capturing it before the scene is painted reports a blank
  // screen, whatever the player actually sees.
  const source = await listen(
    () => `<!doctype html><html><body style="margin:0">
    <canvas id="game" width="320" height="200"></canvas>
    <script>
      setTimeout(() => {
        const ctx = document.getElementById("game").getContext("2d");
        ctx.fillStyle = "#101820";
        ctx.fillRect(0, 0, 320, 200);
        ctx.fillStyle = "#ff5a36";
        for (let x = 0; x < 320; x += 16) ctx.fillRect(x, 0, 8, 200);
        const button = document.createElement("button");
        button.textContent = "Race ready";
        button.style.position = "fixed";
        button.style.left = "10px";
        button.style.top = "10px";
        document.body.appendChild(button);
      }, 800);
    </script>
  </body></html>`
  );
  const { store, root } = artifacts();
  let driver: PlaytestVisualBrowserDriver | null = null;
  try {
    driver = await openDriver({ source, store });
    const captured = await driver.observe();
    assert.equal(captured.status, "observed");
    if (captured.status !== "observed") return;
    assert.ok(
      captured.observation.controls.some(
        (control) => control.name === "Race ready"
      ),
      "the observation was taken after the game painted"
    );
    assert.ok(captured.observation.frame.bytes > 0);
  } finally {
    await driver?.close();
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first frame waits for a game whose canvas appears after the document loads", async () => {
  // A game creates its canvas once it has booted, so at first the document
  // has no canvas at all and nothing the player can see. Treating that as
  // "the page has nothing to wait for" captures the empty screen.
  const source = await listen(
    () => `<!doctype html><html><body style="margin:0">
    <button id="loading" style="visibility:hidden">Loading</button>
    <script>
      setTimeout(() => {
        document.getElementById("loading").style.visibility = "visible";
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 200;
        canvas.style.position = "fixed";
        canvas.style.left = "0";
        canvas.style.top = "0";
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#101820";
        ctx.fillRect(0, 0, 320, 200);
        ctx.fillStyle = "#ff5a36";
        ctx.fillRect(0, 0, 320, 120);
        document.body.appendChild(canvas);
      }, 800);
    </script>
  </body></html>`
  );
  const { store, root } = artifacts();
  let driver: PlaytestVisualBrowserDriver | null = null;
  try {
    driver = await openDriver({ source, store });
    const captured = await driver.observe();
    assert.equal(captured.status, "observed");
    if (captured.status !== "observed") return;
    assert.ok(
      captured.observation.controls.some(
        (control) => control.name === "Loading"
      ),
      "the observation was taken after the game showed itself"
    );
  } finally {
    await driver?.close();
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual browser blocks cross-origin requests before they reach another host", async () => {
  let offOriginRequests = 0;
  const external = await listen(() => {
    offOriginRequests += 1;
    return "<!doctype html><title>external</title>";
  });
  const source = await listen(
    () => `<!doctype html><html><body>
    <button id="probe" onclick="fetch('${external.origin}/private')">Probe</button>
    <script>fetch('${external.origin}/leak').catch(()=>{});</script>
  </body></html>`
  );
  const { store, root } = artifacts();
  let driver: PlaytestVisualBrowserDriver | null = null;
  try {
    driver = await openDriver({ source, store });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(driver.telemetry().blockedRequestCount, 1);
    assert.equal(offOriginRequests, 0);
  } finally {
    await driver?.close();
    await source.close();
    await external.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual browser refuses a game action that attempts unapproved navigation", async () => {
  let externalRequests = 0;
  const external = await listen(() => {
    externalRequests += 1;
    return "<!doctype html><title>unapproved</title>";
  });
  const source = await listen(
    () => `<!doctype html><html><body>
    <a href="${external.origin}/leave">Leave the game</a>
  </body></html>`
  );
  const { store, root } = artifacts();
  let driver: PlaytestVisualBrowserDriver | null = null;
  try {
    driver = await openDriver({ source, store });
    const captured = await driver.observe();
    assert.equal(
      captured.status,
      "observed",
      captured.status === "blocked" ? `blocked: ${captured.reason}` : undefined
    );
    if (captured.status !== "observed") return;
    const link = captured.observation.controls.find(
      (control) => control.name === "Leave the game"
    );
    assert.ok(link);
    const receipt = await driver.act({
      schema: "autodev-playtest-visual-action-v1",
      workspaceId: WORKSPACE,
      targetId: "visual-target-1",
      episodeId: EPISODE_ID,
      observationId: captured.observation.observationId,
      kind: "activate-control",
      controlId: link.controlId
    });
    assert.deepEqual(receipt, {
      status: "refused",
      step: 0,
      reason: "origin-not-approved"
    });
    assert.equal(externalRequests, 0);
    assert.equal(driver.telemetry().coverage, "partial");
  } finally {
    await driver?.close();
    await source.close();
    await external.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh visual session does not inherit cookies from a prior browser context", async () => {
  const requestCookies: string[] = [];
  const source = await listen((_path, _count, cookies) => {
    requestCookies.push(cookies);
    return `<!doctype html><html><body>
      <script>document.cookie='game-session=transient; path=/';</script>
      <button>Continue</button>
    </body></html>`;
  });
  const { store, root } = artifacts();
  let first: PlaytestVisualBrowserDriver | null = null;
  let second: PlaytestVisualBrowserDriver | null = null;
  try {
    first = await openDriver({ source, store });
    await first.close();
    second = await openDriver({ source, store });
    assert.deepEqual(requestCookies, ["", ""]);
  } finally {
    await first?.close();
    await second?.close();
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual browser refuses a visible password gate before capturing a frame", async () => {
  const source = await listen(
    () => `<!doctype html><html><body>
    <label for="password">Password</label><input id="password" type="password">
  </body></html>`
  );
  const { store, root } = artifacts();
  let driver: PlaytestVisualBrowserDriver | null = null;
  try {
    driver = await openDriver({ source, store });
    assert.deepEqual(await driver.observe(), {
      status: "blocked",
      reason: "auth-or-setup-required"
    });
    assert.equal(driver.telemetry().captureCount, 0);
  } finally {
    await driver?.close();
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual browser stops before further input when a password gate appears mid-session", async () => {
  const source = await listen(
    () => `<!doctype html><html><body>
    <button id="continue" onclick="document.body.insertAdjacentHTML('beforeend','<input type=password>')">Continue</button>
  </body></html>`
  );
  const { store, root } = artifacts();
  let driver: PlaytestVisualBrowserDriver | null = null;
  try {
    driver = await openDriver({ source, store });
    const captured = await driver.observe();
    assert.equal(
      captured.status,
      "observed",
      captured.status === "blocked" ? `blocked: ${captured.reason}` : undefined
    );
    if (captured.status !== "observed") return;
    const continueControl = captured.observation.controls.find(
      (control) => control.name === "Continue"
    );
    assert.ok(continueControl);
    const opening = await driver.act({
      schema: "autodev-playtest-visual-action-v1",
      workspaceId: WORKSPACE,
      targetId: "visual-target-1",
      episodeId: EPISODE_ID,
      observationId: captured.observation.observationId,
      kind: "activate-control",
      controlId: continueControl.controlId
    });
    assert.equal(opening.status, "dispatched");
    const nextInput = await driver.act({
      schema: "autodev-playtest-visual-action-v1",
      workspaceId: WORKSPACE,
      targetId: "visual-target-1",
      episodeId: EPISODE_ID,
      observationId: captured.observation.observationId,
      kind: "key-press",
      key: "Enter"
    });
    assert.deepEqual(nextInput, {
      status: "refused",
      step: 1,
      reason: "auth-or-setup-required"
    });
  } finally {
    await driver?.close();
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual browser refuses coordinate input when the captured canvas frame changes", async () => {
  // The frame has to change after the observation and before the action.
  // The test asks the page to change and waits for the page to say it did,
  // so the refusal is never a race against a loaded machine.
  let repaintRequested = false;
  let repaintsAcknowledged = 0;
  const source = await listen((requestPath) => {
    if (requestPath === "/phase") {
      if (!repaintRequested) return "hold";
      repaintsAcknowledged += 1;
      return "repaint";
    }
    if (requestPath === "/painted") {
      repaintsAcknowledged += 1;
      return "painted";
    }
    return `<!doctype html><html><body>
    <canvas id="game" width="100" height="100"></canvas>
    <script>
      const context=document.getElementById('game').getContext('2d');
      context.fillStyle='red'; context.fillRect(0,0,30,30);
      const poll = () => {
        fetch('/phase').then((response) => response.text()).then((answer) => {
          if (answer === 'repaint') {
            context.fillStyle='blue'; context.fillRect(0,0,30,30);
            fetch('/painted');
            return;
          }
          setTimeout(poll, 25);
        });
      };
      setTimeout(poll, 0);
    </script>
  </body></html>`;
  });
  const { store, root } = artifacts();
  let driver: PlaytestVisualBrowserDriver | null = null;
  try {
    driver = await openDriver({ source, store });
    const captured = await driver.observe();
    assert.equal(captured.status, "observed");
    if (captured.status !== "observed") return;
    repaintRequested = true;
    assert.ok(
      await waitFor(() => repaintsAcknowledged >= 2, 10_000),
      "the page was asked to repaint and said it had"
    );
    const receipt = await driver.act({
      schema: "autodev-playtest-visual-action-v1",
      workspaceId: WORKSPACE,
      targetId: "visual-target-1",
      episodeId: EPISODE_ID,
      observationId: captured.observation.observationId,
      kind: "pointer-click",
      frameArtifactId: captured.observation.frame.artifactId,
      x: 50,
      y: 50
    });
    assert.deepEqual(receipt, {
      status: "refused",
      step: 0,
      reason: "stale-observation"
    });
  } finally {
    await driver?.close();
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a decision that arrives late in the episode is still acted on", async () => {
  // A model that needs most of the approved budget to answer is still
  // answering inside the budget the operator approved. The observation it
  // answers is the latest one, and the page is read again before the input
  // goes out, so the action is not a guess about a screen that is gone.
  const source = await listen(
    () => `<!doctype html><html><body>
    <button id="start" onclick="this.textContent='Started'">Start race</button>
  </body></html>`
  );
  const { store, root } = artifacts();
  let driver: PlaytestVisualBrowserDriver | null = null;
  let clock = Date.now();
  try {
    driver = await openDriver({ source, store, now: () => clock });
    const captured = await driver.observe();
    assert.equal(captured.status, "observed");
    if (captured.status !== "observed") return;
    const start = captured.observation.controls.find(
      (control) => control.name === "Start race"
    );
    assert.ok(start);
    clock += 30_000;
    const receipt = await driver.act({
      schema: "autodev-playtest-visual-action-v1",
      workspaceId: WORKSPACE,
      targetId: "visual-target-1",
      episodeId: EPISODE_ID,
      observationId: captured.observation.observationId,
      kind: "activate-control",
      controlId: start.controlId
    });
    assert.equal(receipt.status, "dispatched");
  } finally {
    await driver?.close();
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("visual driver availability is cached per process and never relaunches a browser to check", () => {
  resetPlaytestVisualBrowserDriverAvailabilityCache();
  let calls = 0;
  const probe = {
    executablePath: () => {
      calls += 1;
      return chromium.executablePath();
    }
  };
  const first = isPlaytestVisualBrowserDriverAvailable(probe);
  const second = isPlaytestVisualBrowserDriverAvailable(probe);
  assert.equal(first, true);
  assert.equal(second, true);
  // The probe's executablePath is consulted at most once per cache
  // lifetime: the second call is served from the memoized result, never
  // re-resolving (let alone launching) a browser.
  assert.equal(calls, 1);
  resetPlaytestVisualBrowserDriverAvailabilityCache();
});

test("the open is bounded by the approved episode budget", { timeout: 60_000 }, async () => {
  // A browser that never answers used to hold the episode open for as long
  // as the browser cared to stay silent. The approved wall-time budget is
  // the only bound that covers the whole open, so the open runs under it.
  const source = await listen(() => "<!doctype html><html><body></body></html>");
  const { store, root } = artifacts();
  const browserType = {
    executablePath: () => chromium.executablePath(),
    launch: () => new Promise<never>(() => undefined)
  } satisfies NonNullable<PlaytestVisualBrowserDriverOptions["browserType"]>;
  const startedAt = Date.now();
  try {
    await assert.rejects(
      openDriver({
        source,
        store,
        browserType,
        wallTimeMs: 1000,
        actionTimeoutMs: 1000
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof PlaytestVisualBrowserDriverError,
          `the open must fail with a driver error, got ${String(error)}`
        );
        assert.equal(error.code, "browser-open-timeout");
        return true;
      }
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 30_000,
      `the open must not outlive the approved budget (took ${String(elapsed)} ms)`
    );
  } finally {
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the open does not wait for the page's load event", async () => {
  // A game that is still being built keeps a request pending, and the load
  // event waits for it. The document is what navigation owes the driver:
  // whether the game has painted is the observation's business.
  const pending = createServer((request, response) => {
    if ((request.url ?? "/") === "/pending.png") {
      // Never answered: the page's load event never fires.
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><body><img src=\"/pending.png\"><button>Race</button></body></html>"
    );
  });
  pending.listen(0, "127.0.0.1");
  await once(pending, "listening");
  const address = pending.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const { store, root } = artifacts();
  let driver: PlaytestVisualBrowserDriver | null = null;
  try {
    driver = await openDriver({
      source: { server: pending, origin, close: async () => undefined },
      store,
      actionTimeoutMs: 2000
    });
    const captured = await driver.observe();
    assert.equal(captured.status, "observed");
  } finally {
    await driver?.close();
    await new Promise<void>((resolve) => pending.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a browser that cannot be closed does not hold the episode", { timeout: 60_000 }, async () => {
  // The failure path has to give the browser back and finish: an episode
  // that cannot report its own failure is worse than one that reports it
  // late.
  const source = await listen(() => "<!doctype html><html><body></body></html>");
  const { store, root } = artifacts();
  const wedged = {
    newContext: async () => {
      throw new Error("the browser never answered");
    },
    close: () => new Promise<never>(() => undefined)
  } as unknown as Browser;
  const browserType = {
    executablePath: () => chromium.executablePath(),
    launch: async () => wedged
  } satisfies NonNullable<PlaytestVisualBrowserDriverOptions["browserType"]>;
  const startedAt = Date.now();
  try {
    await assert.rejects(
      openDriver({
        source,
        store,
        browserType,
        wallTimeMs: 2000,
        actionTimeoutMs: 2000
      }),
      (error: unknown) => {
        assert.ok(error instanceof PlaytestVisualBrowserDriverError);
        assert.equal(error.code, "source-unavailable");
        return true;
      }
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 30_000,
      `a browser that cannot be closed must not hold the episode (took ${String(elapsed)} ms)`
    );
  } finally {
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
});
