/**
 * The harness for a visual episode that runs against a scripted browser.
 *
 * The Runtime's episode loop is exercised through the same MCP run control the
 * product uses, with the browser and the model Router replaced by fixtures.
 * What is left is the product's own machinery: the launch request, the
 * approval, the budgets, the loop, the trace and the persisted episode.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PLAYTEST_LAUNCH_REQUEST_SCHEMA,
  type PlaytestEpisode,
  type PlaytestLaunchRequest,
  PLAYTESTS_VISUAL_LOADING_WARNING,
  type PlaytestVisualActionRefusalReason,
  type PlaytestVisualObservation,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";
import type { WorkspaceCatalogRead } from "@simulatorlife/autodev-data";
import { WorkspaceVisualPlaytestTargetRepository } from "@simulatorlife/autodev-data/workspaces";

import { PlaytestArtifactStore } from "../../src/playtesting/artifact-store.ts";
import {
  createPlaytestRunControl,
  type PlaytestingRepositoryOps,
  type PlaytestMcpSession
} from "../../src/playtesting/mcp.ts";
import type {
  PlaytestVisualActionReceipt,
  PlaytestVisualDriverOpener,
  PlaytestVisualEpisodeDriver
} from "../../src/playtesting/visual-browser-driver.ts";
import { inMemoryPlaytestLaunchIntentRepository } from "./playtesting-launch-intents.ts";

export const WORKSPACE_ID = "fixture/visual-episode";
export const TARGET_ID = "racing-game-local";
export const ORIGIN = "http://127.0.0.1:5173";

/** An approval with the budgets the harness runs against. */
export function approval(
  limits: WorkspaceVisualPlaytestTargetApproval["limits"],
  progressPolicy?: WorkspaceVisualPlaytestTargetApproval["progressPolicy"]
): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE_ID,
    targetId: TARGET_ID,
    revision: 1,
    approvalId: "visual-approval-episode-1",
    name: "Visual episode fixture",
    entryUrl: ORIGIN + "/",
    allowedOrigins: [ORIGIN],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits,
    ...(progressPolicy === undefined ? {} : { progressPolicy }),
    approvedAt: "2026-10-20T00:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
}

/** The budgets the harness runs against. */
export function targetLimits(
  overrides: Partial<WorkspaceVisualPlaytestTargetApproval["limits"]> = {}
): WorkspaceVisualPlaytestTargetApproval["limits"] {
  return {
    episodeCount: 1,
    maxStepsPerEpisode: 4,
    wallTimeMs: 20_000,
    smartRequestsPerEpisode: 6,
    smartTokensPerEpisode: 20_000,
    screenshotCountPerEpisode: 10,
    artifactBytesPerEpisode: 1_073_741_824,
    ...overrides
  };
}

export function enabledWorkspaceCatalog(): () => WorkspaceCatalogRead {
  return () => ({
    status: "valid",
    workspaces: [
      {
        id: WORKSPACE_ID,
        baseBranch: "main",
        enabled: true,
        agentRoles: null
      }
    ]
  });
}

export function session(): PlaytestMcpSession {
  return {
    workspaceId: WORKSPACE_ID,
    role: "playtester",
    actor: "operator-1"
  };
}

/**
 * A browser the test drives by hand.
 *
 * The driver refuses the actions the test scripts, in order, and dispatches
 * the rest. Every observation is a real stored frame, so the episode's own
 * accounting is exercised rather than stubbed. The phase is scripted per
 * observation, because whether the game advanced is what the episode's guard
 * measures.
 */
export class ScriptedVisualDriver implements PlaytestVisualEpisodeDriver {
  /** The refusal reason for each action attempt, in order; a gap dispatches. */
  readonly script: readonly (PlaytestVisualActionRefusalReason | null)[];
  /** The phase each observation reports; the last one repeats. */
  readonly phases: readonly (string | null)[];
  /** Whether each observation reports a loading page; the last one repeats. */
  readonly loading: readonly boolean[];
  readonly attempts: { readonly kind: string }[] = [];
  observations = 0;
  private readonly startedAt = Date.now();
  private readonly artifacts: PlaytestArtifactStore;
  private readonly target: WorkspaceVisualPlaytestTargetApproval;
  private readonly episodeId: string;
  private readonly budgetMs: number;

