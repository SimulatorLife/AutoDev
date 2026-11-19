import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compareInvestigations } from "../.rulesync/skills/autodev-session-diagnostics/scripts/investigation-compare.ts";
import { probe } from "../.rulesync/skills/autodev-session-diagnostics/scripts/mcp-probe.ts";
import {
  probeRuleLoading,
  ruleEntryLoads
} from "../.rulesync/skills/autodev-session-diagnostics/scripts/rule-loading-probe.ts";

const COMPARE_SCRIPT = fileURLToPath(
  new URL(
    "../.rulesync/skills/autodev-session-diagnostics/scripts/investigation-compare.ts",
    import.meta.url
  )
);
const SCRIPT = fileURLToPath(
  new URL(
    "../.rulesync/skills/autodev-session-diagnostics/scripts/session-trace.ts",
    import.meta.url
  )
);
const ROOT = "01a0b662-0000-7000-8000-000000000001";
const CHILD = "01a0b664-0000-7000-8000-000000000002";
const OTHER = "01a0b699-0000-7000-8000-000000000003";
const SERVICE_TOKEN = "control-api-service-token";

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly actor: string | undefined;
}

interface FakeControlApi {
  readonly url: string;
  /** The requests the wrapper made, read from the server's own log. */
  readonly requests: () => RecordedRequest[];
  readonly close: () => void;
}

const FAKE_CONTROL_API_SOURCE = String.raw`
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const [body, logFile] = process.argv.slice(2);
const server = createServer((request, response) => {
  appendFileSync(
    logFile,
    JSON.stringify({
      url: request.url ?? "",
      method: request.method ?? "",
      authorization: request.headers.authorization,
      actor: request.headers["x-autodev-actor"]
    }) + "\n"
  );
  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    connection: "close"
  });
  response.end(body);
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("PORT=" + server.address().port + "\n");
});
`;

/**
 * A Control API that answers one diagnostics route and records the request.
 *
 * The server runs in its own process: the wrapper is a child process too, and
 * a child cannot always reach a socket this process opened.
 */
async function fakeControlApi(body: string): Promise<FakeControlApi> {
  const directory = mkdtempSync(join(tmpdir(), "autodev-fake-api-"));
  const serverFile = join(directory, "server.mjs");
  const logFile = join(directory, "requests.jsonl");
  writeFileSync(serverFile, FAKE_CONTROL_API_SOURCE);
  writeFileSync(logFile, "");
  const server = spawn(process.execPath, [serverFile, body, logFile], {
    stdio: ["ignore", "pipe", "inherit"]
  });
  const port = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = /PORT=(\d+)/u.exec(buffer);
      if (match?.[1]) resolve(match[1]);
    });
    server.once("error", reject);
    server.once("exit", () => reject(new Error("the fake Control API exited")));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () =>
      readFileSync(logFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as RecordedRequest),
    close: () => {
      server.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function fixture(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "autodev-diagnostics-"));
  const day = join(home, "sessions", "2026", "09", "18");
  mkdirSync(day, { recursive: true });
  mkdirSync(join(home, "run"), { recursive: true });
  const line = (timestamp: string, type: string, payload: unknown) =>
    JSON.stringify({ timestamp, type, payload });
  const rollout = (id: string, lines: string[]) =>
    writeFileSync(
      join(day, `rollout-2026-09-18T17-00-00-${id}.jsonl`),
      `${lines.join("\n")}\n`
    );
  rollout(ROOT, [
    line("2026-09-18T21:18:00.000Z", "session_meta", {
      id: ROOT,
      session_id: ROOT,
      thread_source: "user",
      model_provider: "local_model_router",
      cwd: "/tmp/repo"
    }),
    line("2026-09-18T21:18:00.100Z", "turn_context", {
      model: "autodev/orchestrator"
    }),
    line("2026-09-18T21:18:00.200Z", "event_msg", {
      type: "task_started",
      turn_id: "t-root"
    }),
    line("2026-09-18T21:18:06.000Z", "event_msg", {
      type: "task_complete",
      turn_id: "t-root",
      last_agent_message: "done"
    })
  ]);
  rollout(CHILD, [
    line("2026-09-18T21:20:00.000Z", "session_meta", {
      id: CHILD,
      session_id: ROOT,
      parent_thread_id: ROOT,
      thread_source: "subagent",
      agent_role: "worker",
      agent_nickname: "ImplementationCoder",
      cwd: "/tmp/repo"
    }),
    line("2026-09-18T21:20:00.100Z", "turn_context", {
      model: "autodev/worker"
    })
  ]);
  rollout(OTHER, [
    line("2026-09-18T21:21:00.000Z", "session_meta", {
      id: OTHER,
      session_id: OTHER,
      thread_source: "user"
    })
  ]);
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

