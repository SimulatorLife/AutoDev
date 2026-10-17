import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspaceVisualPlaytestTargetApproval } from "@simulatorlife/autodev-core";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import { SmartDirectVisualPolicy } from "../src/playtesting/smart-direct-policy.ts";
import { PlaytestVisualBrowserDriver } from "../src/playtesting/visual-browser-driver.ts";

const WORKSPACE_ID = "fixture/visual-game";
const EPISODE_ID = "visual-smart-episode";

function approval(origin: string): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE_ID,
    targetId: "visual-target-1",
    revision: 1,
    approvalId: "visual-approval-1",
    name: "Visual loop fixture",
    entryUrl: origin + "/",
    allowedOrigins: [origin],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 2,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 2,
      smartTokensPerEpisode: 2000,
      screenshotCountPerEpisode: 2,
      artifactBytesPerEpisode: 16 * 1024 * 1024
    },
    approvedAt: "2026-10-17T12:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
}

test("a Smart-direct response drives one admitted action through the isolated visual browser", async () => {
  const game = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body>
      <button onclick="this.textContent='Race underway'">Start race</button>
    </body></html>`);
  });
  game.listen(0, "127.0.0.1");
  await once(game, "listening");
  const address = game.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const target = approval(origin);
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "smart-direct-visual-loop-")
  );
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: artifactRoot
  });
  let driver: PlaytestVisualBrowserDriver | null = null;
  try {
    driver = await PlaytestVisualBrowserDriver.open({
      target,
      episodeId: EPISODE_ID,
      artifacts,
      viewport: { width: 640, height: 480, deviceScaleFactor: 1 },
      actionTimeoutMs: 3000,
      maxSteps: 2
    });
    const first = await driver.observe();
    assert.equal(first.status, "observed");
    if (first.status !== "observed") return;

    const policyRequests: string[] = [];
    const policy = new SmartDirectVisualPolicy(target, {
      endpoint: "http://127.0.0.1:4100/v1/responses",
      fetchImpl: async (_input, init) => {
        policyRequests.push(String(init?.body ?? ""));
        const request = JSON.parse(String(init?.body)) as {
          readonly input: readonly {
            readonly content: readonly { readonly text?: string }[];
          }[];
        };
        const visibleState = JSON.parse(
          request.input[0]?.content[0]?.text ?? "{}"
        ) as {
          readonly controls: readonly { readonly controlId: string }[];
        };
        const startControl = visibleState.controls.find(
          (control) => control.controlId
        );
        return Response.json({
          model: "fixture-smart-model",
          usage: { input_tokens: 300, output_tokens: 40, total_tokens: 340 },
          output_text: JSON.stringify({
            decision: "act",
            intention: "Start a race to inspect the game screen.",
            prediction:
              "The title button will change to the active race screen.",
            reasonCode: "begin-play",
            action: {
              kind: "activate-control",
              controlId: startControl?.controlId
            },
            stopReason: null
          })
        });
      }
    });
    const frameBytes = artifacts.readArtifact(first.observation.frame).bytes;
    const decision = await policy.decide({
      target,
      observation: first.observation,
      frameBytes,
      areasOfFocus: "Inspect the first game screen.",
      history: [],
      deadlineMonotonicMs: performance.now() + 5000
    });
    assert.equal(decision.status, "act");
    if (decision.status !== "act") return;
    const receipt = await driver.act(decision.action, 5000);
    assert.equal(receipt.status, "dispatched");
    if (receipt.status !== "dispatched") return;
    assert.equal(receipt.gameAcknowledgement, "not-observed");

    const after = await driver.observe();
    assert.equal(after.status, "observed");
    if (after.status !== "observed") return;
    assert.ok(
      after.observation.controls.some(({ name }) => name === "Race underway")
    );
    assert.equal(policyRequests.length, 1);
    assert.equal(policy.usage().requestsAttempted, 1);
    assert.equal(policy.usage().tokensUsed, 340);
    assert.equal(driver.telemetry().inputDispatched, 1);
    assert.equal(driver.telemetry().captureCount, 2);
    assert.equal(
      first.observation.frame.sha256,
      createHash("sha256").update(frameBytes).digest("hex")
    );
  } finally {
    await driver?.close();
    await new Promise<void>((resolve) => game.close(() => resolve()));
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});
