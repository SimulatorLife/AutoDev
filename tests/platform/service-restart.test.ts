import assert from "node:assert/strict";
import test from "node:test";

import {
  type KillSignal,
  LABEL_ANTIGRAVITY_PROXY,
  LABEL_CLAUDE_BRIDGE,
  LABEL_COPILOT_PROXY,
  LABEL_MINIMAX_PROXY,
  LABEL_MODEL_ROUTER,
  LABEL_OTEL_COLLECTOR,
  MANAGED_SERVICE_LABELS,
  type ManagedServiceLabel,
  restartServices,
  type ServiceRestartDeps,
  type ServiceRestartOptions
} from "../../src/platform/service-restart.ts";

const PORTS: Record<ManagedServiceLabel, number> = {
  [LABEL_MODEL_ROUTER]: 4100,
  [LABEL_CLAUDE_BRIDGE]: 4000,
  [LABEL_MINIMAX_PROXY]: 18_765,
  [LABEL_ANTIGRAVITY_PROXY]: 4002,
  [LABEL_COPILOT_PROXY]: 4003,
  [LABEL_OTEL_COLLECTOR]: 4318
};
const JOB_PIDS: Record<ManagedServiceLabel, number> = {
  [LABEL_MODEL_ROUTER]: 100,
  [LABEL_CLAUDE_BRIDGE]: 200,
  [LABEL_MINIMAX_PROXY]: 300,
  [LABEL_ANTIGRAVITY_PROXY]: 400,
  [LABEL_COPILOT_PROXY]: 500,
  [LABEL_OTEL_COLLECTOR]: 600
};

function options(
  overrides: Partial<ServiceRestartOptions> = {}
): ServiceRestartOptions {
  return {
    repositoryRoot: "/repo",
    home: "/home",
    codexHome: "/home/.codex",
    otelMode: "direct",
    readyAttempts: 3,
    readyDelayMs: 0,
    ...overrides
  };
}

function labelForPort(port: number): ManagedServiceLabel | undefined {
  return MANAGED_SERVICE_LABELS.find((label) => PORTS[label] === port);
}

interface FakeState {
  loaded: Set<string>;
  /** Extra `launchctl print` lines per label, e.g. a crash-loop exit code. */
  jobLines: Partial<Record<ManagedServiceLabel, string>>;
  /** Listeners that are not the launchd job, keyed by port. */
  strays: Map<number, number>;
}

type FakeDeps = ServiceRestartDeps & {
  calls: string[];
  runs: { args: readonly string[]; input?: string; env?: NodeJS.ProcessEnv }[];
  probes: string[];
  kills: { pid: number; signal: KillSignal }[];
  state: FakeState;
};

function deps(
  overrides: Partial<ServiceRestartDeps> = {},
  initial: Partial<FakeState> = {}
): FakeDeps {
  const calls: string[] = [];
  const runs: FakeDeps["runs"] = [];
  const probes: string[] = [];
  const kills: FakeDeps["kills"] = [];
  const state: FakeState = {
    loaded: new Set(initial.loaded),
    jobLines: initial.jobLines ?? {},
    strays: new Map(initial.strays)
  };
  const jobDump = (label: string): string => {
    const managed = label as ManagedServiceLabel;
    return [
      `gui/501/${label} = {`,
      `\tprogram = /bin/bash /home/.codex/hooks/run-${label}.sh`,
      `\tstderr path = /home/.codex/run/${label}.err.log`,
      `\tpid = ${JOB_PIDS[managed]}`,
      state.jobLines[managed] ?? "\tlast exit code = (never exited)",
      "}"
    ].join("\n");
  };
  return {
    calls,
    runs,
    probes,
    kills,
    state,
    launchd: {
      isLoaded: (label) => state.loaded.has(label),
      print: (label) => jobDump(label),
      bootout: (label) => {
        calls.push(`bootout:${label}`);
        state.loaded.delete(label);
      },
      bootstrap: (plist) => {
        calls.push(`bootstrap:${plist}`);
        const label = MANAGED_SERVICE_LABELS.find((name) =>
          plist.endsWith(`${name}.plist`)
        );
        if (label) state.loaded.add(label);
      },
      enable: (label) => {
        calls.push(`enable:${label}`);
      }
    },
    fileExists: () => true,
    readFile: () => "",
    logTail: (filePath) => [`tail of ${filePath}`],
    commandAvailable: () => true,
    probe: async (url, jsonBody) => {
      probes.push(jsonBody === undefined ? url : `${url} ${jsonBody}`);
      return true;
    },
    sleep: async () => {},
    run: (_command, args, input, env) => {
      runs.push({
        args,
        ...(input === undefined ? {} : { input }),
        ...(env === undefined ? {} : { env })
      });
      return 0;
    },
    listeningPids: (port) => {
      const stray = state.strays.get(port);
      if (stray !== undefined) return [stray];
      const label = labelForPort(port);
      return label && state.loaded.has(label) ? [JOB_PIDS[label]] : [];
    },
    commandLine: () => null,
    kill: (pid, signal) => {
      kills.push({ pid, signal });
    },
    ...overrides
  };
}

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

