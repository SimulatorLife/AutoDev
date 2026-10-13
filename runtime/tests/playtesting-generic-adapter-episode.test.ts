/**
 * A complete episode through the real adapter entrypoint.
 *
 * The other generic-adapter tests inject a game object directly. That proves
 * dispatch, but it skips everything a game actually depends on: the binding is
 * read from the integration directory, the entry module is imported by URL, and
 * the protocol is served by AutoDev's process rather than a test harness.
 *
 * Here a real game module is written to disk, `main()` is invoked exactly as
 * the adapter image invokes it, and the production `PlaytestAdapterClient`
 * drives a full episode over the same stdio transport the Docker sandbox uses.
 * The only substitution is the process boundary: pipes stand in for the
 * container's streams, because a Docker socket is not available in CI.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  PLAYTESTS_ADAPTER_BINDING_SCHEMA,
  PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES,
  PLAYTESTS_GENERIC_ADAPTER_COMMAND,
  PLAYTESTS_INTEGRATION_DIR,
  type PlaytestObservationContract
} from "@simulatorlife/autodev-core";

import { withObservationSchemaHash } from "../src/playtesting/hash-chain.ts";
import { PlaytestAdapterClient } from "../src/playtesting/adapter-client.ts";
import {
  buildDockerRunArguments,
  type PreparedPlaytestSandbox
} from "../src/playtesting/docker-sandbox.ts";
import {
  PLAYTESTS_ADAPTER_CHECKOUT_ROOT,
  PLAYTESTS_ADAPTER_CHECKOUT_ROOT_ENV,
  integrationDirFrom
} from "../src/playtesting/generic-adapter-main.ts";

/**
 * The sandbox request for a prepared run, without touching a real checkout.
 *
 * `buildDockerRunArguments` validates its inputs before it builds argv, so the
 * mount target is decided by the prepared request rather than by the host
 * filesystem.
 */
function preparedFor(command: readonly string[]): PreparedPlaytestSandbox {
  return {
    workspaceId: "fixture/game",
    checkoutRoot: "/host/checkout",
    checkoutSha: "a".repeat(64),
    imageDigest: `ghcr.io/autodev/adapter@sha256:${"b".repeat(64)}`,
    workingDirectory: "/host/checkout",
    command: [...command],
    limits: {
      cpuCores: 1,
      memoryBytes: 256 * 1024 * 1024,
      processCount: 32,
      wallTimeMs: 10_000,
      artifactBytes: 64 * 1024,
      workerCount: 1,
      episodeCount: 1,
      maxStepsPerEpisode: 10,
      critiqueCount: 0
    },
    configuration: {} as PreparedPlaytestSandbox["configuration"],
    observationContract: {} as PreparedPlaytestSandbox["observationContract"],
    rubric: {} as PreparedPlaytestSandbox["rubric"],
    benchmark: null,
    rubricHash: "c".repeat(64)
  };
}

const ADAPTER_ENTRYPOINT = new URL(
  "../src/playtesting/generic-adapter-main.ts",
  import.meta.url
).pathname;

/**
 * A game with no protocol code: six plain functions and a counter.
 *
 * The revision advances on every step, which is what the protocol requires and
 * what a hand-written adapter most often got wrong.
 */
const GAME_MODULE = `
export function createGame() {
  let revision = 0;
  const episodeId = "episode-declarative-1";
  const at = () => revision;
  return {
    reset: () => ({
      episodeId,
      revision: 0,
      rngProvenance: {
        algorithm: "pcg32",
        version: "fixture-v1",
        initialStateHash: "b".repeat(64),
        reproducible: true
      }
    }),
    observe: () => ({
      episodeId,
      revision: at(),
      observation: { room: "atrium", step: at() },
      turnContext: null,
      frame: null
    }),
    legalActions: () => ({
      episodeId,
      revision: at(),
      actions: [{ actionId: "north", description: "Go north.", features: {} }]
    }),
    step: () => {
      revision += 1;
      return {
        episodeId,
        revision,
        acceptedActionId: "north",
        eventIds: ["event-" + revision],
        terminal: revision >= 3
      };
    },
    outcome: () => ({
      episodeId,
      revision: at(),
      state: "terminal",
      outcome: { steps: at() },
      metrics: {},
      evaluations: [],
      missingReasons: []
    })
  };
}
`;