  constructor(
    artifacts: PlaytestArtifactStore,
    target: WorkspaceVisualPlaytestTargetApproval,
    episodeId: string,
    budgetMs: number,
    script: readonly (PlaytestVisualActionRefusalReason | null)[],
    phases: readonly (string | null)[] = [],
    loading: readonly boolean[] = []
  ) {
    this.artifacts = artifacts;
    this.target = target;
    this.episodeId = episodeId;
    this.budgetMs = budgetMs;
    this.script = script;
    this.phases = phases;
    this.loading = loading;
  }

  remainingWallTimeMs(): number {
    return Math.max(0, this.budgetMs - (Date.now() - this.startedAt));
  }

  async observe() {
    this.observations += 1;
    const bytes = new Uint8Array(Buffer.from("fake-frame-bytes"));
    const written = this.artifacts.writeArtifact({
      mediaType: "image/png",
      bytes
    });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(written.reference.sha256, sha256);
    // The phase cycles, so a fixture that means "the game advances" can say
    // so with a short list and still keep advancing for every step.
    const phase =
      this.phases.length === 0
        ? null
        : (this.phases[(this.observations - 1) % this.phases.length] ?? null);
    // The loading flag runs through the list and then holds its last value, so
    // a fixture can say "the page is still loading from here on".
    const loading =
      this.loading.length === 0
        ? false
        : (this.loading[
            Math.min(this.observations - 1, this.loading.length - 1)
          ] ?? false);
    const observation: PlaytestVisualObservation = {
      schema: "autodev-playtest-visual-observation-v1",
      observationId: "observation-" + String(this.observations),
      workspaceId: this.target.workspaceId,
      targetId: this.target.targetId,
      episodeId: this.episodeId,
      origin: ORIGIN,
      capturedAt: new Date().toISOString(),
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      frame: {
        artifactId: written.reference.artifactId,
        sha256,
        bytes: bytes.byteLength,
        mediaType: "image/png"
      },
      privacyState: "clear",
      controls: [
        {
          controlId: "control-start",
          role: "button",
          name: "START",
          enabled: true,
          focused: false,
          inputKind: "none",
          bounds: { x: 100, y: 100, width: 80, height: 24 }
        }
      ],
      visibleWarnings: loading ? [PLAYTESTS_VISUAL_LOADING_WARNING] : [],
      phaseEvidence: phase,
      progressEvidence: null
    };
    return { status: "observed" as const, observation };
  }

  async act(action: {
    readonly kind: string;
  }): Promise<PlaytestVisualActionReceipt> {
    const step = this.attempts.length;
    this.attempts.push({ kind: action.kind });
    const refusal = this.script[step] ?? null;
    if (refusal !== null) {
      return { status: "refused", step, reason: refusal };
    }
    return {
      status: "dispatched",
      step,
      observationId: "observation-" + String(this.observations),
      actionKind: "activate-control" as const,
      dispatchedAt: new Date().toISOString(),
      driverDurationMs: 1,
      gameAcknowledgement: "not-observed" as const
    };
  }

  async close() {
    return {};
  }
}

export interface DecisionRequest {
  readonly input: readonly {
    readonly content: readonly { readonly text?: string }[];
  }[];
}

