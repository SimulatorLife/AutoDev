import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTROL_API_CONTRACT,
  CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
  LOCAL_CONTROL_API_ACTOR
} from "@simulatorlife/autodev-core";
import { verifyControlApiCompatibility } from "@simulatorlife/autodev-runtime/cli/control-api-compatibility";
import {
  type DevBackendDependencies,
  type DevCommandOptions,
  type DevCommandResult,
  ensureBackends,
  ensureConsolePortAvailable,
  ensureConsoleSecrets,
  ensureModelRouter,
  isPortListening,
  readDevControlApiConfig,
  readDevOpenLITUsageConfig,
  repoRoot
} from "@simulatorlife/autodev-runtime/cli/dev";

interface RecordedCommand {
  command: string;
  args: readonly string[];
  options: DevCommandOptions;
}

function createFakeDependencies(
  overrides: Partial<DevBackendDependencies> = {}
): {
  dependencies: DevBackendDependencies;
  commands: RecordedCommand[];
  loggedMessages: string[];
  sleptDurations: number[];
} {
  const commands: RecordedCommand[] = [];
  const loggedMessages: string[] = [];
  const sleptDurations: number[] = [];

  const dependencies: DevBackendDependencies = {
    platform: "darwin",
    repoRoot: "/mock/repo",
    runCommand: (command, args, options): DevCommandResult => {
      commands.push({ command, args, options });
      return { status: 0 };
    },
    isPortListening: async () => true,
    isOpenlitHttpReady: async () => true,
    openlitUsageConfig: () => ({
      baseUrl: "http://127.0.0.1:3000",
      serviceToken: "test-usage-token"
    }),
    sleep: async (milliseconds) => {
      sleptDurations.push(milliseconds);
    },
    writeLine: (message) => {
      loggedMessages.push(message);
    },
    ...overrides
  };

  return { dependencies, commands, loggedMessages, sleptDurations };
}

test("Console development uses only the backend-validated root entrypoint", () => {
  const rootPackage = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8")
  );
  const consolePackage = JSON.parse(
    readFileSync(join(repoRoot, "console/package.json"), "utf8")
  );
  assert.equal(rootPackage.scripts.dev, "node runtime/src/cli/dev.ts");
  assert.equal(rootPackage.scripts["dev:console"], undefined);
  assert.equal(consolePackage.scripts.dev, undefined);
  assert.equal(
    consolePackage.scripts["dev:next"],
    "next dev -p ${AUTODEV_CONSOLE_PORT:-3300}"
  );
});

