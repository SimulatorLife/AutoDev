import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFileSync,
  type SpawnOptions
} from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  defaultPlaytestRegistryDefaults,
  PLAYTESTS_ADAPTER_BINDING_SCHEMA,
  PLAYTESTS_GENERIC_ADAPTER_COMMAND,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";

import type { PlaytestAdapterExit } from "../src/playtesting/adapter-client.ts";
import {
  assertLocalDockerAvailable,
  buildDockerRunArguments,
  launchPlaytestSandbox,
  localDockerSocket,
  PlaytestSandboxApprovalError,
  PlaytestSandboxExecutionError,
  PlaytestSandboxUnavailableError,
  preparePlaytestSandbox,
  runPlaytestSandbox
} from "../src/playtesting/docker-sandbox.ts";
import { playtestManifestHash } from "../src/playtesting/hash-chain.ts";

/** Runtime snapshot root, isolated from the operator's CODEX_HOME. */
const SNAPSHOT_ROOT = realpathSync(
  mkdtempSync(path.join(tmpdir(), "autodev-playtest-snapshots-"))
);
test.after(() => rmSync(SNAPSHOT_ROOT, { recursive: true, force: true }));

function prepare(
  approved: WorkspacePlaytestApproval,
  now?: () => number
): ReturnType<typeof preparePlaytestSandbox> {
  return preparePlaytestSandbox(approved, {
    snapshotRoot: SNAPSHOT_ROOT,
    ...(now === undefined ? {} : { now })
  });
}

function headSha(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
}

function commitAll(root: string, message: string): void {
  execFileSync("git", ["-C", root, "add", "--all"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Playtest test",
    "commit",
    "--quiet",
    "-m",
    message
  ]);
}

const OBSERVATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { room: { type: "string" } },
  required: ["room"]
};
const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { actionId: { type: "string" } },
  required: ["actionId"]
};
const EVENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { kind: { type: "string" } },
  required: ["kind"]
};
const STANDARD_COMMAND = PLAYTESTS_GENERIC_ADAPTER_COMMAND;

function fixtureRubric(): string {
  return (
    JSON.stringify({
      schemaVersion: 2,
      workspaceId: "fixture/game",
      audience: "synthetic-fixture-only",
      registryVersion: "docker-sandbox-fixture-v2",
      eventSchemaHash: playtestManifestHash(EVENT_SCHEMA),
      defaults: {
        ...defaultPlaytestRegistryDefaults(),
        audience: "synthetic-fixture-only",
        scenarioEligibility: ["default"]
      },
      metricDefinitions: [
        {
          metricId: "legal-action-rejection",
          version: 1,
          mechanicKey: "action-execution",
          aggregationWindow: "phase",
          exposurePredicate: "fresh-legal-request-v1",
          eventFields: ["action.offeredIds", "action.expectedRevision"],
          evaluatorRef: "fixture/legal-action-rejection-v1",
          evaluatorHash: "1".repeat(64),
          numerator: "fresh advertised legal requests rejected by engine",
          denominator: "all fresh advertised legal requests",
          unit: "proportion",
          polarity: "lower",
          targetBand: [0, 0],
          notObservable: ["missing-action-or-revision-events"]
        }
      ],
      coverageRequirements: [
        {
          coverageMetricId: "legal-action-rejection",
          mechanicKey: "action-execution",
          phaseId: "tutorial",
          scenarioFamily: "default",
          cohort: "novice",
          policy: "random",
          modality: "headless",
          requiredOpportunities: 10,
          requiredIndependentUnits: 1,
          unsupportedReason: null
        }
      ],
      dimensionRubrics: []
    }) + "\n"
  );
}