function runWrapper(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): ReturnType<typeof spawnSync<string>> {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

test("observed investigations with an omitted metric count as metric-missing", () => {
  const result = compareInvestigations(
    [
      { investigation: { observed: true } },
      { investigation: { observed: false } }
    ],
    [{ investigation: { observed: true, toolCalls: 5 } }]
  );
  assert.equal(result.after.metrics.toolCalls.mean, 5);
  assert.equal(result.after.metrics.toolCalls.missing, 0);
  assert.equal(
    result.before.metrics.toolCalls.missing,
    2,
    "a metric no thread reported is missing on every thread, including the unobserved one"
  );
});

test("comparison rejects malformed thread records and investigation values", () => {
  assert.throws(
    () =>
      compareInvestigations(
        [{ investigation: { observed: "yes" } } as never],
        [{ investigation: { observed: true } }]
      ),
    /observed must be a boolean/u
  );
  assert.throws(
    () =>
      compareInvestigations(
        [{ investigation: { observed: true, toolCalls: Number.NaN } } as never],
        [{ investigation: { observed: true } }]
      ),
    /finite number/u
  );
});

test("comparison CLI reads session-trace reports and gives useful malformed-input errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-compare-"));
  try {
    const good = join(directory, "good.json");
    writeFileSync(
      good,
      JSON.stringify({
        threads: [{ investigation: { observed: true, toolCalls: 2 } }]
      })
    );
    const after = join(directory, "after.json");
    writeFileSync(
      after,
      JSON.stringify({
        threads: [{ investigation: { observed: true, toolCalls: 8 } }]
      })
    );
    const run = spawnSync(process.execPath, [COMPARE_SCRIPT, good, after], {
      encoding: "utf8"
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /toolCalls/u);

    const bad = join(directory, "bad.json");
    writeFileSync(bad, JSON.stringify({ threads: "not-an-array" }));
    const failed = spawnSync(process.execPath, [COMPARE_SCRIPT, bad, after], {
      encoding: "utf8"
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /threads array/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("investigation comparison aggregates observed values and preserves missingness", () => {
  const result = compareInvestigations(
    [
      { investigation: { observed: true, toolCalls: 4, filesRead: 2 } },
      { investigation: { observed: true, toolCalls: 6 } },
      { investigation: { observed: false } }
    ],
    [
      { investigation: { observed: true, toolCalls: 10, filesRead: 4 } },
      { investigation: { observed: true } }
    ]
  );
  assert.equal(result.before.metrics.toolCalls.mean, 5);
  assert.equal(result.after.metrics.toolCalls.mean, 10);
  assert.equal(result.deltas.toolCalls.mean, 5);
  assert.equal(result.before.metrics.filesRead.missing, 2);
  assert.equal(result.before.unavailableThreads, 1);
});

test("the wrapper asks the Control API for the session report", async () => {
  const api = await fakeControlApi("== thread report\n");
  try {
    const run = runWrapper([ROOT], {
      AUTODEV_CONTROL_API_TOKEN: SERVICE_TOKEN,
      AUTODEV_CONTROL_API_BASE_URL: api.url
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "== thread report");
    assert.equal(api.requests().length, 1);
    const request = api.requests()[0]!;
    assert.equal(request.method, "GET");
    assert.equal(request.authorization, `Bearer ${SERVICE_TOKEN}`);
    assert.equal(request.actor, "autodev-local");
    assert.match(request.url, /^\/control\/diagnostics\/sessions\//u);
    assert.match(request.url, /format=text/u);
  } finally {
    api.close();
  }
});

test("the wrapper asks for JSON when it is told to", async () => {
  const api = await fakeControlApi(
    JSON.stringify({ schema: "autodev-session-diagnostics-v1" })
  );
  try {
    const run = runWrapper([ROOT, "--json"], {
      AUTODEV_CONTROL_API_TOKEN: SERVICE_TOKEN,
      AUTODEV_CONTROL_API_BASE_URL: api.url
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      JSON.parse(run.stdout).schema,
      "autodev-session-diagnostics-v1"
    );
    assert.match(api.requests()[0]!.url, /format=json/u);
  } finally {
    api.close();
  }
});

test("the wrapper carries the flags the route needs into the query", async () => {
  const api = await fakeControlApi("report\n");
  try {
    const run = runWrapper(
      [ROOT, "--efficiency", "--failures", "--all-failures", "--items", "--events"],
      {
        AUTODEV_CONTROL_API_TOKEN: SERVICE_TOKEN,
        AUTODEV_CONTROL_API_BASE_URL: api.url
      }
    );
    assert.equal(run.status, 0, run.stderr);
    const url = api.requests()[0]!.url;
    assert.match(url, /includeEfficiency=1/u);
    assert.match(url, /includeFailures=1/u);
    assert.match(url, /allFailures=1/u);
    assert.match(url, /includeItems=1/u);
    assert.match(url, /includeEvents=1/u);
  } finally {
    api.close();
  }
});

test("the wrapper asks for the fleet routes with their own parameters", async () => {
  const api = await fakeControlApi("fleet\n");
  try {
    const recent = runWrapper(["--recent", "3"], {
      AUTODEV_CONTROL_API_TOKEN: SERVICE_TOKEN,
      AUTODEV_CONTROL_API_BASE_URL: api.url
    });
    assert.equal(recent.status, 0, recent.stderr);
    assert.match(api.requests()[0]!.url, /^\/control\/diagnostics\/sessions\/recent/u);
    assert.match(api.requests()[0]!.url, /limit=3/u);

    const hooks = runWrapper(["--hooks", "--since", "14"], {
      AUTODEV_CONTROL_API_TOKEN: SERVICE_TOKEN,
      AUTODEV_CONTROL_API_BASE_URL: api.url
    });
    assert.equal(hooks.status, 0, hooks.stderr);
    assert.match(api.requests()[1]!.url, /^\/control\/diagnostics\/hooks/u);
    assert.match(api.requests()[1]!.url, /sinceDays=14/u);

    const scan = runWrapper(["--scan-recent", "5"], {
      AUTODEV_CONTROL_API_TOKEN: SERVICE_TOKEN,
      AUTODEV_CONTROL_API_BASE_URL: api.url
    });
    assert.equal(scan.status, 0, scan.stderr);
    assert.match(api.requests()[2]!.url, /^\/control\/diagnostics\/sessions\/scan/u);
    assert.match(api.requests()[2]!.url, /limit=5/u);
  } finally {
    api.close();
  }
});

test("the wrapper reads the Control API token from the codex home's secrets file", async () => {
  const api = await fakeControlApi("report\n");
  const { home, cleanup } = fixture();
  try {
    writeFileSync(
      join(home, "openlit-secrets.env"),
      `# the control api credential\nAUTODEV_CONTROL_API_TOKEN="${SERVICE_TOKEN}"\n`
    );
    const run = runWrapper([ROOT, "--offline"], {
      AUTODEV_CONTROL_API_BASE_URL: api.url,
      CODEX_HOME: home,
      AUTODEV_CONTROL_API_TOKEN: ""
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(api.requests().length, 0, "--offline must not call the API");

    const online = runWrapper([ROOT], {
      AUTODEV_CONTROL_API_BASE_URL: api.url,
      CODEX_HOME: home,
      AUTODEV_CONTROL_API_TOKEN: ""
    });
    assert.equal(online.status, 0, online.stderr);
    assert.equal(api.requests().length, 1);
    assert.equal(api.requests()[0]!.authorization, `Bearer ${SERVICE_TOKEN}`);
  } finally {
    api.close();
    cleanup();
  }
});

test("the wrapper never prints the credential it used", async () => {
  const api = await fakeControlApi("report\n");
  try {
    const run = runWrapper([ROOT], {
      AUTODEV_CONTROL_API_TOKEN: SERVICE_TOKEN,
      AUTODEV_CONTROL_API_BASE_URL: api.url
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, new RegExp(SERVICE_TOKEN, "u"));
    assert.doesNotMatch(run.stderr, new RegExp(SERVICE_TOKEN, "u"));
  } finally {
    api.close();
  }
});

test("an offline run reads the machine directly, through the same engine", () => {
  const { home, cleanup } = fixture();
  try {
    const run = runWrapper([ROOT, "--json", "--offline", "--codex-home", home], {
      AUTODEV_CONTROL_API_TOKEN: SERVICE_TOKEN,
      AUTODEV_CONTROL_API_BASE_URL: "http://127.0.0.1:1"
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.schema, "autodev-session-diagnostics-v1");
    assert.equal(report.found, true);
    assert.equal(report.threads.length, 2);
    assert.equal(report.live, null);
  } finally {
    cleanup();
  }
});

test("a run against a Control API that is not there falls back to the engine", () => {
  const { home, cleanup } = fixture();
  try {
    // No --offline and no --codex-home: the wrapper wants the live API, and the
    // API is not there. The same engine answers from the machine instead.
    const run = runWrapper([ROOT, "--json"], {
      AUTODEV_CONTROL_API_TOKEN: SERVICE_TOKEN,
      AUTODEV_CONTROL_API_BASE_URL: "http://127.0.0.1:1",
      CODEX_HOME: home
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.schema, "autodev-session-diagnostics-v1");
    assert.equal(report.found, true);
    assert.equal(report.threads.length, 2);
  } finally {
    cleanup();
  }
});

test("the wrapper and the CLI produce the same report", () => {
  const { home, cleanup } = fixture();
  try {
    const wrapper = runWrapper([ROOT, "--json", "--offline", "--codex-home", home]);
    const cli = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../runtime/src/cli/autodev.ts", import.meta.url)),
        "diagnostics",
        ROOT,
        "--json",
        "--offline",
        "--codex-home",
        home
      ],
      { encoding: "utf8" }
    );
    assert.equal(wrapper.status, 0, wrapper.stderr);
    assert.equal(cli.status, 0, cli.stderr);
    const fromWrapper = JSON.parse(wrapper.stdout);
    const fromCli = JSON.parse(cli.stdout);
    assert.deepEqual(fromWrapper.threads, fromCli.threads);
    assert.deepEqual(fromWrapper.aggregates, fromCli.aggregates);
  } finally {
    cleanup();
  }
});

test("the wrapper's JSON report is readable by the investigation comparison", () => {
  const { home, cleanup } = fixture();
  const directory = mkdtempSync(join(tmpdir(), "autodev-compare-cli-"));
  try {
    const reportFile = join(directory, "report.json");
    const run = runWrapper([ROOT, "--json", "--offline", "--codex-home", home]);
    assert.equal(run.status, 0, run.stderr);
    writeFileSync(reportFile, run.stdout);
    const compared = spawnSync(
      process.execPath,
      [COMPARE_SCRIPT, reportFile, reportFile],
      { encoding: "utf8" }
    );
    assert.equal(compared.status, 0, compared.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    cleanup();
  }
});

test("the wrapper documents its usage and exits 2 when it is asked for nothing", () => {
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(
    usage.stderr,
    /usage: session-trace\.ts <session-or-thread-id>/
  );
  assert.match(usage.stderr, /--scan-recent/u);
  assert.match(usage.stderr, /--hooks/u);
});

test("the MCP probe reports the tools, each call, and the stderr of a server that dies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autodev-mcp-probe-"));
  try {
    // A tiny MCP server: one tool that works, one that makes it exit like lsp-mcp-server did.
    const server = join(dir, "server.mjs");
    writeFileSync(
      server,
      String.raw`import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [ { name: "ok_tool" }, { name: "crash_tool" } ] } });
  else if (m.method === "tools/call" && m.params.name === "ok_tool") send({ jsonrpc: "2.0", id: m.id, result: { content: [ { type: "text", text: "fine" } ] } });
  else if (m.method === "tools/call") { process.stderr.write("spawn typescript-language-server ENOENT\n"); process.exit(1); }
});
`
    );
    const launcher = join(dir, "launcher.sh");
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`
    );
    chmodSync(launcher, 0o755);
    const result = await probe({
      server: "fake",
      cwd: dir,
      launcher,
      calls: [
        { tool: "ok_tool", args: {} },
        { tool: "crash_tool", args: {} }
      ],
      timeoutMs: 5000
    });
    assert.deepEqual(result.tools, ["ok_tool", "crash_tool"]);
    assert.deepEqual(
      result.calls.map((call) => [call.tool, call.ok]),
      [
        ["ok_tool", true],
        ["crash_tool", false]
      ]
    );
    assert.match(result.calls[1]?.text ?? "", /server exited/);
    assert.equal(result.exited?.code, 1);
    assert.match(result.stderrTail, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rules entry loads only when it resolves to a file directly in the rules directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-rules-"));
  try {
    const rulesDir = join(directory, "rules");
    const outside = join(directory, "outside.rules");
    mkdirSync(rulesDir, { recursive: true });
    mkdirSync(join(rulesDir, "nested"), { recursive: true });
    writeFileSync(join(rulesDir, "default.rules"), "allow git\n");
    writeFileSync(outside, "allow git\n");
    symlinkSync(outside, join(rulesDir, "linked.rules"));
    writeFileSync(join(rulesDir, "nested", "default.rules"), "allow git\n");

    assert.equal(
      ruleEntryLoads(rulesDir, join(rulesDir, "default.rules")).loads,
      true,
      "a regular file directly in the rules directory is loaded"
    );
    assert.equal(
      ruleEntryLoads(rulesDir, join(rulesDir, "linked.rules")).loads,
      false,
      "a symlink is skipped by Codex, so the entry never lifts the sandbox"
    );
    assert.equal(
      ruleEntryLoads(rulesDir, join(rulesDir, "nested", "default.rules")).loads,
      false,
      "a file below the rules directory is not an entry Codex resolves"
    );
    assert.equal(typeof probeRuleLoading, "function");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