test("dev Control API config resolves the generated local default and explicit overrides", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "autodev-dev-control-api-"));
  const consoleDir = join(tempDir, "console");
  mkdirSync(consoleDir, { recursive: true });
  writeFileSync(
    join(consoleDir, ".env.local"),
    [
      "AUTODEV_CONTROL_API_TOKEN=console-token",
      "AUTODEV_CONTROL_API_BASE_URL=${AUTODEV_CONTROL_API_BASE_URL:-http://127.0.0.1:4101}"
    ].join("\n")
  );
  try {
    assert.deepEqual(readDevControlApiConfig(tempDir, {}), {
      baseUrl: "http://127.0.0.1:4101",
      serviceToken: "console-token"
    });
    writeFileSync(
      join(consoleDir, ".env.local"),
      [
        'AUTODEV_CONTROL_API_TOKEN="console-token"',
        'AUTODEV_CONTROL_API_BASE_URL="https://control.example.test/"'
      ].join("\n")
    );
    assert.deepEqual(readDevControlApiConfig(tempDir, {}), {
      baseUrl: "https://control.example.test",
      serviceToken: "console-token"
    });
    assert.deepEqual(
      readDevControlApiConfig(tempDir, {
        AUTODEV_CONTROL_API_TOKEN: "process-token",
        AUTODEV_CONTROL_API_BASE_URL: "https://control.example.test/"
      }),
      {
        baseUrl: "https://control.example.test",
        serviceToken: "process-token"
      }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("dev Control API probe accepts the current provider, model-discovery, and Playtesting contracts", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const responses = [
    Response.json({
      schema: CONTROL_API_CONTRACT.schema,
      version: CONTROL_API_CONTRACT.version
    }),
    Response.json({
      schema: "autodev-control-providers-v2",
      providers: [
        {
          id: "copilot",
          links: { usage: null, documentation: "https://example.test/docs" }
        }
      ]
    }),
    Response.json({
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: [
        {
          provider: "copilot",
          discovery: {
            status: "unavailable",
            source: null,
            lastAttemptAt: null,
            reason: "No model listing is configured."
          }
        }
      ]
    }),
    Response.json({
      schema: "autodev-control-playtesting-capabilities-v3",
      workspaceId: "autodev-dev-probe/not-configured",
      modeReadiness: {
        "adapter-accelerated": { status: "ready", reasons: [] },
        "autonomous-visual": {
          status: "unavailable",
          reasons: [
            {
              code: "visual-driver-unavailable",
              label: "Visual driver unavailable",
              message:
                "Runtime does not yet have the isolated browser gameplay driver.",
              severity: "unavailable"
            }
          ],
          targetStore: "available",
          targets: []
        },
        "scripted-regression": {
          status: "unavailable",
          reasons: [
            {
              code: "scripted-regression-unavailable",
              label: "Scripted regression unavailable",
              message:
                "Runtime does not yet have the approved scripted-regression launch path.",
              severity: "unavailable"
            }
          ]
        }
      }
    }),
    Response.json({
      schema: CONTROL_API_PLAYTESTING_READINESS_SCHEMA,
      workspaceId: "autodev-dev-probe/not-configured",
      status: "ready"
    }),
    Response.json({
      schema: "autodev-control-evaluations-v1",
      evaluations: []
    })
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    const response = responses.shift();
    assert.ok(response, "probe must make only the six expected GET requests");
    return response;
  };

  await verifyControlApiCompatibility(
    { baseUrl: "http://127.0.0.1:4101", serviceToken: "never-log-this" },
    fetchImpl
  );

  assert.equal(requests.length, 6);
  assert.equal(
    requests[0]?.url,
    `http://127.0.0.1:4101${CONTROL_API_CONTRACT.path}`
  );
  assert.equal(requests[1]?.url, "http://127.0.0.1:4101/control/providers");
  assert.match(requests[2]?.url ?? "", /\/control\/provider-models$/u);
  assert.match(
    requests[3]?.url ?? "",
    /\/control\/playtesting\/capabilities\?/u
  );
  assert.equal(requests[5]?.url, "http://127.0.0.1:4101/control/evaluations");
  assert.equal(
    requests[0]?.headers.get("authorization"),
    "Bearer never-log-this"
  );
  assert.equal(
    requests[0]?.headers.get("x-autodev-actor"),
    LOCAL_CONTROL_API_ACTOR
  );
});

test("dev Control API probe rejects a Runtime without the current contract handshake", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/control/contracts")) {
      return Response.json(
        { error: { code: "autodev_control_api_unknown_path" } },
        { status: 404 }
      );
    }
    if (url.endsWith("/control/providers")) {
      return Response.json({
        schema: "autodev-control-providers-v2",
        providers: [
          {
            id: "copilot",
            links: { usage: null, documentation: "https://example.test/docs" }
          }
        ]
      });
    }
    return Response.json({
      schema: "autodev-control-playtesting-capabilities-v2",
      workspaceId: "autodev-dev-probe/not-configured",
      modeReadiness: {
        "adapter-accelerated": { status: "ready", reasons: [] },
        "autonomous-visual": {
          status: "unavailable",
          reasons: [
            {
              code: "visual-driver-unavailable",
              label: "Visual driver unavailable",
              message:
                "Runtime does not yet have the isolated browser gameplay driver.",
              severity: "unavailable"
            }
          ],
          targetStore: "available",
          targets: []
        },
        "scripted-regression": {
          status: "unavailable",
          reasons: [
            {
              code: "scripted-regression-unavailable",
              label: "Scripted regression unavailable",
              message:
                "Runtime does not yet have the approved scripted-regression launch path.",
              severity: "unavailable"
            }
          ]
        }
      }
    });
  };

  await assert.rejects(
    verifyControlApiCompatibility(
      { baseUrl: "http://127.0.0.1:4101", serviceToken: "never-log-this" },
      fetchImpl
    ),
    (error: Error) => {
      assert.match(error.message, /contract endpoint returned HTTP 404/u);
      assert.doesNotMatch(error.message, /never-log-this/u);
      return true;
    }
  );
  assert.deepEqual(requests, ["http://127.0.0.1:4101/control/contracts"]);
});