function configFor(): string {
  return (
    JSON.stringify({
      schemaVersion: 1,
      adapter: {
        transport: "stdio-jsonl",
        command: [...PLAYTESTS_GENERIC_ADAPTER_COMMAND]
      },
      modes: ["headless"],
      scenarios: ["default"],
      scenarioFamilies: { default: "default" },
      policies: ["heuristic"],
      budget: {
        episodes: 10,
        maxStepsPerEpisode: 100,
        workers: 1,
        wallTimeMinutes: 1
      },
      analysis: {
        rubric: "playtest.rubric.json",
        observationContract: "playtest.observation.json",
        benchmark: null,
        critic: "auto",
        maxReviewedSessions: 0,
        reviewSelection: {
          surveillanceSessions: 0,
          discoverySessions: 0,
          discoverySignal: null
        },
        visualCapture: "off",
        counterfactuals: "off",
        understandingProbes: "off",
        learningCohorts: "off",
        humanCalibration: "off"
      },
      reporting: { githubIssues: "disabled" }
    }) + "\n"
  );
}

function repository(): {
  readonly root: string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "autodev-playtest-repo-")
  );
  mkdirSync(path.join(root, ".autodev"));
  writeFileSync(
    path.join(root, ".autodev", "playtest.config.json"),
    configFor()
  );
  writeFileSync(
    path.join(root, ".autodev", "playtest.observation.json"),
    JSON.stringify({
      schemaVersion: 1,
      schemaHash: playtestManifestHash(OBSERVATION_SCHEMA),
      mode: "headless",
      cohort: "fixture",
      visibilityMode: "structured",
      fields: [
        {
          fieldPath: "room",
          unit: null,
          displayRounding: null,
          revelationTiming: "before-action",
          playerRuleRef: "fixture/rules/room"
        }
      ],
      uiEquivalence: "unverified",
      conformanceFixtureHash: null
    }) + "\n"
  );
  writeFileSync(
    path.join(root, ".autodev", "playtest.binding.json"),
    JSON.stringify(
      {
        schema: PLAYTESTS_ADAPTER_BINDING_SCHEMA,
        schemaVersion: 1,
        tier: "declarative",
        entry: "node-fixture-game.mjs",
        factory: "createGame",
        schemas: {
          observation: OBSERVATION_SCHEMA,
          action: ACTION_SCHEMA,
          event: EVENT_SCHEMA
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
    ) + "\n"
  );
  writeFileSync(
    path.join(root, ".autodev", "node-fixture-game.mjs"),
    "export function createGame() { return {}; }\n"
  );
  writeFileSync(
    path.join(root, ".autodev", "playtest.rubric.json"),
    fixtureRubric()
  );
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", [
    "-C",
    root,
    "add",
    ".autodev/playtest.config.json",
    ".autodev/playtest.binding.json",
    ".autodev/node-fixture-game.mjs",
    ".autodev/playtest.observation.json",
    ".autodev/playtest.rubric.json"
  ]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Playtest test",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  ]);
  return {
    root: realpathSync(root),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function approval(root: string): WorkspacePlaytestApproval {
  return {
    schema: "autodev-workspace-playtest-approval-v2",
    workspaceId: "fixture/game",
    revision: 1,
    approvalId: "approval-1",
    checkoutRoot: realpathSync(root),
    adapterImageDigest: `ghcr.io/fixture/game@sha256:${"a".repeat(64)}`,
    workingDirectory: ".",
    adapterCommand: [...STANDARD_COMMAND],
    allowedScenarios: ["default"],
    allowedPolicies: ["heuristic"],
    limits: {
      cpuCores: 1,
      memoryBytes: 256 * 1024 * 1024,
      processCount: 32,
      wallTimeMs: 10_000,
      artifactBytes: 64 * 1024,
      workerCount: 1,
      episodeCount: 10,
      maxStepsPerEpisode: 100,
      critiqueCount: 0
    },
    retentionDays: 30,
    issueReporting: "disabled",
    humanStudyAllowed: false,
    approvedAt: "2026-10-09T12:00:00.000Z",
    approvedBy: "test-operator",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null
  };
}

/**
 * `sockaddr_un.sun_path` is a fixed-size buffer -- 104 bytes on macOS, 108 on
 * Linux, NUL terminator included -- so `listen()` rejects an over-long path
 * with `EINVAL` before it ever binds. A deep `TMPDIR` (long-lived sandbox
 * session directories, some CI runners) therefore breaks this fixture even
 * though the filesystem has room; production does not share the problem
 * because `localDockerSocket` returns a fixed short path.
 */
const SUN_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;
// Short prefix: every character here comes out of the socket path budget, and
// `mkdtemp` appends six more. The socket name is fixed by the mock engine.
const SOCKET_DIR_PREFIX = "agy-";
const SOCKET_NAME = "engine.sock";

/** Standard temporary roots, shortest-fitting first; `tmpdir` is preferred. */
function socketTempRoots(): string[] {
  const roots = [tmpdir()];
  if (process.platform !== "win32") roots.push("/tmp", "/var/tmp");
  return roots;
}

/**
 * Create the directory that will hold the socket, preferring `tmpdir()` but
 * falling back to shorter standard roots when `tmpdir()` alone would overflow
 * `sun_path`. Reports every candidate it rejected so a genuine failure says
 * which roots were unusable and why, rather than surfacing as an opaque
 * `EINVAL` from `listen()`.
 */
function createSocketDirectory(): string {
  const rejected: string[] = [];
  for (const root of socketTempRoots()) {
    const directory = path.join(root, `${SOCKET_DIR_PREFIX}XXXXXX`);
    // mkdtemp replaces the six X characters with random ones.
    const projected = path.join(directory, SOCKET_NAME);
    if (Buffer.byteLength(projected) >= SUN_PATH_LIMIT) {
      rejected.push(
        `${projected} needs ${Buffer.byteLength(projected)} bytes of a ${SUN_PATH_LIMIT}-byte sun_path`
      );
      continue;
    }
    try {
      return mkdtempSync(directory);
    } catch (error) {
      rejected.push(
        `${root}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  throw new Error(
    `Unable to create a directory for a Unix socket path: ${rejected.join("; ")}`
  );
}

async function withLocalSocket<T>(
  run: (socket: string) => Promise<T>
): Promise<T> {
  const directory = createSocketDirectory();
  const socket = path.join(directory, SOCKET_NAME);
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    return await run(socket);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

// eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess inherits from EventEmitter in node:child_process
class MockChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  killSignal: NodeJS.Signals | null = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGKILL"): boolean {
    this.killed = true;
    this.killSignal = signal;
    this.signalCode = signal;
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", null, signal);
    });
    return true;
  }

  simulateExit(code: number, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", code, signal);
    });
  }

  simulateError(error: Error): void {
    setImmediate(() => {
      this.emit("error", error);
    });
  }
}

test("sandbox snapshots the checkout's latest commit with its own config hash", () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));
    const sha = headSha(fixture.root);
    assert.equal(prepared.sourceCheckoutRoot, fixture.root);
    assert.deepEqual(prepared.build, {
      buildSha: sha,
      gameBuild: sha,
      configHash: createHash("sha256").update(configFor()).digest("hex")
    });
    assert.ok(prepared.checkoutRoot.startsWith(SNAPSHOT_ROOT + path.sep));
    assert.equal(path.basename(prepared.checkoutRoot), sha);
    assert.equal(prepared.workingDirectory, prepared.checkoutRoot);
    assert.deepEqual(prepared.command, PLAYTESTS_GENERIC_ADAPTER_COMMAND);
    assert.equal(
      readFileSync(
        path.join(prepared.checkoutRoot, ".autodev", "playtest.config.json"),
        "utf8"
      ),
      configFor()
    );
  } finally {
    fixture.cleanup();
  }
});

test("uncommitted, untracked, and ignored files never reach the build snapshot", () => {
  const fixture = repository();
  try {
    writeFileSync(path.join(fixture.root, ".gitignore"), ".env\n");
    commitAll(fixture.root, "ignore local secret files");
    writeFileSync(path.join(fixture.root, ".env"), "API_SECRET=no\n");
    writeFileSync(path.join(fixture.root, "untracked.txt"), "no\n");
    writeFileSync(
      path.join(fixture.root, ".autodev", "node-fixture-game.mjs"),
      "export function createGame() { throw new Error('in progress'); }\n"
    );
    const prepared = prepare(approval(fixture.root));
    assert.equal(prepared.build.buildSha, headSha(fixture.root));
    assert.equal(existsSync(path.join(prepared.checkoutRoot, ".env")), false);
    assert.equal(
      existsSync(path.join(prepared.checkoutRoot, "untracked.txt")),
      false
    );
    assert.equal(
      readFileSync(
        path.join(prepared.checkoutRoot, ".autodev", "node-fixture-game.mjs"),
        "utf8"
      ),
      "export function createGame() { return {}; }\n"
    );
    // The operator's own index and working tree are untouched.
    assert.equal(
      execFileSync("git", ["-C", fixture.root, "status", "--porcelain"], {
        encoding: "utf8"
      }),
      " M .autodev/node-fixture-game.mjs\n?? untracked.txt\n"
    );
  } finally {
    fixture.cleanup();
  }
});

test("each batch follows the newest commit without re-approval and prunes stale snapshots", () => {
  const fixture = repository();
  try {
    const approved = approval(fixture.root);
    let clock = Date.parse("2026-10-15T00:00:00.000Z");
    const first = prepare(approved, () => clock);
    assert.equal(
      prepare(approved, () => clock).checkoutRoot,
      first.checkoutRoot
    );

    writeFileSync(path.join(fixture.root, "CHANGELOG.md"), "next build\n");
    commitAll(fixture.root, "next build");
    clock += 3 * 60 * 60 * 1000;
    const second = prepare(approved, () => clock);
    assert.equal(second.build.buildSha, headSha(fixture.root));
    assert.notEqual(second.build.buildSha, first.build.buildSha);
    assert.notEqual(second.checkoutRoot, first.checkoutRoot);
    assert.ok(existsSync(path.join(second.checkoutRoot, "CHANGELOG.md")));
    assert.equal(
      existsSync(first.checkoutRoot),
      false,
      "a snapshot unused for longer than the retention window is pruned"
    );
  } finally {
    fixture.cleanup();
  }
});

test("a commit that does not track .autodev/ is refused before any sandbox", () => {
  const fixture = repository();
  try {
    execFileSync("git", [
      "-C",
      fixture.root,
      "rm",
      "--cached",
      "-r",
      "-q",
      ".autodev"
    ]);
    writeFileSync(path.join(fixture.root, ".gitignore"), ".autodev/\n");
    commitAll(fixture.root, "ignore autodev");
    assert.throws(
      () => prepare(approval(fixture.root)),
      /playtest\.config\.json/u
    );
  } finally {
    fixture.cleanup();
  }
});

test("sandbox refuses an adapter command the operator did not approve", () => {
  const fixture = repository();
  try {
    assert.throws(
      () =>
        prepare({
          ...approval(fixture.root),
          adapterCommand: ["/bin/sh", "-c", "touch /tmp/unauthorized"]
        }),
      /exact operator approval/u
    );
  } finally {
    fixture.cleanup();
  }
});

test("sandbox rejects committed workspace escapes, missing directories, and unpinned images", () => {
  const fixture = repository();
  const outside = mkdtempSync(path.join(tmpdir(), "autodev-playtest-outside-"));
  try {
    symlinkSync(outside, path.join(fixture.root, "outside"));
    commitAll(fixture.root, "commit an escaping symlink");
    assert.throws(
      () =>
        prepare({
          ...approval(fixture.root),
          workingDirectory: "outside"
        }),
      /escapes the approved checkout/u
    );
    assert.throws(
      () =>
        prepare({
          ...approval(fixture.root),
          workingDirectory: "not-committed"
        }),
      /does not exist in the latest commit/u
    );
    assert.throws(
      () =>
        prepare({
          ...approval(fixture.root),
          adapterImageDigest: "fixture/game:latest"
        }),
      /approval is invalid/u
    );
    assert.ok(lstatSync(path.join(fixture.root, "outside")).isSymbolicLink());
  } finally {
    fixture.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("Docker argv enforces a local, read-only, networkless container with hard quotas", async () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));
    await withLocalSocket(async (socket) => {
      const args = buildDockerRunArguments(
        prepared,
        "run-42",
        fixture.root,
        socket
      );
      const joined = args.join(" ");
      assert.equal(args[0], "--host");
      assert.equal(args[1], `unix://${socket}`);
      assert.ok(args.includes("--pull=never"));
      assert.ok(args.includes("--network=none"));
      assert.ok(args.includes("--read-only"));
      assert.ok(args.includes("--cap-drop=ALL"));
      assert.ok(args.includes("--security-opt=no-new-privileges"));
      assert.ok(args.includes("--log-driver=none"));
      assert.ok(args.includes("--pids-limit"));
      assert.ok(args.includes("--memory-swap"));
      assert.ok(args.includes("--cpus"));
      assert.ok(joined.includes("type=bind,source=" + prepared.checkoutRoot));
      assert.ok(joined.includes("target=/workspace,readonly"));
      assert.ok(joined.includes("/artifacts:rw,noexec,nosuid,nodev"));
      assert.ok(joined.includes("ghcr.io/fixture/game@sha256:"));
      const entrypointIndex = args.indexOf("--entrypoint");
      assert.notEqual(entrypointIndex, -1);
      assert.equal(
        args[entrypointIndex + 1],
        PLAYTESTS_GENERIC_ADAPTER_COMMAND[0]
      );
      assert.ok(
        args.includes(
          "AUTODEV_PLAYTEST_ENGINE_BUILD=" + prepared.build.gameBuild
        )
      );
      assert.doesNotMatch(joined, /--gpus|DOCKER_HOST=.*tcp/u);
      assert.doesNotMatch(joined, /--env .*API_KEY|--env .*TOKEN/u);
    });
  } finally {
    fixture.cleanup();
  }
});

test("branch traces enter through a SHA-addressed read-only mount and are removed after exit", async () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));
    const bytes = Buffer.from("verified replay trace", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const reference = {
      artifactId: "runtime-private-trace-id",
      sha256,
      bytes: bytes.byteLength,
      mediaType: "application/x-ndjson"
    };
    let capturedArgs: readonly string[] = [];
    let inputDirectory: string | null = null;

    await withLocalSocket(async (socket) => {
      const mockChild = new MockChildProcess();
      const sandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        inputArtifacts: [{ reference, bytes }],
        spawn: (_command, args) => {
          capturedArgs = args;
          const mount = args.find(
            (arg) =>
              arg.startsWith("type=bind,source=") &&
              arg.includes("target=/run/autodev-playtest-input")
          );
          assert.ok(mount);
          const targetSeparator = ",target=";
          const targetIndex = mount.indexOf(targetSeparator);
          assert.notEqual(targetIndex, -1);
          inputDirectory = mount.slice("type=bind,source=".length, targetIndex);
          const inputFile = path.join(inputDirectory, sha256);
          assert.deepEqual(readFileSync(inputFile), bytes);
          assert.equal(lstatSync(inputFile).mode & 0o777, 0o400);
          mockChild.simulateExit(0);
          return mockChild as unknown as ChildProcess;
        },
        execFile: () => ""
      });
      await sandbox.result;
      const mount = capturedArgs.find((arg) =>
        arg.includes("target=/run/autodev-playtest-input")
      );
      assert.match(mount ?? "", /,readonly$/u);
      assert.ok(
        capturedArgs.includes(
          "AUTODEV_PLAYTEST_INPUT_DIR=/run/autodev-playtest-input"
        )
      );
      assert.ok(
        capturedArgs.includes("AUTODEV_PLAYTEST_OUTPUT_DIR=/artifacts")
      );
      await sandbox.cleanup();
      assert.ok(inputDirectory);
      assert.equal(existsSync(inputDirectory), false);
    });

    await withLocalSocket(async (socket) => {
      let launched = false;
      await assert.rejects(
        launchPlaytestSandbox(prepared, {
          socket,
          inputArtifacts: [{ reference, bytes: Buffer.from("tampered") }],
          inspectImage: () => true,
          spawn: () => {
            launched = true;
            return new MockChildProcess() as unknown as ChildProcess;
          },
          execFile: () => ""
        }),
        PlaytestSandboxApprovalError
      );
      assert.equal(launched, false);
    });
  } finally {
    fixture.cleanup();
  }
});