/** A local stand-in for the model Router, so no provider is ever contacted. */
export async function startFakeRouter(decisions: readonly unknown[]): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
  readonly requests: DecisionRequest[];
}> {
  const requests: DecisionRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as DecisionRequest
      );
      const decision = decisions[requests.length - 1] ?? decisions.at(-1);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "fixture-smart-model",
          usage: { input_tokens: 300, output_tokens: 40, total_tokens: 340 },
          output_text: JSON.stringify(decision)
        })
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/** The decision that dispatches the visible control. */
export const ACT_DECISION = {
  decision: "act",
  intention: "Start the race from the title screen.",
  prediction: "The title button will change to the active race screen.",
  reasonCode: "begin-play",
  action: { kind: "activate-control", controlId: "control-start" },
  stopReason: null,
  focusReport: null
};

/** The decision that ends the episode. */
export const STOP_DECISION = {
  decision: "stop",
  intention: "The race screen has no further visible progress to make.",
  prediction: "Exploration ends with the race screen unchanged.",
  reasonCode: "objective-achieved",
  action: null,
  stopReason: "objective-achieved",
  focusReport: {
    objective: "Explore the visible controls.",
    inScope: ["title screen"],
    forbiddenScope: ["hidden game state"],
    stopCriteria: ["no visible progress"],
    outcome: "achieved",
    summary:
      "The visible title screen offers one control and no further progress.",
    evidenceSteps: [0]
  }
};

export interface EpisodeRun {
  readonly episode: PlaytestEpisode;
  readonly driver: ScriptedVisualDriver;
  readonly routerRequests: DecisionRequest[];
  readonly traceSteps: readonly Record<string, unknown>[];
}

/**
 * Runs one autonomous-visual episode against the scripted browser and the
 * fake Router, and returns the persisted episode with the trace it recorded.
 */