test("dev Control API probe names a missing contract endpoint without exposing credentials", async () => {
  await assert.rejects(
    verifyControlApiCompatibility(
      { baseUrl: "http://127.0.0.1:4101", serviceToken: "probe-token" },
      async () =>
        Response.json(
          { error: { code: "autodev_control_api_unknown_path" } },
          { status: 404 }
        )
    ),
    (error: Error) => {
      assert.match(error.message, /contract endpoint returned HTTP 404/u);
      assert.match(
        error.message,
        new RegExp(`version ${String(CONTROL_API_CONTRACT.version)}`, "u")
      );
      assert.match(error.message, /pnpm run install:codex/u);
      assert.doesNotMatch(error.message, /probe-token/u);
      return true;
    }
  );
});

test("dev Control API probe rejects an older published compatibility revision", async () => {
  await assert.rejects(
    verifyControlApiCompatibility(
      { baseUrl: "http://127.0.0.1:4101", serviceToken: "probe-token" },
      async () =>
        Response.json({
          schema: CONTROL_API_CONTRACT.schema,
          version: CONTROL_API_CONTRACT.version - 1
        })
    ),
    (error: Error) => {
      assert.match(
        error.message,
        /Control API contract revision is missing or stale/u
      );
      assert.doesNotMatch(error.message, /probe-token/u);
      return true;
    }
  );
});

test("dev Control API probe rejects the stale Providers v2 response without links", async () => {
  let requestCount = 0;
  const fetchImpl: typeof fetch = async () => {
    requestCount += 1;
    return requestCount === 1
      ? Response.json({
          schema: CONTROL_API_CONTRACT.schema,
          version: CONTROL_API_CONTRACT.version
        })
      : Response.json({
          schema: "autodev-control-providers-v2",
          providers: [{ id: "codex" }]
        });
  };

  await assert.rejects(
    verifyControlApiCompatibility(
      { baseUrl: "http://127.0.0.1:4101", serviceToken: "probe-token" },
      fetchImpl
    ),
    (error: Error) => {
      assert.match(
        error.message,
        /current Providers v2 response contract is missing/u
      );
      assert.doesNotMatch(error.message, /probe-token/u);
      return true;
    }
  );
  assert.equal(requestCount, 2);
});

test("dev Control API probe blocks a Runtime missing model-discovery states", async () => {
  let requestCount = 0;
  const fetchImpl: typeof fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return Response.json({
        schema: CONTROL_API_CONTRACT.schema,
        version: CONTROL_API_CONTRACT.version
      });
    }
    if (requestCount === 2) {
      return Response.json({
        schema: "autodev-control-providers-v2",
        providers: [
          { id: "copilot", links: { usage: null, documentation: null } }
        ]
      });
    }
    return Response.json(
      { error: { code: "autodev_control_api_unknown_path" } },
      { status: 404 }
    );
  };

  await assert.rejects(
    verifyControlApiCompatibility(
      { baseUrl: "http://127.0.0.1:4101", serviceToken: "probe-token" },
      fetchImpl
    ),
    (error: Error) => {
      assert.match(
        error.message,
        /provider-model discovery response contract is missing/u
      );
      assert.doesNotMatch(error.message, /probe-token/u);
      return true;
    }
  );
  assert.equal(requestCount, 3);
});

