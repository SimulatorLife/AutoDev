import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFileSync,
  type SpawnOptions
} from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  lstatSync,
  mkdtempSync,
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

const STANDARD_COMMAND = ["/usr/bin/python3", "adapter.py"] as const;

function fixtureRubric(): string {
  return (
    JSON.stringify({
      schemaVersion: 1,
      workspaceId: "fixture/game",
      audience: "synthetic-fixture-only",
      registryVersion: "docker-sandbox-fixture-v1",
      eventSchemaHash: "d".repeat(64),
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
          exposurePredicate: "fresh-legal-request-v1",
          eventFields: ["action.offeredIds", "action.expectedRevision"],
          evaluatorRef: "fixture/legal-action-rejection-v1",
          numerator: "fresh advertised legal requests rejected by engine",
          denominator: "all fresh advertised legal requests",
          unit: "proportion",
          polarity: "lower",
          targetBand: [0, 0],
          notObservable: ["missing-action-or-revision-events"]
        }
      ],
      dimensionRubrics: []
    }) + "\n"
  );
}

function configFor(command: readonly string[]): string {
  return (
    JSON.stringify({
      schemaVersion: 1,
      adapter: { transport: "stdio-jsonl", command },
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
        maxReviewedSessions: 10,
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

function repository(command: readonly string[] = STANDARD_COMMAND): {
  readonly root: string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "autodev-playtest-repo-")
  );
  writeFileSync(path.join(root, "adapter.py"), "print('adapter')\n");
  writeFileSync(path.join(root, "playtest.config.json"), configFor(command));
  writeFileSync(
    path.join(root, "playtest.observation.json"),
    JSON.stringify({
      schemaVersion: 1,
      schemaHash: "d".repeat(64),
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
  writeFileSync(path.join(root, "playtest.rubric.json"), fixtureRubric());
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", [
    "-C",
    root,
    "add",
    "adapter.py",
    "playtest.config.json",
    "playtest.observation.json",
    "playtest.rubric.json"
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

function approval(
  root: string,
  command: readonly string[] = STANDARD_COMMAND
): WorkspacePlaytestApproval {
  const buildSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
  return {
    schema: "autodev-workspace-playtest-approval-v1",
    workspaceId: "fixture/game",
    revision: 1,
    approvalId: "approval-1",
    checkoutRoot: realpathSync(root),
    buildSha,
    gameBuild: "fixture-game-build",
    playtestConfigHash: createHash("sha256")
      .update(configFor(command))
      .digest("hex"),
    adapterImageDigest: `ghcr.io/fixture/game@sha256:${"a".repeat(64)}`,
    workingDirectory: ".",
    adapterCommand: [...command],
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

async function withLocalSocket<T>(
  run: (socket: string) => Promise<T>
): Promise<T> {
  const directory = mkdtempSync(path.join(tmpdir(), "autodev-docker-socket-"));
  const socket = path.join(directory, "engine.sock");
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

test("sandbox approval pins a clean checkout, command, image, and bounded resources", () => {
  const fixture = repository();
  try {
    const prepared = preparePlaytestSandbox(approval(fixture.root));
    assert.equal(prepared.checkoutRoot, fixture.root);
    assert.match(prepared.checkoutSha, /^[a-f\d]{40}$/u);
    assert.deepEqual(prepared.command, ["/usr/bin/python3", "adapter.py"]);
    assert.equal(prepared.workingDirectory, fixture.root);
  } finally {
    fixture.cleanup();
  }
});

test("sandbox refuses a changed build, dirty checkout, and unapproved command", () => {
  const fixture = repository();
  try {
    const approved = approval(fixture.root);
    assert.throws(
      () => preparePlaytestSandbox({ ...approved, buildSha: "f".repeat(40) }),
      PlaytestSandboxApprovalError
    );
    writeFileSync(path.join(fixture.root, "untracked.txt"), "no\n");
    assert.throws(
      () => preparePlaytestSandbox(approved),
      /modified, untracked, or ignored/u
    );
    rmSync(path.join(fixture.root, "untracked.txt"));
    assert.throws(
      () =>
        preparePlaytestSandbox({
          ...approved,
          adapterCommand: ["/bin/sh", "-c", "touch /tmp/unauthorized"]
        }),
      /exact operator approval/u
    );
  } finally {
    fixture.cleanup();
  }
});

test("sandbox refuses ignored workspace-local files before they can be mounted", () => {
  const fixture = repository();
  try {
    writeFileSync(path.join(fixture.root, ".gitignore"), ".env\n");
    execFileSync("git", ["-C", fixture.root, "add", ".gitignore"]);
    execFileSync("git", [
      "-C",
      fixture.root,
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=Playtest test",
      "commit",
      "--quiet",
      "-m",
      "ignore local secret files"
    ]);
    writeFileSync(
      path.join(fixture.root, ".env"),
      "API_SECRET=must-not-mount\n"
    );
    assert.throws(
      () => preparePlaytestSandbox(approval(fixture.root)),
      /ignored files/u
    );
  } finally {
    fixture.cleanup();
  }
});

test("sandbox rejects workspace escapes and unpinned container images", () => {
  const fixture = repository();
  const outside = mkdtempSync(path.join(tmpdir(), "autodev-playtest-outside-"));
  try {
    symlinkSync(outside, path.join(fixture.root, "outside"));
    assert.throws(
      () =>
        preparePlaytestSandbox({
          ...approval(fixture.root),
          workingDirectory: "outside"
        }),
      /escapes the approved checkout/u
    );
    assert.throws(
      () =>
        preparePlaytestSandbox({
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
    const prepared = preparePlaytestSandbox(approval(fixture.root));
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
      assert.ok(joined.includes("type=bind,source=" + fixture.root));
      assert.ok(joined.includes("target=/workspace,readonly"));
      assert.ok(joined.includes("/artifacts:rw,noexec,nosuid,nodev"));
      assert.ok(joined.includes("ghcr.io/fixture/game@sha256:"));
      assert.ok(joined.includes("--entrypoint /usr/bin/python3"));
      assert.doesNotMatch(joined, /--gpus|DOCKER_HOST=.*tcp/u);
      assert.doesNotMatch(joined, /--env .*API_KEY|--env .*TOKEN/u);
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
    const prepared = preparePlaytestSandbox(approval(fixture.root));
    assert.throws(
      () => assertLocalDockerAvailable("/no/such/socket.sock"),
      PlaytestSandboxUnavailableError
    );
    const nonSocket = path.join(fixture.root, "adapter.py");
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
    const prepared = preparePlaytestSandbox(approval(fixture.root));
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

test("adversarial: command arguments and metacharacters are preserved without shell", async () => {
  const unescapedCommand = [
    "/bin/bash",
    "-c",
    "echo 'hello $WORLD' > /artifacts/out.txt; rm -rf /",
    "arg with spaces & pipes |"
  ];
  const fixture = repository(unescapedCommand);
  try {
    const approved = approval(fixture.root, unescapedCommand);
    const prepared = preparePlaytestSandbox(approved);

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
    const prepared = preparePlaytestSandbox(approval(fixture.root));
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
    const prepared = preparePlaytestSandbox(approved);
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
    const prepared = preparePlaytestSandbox(approval(fixture.root));

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
    const prepared = preparePlaytestSandbox(approval(fixture.root));

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
    const prepared = preparePlaytestSandbox(approval(fixture.root));

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
    const prepared = preparePlaytestSandbox(approval(fixture.root));

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

    const prepared = preparePlaytestSandbox(approval(fixture.root));

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
    const prepared = preparePlaytestSandbox(approval(fixture.root));
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
