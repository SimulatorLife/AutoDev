import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFileSync,
  type spawn,
  type SpawnOptions
} from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA } from "@simulatorlife/autodev-core";

import {
  launchPlaytestAnalystProcess,
  type PlaytestAnalystProcessResult
} from "../src/playtesting/analyst-process.ts";

function aggregationFor(episodeIds: readonly string[]) {
  const sources = episodeIds.map((episodeId, index) => ({
    episodeId,
    batchId: `batch-${String(index + 1)}`,
    packetId: `packet-${String(index + 1)}`
  }));
  return {
    schema: PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
    workspaceId: "owner/RacingGame",
    analysisId: "analysis-123",
    status:
      episodeIds.length >= 2
        ? ("no-applicable-metrics" as const)
        : ("insufficient-packets" as const),
    method: "ratio-of-sums-within-identical-stratum-v1" as const,
    sourcePackets: sources,
    rows: [],
    omittedMetrics: [],
    reason:
      episodeIds.length >= 2
        ? ("no-applicable-metric-rows" as const)
        : ("fewer-than-two-packets" as const)
  };
}

test("analyst dispatch uses the existing provider-agent role with a read-only scoped context", async () => {
  const calls: {
    command: string;
    args: readonly string[];
    options: SpawnOptions;
  }[] = [];
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  const child = {
    once(event: string, handler: (...args: unknown[]) => void) {
      eventHandlers.set(event, handler);
      return child;
    },
    kill: () => true,
    emitForTest(event: string, ...args: unknown[]) {
      eventHandlers.get(event)?.(...args);
    }
  } as unknown as ChildProcess & {
    emitForTest(event: string, ...args: unknown[]): void;
  };
  const spawnProcess = ((
    command: string,
    args: string[],
    options: SpawnOptions
  ) => {
    calls.push({ command, args, options });
    return child;
  }) as unknown as typeof spawn;
  const processHandle = launchPlaytestAnalystProcess(
    {
      analysisId: "analysis-123",
      workspaceId: "owner/RacingGame",
      actor: "control-api:abcd",
      episodeIds: ["episode-1", "episode-2"],
      analysisKind: "confirmatory",
      requireFindings: false,
      metricAggregation: aggregationFor(["episode-1", "episode-2"])
    },
    {
      environment: {
        AUTODEV_REPO_ROOT: "/checkout",
        AUTODEV_CONTROL_API_BASE_URL: "http://127.0.0.1:4101",
        AUTODEV_CONTROL_API_LISTEN_HOST: "127.0.0.1",
        AUTODEV_CONTROL_API_LISTEN_PORT: "4101",
        AUTODEV_CONTROL_API_TOKEN: "general-secret",
        AUTODEV_PLAYTEST_CONTROL_API_ACTOR: "playtest-runtime",
        AUTODEV_PLAYTEST_CONTROL_API_ROLE: "playtester",
        AUTODEV_PLAYTEST_CONTROL_API_TOKEN: "runner-secret",
        AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN: "analyst-secret"
      },
      spawnProcess
    }
  );

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  const spawnOptions = call.options;
  const childEnvironment = spawnOptions.env ?? {};
  assert.equal(call.command, process.execPath);
  assert.equal(call.args[1], "--role");
  assert.equal(call.args[2], "playtest-analyst");
  assert.equal(call.args[3], "--cwd");
  assert.equal(call.args[4], spawnOptions.cwd);
  assert.equal(typeof spawnOptions.cwd, "string");
  const isolatedWorkspace = String(spawnOptions.cwd);
  assert.deepEqual(readdirSync(isolatedWorkspace), [".git"]);
  assert.equal(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: isolatedWorkspace,
      encoding: "utf8"
    }).trim(),
    isolatedWorkspace
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: isolatedWorkspace,
      encoding: "utf8"
    }).trim(),
    "",
    "the Code Mode root contains no tracked or untracked game content"
  );
  assert.equal(
    execFileSync("git", ["remote"], {
      cwd: isolatedWorkspace,
      encoding: "utf8"
    }).trim(),
    "",
    "the private Code Mode root must not identify a remote repository"
  );
  assert.equal(
    execFileSync("git", ["ls-files"], {
      cwd: isolatedWorkspace,
      encoding: "utf8"
    }).trim(),
    "",
    "the private Code Mode root must have no tracked source"
  );
  assert.equal(
    statSync(path.join(isolatedWorkspace, ".git")).mode & 0o777,
    0o700
  );
  assert.equal(statSync(String(spawnOptions.cwd)).mode & 0o777, 0o700);
  assert.ok(call.args[0]?.endsWith("/runtime/src/cli/provider-agent.ts"));
  assert.match(call.args.at(-1) ?? "", /episode-1[\s\S]*episode-2/u);
  assert.match(
    call.args.at(-1) ?? "",
    /deterministic selected-session metric aggregation/u
  );
  assert.match(
    call.args.at(-1) ?? "",
    /ratio-of-sums-within-identical-stratum-v1/u
  );
  assert.match(
    call.args.at(-1) ?? "",
    /strict playtest\.submitReview input requires episodeId, packetId, packetArtifactId, packetSha256, chronologicalSummary, status/u
  );
  assert.match(
    call.args.at(-1) ?? "",
    /reportCompleteness must contain exactly four keys/u
  );
  assert.match(
    call.args.at(-1) ?? "",
    /available evidenceRefs are whole-episode locators/u
  );
  assert.match(
    call.args.at(-1) ?? "",
    /Omit findings for this analyst hypothesis review/u
  );
  assert.doesNotMatch(call.args.join(" "), /analyst-secret|runner-secret/u);
  assert.deepEqual(
    spawnOptions.stdio,
    ["ignore", "pipe", "pipe"],
    "the child's own output is captured, not inherited into the service's streams"
  );
  assert.equal(childEnvironment.AUTODEV_PLAYTEST_ROLE, "playtest-analyst");
  assert.equal(
    childEnvironment.AUTODEV_CONFIGURATION_ROOT,
    "/checkout",
    "the analyst child is told where AutoDev's managed configuration lives"
  );
  assert.equal(
    childEnvironment.AUTODEV_REPO_ROOT,
    "/checkout",
    "the analyst child's repo root is the checkout the dispatcher named, not a root derived from where the Runtime happens to be installed: the analyst's Playtesting MCP server reads the canonical workspace catalog and the agent role set from that root, so it has to be the same root the Control API that dispatched the analysis reads"
  );
  assert.equal(childEnvironment.AUTODEV_PLAYTEST_ANALYSIS_ID, "analysis-123");
  assert.equal(
    childEnvironment.AUTODEV_PLAYTEST_SELECTED_EPISODE_IDS,
    JSON.stringify(["episode-1", "episode-2"])
  );
  assert.equal(
    childEnvironment.AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION,
    JSON.stringify(aggregationFor(["episode-1", "episode-2"]))
  );
  assert.equal(childEnvironment.AUTODEV_PLAYTEST_ACTOR_ID, "control-api:abcd");
  assert.equal(
    childEnvironment.AUTODEV_PLAYTEST_TASK_ID,
    "playtest-analysis-analysis-123"
  );
  assert.equal(childEnvironment.AUTODEV_PLAYTEST_CONTROL_API_ROLE, undefined);
  assert.equal(childEnvironment.AUTODEV_PLAYTEST_CONTROL_API_ACTOR, undefined);
  assert.equal(childEnvironment.AUTODEV_PLAYTEST_CONTROL_API_TOKEN, undefined);
  assert.equal(childEnvironment.AUTODEV_CONTROL_API_BASE_URL, undefined);
  assert.equal(childEnvironment.AUTODEV_CONTROL_API_LISTEN_HOST, undefined);
  assert.equal(childEnvironment.AUTODEV_CONTROL_API_LISTEN_PORT, undefined);
  assert.equal(
    childEnvironment.AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN,
    undefined
  );
  assert.equal(childEnvironment.AUTODEV_CONTROL_API_TOKEN, undefined);
  assert.equal(childEnvironment.AUTODEV_MEMORY_MODE, "disabled");
  assert.equal(childEnvironment.AUTODEV_PLAYTEST_ANALYSIS_MODE, "1");
  assert.equal(
    path.dirname(String(childEnvironment.CODEX_HOME)),
    childEnvironment.HOME
  );
  assert.ok(existsSync(String(childEnvironment.CODEX_HOME)));

  const resultPromise = processHandle.completion;
  child.emitForTest("close", 0, null);
  const result: PlaytestAnalystProcessResult = await resultPromise;
  assert.equal(existsSync(String(spawnOptions.cwd)), false);
  assert.equal(existsSync(String(childEnvironment.HOME)), false);
  assert.deepEqual(result, {
    exitCode: 0,
    signal: null,
    timedOut: false,
    launchFailed: false,
    diagnostic: null
  });
});