test("dev OpenLIT Usage config resolves the server credential and URL", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "autodev-dev-usage-config-"));
  const consoleDir = join(tempDir, "console");
  mkdirSync(consoleDir, { recursive: true });
  writeFileSync(
    join(consoleDir, ".env.local"),
    [
      "AUTODEV_OPENLIT_USAGE_TOKEN=file-token",
      "AUTODEV_OPENLIT_USAGE_URL=${AUTODEV_OPENLIT_USAGE_URL:-http://127.0.0.1:3000}"
    ].join("\n")
  );
  try {
    assert.deepEqual(readDevOpenLITUsageConfig(tempDir, {}), {
      baseUrl: "http://127.0.0.1:3000",
      serviceToken: "file-token"
    });
    assert.deepEqual(
      readDevOpenLITUsageConfig(tempDir, {
        AUTODEV_OPENLIT_USAGE_TOKEN: "env-token",
        AUTODEV_OPENLIT_USAGE_URL: "https://usage.example.test/"
      }),
      {
        baseUrl: "https://usage.example.test",
        serviceToken: "env-token"
      }
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("dev Control API probe rejects a Runtime that does not register Playtesting", async () => {
  const responses = [
    Response.json({
      schema: CONTROL_API_CONTRACT.schema,
      version: CONTROL_API_CONTRACT.version
    }),
    Response.json({
      schema: "autodev-control-providers-v2",
      providers: [
        { id: "copilot", links: { usage: null, documentation: null } }
      ]
    }),
    Response.json({
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: [
        {
          provider: "copilot",
          discovery: {
            status: "unavailable",
            source: null,
            lastAttemptAt: null,
            reason: "No model listing is configured."
          }
        }
      ]
    }),
    Response.json(
      { error: { code: "autodev_control_api_unknown_path" } },
      { status: 404 }
    )
  ];
  const fetchImpl: typeof fetch = async () => {
    const response = responses.shift();
    assert.ok(response);
    return response;
  };

  await assert.rejects(
    verifyControlApiCompatibility(
      { baseUrl: "http://127.0.0.1:4101", serviceToken: "probe-token" },
      fetchImpl
    ),
    /workspace-scoped Playtesting routes are missing/u
  );
});

test("dev Control API probe passes against the in-tree authenticated listener", async () => {
  const previous = {
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    viewers: process.env.AUTODEV_CONTROL_VIEWERS,
    operators: process.env.AUTODEV_CONTROL_OPERATORS
  };
  const serviceToken = "dev-control-api-integration-test-token-0123456789";
  process.env.AUTODEV_CONTROL_API_TOKEN = serviceToken;
  process.env.AUTODEV_CONTROL_VIEWERS = "";
  process.env.AUTODEV_CONTROL_OPERATORS = "";
  let server: Server | undefined;
  try {
    const { createControlApiServer } =
      await import("@simulatorlife/autodev-runtime/router/server");
    server = createControlApiServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await verifyControlApiCompatibility({
      baseUrl: `http://127.0.0.1:${address.port}`,
      serviceToken
    });
  } finally {
    if (server?.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
    for (const [name, value] of Object.entries({
      AUTODEV_CONTROL_API_TOKEN: previous.token,
      AUTODEV_CONTROL_VIEWERS: previous.viewers,
      AUTODEV_CONTROL_OPERATORS: previous.operators
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("OpenLIT reconciliation fingerprints mounted config for service restarts", () => {
  const compose = readFileSync(
    join(repoRoot, "config", "openlit", "docker-compose.yml"),
    "utf8"
  );
  const runner = readFileSync(
    join(repoRoot, "scripts", "openlit", "up.sh"),
    "utf8"
  );
  const [clickhouseService, openlitService = ""] = compose.split("  openlit:");

  assert.match(
    runner,
    /AUTODEV_OPENLIT_CLICKHOUSE_CONFIG_HASH=.*fingerprint_files/u
  );
  assert.match(runner, /AUTODEV_OPENLIT_OTEL_CONFIG_HASH=.*fingerprint_files/u);
  assert.match(runner, /clickhouse-config\.xml[\s\S]*clickhouse-init\.sh/u);
  assert.match(runner, /otel-collector-config\.yaml/u);
  assert.match(
    clickhouseService ?? "",
    /io\.autodev\.openlit\.clickhouse-config-sha256: \$\{AUTODEV_OPENLIT_CLICKHOUSE_CONFIG_HASH/u
  );
  assert.match(
    openlitService,
    /io\.autodev\.openlit\.collector-config-sha256: \$\{AUTODEV_OPENLIT_OTEL_CONFIG_HASH/u
  );
  assert.match(
    runner,
    /Verifying the deployed AutoDev Usage response contract[\s\S]*openlit:verify-usage/u
  );
  assert.match(runner, /CONSOLE_USAGE_TOKEN_OVERRIDE=/u);
  assert.match(
    runner,
    /AUTODEV_OPENLIT_USAGE_TOKEN=.*CONSOLE_USAGE_TOKEN_OVERRIDE/u
  );
});

test("isPortListening resolves false on closed port and true on listening port", async () => {
  const closed = await isPortListening(59_981, "127.0.0.1", 100);
  assert.equal(closed, false);

  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const openPort = address.port;

  const listening = await isPortListening(openPort, "127.0.0.1", 200);
  assert.equal(listening, true);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

test("ensureConsoleSecrets synchronizes only a temporary Console environment", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "autodev-dev-secrets-"));
  const consoleDir = join(tempDir, "console");
  const scriptsDir = join(tempDir, "scripts", "openlit");
  mkdirSync(consoleDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  const consoleEnv = join(consoleDir, ".env.local");
  const scriptPath = join(scriptsDir, "bootstrap-secrets.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh\ncat > "${consoleEnv}" << 'EOF'\nAUTODEV_CONTROL_API_TOKEN=synced-token\nAUTODEV_OPENLIT_USAGE_TOKEN=synced-usage\nEOF\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    consoleEnv,
    "AUTODEV_CONTROL_API_TOKEN=stale-token\nAUTODEV_OPENLIT_USAGE_TOKEN=stale-usage\n"
  );
  const secretDir = mkdtempSync(join(tmpdir(), "autodev-dev-canon-"));
  const secretFile = join(secretDir, "openlit-secrets.env");
  writeFileSync(
    secretFile,
    "AUTODEV_CONTROL_API_TOKEN=synced-token\nAUTODEV_OPENLIT_USAGE_TOKEN=synced-usage\n"
  );
  const previousSecretFile = process.env.AUTODEV_OPENLIT_SECRET_FILE;
  process.env.AUTODEV_OPENLIT_SECRET_FILE = secretFile;
  try {
    ensureConsoleSecrets(tempDir);
    const synchronized = readFileSync(consoleEnv, "utf8");
    assert.match(synchronized, /AUTODEV_CONTROL_API_TOKEN=synced-token/u);
    assert.match(synchronized, /AUTODEV_OPENLIT_USAGE_TOKEN=synced-usage/u);
  } finally {
    if (previousSecretFile === undefined) {
      delete process.env.AUTODEV_OPENLIT_SECRET_FILE;
    } else {
      process.env.AUTODEV_OPENLIT_SECRET_FILE = previousSecretFile;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  }
});

test("already-ready services still reconcile the current image and config", async () => {
  const { dependencies, commands, loggedMessages } = createFakeDependencies({
    isPortListening: async (port) => {
      if (port === 8123) return true;
      if (port === 4100) return true;
      return false;
    },
    isOpenlitHttpReady: async () => true
  });

  const result = await ensureBackends(dependencies);

  assert.equal(result.telemetryActive, true);
  assert.equal(result.routerActive, true);
  assert.equal(
    commands.length,
    2,
    "Docker readiness and the idempotent Compose reconciliation still run"
  );
  assert.deepEqual(commands[0]?.args, ["info"]);
  assert.deepEqual(commands[1]?.args, ["/mock/repo/scripts/openlit/up.sh"]);
  assert.equal(
    commands[1]?.options.env?.AUTODEV_OPENLIT_USAGE_URL,
    "http://127.0.0.1:3000"
  );
  assert.equal(
    commands[1]?.options.env?.AUTODEV_OPENLIT_USAGE_TOKEN,
    "test-usage-token"
  );
  assert.ok(
    loggedMessages.some((msg) => msg.includes("Reconciling the OpenLIT"))
  );
  assert.ok(
    loggedMessages.some((msg) =>
      msg.includes("OpenLIT Usage v4 and ClickHouse are ready")
    )
  );
});

test("macOS opens Docker when daemon is absent and then starts OpenLIT", async () => {
  let dockerProbeCount = 0;
  let upScriptRan = false;

  const { dependencies, commands } = createFakeDependencies({
    platform: "darwin",
    repoRoot: "/mock/repo",
    runCommand: (command, args, options): DevCommandResult => {
      commands.push({ command, args, options });
      if (command === "docker" && args[0] === "info") {
        dockerProbeCount += 1;
        // First probe fails (daemon absent); second probe (during wait) succeeds.
        return dockerProbeCount === 1 ? { status: 1 } : { status: 0 };
      }
      if (command === "open" && args[0] === "-a" && args[1] === "Docker") {
        return { status: 0 };
      }
      if (command === "bash" && args[0]?.endsWith("scripts/openlit/up.sh")) {
        upScriptRan = true;
        return { status: 0 };
      }
      return { status: 0 };
    },
    isPortListening: async (port) => {
      if (port === 8123) {
        // ClickHouse ready only after up.sh ran
        return upScriptRan;
      }
      if (port === 4100) return true;
      return false;
    },
    isOpenlitHttpReady: async () => upScriptRan
  });

  const result = await ensureBackends(dependencies);

  assert.equal(result.telemetryActive, true);
  assert.equal(result.routerActive, true);

  // Verify command sequence:
  // 1. docker info (failed)
  // 2. open -a Docker
  // 3. docker info (succeeded)
  // 4. bash .../scripts/openlit/up.sh
  assert.equal(commands.length, 4);
  assert.equal(commands[0]?.command, "docker");
  assert.deepEqual(commands[0]?.args, ["info"]);

  assert.equal(commands[1]?.command, "open");
  assert.deepEqual(commands[1]?.args, ["-a", "Docker"]);

  assert.equal(commands[2]?.command, "docker");
  assert.deepEqual(commands[2]?.args, ["info"]);

  assert.equal(commands[3]?.command, "bash");
  assert.deepEqual(commands[3]?.args, ["/mock/repo/scripts/openlit/up.sh"]);
});

test("other platform without Docker fails before running up", async () => {
  const { dependencies, commands } = createFakeDependencies({
    platform: "linux",
    runCommand: (command, args, options): DevCommandResult => {
      commands.push({ command, args, options });
      if (command === "docker" && args[0] === "info") {
        return { status: 1 };
      }
      return { status: 0 };
    },
    isPortListening: async () => false,
    isOpenlitHttpReady: async () => false
  });

  await assert.rejects(
    async () => {
      await ensureBackends(dependencies);
    },
    (err: Error) => {
      assert.match(err.message, /Docker Engine is required for OpenLIT Usage/);
      return true;
    }
  );

  assert.equal(commands.length, 1, "Only docker info should have been called");
  assert.equal(commands[0]?.command, "docker");
  assert.equal(
    commands.some(
      (cmd) =>
        cmd.command === "open" || cmd.args.some((arg) => arg.includes("up.sh"))
    ),
    false,
    "Must not launch Docker Desktop or run up.sh on non-macOS platform"
  );
});

test("startup script failure propagates", async () => {
  const { dependencies, commands } = createFakeDependencies({
    platform: "darwin",
    repoRoot: "/mock/repo",
    runCommand: (command, args, options): DevCommandResult => {
      commands.push({ command, args, options });
      if (command === "docker" && args[0] === "info") {
        return { status: 0 };
      }
      if (command === "bash" && args[0]?.endsWith("scripts/openlit/up.sh")) {
        return {
          status: 1,
          error: new Error("Container build error")
        };
      }
      return { status: 0 };
    },
    isPortListening: async () => false,
    isOpenlitHttpReady: async () => false
  });

  await assert.rejects(
    async () => {
      await ensureBackends(dependencies);
    },
    (err: Error) => {
      assert.match(
        err.message,
        /OpenLIT startup failed: Container build error/
      );
      return true;
    }
  );
});

test("successful startup waits for ClickHouse and HTTP readiness", async () => {
  let upScriptRan = false;
  let postUpPolls = 0;

  const { dependencies, commands, sleptDurations } = createFakeDependencies({
    platform: "darwin",
    repoRoot: "/mock/repo",
    runCommand: (command, args, options): DevCommandResult => {
      commands.push({ command, args, options });
      if (command === "bash" && args[0]?.endsWith("scripts/openlit/up.sh")) {
        upScriptRan = true;
      }
      return { status: 0 };
    },
    isPortListening: async (port) => {
      if (port === 8123) {
        // ClickHouse becomes ready once up.sh has run
        return upScriptRan;
      }
      if (port === 4100) return false;
      return false;
    },
    isOpenlitHttpReady: async () => {
      if (!upScriptRan) return false;
      postUpPolls += 1;
      // First poll in waitForOpenlitStack returns false (triggering sleep), subsequent poll returns true
      return postUpPolls >= 2;
    }
  });

  const result = await ensureBackends(dependencies);

  assert.equal(result.telemetryActive, true);
  assert.equal(result.routerActive, false);
  assert.ok(
    sleptDurations.length > 0,
    "Must sleep while polling for service readiness"
  );
  assert.ok(
    postUpPolls >= 2,
    "Must verify OpenLIT HTTP readiness through polling"
  );
  assert.ok(
    commands.some(
      (cmd) =>
        cmd.command === "bash" && cmd.args.some((arg) => arg.includes("up.sh"))
    )
  );
});

test("ensureModelRouter recognizes already-active router without restarting", async () => {
  const commands: RecordedCommand[] = [];
  const loggedMessages: string[] = [];
  const ready = await ensureModelRouter({
    repoRoot: "/mock/repo",
    isPortListening: async (port) => port === 4100 || port === 4101,
    runCommand: (command, args, options) => {
      commands.push({ command, args, options });
      return { status: 0 };
    },
    sleep: async () => {},
    writeLine: (msg) => {
      loggedMessages.push(msg);
    },
    platform: "darwin"
  });

  assert.equal(ready, true);
  assert.equal(commands.length, 0, "Must not execute commands if already active");
  assert.ok(
    loggedMessages.some((msg) =>
      msg.includes("AutoDev Model Router is active (ports 4100, 4101)")
    )
  );
});

test("ensureModelRouter materializes runtime and kickstarts launchd service when ports are closed", async () => {
  const commands: RecordedCommand[] = [];
  const loggedMessages: string[] = [];
  let pollCount = 0;

  const ready = await ensureModelRouter({
    repoRoot: "/mock/repo",
    isPortListening: async (port) => {
      if (pollCount >= 2 && (port === 4100 || port === 4101)) {
        return true;
      }
      return false;
    },
    runCommand: (command, args, options) => {
      commands.push({ command, args, options });
      // When launchctl print is called, return 0 (indicating loaded in launchd)
      if (command === "launchctl" && args[0] === "print") {
        return { status: 0 };
      }
      return { status: 0 };
    },
    sleep: async () => {
      pollCount += 1;
    },
    writeLine: (msg) => {
      loggedMessages.push(msg);
    },
    platform: "darwin"
  });

  assert.equal(ready, true);
  assert.ok(commands.length >= 3, "Must materialize, check launchctl, and kickstart");
  assert.equal(commands[0]?.command, "node");
  assert.ok(commands[0]?.args.some((arg) => arg.includes("--materialize-only")));
  assert.equal(commands[1]?.command, "launchctl");
  assert.equal(commands[1]?.args[0], "print");
  assert.equal(commands[2]?.command, "launchctl");
  assert.equal(commands[2]?.args[0], "kickstart");
  assert.ok(
    loggedMessages.some((msg) =>
      msg.includes("AutoDev Model Router is ready (ports 4100, 4101)")
    )
  );
});

test("ensureConsolePortAvailable does nothing when port is free", async () => {
  const commands: RecordedCommand[] = [];
  await ensureConsolePortAvailable(3300, {
    isPortListening: async () => false,
    runCommand: (command, args, options) => {
      commands.push({ command, args, options });
      return { status: 0 };
    },
    sleep: async () => {},
    writeLine: () => {},
    platform: "darwin",
    repoRoot: "/mock/repo"
  });

  assert.equal(commands.length, 0);
});

test("ensureConsolePortAvailable stops conflicting launchd console service when occupied", async () => {
  const commands: RecordedCommand[] = [];
  const loggedMessages: string[] = [];
  let listening = true;

  await ensureConsolePortAvailable(3300, {
    isPortListening: async () => listening,
    runCommand: (command, args, options) => {
      commands.push({ command, args, options });
      if (command === "launchctl" && args[0] === "print") {
        return { status: 0 };
      }
      if (command === "launchctl" && args[0] === "bootout") {
        listening = false;
        return { status: 0 };
      }
      return { status: 0 };
    },
    sleep: async () => {},
    writeLine: (msg) => {
      loggedMessages.push(msg);
    },
    platform: "darwin",
    repoRoot: "/mock/repo"
  });

  assert.equal(commands.length, 2);
  assert.equal(commands[0]?.command, "launchctl");
  assert.equal(commands[0]?.args[0], "print");
  assert.equal(commands[1]?.command, "launchctl");
  assert.equal(commands[1]?.args[0], "bootout");
  assert.ok(
    loggedMessages.some((msg) =>
      msg.includes("Stopping conflicting LaunchAgent com.codex.autodev-console")
    )
  );
  assert.ok(
    loggedMessages.some((msg) => msg.includes("Port 3300 is now available"))
  );
});