function observationContract(): PlaytestObservationContract {
  return withObservationSchemaHash({
    schemaVersion: 1 as const,
    mode: "headless" as const,
    cohort: "default",
    visibilityMode: "structured" as const,
    fields: [
      {
        fieldPath: "room",
        unit: null,
        displayRounding: null,
        revelationTiming: "before-action" as const,
        playerRuleRef: "rules/room"
      }
    ],
    uiEquivalence: "unverified" as const,
    conformanceFixtureHash: null
  });
}

/**
 * A checkout holding exactly what a game checks in: the integration directory
 * plus the entry module its binding names.
 *
 * `workingDirectory` is the game's own subdirectory, which is the case that
 * breaks a working-directory-relative integration lookup.
 */
function checkout(workingDirectory: string): {
  readonly root: string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "autodev-playtest-episode-")
  );
  const integration = path.join(root, PLAYTESTS_INTEGRATION_DIR);
  mkdirSync(integration, { recursive: true });
  mkdirSync(path.join(root, workingDirectory), { recursive: true });
  writeFileSync(path.join(integration, "adapter.js"), GAME_MODULE);
  writeFileSync(
    path.join(integration, "playtest.observation.json"),
    `${JSON.stringify(observationContract(), null, 2)}\n`
  );
  writeFileSync(
    path.join(integration, "playtest.config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        adapter: {
          transport: "stdio-jsonl",
          command: [...PLAYTESTS_GENERIC_ADAPTER_COMMAND]
        },
        modes: ["headless"],
        scenarios: ["default"]
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    path.join(integration, "playtest.binding.json"),
    `${JSON.stringify(
      {
        schema: PLAYTESTS_ADAPTER_BINDING_SCHEMA,
        schemaVersion: 1,
        tier: "declarative",
        entry: "adapter.js",
        factory: "createGame",
        schemas: {
          observation: { type: "object", properties: { room: {}, step: {} } },
          action: { type: "object", properties: { actionId: {} } },
          event: { type: "object", properties: { eventId: {} } }
        },
        bindings: {
          reset: { export: "reset" },
          observe: { export: "observe" },
          legalActions: { export: "legalActions" },
          step: { export: "step" },
          outcome: { export: "outcome" }
        }
      },
      null,
      2
    )}\n`
  );
  return {
    root: realpathSync(root),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test("a declarative game runs a full episode through the real adapter entrypoint", async () => {
  const fixture = checkout("game");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      ADAPTER_ENTRYPOINT,
      "--integration-dir",
      PLAYTESTS_INTEGRATION_DIR
    ],
    {
      cwd: path.join(fixture.root, "game"),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // The sandbox mounts the approved checkout at this path; the adapter
        // resolves its integration directory against it rather than against cwd.
        [PLAYTESTS_ADAPTER_CHECKOUT_ROOT_ENV]: fixture.root
      }
    }
  );
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) =>
    stderr.push(chunk.toString("utf8"))
  );
  const client = new PlaytestAdapterClient({
    // The client writes requests into the child's stdin and reads replies from
    // its stdout, the same direction the Docker sandbox pipes use.
    stdin: child.stdin as PassThrough,
    stdout: child.stdout as PassThrough,
    stderr: new PassThrough(),
    onExit: () => {}
  });
  try {
    const capabilities = await client.negotiateCapabilities();
    assert.equal(capabilities.protocolVersion, 1);

    const opened = await client.call("game.reset", {
      seed: "seed-1",
      scenarioId: "default",
      approvedVariantHash: "c".repeat(64)
    });
    assert.equal(
      opened.ok,
      true,
      opened.ok ? "" : `${opened.code} ${opened.message}`
    );

    const observed = await client.call("game.observe", {
      episodeId: "episode-declarative-1",
      expectedRevision: 0
    });
    assert.equal(observed.ok, true);
    assert.deepEqual(
      observed.ok
        ? (observed.result as { observation: unknown }).observation
        : null,
      { room: "atrium", step: 0 }
    );

    const actions = await client.call("game.legalActions", {
      episodeId: "episode-declarative-1",
      expectedRevision: 0
    });
    assert.equal(actions.ok, true);

    // The revision must advance for the next call; a game whose revision is
    // stuck is rejected by the client rather than silently accepted.
    const stepped = await client.step({
      episodeId: "episode-declarative-1",
      actionId: "north",
      expectedRevision: 0
    });
    assert.equal(stepped.ok, true);
    assert.equal(
      stepped.ok ? (stepped.result as { revision: number }).revision : null,
      1
    );

    const settled = await client.call("game.outcome", {
      episodeId: "episode-declarative-1",
      expectedRevision: 1
    });
    assert.equal(settled.ok, true);
    assert.equal(
      settled.ok ? (settled.result as { state: string }).state : null,
      "terminal"
    );
    client.close();
  } finally {
    client.close();
    child.kill("SIGKILL");
    fixture.cleanup();
  }
  assert.deepEqual(
    stderr,
    [],
    "the adapter must not write to stderr on a clean run"
  );
});