test("analyst dispatch needs no unused Control API credential", async () => {
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  const child = {
    once(event: string, handler: (...args: unknown[]) => void) {
      eventHandlers.set(event, handler);
      return child;
    },
    kill: () => true,
    emitForTest(event: string, ...args: unknown[]) {
      eventHandlers.get(event)?.(...args);
    }
  } as unknown as ChildProcess & {
    emitForTest(event: string, ...args: unknown[]): void;
  };
  let spawnCount = 0;
  const spawnProcess = ((
    _command: string,
    _args: string[],
    _options: SpawnOptions
  ) => {
    spawnCount += 1;
    return child;
  }) as unknown as typeof spawn;
  const processHandle = launchPlaytestAnalystProcess(
    {
      analysisId: "analysis-123",
      workspaceId: "owner/RacingGame",
      actor: "control-api:abcd",
      episodeIds: ["episode-1"],
      analysisKind: "confirmatory",
      requireFindings: false,
      metricAggregation: aggregationFor(["episode-1"])
    },
    {
      environment: {},
      spawnProcess
    }
  );
  assert.equal(spawnCount, 1);
  eventHandlers.get("close")?.(0, null);
  assert.deepEqual(await processHandle.completion, {
    exitCode: 0,
    signal: null,
    timedOut: false,
    launchFailed: false,
    diagnostic: null
  });
});

