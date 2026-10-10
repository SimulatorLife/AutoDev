import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type DevBackendDependencies,
  type DevCommandOptions,
  type DevCommandResult,
  ensureBackends,
  ensureConsoleSecrets,
  isPortListening,
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

test("package.json declares dev and dev:console scripts", () => {
  const pkgPath = join(repoRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.equal(pkg.scripts.dev, "node runtime/src/cli/dev.ts");
  assert.equal(
    pkg.scripts["dev:console"],
    "pnpm --filter @simulatorlife/autodev-console dev"
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

test("already-ready skips Docker/up", async () => {
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
    0,
    "No commands should run when services are already ready"
  );
  assert.ok(
    loggedMessages.some((msg) =>
      msg.includes("OpenLIT Usage and ClickHouse are ready")
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