test("an unbound method is refused by name over the real transport", async () => {
  const fixture = checkout("game");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      ADAPTER_ENTRYPOINT,
      "--integration-dir",
      PLAYTESTS_INTEGRATION_DIR
    ],
    {
      cwd: path.join(fixture.root, "game"),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        [PLAYTESTS_ADAPTER_CHECKOUT_ROOT_ENV]: fixture.root
      }
    }
  );
  const client = new PlaytestAdapterClient({
    // The client writes requests into the child's stdin and reads replies from
    // its stdout, the same direction the Docker sandbox pipes use.
    stdin: child.stdin as PassThrough,
    stdout: child.stdout as PassThrough,
    stderr: new PassThrough(),
    onExit: () => {}
  });
  try {
    await client.negotiateCapabilities();
    // `game.fork` is not bound by this game. It must be refused rather than
    // answered from a default the Runtime would then report as real.
    const forked = await client.call("game.fork", {
      episodeId: "episode-declarative-1",
      expectedRevision: 0
    });
    assert.equal(forked.ok, false);
    assert.equal(
      forked.ok ? null : forked.code,
      PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.unsupportedCapability
    );
    client.close();
  } finally {
    child.kill("SIGKILL");
    fixture.cleanup();
  }
});
test("the mount the sandbox builds is the path the adapter resolves against", () => {
  // These two are a pair: the sandbox mounts the checkout at one path and the
  // adapter looks for the binding under another. If they drift, the adapter
  // searches outside the read-only mount for a binding that is present, and the
  // game fails onboarding with a file it can see in its own checkout.
  const containerArgs = buildDockerRunArguments(
    preparedFor(PLAYTESTS_GENERIC_ADAPTER_COMMAND),
    "run-paired-paths",
    realpathSync(tmpdir()),
    undefined
  );
  const mounted = containerArgs.find((arg) => arg.startsWith("type=bind,"));
  assert.ok(
    mounted?.includes(`target=${PLAYTESTS_ADAPTER_CHECKOUT_ROOT},readonly`),
    `the checkout must be mounted where the adapter looks: ${String(mounted)}`
  );
  assert.equal(
    integrationDirFrom(["--integration-dir", PLAYTESTS_INTEGRATION_DIR]),
    `${PLAYTESTS_ADAPTER_CHECKOUT_ROOT}/${PLAYTESTS_INTEGRATION_DIR}`
  );
  // The integration directory is checkout-root relative, never working
  // directory relative: the game's own directory is not where it keeps this.
  assert.equal(
    integrationDirFrom([], "/some/other/game/dir"),
    `/some/other/game/dir/${PLAYTESTS_INTEGRATION_DIR}`
  );
});