test("a failed analyst reports what the child said, bounded", async () => {
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  const streamHandlers = new Map<string, (...args: unknown[]) => void>();
  const stream = {
    on(event: string, handler: (...args: unknown[]) => void) {
      streamHandlers.set(event, handler);
      return stream;
    }
  };
  const child = {
    once(event: string, handler: (...args: unknown[]) => void) {
      eventHandlers.set(event, handler);
      return child;
    },
    stdout: stream,
    stderr: stream,
    kill: () => true,
    emitForTest(event: string, ...args: unknown[]) {
      eventHandlers.get(event)?.(...args);
    }
  } as unknown as ChildProcess;
  const spawnProcess = ((
    _command: string,
    _args: string[],
    _options: SpawnOptions
  ) => child) as unknown as typeof spawn;
  const processHandle = launchPlaytestAnalystProcess(
    {
      analysisId: "analysis-123",
      workspaceId: "owner/RacingGame",
      actor: "control-api:abcd",
      episodeIds: ["episode-1"],
      analysisKind: "confirmatory",
      requireFindings: false,
      metricAggregation: aggregationFor(["episode-1"])
    },
    {
      environment: {},
      spawnProcess
    }
  );
  streamHandlers.get("data")?.(
    Buffer.from("error: unexpected argument '--strict-config' found\n")
  );
  eventHandlers.get("close")?.(2, null);
  const result = await processHandle.completion;
  assert.equal(result.exitCode, 2);
  assert.equal(
    result.diagnostic,
    "error: unexpected argument '--strict-config' found",
    "a failed analyst must say why it stopped"
  );
});