test("a supervised restart reloads each service with bootstrap alone and runs no ensure hooks", async () => {
  const fake = deps();
  const [status, stderr] = await captureStderr(() =>
    restartServices(options(), fake)
  );
  assert.equal(status, 0);
  for (const label of MANAGED_SERVICE_LABELS.slice(0, 5)) {
    const plist = `bootstrap:/home/Library/LaunchAgents/${label}.plist`;
    assert.ok(
      fake.calls.indexOf(`enable:${label}`) < fake.calls.indexOf(plist),
      `${label} is enabled before it is bootstrapped`
    );
  }
  assert.equal(
    fake.calls.some((call) => call.startsWith("kickstart")),
    false,
    "RunAtLoad already starts the job; kickstart -k would kill it mid-startup"
  );
  assert.ok(fake.calls.includes(`bootout:${LABEL_OTEL_COLLECTOR}`));
  assert.equal(
    fake.calls.includes(
      `bootstrap:/home/Library/LaunchAgents/${LABEL_OTEL_COLLECTOR}.plist`
    ),
    false,
    "direct OTel mode unloads the collector without starting it"
  );
  assert.deepEqual(fake.runs, [], "launchd already verified every service");
  assert.match(stderr, /supervised by launchd/u);
  assert.equal(stderr.includes("is not running"), false);
});

test("collector mode verifies the collector alongside the bridges", async () => {
  const fake = deps();
  assert.equal(
    await restartServices(options({ otelMode: "collector" }), fake),
    0
  );
  assert.ok(
    fake.calls.includes(
      `bootstrap:/home/Library/LaunchAgents/${LABEL_OTEL_COLLECTOR}.plist`
    )
  );
  assert.ok(
    fake.probes.includes("http://127.0.0.1:4318/v1/logs {}"),
    "the OTLP receiver refuses a bare POST with 415; probe with an empty JSON export"
  );
});

test("a crash-looping bridge is reported at once with its log, without holding up the install", async () => {
  const fake = deps(
    {},
    {
      jobLines: { [LABEL_COPILOT_PROXY]: "\tlast exit code = 1" }
    }
  );
  const probe = fake.probe;
  const copilotProbes: string[] = [];
  const [status, stderr] = await captureStderr(() =>
    restartServices(options({ readyAttempts: 80 }), {
      ...fake,
      probe: async (url, jsonBody) => {
        if (url.includes(":4003/")) {
          copilotProbes.push(url);
          return false;
        }
        return probe(url, jsonBody);
      }
    })
  );
  assert.equal(status, 0, "an optional bridge does not fail the install");
  assert.deepEqual(copilotProbes, [], "no readiness polling for a crashed job");
  assert.match(
    stderr,
    /com\.codex\.copilot-proxy is not running: exited with code 1 \(router will route around it\)/u
  );
  assert.match(
    stderr,
    /log: \/home\/\.codex\/run\/com\.codex\.copilot-proxy\.err\.log/u
  );
  assert.match(
    stderr,
    /\| tail of \/home\/\.codex\/run\/com\.codex\.copilot-proxy\.err\.log/u
  );
});

test("a router that never becomes ready fails the install", async () => {
  const base = deps();
  const [status, stderr] = await captureStderr(() =>
    restartServices(options(), {
      ...base,
      probe: async (url) => !url.includes(":4100/")
    })
  );
  assert.equal(status, 1);
  assert.match(
    stderr,
    /com\.codex\.model-router is not running: did not become ready/u
  );
});

