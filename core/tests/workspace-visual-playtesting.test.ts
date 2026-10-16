import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkspaceVisualPlaytestTargetApproval,
  WORKSPACE_VISUAL_PLAYTEST_TARGET_SCHEMA,
  type WorkspaceVisualPlaytestTargetApproval
} from "../src/workspaces/visual-playtesting.ts";

function target(
  overrides: Partial<WorkspaceVisualPlaytestTargetApproval> = {}
): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: WORKSPACE_VISUAL_PLAYTEST_TARGET_SCHEMA,
    workspaceId: "owner/game",
    targetId: "racing-game-local",
    revision: 1,
    approvalId: "visual-approval-1",
    name: "RacingGame local browser",
    entryUrl: "http://localhost:5173/",
    allowedOrigins: ["http://localhost:5173"],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: {
      episodeCount: 1,
      maxStepsPerEpisode: 80,
      wallTimeMs: 120_000,
      smartRequestsPerEpisode: 30,
      smartTokensPerEpisode: 25_000,
      screenshotCountPerEpisode: 160,
      artifactBytesPerEpisode: 64 * 1024 * 1024
    },
    approvedAt: "2026-10-16T12:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...overrides
  };
}

test("visual target approval pins exact origins, bounded input, and per-episode quotas", () => {
  assertWorkspaceVisualPlaytestTargetApproval(target());
  assertWorkspaceVisualPlaytestTargetApproval(
    target({
      entryUrl: "https://games.example.test/play",
      allowedOrigins: [
        "https://games.example.test",
        "https://assets.example.test"
      ],
      entryRequirements: "consent-or-age-screen",
      controlTimingClass: "pausable",
      inputCapabilities: ["keyboard", "pointer", "gamepad"]
    })
  );
});

test("visual target approval refuses unpinned, credentialed, query, and insecure remote URLs", () => {
  for (const entryUrl of [
    "https://games.example.test/start?token=private",
    "https://user:password@games.example.test/",
    "http://games.example.test/",
    "file:///Applications/game/index.html",
    "https://games.example.test/#/private",
    "http://localhost:5173"
  ]) {
    assert.throws(
      () =>
        assertWorkspaceVisualPlaytestTargetApproval(
          target({
            entryUrl,
            allowedOrigins: [
              entryUrl.startsWith("http://")
                ? "http://localhost:5173"
                : "https://games.example.test"
            ]
          })
        ),
      TypeError,
      entryUrl
    );
  }
});

test("visual target approval requires exact origin allowlists and known capabilities", () => {
  assert.throws(
    () =>
      assertWorkspaceVisualPlaytestTargetApproval(
        target({ allowedOrigins: ["https://*.example.test"] })
      ),
    /exact origins/u
  );
  assert.throws(
    () =>
      assertWorkspaceVisualPlaytestTargetApproval(
        target({ allowedOrigins: ["https://other.example.test"] })
      ),
    /including the entry origin/u
  );
  assert.throws(
    () =>
      assertWorkspaceVisualPlaytestTargetApproval(
        target({ inputCapabilities: ["keyboard", "shell"] as never })
      ),
    /input capabilities/u
  );
  assert.throws(
    () =>
      assertWorkspaceVisualPlaytestTargetApproval(
        target({ limits: { ...target().limits, wallTimeMs: 0 } })
      ),
    /wallTimeMs is out of range/u
  );
  assert.throws(
    () =>
      assertWorkspaceVisualPlaytestTargetApproval({
        ...target(),
        shellCommand: "node server.mjs"
      }),
    /unsupported shape/u
  );
});

test("visual target revocation metadata is all-or-nothing", () => {
  assertWorkspaceVisualPlaytestTargetApproval(
    target({
      revokedAt: "2026-10-16T12:30:00.000Z",
      revokedBy: "operator-2",
      revocationReason: "Origin no longer approved"
    })
  );
  assert.throws(
    () =>
      assertWorkspaceVisualPlaytestTargetApproval(
        target({ revokedAt: null, revokedBy: "operator-2" })
      ),
    /cannot carry revocation metadata/u
  );
});