test("discovery analyst dispatch has no metric aggregation and receives a hypothesis-only prompt", async () => {
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  const child = {
    once(event: string, handler: (...args: unknown[]) => void) {
      eventHandlers.set(event, handler);
      return child;
    },
    kill: () => true,
    emitForTest(event: string, ...args: unknown[]) {
      eventHandlers.get(event)?.(...args);
    }
  } as unknown as ChildProcess & {
    emitForTest(event: string, ...args: unknown[]): void;
  };
  const calls: {
    args: readonly string[];
    options: SpawnOptions;
  }[] = [];
  const spawnProcess = ((
    _command: string,
    args: string[],
    options: SpawnOptions
  ) => {
    calls.push({ args, options });
    return child;
  }) as unknown as typeof spawn;
  const processHandle = launchPlaytestAnalystProcess(
    {
      analysisId: "analysis-discovery-1",
      workspaceId: "owner/RacingGame",
      actor: "control-api:abcd",
      episodeIds: ["ep-visual-1"],
      analysisKind: "discovery",
      requireFindings: false,
      metricAggregation: null
    },
    { environment: {}, spawnProcess }
  );
  const call = calls[0];
  assert.ok(call);
  const prompt = call.args.at(-1) ?? "";
  const childEnvironment = call.options.env ?? {};
  assert.match(prompt, /analysisKind=discovery/u);
  assert.match(prompt, /playtest.submitDiscoveryReview/u);
  assert.match(prompt, /areasOfFocus as the operator's requested focus/u);
  assert.match(
    prompt,
    /not evidence that an objective was attempted or achieved/u
  );
  assert.match(prompt, /playerSelfReport.*testimony.*hypothesis prompt only/u);
  assert.match(
    prompt,
    /every analyst claim must cite the packet's own visible step\/frame evidence/u
  );
  assert.match(prompt, /unscored discovery only/u);
  assert.doesNotMatch(prompt, /ratio-of-sums/u);
  assert.equal(childEnvironment.AUTODEV_PLAYTEST_ANALYSIS_KIND, "discovery");
  assert.equal(
    childEnvironment.AUTODEV_PLAYTEST_ANALYSIS_METRIC_AGGREGATION,
    undefined
  );
  eventHandlers.get("close")?.(0, null);
  assert.deepEqual(await processHandle.completion, {
    exitCode: 0,
    signal: null,
    timedOut: false,
    launchFailed: false,
    diagnostic: null
  });
});

test("a findings request asks for the strict finding identity, and a hypothesis review omits findings", async () => {
  const prompts: string[] = [];
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  const child = {
    once(event: string, handler: (...args: unknown[]) => void) {
      eventHandlers.set(event, handler);
      return child;
    },
    kill: () => true,
    emitForTest(event: string, ...args: unknown[]) {
      eventHandlers.get(event)?.(...args);
    }
  } as unknown as ChildProcess & {
    emitForTest(event: string, ...args: unknown[]): void;
  };
  const spawnProcess = ((
    _command: string,
    args: string[],
    _options: SpawnOptions
  ) => {
    prompts.push(args.at(-1) ?? "");
    return child;
  }) as unknown as typeof spawn;
  for (const requireFindings of [true, false]) {
    const processHandle = launchPlaytestAnalystProcess(
      {
        analysisId: "analysis-123",
        workspaceId: "owner/RacingGame",
        actor: "control-api:abcd",
        episodeIds: ["episode-1"],
        analysisKind: "confirmatory",
        requireFindings,
        metricAggregation: aggregationFor(["episode-1"])
      },
      { environment: {}, spawnProcess }
    );
    eventHandlers.get("close")?.(0, null);
    await processHandle.completion;
  }
  const [findingsPrompt, hypothesisPrompt] = prompts;
  assert.ok(findingsPrompt);
  assert.ok(hypothesisPrompt);
  // The request says which job the analyst is running, so the two prompts
  // must not both be able to describe themselves as a findings review.
  assert.match(findingsPrompt, /This request requires findings/u);
  assert.match(
    findingsPrompt,
    /\{identity: \{mechanicKey, failureSignature: \{action, witness\}\}, title, description, evidenceStatus: "hypothesis", evidenceRefs\}/u
  );
  assert.match(
    findingsPrompt,
    /mechanicKey must be copied verbatim from one of the packet's metricIntent mechanicKey values/u
  );
  assert.doesNotMatch(findingsPrompt, /Omit findings for this analyst/u);
  assert.match(hypothesisPrompt, /Omit findings for this analyst/u);
  assert.doesNotMatch(hypothesisPrompt, /This request requires findings/u);
});

test("a failed analyst reports what the child said, bounded", async () => {
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  const streamHandlers = new Map<string, (...args: unknown[]) => void>();
  const stream = {
    on(event: string, handler: (...args: unknown[]) => void) {
      streamHandlers.set(event, handler);
      return stream;
    }
  };
  const child = {
    once(event: string, handler: (...args: unknown[]) => void) {
      eventHandlers.set(event, handler);
      return child;
    },
    stdout: stream,
    stderr: stream,
    kill: () => true,
    emitForTest(event: string, ...args: unknown[]) {
      eventHandlers.get(event)?.(...args);
    }
  } as unknown as ChildProcess;
  const spawnProcess = ((
    _command: string,
    _args: string[],
    _options: SpawnOptions
  ) => child) as unknown as typeof spawn;
  const processHandle = launchPlaytestAnalystProcess(
    {
      analysisId: "analysis-123",
      workspaceId: "owner/RacingGame",
      actor: "control-api:abcd",
      episodeIds: ["episode-1"],
      analysisKind: "confirmatory",
      requireFindings: false,
      metricAggregation: aggregationFor(["episode-1"])
    },
    {
      environment: {},
      spawnProcess
    }
  );
  streamHandlers.get("data")?.(
    Buffer.from("error: unexpected argument '--strict-config' found\n")
  );
  eventHandlers.get("close")?.(2, null);
  const result = await processHandle.completion;
  assert.equal(result.exitCode, 2);
  assert.equal(
    result.diagnostic,
    "error: unexpected argument '--strict-config' found",
    "a failed analyst must say why it stopped"
  );
});