test("a router port answered by a process other than the launchd job fails the install", async () => {
  const base = deps();
  const [status, stderr] = await captureStderr(() =>
    restartServices(options(), {
      ...base,
      listeningPids: (port) =>
        port === 4100 && base.state.loaded.has(LABEL_MODEL_ROUTER)
          ? [68_804]
          : base.listeningPids(port)
    })
  );
  assert.equal(status, 1);
  assert.match(
    stderr,
    /port 4100 is served by pid 68804, not the launchd job \(pid 100\)/u
  );
});

test("an unmanaged listener from this CODEX_HOME is stopped and gone before its label is bootstrapped", async () => {
  const fake = deps({}, { strays: new Map([[4100, 68_804]]) });
  let releasedAfter = 0;
  const [status, stderr] = await captureStderr(() =>
    restartServices(options(), {
      ...fake,
      commandLine: (pid) =>
        pid === 68_804 ? "node /home/.codex/src/router/server.ts" : null,
      kill: (pid, signal) => {
        fake.kills.push({ pid, signal });
        fake.calls.push(`kill:${pid}:${signal}`);
      },
      sleep: async () => {
        releasedAfter += 1;
        if (releasedAfter === 3) fake.state.strays.delete(4100);
      }
    })
  );
  assert.equal(status, 0);
  assert.match(
    stderr,
    /reaping unmanaged com\.codex\.model-router on port 4100 \(pid 68804\)/u
  );
  assert.deepEqual(fake.kills, [{ pid: 68_804, signal: "SIGTERM" }]);
  assert.ok(
    fake.calls.indexOf("kill:68804:SIGTERM") <
      fake.calls.indexOf(
        `bootstrap:/home/Library/LaunchAgents/${LABEL_MODEL_ROUTER}.plist`
      ),
    "the stray process is stopped before the new job can hit EADDRINUSE"
  );
});

test("an unmanaged listener that ignores SIGTERM is killed before its label is bootstrapped", async () => {
  const fake = deps({}, { strays: new Map([[4100, 68_804]]) });
  const [status] = await captureStderr(() =>
    restartServices(options(), {
      ...fake,
      commandLine: () => "node /home/.codex/src/router/server.ts",
      kill: (pid, signal) => {
        fake.kills.push({ pid, signal });
        if (signal === "SIGKILL") fake.state.strays.delete(4100);
      }
    })
  );
  assert.equal(status, 0);
  assert.deepEqual(fake.kills, [
    { pid: 68_804, signal: "SIGTERM" },
    { pid: 68_804, signal: "SIGKILL" }
  ]);
});

test("a port held by a process this installer does not own is left alone and falls back to the ensure hooks", async () => {
  const fake = deps({}, { strays: new Map([[4003, 42]]) });
  const [status, stderr] = await captureStderr(() =>
    restartServices(options(), {
      ...fake,
      commandLine: () => "/usr/bin/some-other-server"
    })
  );
  assert.equal(status, 0);
  assert.deepEqual(fake.kills, []);
  assert.match(
    stderr,
    /port 4003 held by a process this installer does not own \(pid 42\)/u
  );
  assert.match(stderr, /launchd could not load com\.codex\.copilot-proxy/u);
  assert.equal(
    fake.runs.length,
    5,
    "the direct ensure hooks start what launchd could not"
  );
});

test("a label launchd refuses to load is reported and falls back to the ensure hooks", async () => {
  const fake = deps();
  const [status, stderr] = await captureStderr(() =>
    restartServices(options(), {
      ...fake,
      launchd: {
        ...fake.launchd,
        bootstrap: (plist) => {
          if (plist.endsWith(`${LABEL_CLAUDE_BRIDGE}.plist`))
            throw new Error("Bootstrap failed: 5: Input/output error");
          fake.launchd.bootstrap(plist);
        }
      }
    })
  );
  assert.equal(status, 0);
  assert.match(
    stderr,
    /could not load com\.codex\.claude-bridge: Bootstrap failed: 5: Input\/output error/u
  );
  assert.match(stderr, /launchd could not load com\.codex\.claude-bridge/u);
  assert.equal(stderr.includes("launchctl unavailable"), false);
  assert.ok(
    fake.runs.some((run) =>
      run.args.at(-1)?.endsWith("ensure-codex-model-router.sh")
    )
  );
});

