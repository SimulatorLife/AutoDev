/** Launch the existing provider-neutral analyst role for a bounded evidence selection. */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
  assertPlaytestCrossSessionMetricAggregation,
  type PlaytestCrossSessionMetricAggregation
} from "@simulatorlife/autodev-core";

import {
  resolveRuntimeSourcePath,
  resolveRuntimeSourceRoot
} from "../shared/runtime-source-root.ts";

const ANALYST_ROLE = "playtest-analyst" as const;
const ANALYST_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINATION_GRACE_MS = 2000;

function removeIsolatedWorkspace(workspace: string): void {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Cleanup must not strand the Runtime task's completion status.
  }
}

export interface PlaytestAnalystProcessInput {
  readonly analysisId: string;
  readonly workspaceId: string;
  readonly actor: string;
  readonly episodeIds: readonly string[];
  readonly metricAggregation: PlaytestCrossSessionMetricAggregation;
}

export interface PlaytestAnalystProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly launchFailed: boolean;
}

export interface PlaytestAnalystProcess {
  readonly completion: Promise<PlaytestAnalystProcessResult>;
  terminate(): void;
}

export interface PlaytestAnalystProcessOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnProcess?: typeof spawn;
}

function playtestAnalystPrompt(input: PlaytestAnalystProcessInput): string {
  assertPlaytestCrossSessionMetricAggregation(
    input.metricAggregation,
    input.workspaceId,
    input.analysisId,
    input.episodeIds
  );
  return [
    "Review the already-recorded playtest evidence selected by the Console. This task never runs or branches gameplay.",
    `Trusted workspace: ${input.workspaceId}`,
    `Analysis run: ${input.analysisId}`,
    "Review exactly these persisted episode IDs, and no others:",
    ...input.episodeIds.map((episodeId) => `- ${episodeId}`),
    "Runtime computed the following deterministic selected-session metric aggregation from the exact frozen packets. Treat these as descriptive ratio-of-sums only within the exact strata shown; do not recompute, average per-session percentages, infer a matched-seed effect, or make population claims. Independent units are null when the metric's declared unit cannot be deduplicated from these packets. Cite the source packets for every interpretation:",
    JSON.stringify(input.metricAggregation),
    "For each episode, call playtest.prepareReview first, then submit one review using the exact packetId, packetArtifactId, packetSha256, rubric hash, and workspace returned by that tool. Use only the bounded packet and its included sibling context; do not call playtest.prepareCrossSessionReview because Runtime already froze the exact selection for this dispatch. Submit reports independently per episode and cite only that episode's packet. If a packet is unavailable, leave it unreviewed; do not substitute raw or unselected evidence.",
    "The strict playtest.submitReview input requires episodeId, packetId, packetArtifactId, packetSha256, chronologicalSummary, status (hypothesis or not observed only), non-empty top-level evidenceRefs, non-empty observations and interpretations (each exactly {text,evidenceRefs}), alternativeExplanations, reportCompleteness, experiments, and rubricHash. dimensionEvidence is optional and each item has only dimensionId, rationale, evidenceRefs, and optional counterexampleId. Runtime copies authoritativeMetrics and derives anchor categories, provenance, author, version, and timestamps; do not submit those fields.",
    "reportCompleteness must contain exactly four keys, with no narrative-section keys or extra metadata: crossSessionContext, alternatives, experiments, and followUp. Cross-session context is {status:unavailable,reason:<packet-specific reason>} or {status:available,evidenceRefs:[{kind:episode,id:<packet-supplied sibling episode ID>}]}; the available evidenceRefs are whole-episode locators, not synthesis triples. For empty alternativeExplanations use alternatives={status:none-identified,reason:<evidence-grounded reason>}; for a non-empty array use exactly {status:provided}. For an empty experiments array use experiments={status:none-recommended,reason:<evidence-grounded reason>}; for a non-empty array use exactly {status:proposed}. Follow-up is exactly {status:proposed,text:<next investigation>} or {status:none,reason:<why none>}. Do not use historical not-recorded statuses in a new review.",
    "Per-session experiment entries have exactly hypothesis, falsifier, metricId, controls (a non-empty string array), and budget; do not add citations there. Keep hypotheses in interpretations with evidenceRefs. Omit findings for this analyst hypothesis review; if a future request requires a finding, its separate strict identity uses mechanicKey, failureSignature, and scope, never a locator. Do not use a score field in dimensionEvidence; provide only supported dimension-specific rationale/citations.",
    "After the per-session reviews, when at least two packets were prepared, submit one batch-level cross-session synthesis with playtest.submitCrossSessionSynthesis. Cite every pattern, counterexample, confounder, and proposed experiment using {episodeId, packetId, locator} references from those exact packets. Keep all conclusions at hypothesis level; do not call patterns verified or corroborated. If fewer than two packets were available, do not submit a synthesis.",
    "Do not run, branch, modify source, change game state, or publish issues. Do not claim verification or corroboration; reviews remain hypotheses or not-observed."
  ].join("\n");
}

