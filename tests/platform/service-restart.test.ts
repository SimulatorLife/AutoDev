import assert from "node:assert/strict";
import test from "node:test";

import {
  MANAGED_SERVICE_LABELS,
  restartServices,
  type ServiceRestartDeps,
  type ServiceRestartOptions
} from "../../src/platform/service-restart.ts";

function options(
  overrides: Partial<ServiceRestartOptions> = {}
): ServiceRestartOptions {
  return {
    repositoryRoot: "/repo",
    home: "/home",
    codexHome: "/home/.codex",
    otelMode: "direct",
    readyAttempts: 1,
    readyDelayMs: 0,
    ...overrides
  };
}

function deps(
  overrides: Partial<ServiceRestartDeps> = {}
): ServiceRestartDeps & {
  calls: string[];
  runs: { args: readonly string[]; input?: string; env?: NodeJS.ProcessEnv }[];
} {
  const calls: string[] = [];
  const runs: {
    args: readonly string[];
    input?: string;
    env?: NodeJS.ProcessEnv;
  }[] = [];
  return {
    calls,
    runs,
    launchd: {
      isLoaded: () => false,
      print: () => "",
      bootout: (label) => {
        calls.push(`bootout:${label}`);
      },
      bootstrap: (plist) => {
        calls.push(`bootstrap:${plist}`);
      },
      enable: (label) => {
        calls.push(`enable:${label}`);
      },
      kickstart: (label) => {
        calls.push(`kickstart:${label}`);
      }
    },
    fileExists: () => true,
    readFile: () => "",
    commandAvailable: () => true,
    probe: async () => true,
    sleep: async () => {},
    run: (_command, args, input, env) => {
      runs.push({
        args,
        ...(input === undefined ? {} : { input }),
        ...(env === undefined ? {} : { env })
      });
      return 0;
    },
    listeningPids: () => [],
    commandLine: () => null,
    kill: () => {},
    ...overrides
  };
}

test("launchd restart adopts every configured service and runs direct ensures", async () => {
  const fake = deps();
  assert.equal(await restartServices(options(), fake), 0);
  assert.equal(
    fake.calls.filter((call) => call.startsWith("bootstrap:")).length,
    5
  );
  assert.equal(
    fake.calls.filter((call) => call.startsWith("enable:")).length,
    5
  );
  assert.ok(fake.calls.includes("bootout:com.codex.otel-collector"));
  assert.equal(fake.runs.length, 5);
  assert.ok(
    fake.runs.some((run) =>
      run.args.at(-1)?.endsWith("ensure-codex-model-router.sh")
    )
  );
});

test("direct mode never stops a foreign loaded service", async () => {
  const fake = deps({
    launchd: {
      isLoaded: (label) => label === "com.codex.otel-collector",
      print: () => "program = /foreign/runtime/collector",
      bootout: (label) => {
        fake.calls.push(`bootout:${label}`);
      },
      bootstrap: (plist) => {
        fake.calls.push(`bootstrap:${plist}`);
      },
      enable: (label) => {
        fake.calls.push(`enable:${label}`);
      },
      kickstart: (label) => {
        fake.calls.push(`kickstart:${label}`);
      }
    }
  });
  assert.equal(await restartServices(options(), fake), 0);
  assert.equal(fake.calls.includes("bootout:com.codex.otel-collector"), false);
  assert.equal(fake.runs.length, 0);
});

test("a loaded service with an earlier install path under the same CODEX_HOME is adopted and restarted", async () => {
  const fake = deps({
    launchd: {
      isLoaded: (label) => label === "com.codex.otel-collector",
      print: () =>
        "program = /bin/bash\narguments = { /home/.codex/hooks/codex/otel/run-autodev-otel-collector.sh }\nCODEX_HOME => /home/.codex",
      bootout: (label) => {
        fake.calls.push(`bootout:${label}`);
      },
      bootstrap: (plist) => {
        fake.calls.push(`bootstrap:${plist}`);
      },
      enable: (label) => {
        fake.calls.push(`enable:${label}`);
      },
      kickstart: (label) => {
        fake.calls.push(`kickstart:${label}`);
      }
    }
  });
  assert.equal(
    await restartServices(options({ otelMode: "collector" }), fake),
    0
  );
  assert.ok(fake.calls.includes("bootout:com.codex.otel-collector"));
  assert.ok(
    fake.calls.includes(
      "bootstrap:/home/Library/LaunchAgents/com.codex.otel-collector.plist"
    )
  );
  assert.ok(fake.calls.includes("enable:com.codex.otel-collector"));
  assert.ok(fake.calls.includes("kickstart:com.codex.otel-collector"));
});

test("a runtime rooted at another CODEX_HOME is left untouched", async () => {
  const fake = deps({
    readFile: () => "<key>CODEX_HOME</key><string>/other/.codex</string>"
  });
  assert.equal(await restartServices(options(), fake), 0);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.runs, []);
});

test("launchd-unavailable mode forwards Collector paths and runs fallback ensures", async () => {
  const fake = deps({
    commandAvailable: () => false,
    fileExists: () => false,
    probe: async () => false
  });
  assert.equal(
    await restartServices(
      options({ otelMode: "collector", readyAttempts: 0 }),
      fake
    ),
    0
  );
  const collector = fake.runs.find((run) =>
    run.args.at(-1)?.endsWith("ensure-autodev-otel-collector.sh")
  );
  assert.deepEqual(collector?.env, {
    AUTODEV_OTEL_REPO_ROOT: "/repo",
    AUTODEV_OTEL_CONFIG: "/repo/config/otel/collector.yaml",
    AUTODEV_OTEL_VERSION_FILE: "/repo/config/otel/collector.version"
  });
});

test("only processes matching an installed service hook are reaped", async () => {
  let killed = 0;
  const fake = deps({
    listeningPids: (port) => (port === 4003 ? [42] : []),
    commandLine: () => "/home/.codex/src/providers/copilot.ts",
    kill: () => {
      killed += 1;
    }
  });
  assert.equal(await restartServices(options(), fake), 0);
  assert.equal(killed, 1);
  assert.equal(MANAGED_SERVICE_LABELS.length, 6);
});

function captureStderr<T>(run: () => Promise<T>): Promise<[T, string]> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  return run().then(
    (value): [T, string] => {
      process.stderr.write = original;
      return [value, captured];
    },
    (error: unknown) => {
      process.stderr.write = original;
      throw error;
    }
  );
}

test("a label launchd refuses to load is reported as a load failure, not a missing launchctl", async () => {
  const fake = deps({
    commandAvailable: () => true,
    launchd: {
      isLoaded: () => false,
      print: () => "",
      bootout: () => {},
      bootstrap: (plist) => {
        if (plist.endsWith("com.codex.claude-bridge.plist"))
          throw new Error("Bootstrap failed: 5: Input/output error");
      },
      enable: () => {},
      kickstart: () => {}
    }
  });
  const [status, stderr] = await captureStderr(() =>
    restartServices(options(), fake)
  );
  assert.equal(status, 0);
  assert.match(stderr, /launchd could not load com\.codex\.claude-bridge/u);
  assert.equal(stderr.includes("launchctl unavailable"), false);
});

test("a missing launchctl is reported as an unavailable supervisor and skips every launchd call", async () => {
  const fake = deps({ commandAvailable: () => false });
  const [status, stderr] = await captureStderr(() =>
    restartServices(options(), fake)
  );
  assert.equal(status, 0);
  assert.match(stderr, /launchctl unavailable \(sandbox\?\)/u);
  assert.deepEqual(fake.calls, []);
});