test("a job that will not unload is reported instead of being bootstrapped over", async () => {
  const fake = deps({}, { loaded: new Set([LABEL_MODEL_ROUTER]) });
  const [status, stderr] = await captureStderr(() =>
    restartServices(options(), {
      ...fake,
      launchd: {
        ...fake.launchd,
        bootout: (label) => {
          if (label === LABEL_MODEL_ROUTER)
            throw new Error(
              `gui/501/${label} was still loaded 50000ms after bootout`
            );
          fake.launchd.bootout(label);
        }
      }
    })
  );
  assert.equal(status, 0);
  assert.match(
    stderr,
    /could not unload com\.codex\.model-router: .*still loaded/u
  );
  assert.equal(
    fake.calls.includes(
      `bootstrap:/home/Library/LaunchAgents/${LABEL_MODEL_ROUTER}.plist`
    ),
    false
  );
  assert.match(stderr, /launchd could not load com\.codex\.model-router/u);
});

test("a loaded service owned by another runtime leaves every service untouched", async () => {
  const fake = deps({}, { loaded: new Set([LABEL_OTEL_COLLECTOR]) });
  const [status, stderr] = await captureStderr(() =>
    restartServices(options(), {
      ...fake,
      launchd: {
        ...fake.launchd,
        print: (label) =>
          label === LABEL_OTEL_COLLECTOR
            ? "program = /foreign/runtime/collector"
            : fake.launchd.print(label)
      }
    })
  );
  assert.equal(status, 0);
  assert.deepEqual(
    fake.calls,
    [],
    "no label is reloaded before the ownership check"
  );
  assert.deepEqual(fake.runs, []);
  assert.match(
    stderr,
    /loaded com\.codex\.otel-collector belongs to another runtime/u
  );
});

test("a loaded service with an earlier install path under the same CODEX_HOME is adopted and restarted", async () => {
  const fake = deps({}, { loaded: new Set([LABEL_OTEL_COLLECTOR]) });
  assert.equal(
    await restartServices(options({ otelMode: "collector" }), {
      ...fake,
      launchd: {
        ...fake.launchd,
        print: (label) =>
          label === LABEL_OTEL_COLLECTOR
            ? "program = /bin/bash\narguments = { /home/.codex/hooks/codex/otel/run-autodev-otel-collector.sh }\nCODEX_HOME => /home/.codex"
            : fake.launchd.print(label)
      }
    }),
    0
  );
  assert.ok(fake.calls.includes(`bootout:${LABEL_OTEL_COLLECTOR}`));
  assert.ok(fake.calls.includes(`enable:${LABEL_OTEL_COLLECTOR}`));
  assert.ok(
    fake.calls.includes(
      `bootstrap:/home/Library/LaunchAgents/${LABEL_OTEL_COLLECTOR}.plist`
    )
  );
});

test("a runtime rooted at another CODEX_HOME is left untouched", async () => {
  const fake = deps({
    readFile: () => "<key>CODEX_HOME</key><string>/other/.codex</string>"
  });
  assert.equal(await restartServices(options(), fake), 0);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.runs, []);
});

test("a missing launchctl skips every launchd call and forwards Collector paths to the ensure hooks", async () => {
  const fake = deps({ commandAvailable: () => false });
  const [status, stderr] = await captureStderr(() =>
    restartServices(options({ otelMode: "collector" }), fake)
  );
  assert.equal(status, 0);
  assert.match(stderr, /launchctl unavailable \(sandbox\?\)/u);
  assert.deepEqual(fake.calls, []);
  const collector = fake.runs.find((run) =>
    run.args.at(-1)?.endsWith("ensure-autodev-otel-collector.sh")
  );
  assert.deepEqual(collector?.env, {
    AUTODEV_OTEL_REPO_ROOT: "/repo",
    AUTODEV_OTEL_CONFIG: "/repo/config/otel/collector.yaml",
    AUTODEV_OTEL_VERSION_FILE: "/repo/config/otel/collector.version"
  });
});
