import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

import type { WorkspaceVisualPlaytestTargetApproval } from "@simulatorlife/autodev-core";
import { chromium } from "playwright-core";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  isPlaytestVisualBrowserDriverAvailable,
  PlaytestVisualBrowserDriver,
  resetPlaytestVisualBrowserDriverAvailabilityCache,
  type PlaytestVisualBrowserDriverOptions
} from "../src/playtesting/visual-browser-driver.ts";

const WORKSPACE = "fixture/visual-game";
const EPISODE_ID = "visual-episode-1";

interface RunningServer {
  readonly server: Server;
  readonly origin: string;
  close(): Promise<void>;
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
}): Promise<PlaytestVisualBrowserDriver> {
  return PlaytestVisualBrowserDriver.open({
    target: target(input.source.origin),
    episodeId: EPISODE_ID,
    artifacts: input.store,
    viewport: { width: 640, height: 480, deviceScaleFactor: 1 },
    actionTimeoutMs: 3000,
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
  const source = await listen(
    () => `<!doctype html><html><body>
    <canvas id="game" width="100" height="100"></canvas>
    <script>
      const context=document.getElementById('game').getContext('2d');
      context.fillStyle='red'; context.fillRect(0,0,30,30);
      setTimeout(()=>{ context.fillStyle='blue'; context.fillRect(0,0,30,30); }, 250);
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
    await new Promise((resolve) => setTimeout(resolve, 350));
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