/**
 * Start the existing `run-provider-agent` CLI in its read-only analyst role.
 * The agent runs in a private, source-empty Git root, not the game checkout.
 * Codex 0.154 omits its structured workspace metadata for a non-Git cwd, which
 * makes the provider router refuse the request; the empty local Git metadata
 * supplies that boundary without a remote, tracked file, or game commit. The
 * allowlisted tools use the workspace-bound Playtesting repository directly;
 * the child receives no Control API credential or run-control client. Runtime
 * retains dispatch lifecycle/status.
 */
export function launchPlaytestAnalystProcess(
  input: PlaytestAnalystProcessInput,
  options: PlaytestAnalystProcessOptions = {}
): PlaytestAnalystProcess {
  const environment = options.environment ?? process.env;
  const spawnProcess = options.spawnProcess ?? spawn;
  const repositoryRoot = resolveRuntimeSourceRoot(import.meta.dirname);
  const providerAgent = resolveRuntimeSourcePath(
    repositoryRoot,
    "cli/provider-agent.ts"
  );
  const taskId = `playtest-analysis-${input.analysisId}`;
  const runId = `playtest-analysis-${randomUUID()}`;
  const sourceHome = environment.HOME?.trim() || homedir();
  const sourceCodexHome =
    environment.CODEX_HOME?.trim() || path.join(sourceHome, ".codex");
  const isolatedRoot = mkdtempSync(
    path.join(tmpdir(), "autodev-playtest-analyst-")
  );
  chmodSync(isolatedRoot, 0o700);
  const isolatedWorkspace = path.join(isolatedRoot, "workspace");
  const analystHome = path.join(isolatedRoot, "home");
  const isolatedCodexHome = path.join(analystHome, ".codex");
  mkdirSync(isolatedWorkspace, { mode: 0o700 });
  mkdirSync(isolatedCodexHome, { recursive: true, mode: 0o700 });
  chmodSync(isolatedWorkspace, 0o700);
  chmodSync(analystHome, 0o700);
  chmodSync(isolatedCodexHome, 0o700);
  const canonicalIsolatedRoot = realpathSync(isolatedRoot);
  const canonicalWorkspace = realpathSync(isolatedWorkspace);
  try {
    const privateGitTemplate = path.join(isolatedRoot, "git-template");
    mkdirSync(privateGitTemplate, { mode: 0o700 });
    chmodSync(privateGitTemplate, 0o700);
    const gitEnvironment: NodeJS.ProcessEnv = {
      PATH: environment.PATH ?? process.env.PATH,
      HOME: analystHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(analystHome, "empty-gitconfig"),
      GIT_TEMPLATE_DIR: privateGitTemplate
    };
    execFileSync("git", ["init", "--quiet"], {
      cwd: canonicalWorkspace,
      env: gitEnvironment,
      stdio: "ignore"
    });
    chmodSync(path.join(canonicalWorkspace, ".git"), 0o700);
  } catch (error) {
    removeIsolatedWorkspace(canonicalIsolatedRoot);
    throw new Error(
      "Playtest analyst private workspace could not be prepared for Code Mode.",
      { cause: error }
    );
  }
  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    HOME: analystHome,
    CODEX_HOME: isolatedCodexHome,
    AUTODEV_PLAYTEST_ANALYSIS_MODE: "1",
    AUTODEV_PLAYTEST_ANALYST_HOME: analystHome,
    AUTODEV_PLAYTEST_ANALYST_CODEX_HOME: isolatedCodexHome,
    AUTODEV_PLAYTEST_ANALYST_SOURCE_HOME: sourceHome,
    AUTODEV_PLAYTEST_ANALYST_SOURCE_CODEX_HOME: sourceCodexHome,
    AUTODEV_REPO_ROOT: repositoryRoot,
    AUTODEV_PLAYTEST_WORKSPACE_ID: input.workspaceId,
    AUTODEV_PLAYTEST_ROLE: ANALYST_ROLE,
    AUTODEV_PLAYTEST_ACTOR_ID: input.actor,
    AUTODEV_PLAYTEST_TASK_ID: taskId,
    AUTODEV_PLAYTEST_RUN_ID: runId,
    AUTODEV_PLAYTEST_ANALYSIS_ID: input.analysisId,
    AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS: JSON.stringify(input.episodeIds),
    AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION: JSON.stringify(
      input.metricAggregation
    ),
    AUTODEV_PLAYTEST_REPOSITORY_ROOT: repositoryRoot,
    AUTODEV_MEMORY_MODE: "disabled"
  };
  // This process reads/writes through its role- and workspace-bound MCP data
  // tools. It receives no general or Playtesting Control API credential.
  delete childEnvironment.AUTODEV_CONTROL_API_TOKEN;
  delete childEnvironment.AUTODEV_PLAYTEST_CONTROL_API_TOKEN;
  delete childEnvironment.AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN;
  delete childEnvironment.AUTODEV_PLAYTEST_CONTROL_API_ACTOR;
  delete childEnvironment.AUTODEV_PLAYTEST_CONTROL_API_ROLE;
  delete childEnvironment.AUTODEV_CONTROL_API_BASE_URL;
  delete childEnvironment.AUTODEV_CONTROL_API_LISTEN_HOST;
  delete childEnvironment.AUTODEV_CONTROL_API_LISTEN_PORT;
  const prompt = playtestAnalystPrompt(input);
  let child: ChildProcess;
  try {
    child = spawnProcess(
      process.execPath,
      [
        providerAgent,
        "--role",
        ANALYST_ROLE,
        "--cwd",
        canonicalWorkspace,
        "--prompt",
        prompt
      ],
      {
        cwd: canonicalWorkspace,
        env: childEnvironment,
        stdio: "ignore",
        windowsHide: true
      }
    );
  } catch (error) {
    removeIsolatedWorkspace(canonicalIsolatedRoot);
    throw error;
  }

  let timedOut = false;
  let launchFailed = false;
  let settled = false;
  let forceKill: NodeJS.Timeout | undefined;
  let resolveCompletion!: (result: PlaytestAnalystProcessResult) => void;
  const completion = new Promise<PlaytestAnalystProcessResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
    forceKill.unref();
  }, ANALYST_TIMEOUT_MS);
  timeout.unref();
  const finish = (
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    removeIsolatedWorkspace(canonicalIsolatedRoot);
    resolveCompletion({ exitCode, signal, timedOut, launchFailed });
  };
  child.once("error", () => {
    launchFailed = true;
    finish(null, null);
  });
  child.once("close", (exitCode, signal) => {
    finish(exitCode, signal);
  });

  return {
    completion,
    terminate() {
      if (settled || forceKill) return;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
      forceKill.unref();
    }
  };
}