export async function runVisualEpisode(options: {
  readonly script: readonly (PlaytestVisualActionRefusalReason | null)[];
  readonly decisions: readonly unknown[];
  readonly phases?: readonly (string | null)[];
  readonly loading?: readonly boolean[];
  readonly limits?: WorkspaceVisualPlaytestTargetApproval["limits"];
  readonly progressPolicy?: WorkspaceVisualPlaytestTargetApproval["progressPolicy"];
}): Promise<EpisodeRun> {
  // The approval repository refuses a root that resolves through a symlink,
  // and the operating system's temporary directory is one on macOS. The
  // roots are resolved first so the repositories are given the directories
  // they will actually use.
  const visualRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "visual-episode-target-"))
  );
  const artifactRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "visual-episode-artifacts-"))
  );
  const router = await startFakeRouter(options.decisions);
  const previousPort = process.env.CODEX_MODEL_ROUTER_PORT;
  process.env.CODEX_MODEL_ROUTER_PORT = String(router.port);
  const episodes: PlaytestEpisode[] = [];
  let driver: ScriptedVisualDriver | null = null;
  try {
    const visualTargetRepository = new WorkspaceVisualPlaytestTargetRepository(
      visualRoot
    );
    const limits = options.limits ?? targetLimits();
    visualTargetRepository.approve(
      approval(limits, options.progressPolicy),
      null
    );
    const artifacts = new PlaytestArtifactStore({
      workspaceId: WORKSPACE_ID,
      rootDirectory: artifactRoot
    });
    const repository: PlaytestingRepositoryOps = {
      getBatch: async () => null,
      listBatches: async () => ({ rows: [], total: 0, nextCursor: null }),
      listEpisodes: async () => ({ rows: [], total: 0, nextCursor: null }),
      listFindings: async () => ({ rows: [], total: 0, nextCursor: null }),
      listComparisons: async () => ({ rows: [], total: 0, nextCursor: null }),
      listBenchmarks: async () => ({ rows: [], total: 0, nextCursor: null }),
      listExperiments: async () => ({ rows: [], total: 0, nextCursor: null }),
      listHumanStudies: async () => ({ rows: [], total: 0, nextCursor: null }),
      getEpisode: async () => null,
      getLatestReviewForEpisode: async () => null,
      getLatestDiscoveryReviewForEpisode: async () => null,
      insertDiscoveryReview: async () => {},
      getFinding: async () => null,
      getLatestFindingByFingerprint: async () => null,
      insertComparison: async () => {},
      insertBatch: async () => {},
      insertEpisode: async (episode) => {
        episodes.push(episode);
      },
      insertCrossSessionSynthesis: async () => {},
      getCrossSessionSynthesisForAnalysis: async () => null,
      listCrossSessionSyntheses: async () => ({
        rows: [],
        total: 0,
        nextCursor: null
      }),
      insertReview: async () => {},
      insertFinding: async () => {},
      getLatestReview: async () => null,
      getLatestComparison: async () => null
    };
    const openVisualDriver: PlaytestVisualDriverOpener = async (
      driverOptions
    ) => {
      driver = new ScriptedVisualDriver(
        driverOptions.artifacts,
        driverOptions.target,
        driverOptions.episodeId,
        limits.wallTimeMs,
        options.script,
        options.phases ?? [],
        options.loading ?? []
      );
      return driver;
    };
    const control = createPlaytestRunControl({
      artifactStoreForWorkspace: () => artifacts,
      playtestRepository: repository,
      launchIntentRepository: inMemoryPlaytestLaunchIntentRepository(),
      visualTargetRepository,
      readWorkspaceCatalog: enabledWorkspaceCatalog(),
      openVisualDriver
    });
    const request: PlaytestLaunchRequest = {
      schema: PLAYTEST_LAUNCH_REQUEST_SCHEMA,
      mode: "autonomous-visual",
      workspaceId: WORKSPACE_ID,
      requestId: "request-visual-episode-1",
      capabilityRevision: "b".repeat(64),
      targetId: TARGET_ID,
      policyId: "smart-direct",
      areasOfFocus: "Explore the visible controls.",
      limits
    };
    const receipt = await control.startRun(session(), request);
    await control.waitForRun(session(), WORKSPACE_ID, receipt.batchId, 20_000);
    assert.ok(episodes.length > 0);
    assert.ok(driver);
    const episode = episodes.at(-1);
    assert.ok(episode);
    return {
      // Every revision of the one episode is persisted; the last one is final.
      episode,
      driver,
      routerRequests: router.requests,
      traceSteps: readTraceSteps(artifactRoot, episode)
    };
  } finally {
    if (previousPort === undefined) delete process.env.CODEX_MODEL_ROUTER_PORT;
    else process.env.CODEX_MODEL_ROUTER_PORT = previousPort;
    await router.close();
    rmSync(visualRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

/** The episode's own trace window, as the recorded lines. */
export function readTraceSteps(
  artifactRoot: string,
  episode: PlaytestEpisode
): readonly Record<string, unknown>[] {
  assert.ok(episode.trace, "the episode recorded no trace window");
  const windowPath = path.join(
    artifactRoot,
    WORKSPACE_ID,
    "windows",
    episode.trace.id + ".jsonl"
  );
  return readFileSync(windowPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The visible state the decision backend was asked to read. */
export function visibleStateOf(request: DecisionRequest): {
  readonly recentHistory: readonly {
    readonly step: number;
    readonly action: string;
    readonly observation: string;
    readonly outcome: string;
  }[];
  readonly progress: {
    readonly version: string;
    readonly advanced: boolean;
    readonly loading: boolean;
    readonly unchangedSteps: number;
    readonly unchangedMs: number;
    readonly maxUnchangedDecisions: number | null;
    readonly maxUnchangedMs: number | null;
  };
} {
  const text = request.input[0]?.content[0]?.text ?? "{}";
  return JSON.parse(text) as {
    readonly recentHistory: readonly {
      readonly step: number;
      readonly action: string;
      readonly observation: string;
      readonly outcome: string;
    }[];
    readonly progress: {
      readonly version: string;
      readonly advanced: boolean;
      readonly loading: boolean;
      readonly unchangedSteps: number;
      readonly unchangedMs: number;
      readonly maxUnchangedDecisions: number | null;
      readonly maxUnchangedMs: number | null;
    };
  };
}