test("Docker host resolution refuses remote-only platforms", () => {
  assert.equal(
    localDockerSocket("linux", "/home/test"),
    "/var/run/docker.sock"
  );
  assert.equal(
    localDockerSocket("darwin", "/Users/test"),
    "/Users/test/.docker/run/docker.sock"
  );
  assert.throws(
    () => localDockerSocket("win32"),
    PlaytestSandboxUnavailableError
  );
});

test("adversarial: docker unavailable and remote sockets fail closed", async () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));
    assert.throws(
      () => assertLocalDockerAvailable("/no/such/socket.sock"),
      PlaytestSandboxUnavailableError
    );
    const nonSocket = path.join(
      fixture.root,
      ".autodev",
      "node-fixture-game.mjs"
    );
    assert.throws(
      () => assertLocalDockerAvailable(nonSocket),
      PlaytestSandboxUnavailableError
    );
    await assert.rejects(async () => {
      await launchPlaytestSandbox(prepared, {
        socket: "/no/such/docker.sock",
        inspectImage: () => true
      });
    }, PlaytestSandboxUnavailableError);
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: pinned-image enforcement prevents execution without local image and pulls", async () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));
    await withLocalSocket(async (socket) => {
      await assert.rejects(async () => {
        await launchPlaytestSandbox(prepared, {
          socket,
          inspectImage: () => false
        });
      }, /not locally available without pulling/u);
      const args = buildDockerRunArguments(
        prepared,
        "run-check",
        fixture.root,
        socket
      );
      assert.ok(args.includes("--pull=never"));
    });
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: Docker never uses a shell when serializing argv", async () => {
  const unescapedCommand = [
    "/bin/bash",
    "-c",
    "echo 'hello $WORLD' > /artifacts/out.txt; rm -rf /",
    "arg with spaces & pipes |"
  ];
  const fixture = repository();
  try {
    const approved = prepare(approval(fixture.root));
    // Inject an adversarial argv vector at the low-level launcher seam. The
    // approved-config path only permits AutoDev's generic adapter command.
    const prepared = { ...approved, command: unescapedCommand };

    let capturedCommand = "";
    let capturedArgs: readonly string[] = [];
    let capturedOptions: SpawnOptions | undefined;

    await withLocalSocket(async (socket) => {
      const mockChild = new MockChildProcess();
      const sandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        spawn: (cmd, args, options) => {
          capturedCommand = cmd;
          capturedArgs = args;
          capturedOptions = options;
          mockChild.simulateExit(0);
          return mockChild as unknown as ChildProcess;
        },
        execFile: () => ""
      });

      const result = await sandbox.result;
      assert.equal(result.exitCode, 0);
      assert.equal(capturedCommand, "docker");
      assert.equal(capturedOptions?.shell, false);

      const entrypointIndex = capturedArgs.indexOf("--entrypoint");
      assert.notEqual(entrypointIndex, -1);
      assert.equal(capturedArgs[entrypointIndex + 1], "/bin/bash");
      assert.equal(
        capturedArgs.at(-2),
        "echo 'hello $WORLD' > /artifacts/out.txt; rm -rf /"
      );
      assert.equal(capturedArgs.at(-1), "arg with spaces & pipes |");
    });
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: cancellation kills child process and forces container removal", async () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));
    const dockerCommands: string[][] = [];

    await withLocalSocket(async (socket) => {
      const mockChild = new MockChildProcess();
      let exitSignal: NodeJS.Signals | null = null;

      const sandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        spawn: () => mockChild as unknown as ChildProcess,
        execFile: (_file, args) => {
          dockerCommands.push([...args]);
          return "";
        }
      });

      sandbox.onExit((cause: PlaytestAdapterExit) => {
        exitSignal = cause.signal;
      });

      await sandbox.cancel("Operator cancelled");

      await assert.rejects(
        async () => {
          await sandbox.result;
        },
        (error: unknown) => {
          assert.ok(error instanceof PlaytestSandboxExecutionError);
          assert.equal(error.category, "cancelled");
          return true;
        }
      );

      assert.equal(mockChild.killed, true);
      assert.equal(mockChild.killSignal, "SIGKILL");
      assert.equal(exitSignal, "SIGKILL");
      const rmCalls = dockerCommands.filter(
        (call) => call.includes("rm") && call.includes("--force")
      );
      assert.ok(rmCalls.length > 0);
    });
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: wall-time timeout terminates container and preserves partial evidence", async () => {
  const fixture = repository();
  try {
    const approved = {
      ...approval(fixture.root),
      limits: {
        ...approval(fixture.root).limits,
        wallTimeMs: 1000
      }
    };
    const prepared = prepare(approved);
    const dockerCommands: string[][] = [];

    await withLocalSocket(async (socket) => {
      const mockChild = new MockChildProcess();

      const sandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        spawn: () => mockChild as unknown as ChildProcess,
        execFile: (_file, args) => {
          dockerCommands.push([...args]);
          return "";
        }
      });

      await assert.rejects(
        async () => {
          await sandbox.result;
        },
        (error: unknown) => {
          assert.ok(error instanceof PlaytestSandboxExecutionError);
          assert.equal(error.category, "timeout");
          return true;
        }
      );

      assert.equal(mockChild.killed, true);
      assert.equal(mockChild.killSignal, "SIGKILL");
      const rmCalls = dockerCommands.filter(
        (call) => call.includes("rm") && call.includes("--force")
      );
      assert.ok(rmCalls.length > 0);
    });
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: process spawn error is captured with clean container teardown", async () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));

    await withLocalSocket(async (socket) => {
      const mockChild = new MockChildProcess();
      const sandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        spawn: () => {
          mockChild.simulateError(new Error("spawn ENOENT docker"));
          return mockChild as unknown as ChildProcess;
        },
        execFile: () => ""
      });

      await assert.rejects(
        async () => {
          await sandbox.result;
        },
        (error: unknown) => {
          assert.ok(error instanceof PlaytestSandboxExecutionError);
          assert.equal(error.category, "process-error");
          assert.match(error.message, /ENOENT/u);
          return true;
        }
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: exit code is captured and reported on non-zero exit", async () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));

    await withLocalSocket(async (socket) => {
      const mockChild = new MockChildProcess();
      let capturedExit: PlaytestAdapterExit | null = null;

      const sandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        spawn: () => {
          mockChild.simulateExit(42);
          return mockChild as unknown as ChildProcess;
        },
        execFile: () => ""
      });

      sandbox.onExit((cause) => {
        capturedExit = cause;
      });

      await assert.rejects(
        async () => {
          await sandbox.result;
        },
        (error: unknown) => {
          assert.ok(error instanceof PlaytestSandboxExecutionError);
          assert.equal(error.category, "exit-code");
          assert.equal(error.exitCode, 42);
          return true;
        }
      );

      assert.equal((capturedExit as PlaytestAdapterExit | null)?.code, 42);
    });
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: output limits abort execution and force kill container", async () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));

    await withLocalSocket(async (socket) => {
      const mockChild = new MockChildProcess();

      const sandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        maxOutputBytes: 64,
        spawn: () => {
          setImmediate(() => {
            mockChild.stdout.write(Buffer.alloc(128, "x"));
          });
          return mockChild as unknown as ChildProcess;
        },
        execFile: () => ""
      });

      await assert.rejects(
        async () => {
          await sandbox.result;
        },
        (error: unknown) => {
          assert.ok(error instanceof PlaytestSandboxExecutionError);
          assert.equal(error.category, "output-limit");
          return true;
        }
      );

      assert.equal(mockChild.killed, true);
    });
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: artifact symlink rejection, byte quota, and staging cleanup", async () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));

    await withLocalSocket(async (socket) => {
      // 1. Symlink rejection
      const mockSymlink = new MockChildProcess();
      const symlinkSandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        spawn: () => {
          mockSymlink.simulateExit(0);
          return mockSymlink as unknown as ChildProcess;
        },
        execFile: (_file, args) => {
          if (args.includes("cp")) {
            const stagingDir = args.at(-1);
            if (stagingDir) {
              symlinkSync("/etc/passwd", path.join(stagingDir, "escape.link"));
            }
          }
          return "";
        }
      });

      await assert.rejects(
        async () => {
          await symlinkSandbox.result;
        },
        (error: unknown) => {
          assert.ok(error instanceof PlaytestSandboxExecutionError);
          assert.equal(error.category, "artifact-error");
          assert.match(error.message, /forbidden symbolic link/u);
          return true;
        }
      );

      // 2. Byte quota rejection
      const mockSize = new MockChildProcess();
      const sizeSandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        maxArtifactBytes: 100,
        spawn: () => {
          mockSize.simulateExit(0);
          return mockSize as unknown as ChildProcess;
        },
        execFile: (_file, args) => {
          if (args.includes("cp")) {
            const stagingDir = args.at(-1);
            if (stagingDir) {
              writeFileSync(
                path.join(stagingDir, "oversized.bin"),
                Buffer.alloc(200)
              );
            }
          }
          return "";
        }
      });

      await assert.rejects(
        async () => {
          await sizeSandbox.result;
        },
        (error: unknown) => {
          assert.ok(error instanceof PlaytestSandboxExecutionError);
          assert.equal(error.category, "artifact-error");
          assert.match(error.message, /total bytes.*exceeded limit/u);
          return true;
        }
      );

      // 3. Valid artifacts with partial preservation on failed run & cleanup
      const mockPreserve = new MockChildProcess();
      const preserveSandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        spawn: () => {
          mockPreserve.simulateExit(1);
          return mockPreserve as unknown as ChildProcess;
        },
        execFile: (_file, args) => {
          if (args.includes("cp")) {
            const stagingDir = args.at(-1);
            if (stagingDir) {
              writeFileSync(
                path.join(stagingDir, "metrics.json"),
                '{"score":10}'
              );
            }
          }
          return "";
        }
      });

      await assert.rejects(
        async () => {
          await preserveSandbox.result;
        },
        (error: unknown) => {
          assert.ok(error instanceof PlaytestSandboxExecutionError);
          assert.equal(error.category, "exit-code");
          assert.ok(
            error.partialArtifacts && error.partialArtifacts.length === 1
          );
          assert.equal(error.partialArtifacts[0]?.relativePath, "metrics.json");
          return true;
        }
      );

      await preserveSandbox.cleanup();
    });
  } finally {
    fixture.cleanup();
  }
});

test("adversarial: sanitized environment strips host credentials and disallows GPU", async () => {
  const fixture = repository();
  const originalEnv = { ...process.env };
  try {
    process.env.OPENAI_API_KEY = "sk-adversarial-secret";
    process.env.GITHUB_TOKEN = "ghp-adversarial-token";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-adversarial-secret";
    process.env.DOCKER_AUTH = "docker-adversarial-auth";

    const prepared = prepare(approval(fixture.root));

    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    let spawnedArgs: readonly string[] = [];

    await withLocalSocket(async (socket) => {
      const mockChild = new MockChildProcess();
      const sandbox = await launchPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        spawn: (_cmd, args, options) => {
          spawnedArgs = args;
          spawnedEnv = options.env;
          mockChild.simulateExit(0);
          return mockChild as unknown as ChildProcess;
        },
        execFile: () => ""
      });

      await sandbox.result;

      assert.ok(spawnedEnv);
      assert.equal(spawnedEnv.OPENAI_API_KEY, undefined);
      assert.equal(spawnedEnv.GITHUB_TOKEN, undefined);
      assert.equal(spawnedEnv.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(spawnedEnv.DOCKER_AUTH, undefined);
      assert.ok(spawnedEnv.HOME);
      assert.ok(spawnedEnv.DOCKER_CONFIG);
      assert.equal(spawnedEnv.HOME, spawnedEnv.DOCKER_CONFIG);

      const joinedArgs = spawnedArgs.join(" ");
      assert.doesNotMatch(joinedArgs, /--gpus/u);
      assert.doesNotMatch(
        joinedArgs,
        /sk-adversarial|ghp-adversarial|aws-adversarial/u
      );
    });
  } finally {
    process.env = originalEnv;
    fixture.cleanup();
  }
});

test("runPlaytestSandbox runs an approved container sandbox to completion", async () => {
  const fixture = repository();
  try {
    const prepared = prepare(approval(fixture.root));
    await withLocalSocket(async (socket) => {
      const mockChild = new MockChildProcess();
      const result = await runPlaytestSandbox(prepared, {
        socket,
        inspectImage: () => true,
        spawn: () => {
          mockChild.simulateExit(0);
          return mockChild as unknown as ChildProcess;
        },
        execFile: () => ""
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.equal(result.cancelled, false);
    });
  } finally {
    fixture.cleanup();
  }
});
