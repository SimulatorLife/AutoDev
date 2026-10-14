import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";

const REPO_ROOT = resolvePath(import.meta.dirname, "..");

/**
 * A stand-in for `agy -p`: speaks MCP to the tools shim its own mcp_config
 * names, the way agy reaches every MCP server. A `call` blocks on a real
 * tools/call, which is what parks the turn.
 */
const FAKE_AGY = String.raw`
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const log = process.env.FAKE_AGY_LOG;
appendFileSync(log, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + "\n");

// agy streams a text delta before reaching for a tool, so the bridge has
// something to open the response with.
process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_type: "text", text_delta: "looking" } }) + "\n");

const config = JSON.parse(
  readFileSync(join(process.env.HOME, ".gemini", "config", "mcp_config.json"), "utf8")
);
const definition = config.mcpServers.codex;
if (!definition) {
  process.stderr.write("no codex MCP server was configured\n");
  process.exit(3);
}
const server = spawn(definition.command, definition.args, {
  env: { ...process.env, ...definition.env },
  stdio: ["pipe", "pipe", "inherit"]
});

let nextId = 1;
const pending = new Map();
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    pending.get(message.id)?.(message.result ?? message.error);
    pending.delete(message.id);
  }
});
function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

await rpc("initialize", { protocolVersion: "2025-06-18" });
const listed = await rpc("tools/list", {});
appendFileSync(log, JSON.stringify({ tools: listed.tools.map((tool) => tool.name) }) + "\n");

const result = await rpc("tools/call", { name: "read_file", arguments: { path: "README.md" } });
appendFileSync(log, JSON.stringify({ result }) + "\n");

process.stdout.write(
  JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "read it: " + (result.content?.[0]?.text ?? "") } }) + "\n"
);
server.kill();
process.exit(0);
`;

/**
 * The same stand-in, but with two calls in flight at once. The first parks the
 * turn, so the second arrives when there is no live response left to emit it on
 * -- which is exactly the window where a queued call can be lost.
 */
const PARALLEL_AGY = String.raw`
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const log = process.env.FAKE_AGY_LOG;
appendFileSync(log, JSON.stringify({ pid: process.pid }) + "\n");
process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_type: "text", text_delta: "looking" } }) + "\n");

const config = JSON.parse(
  readFileSync(join(process.env.HOME, ".gemini", "config", "mcp_config.json"), "utf8")
);
const definition = config.mcpServers.codex;
if (!definition) {
  process.stderr.write("no codex MCP server was configured\n");
  process.exit(3);
}
const server = spawn(definition.command, definition.args, {
  env: { ...process.env, ...definition.env },
  stdio: ["pipe", "pipe", "inherit"]
});

let nextId = 1;
const pending = new Map();
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    pending.get(message.id)?.(message.result ?? message.error);
    pending.delete(message.id);
  }
});
function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

await rpc("initialize", { protocolVersion: "2025-06-18" });
const names = ["first", "second"];
const results = await Promise.all(
  names.map((tool) =>
    rpc("tools/call", { name: "read_file", arguments: { path: tool + ".md" } })
  )
);
process.stdout.write(
  JSON.stringify({
    event: "result",
    result: {
      status: "SUCCESS",
      response: "read both: " + results.map((r) => r.content?.[0]?.text ?? "?").join(", ")
    }
  }) + "\n"
);
server.kill();
process.exit(0);
`;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function waitForBridge(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(
      () => reject(new Error(`bridge start timed out: ${stderr}`)),
      10_000
    );
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes("Antigravity Responses proxy listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`bridge exited before startup (${code}): ${stderr}`));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

const TOOLS = [
  {
    type: "additional_tools",
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file from the workspace.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }
    ]
  }
];

function sseEvents(body: string): Record<string, any>[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

async function post(
  port: number,
  body: unknown,
  signal: AbortSignal
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-autodev-agent-role": "browser-tester"
    },
    body: JSON.stringify(body),
    signal
  });
  return { status: response.status, body: await response.text() };
}

test("a Codex tool agy called is parked, and the continuation resumes the same turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "autodev-agy-codex-loop-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  const workspace = join(root, "workspace");
  const agyHome = join(home, ".gemini");
  const agyCliDir = join(agyHome, "antigravity-cli");
  const agyLog = join(root, "agy.jsonl");
  const fakeAgy = join(root, "fake-agy.mjs");
  const port = await reservePort();

  mkdirSync(join(agyHome, "config"), { recursive: true });
  mkdirSync(agyCliDir, { recursive: true });
  mkdirSync(join(agyHome, "antigravity-browser-profile"), {
    recursive: true
  });
  mkdirSync(join(codexHome, "provider-runtime"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(agyHome, "config", "mcp_config.json"), "{}\n");
  writeFileSync(
    join(agyCliDir, "settings.json"),
    '{"permissions":{"allow":[],"deny":[]}}\n'
  );
  writeFileSync(
    join(codexHome, "provider-runtime", "mcp-servers.json"),
    JSON.stringify({ playwright: { command: process.execPath, args: [] } })
  );
  writeFileSync(fakeAgy, `#!/usr/bin/env node\n${FAKE_AGY}`, { mode: 0o755 });
  writeFileSync(agyLog, "");

  const bridge = spawn(
    process.execPath,
    ["runtime/src/providers/antigravity.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        AGY_PROXY_PORT: String(port),
        AGY_CLI_PATH: fakeAgy,
        AGY_SKIP_PERMISSIONS: "true",
        FAKE_AGY_LOG: agyLog,
        LITELLM_API_KEY: ""
      },
      stdio: ["ignore", "ignore", "pipe"]
    }
  );

  try {
    await waitForBridge(bridge);

    // First request: agy calls a Codex tool and blocks on it.
    const first = await post(
      port,
      {
        cwd: workspace,
        input: [
          ...TOOLS,
          { type: "message", role: "user", content: "read it" }
        ],
        model: "gemini-3.8-flash-medium",
        stream: true
      },
      AbortSignal.timeout(30_000)
    );
    assert.equal(first.status, 200, first.body);
    assert.match(
      first.body,
      /data: \[DONE\]/,
      "the parked turn ends its response"
    );

    // `output_item.added` announces the item with empty arguments, exactly as
    // Codex expects; the arguments land on the `done` event.
    const added = sseEvents(first.body).find(
      (event) =>
        event.type === "response.output_item.added" &&
        event.item?.type === "function_call"
    );
    assert.ok(added, `the call must be announced: ${first.body}`);
    assert.equal(added.item.arguments, "");
    assert.ok(
      added.output_index >= 2,
      `the call must land after the reasoning and message items, not inside one: index ${added.output_index}`
    );

    const call = sseEvents(first.body).find(
      (event) =>
        event.type === "response.output_item.done" &&
        event.item?.type === "function_call"
    );
    assert.ok(call, `the bridge must owe Codex the call: ${first.body}`);
    assert.equal(call.item.name, "read_file");
    assert.deepEqual(JSON.parse(call.item.arguments), { path: "README.md" });

    // Second request: Codex answers the call, and the turn continues.
    const second = await post(
      port,
      {
        cwd: workspace,
        input: [
          ...TOOLS,
          { type: "message", role: "user", content: "read it" },
          call.item,
          {
            type: "function_call_output",
            call_id: call.item.call_id,
            output: "the file body"
          }
        ],
        model: "gemini-3.8-flash-medium",
        stream: true
      },
      AbortSignal.timeout(30_000)
    );
    assert.equal(second.status, 200, second.body);
    const completed = sseEvents(second.body).find(
      (event) => event.type === "response.completed"
    );
    assert.ok(
      completed,
      `the continuation must finish the turn: ${second.body}`
    );
    assert.match(completed.response.output_text, /read it: the file body/);

    // One agy process for the whole exchange: a second one would mean the
    // continuation started a fresh turn and the original stayed parked.
    const launches = readFileSync(agyLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
    assert.equal(
      launches.filter((entry) => typeof entry.pid === "number").length,
      1,
      `the parked turn must be resumed, not replaced: ${agyLog}`
    );
    // The shim answered with the tools Codex offered on this turn.
    assert.deepEqual(launches.find((e) => e.tools)?.tools, ["read_file"]);
    assert.deepEqual(
      launches.find((e) => e.result)?.result?.content?.[0]?.text,
      "the file body"
    );
    // agy ran as the agent whose built-ins are excluded.
    const argv: string[] = launches.find((e) => e.argv)?.argv ?? [];
    assert.equal(argv[argv.indexOf("--agent") + 1], "autodev-codex-tools");
    assert.ok(argv.includes("--add-dir"));
  } finally {
    await stopChild(bridge);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a call against a turn that is gone is refused rather than left to hang", async () => {
  const root = mkdtempSync(join(tmpdir(), "autodev-agy-codex-refuse-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(
    join(home, ".gemini", "antigravity-cli", "settings.json"),
    '{"permissions":{"allow":[],"deny":[]}}\n'
  );
  const port = await reservePort();

  // A bridge with no live turn: the registry is empty, so the shim's call has
  // nothing to park against and must be told so instead of waiting.
  const bridge = spawn(
    process.execPath,
    ["runtime/src/providers/antigravity.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: join(root, "codex"),
        AGY_PROXY_PORT: String(port),
        AGY_SKIP_PERMISSIONS: "true",
        AGY_SHIM_ONLY: "true",
        AGY_HOME_ONLY: "true",
        AUTODEV_BRIDGE_ONLY: "1",
        LITELLM_API_KEY: ""
      },
      stdio: ["ignore", "ignore", "pipe"]
    }
  );

  try {
    await waitForBridge(bridge);
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/bridge-tools/call`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          turn: "no-such-turn",
          name: "read_file",
          arguments: {}
        }),
        signal: AbortSignal.timeout(10_000)
      }
    );
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /no longer active/);
  } finally {
    await stopChild(bridge);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second tool call made while the turn is parked still reaches Codex", async () => {
  const root = mkdtempSync(join(tmpdir(), "autodev-agy-codex-parallel-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  const workspace = join(root, "workspace");
  const agyHome = join(home, ".gemini");
  const agyCliDir = join(agyHome, "antigravity-cli");
  const agyLog = join(root, "agy.jsonl");
  const fakeAgy = join(root, "fake-agy.mjs");
  const port = await reservePort();

  mkdirSync(join(agyHome, "config"), { recursive: true });
  mkdirSync(agyCliDir, { recursive: true });
  mkdirSync(join(agyHome, "antigravity-browser-profile"), {
    recursive: true
  });
  mkdirSync(join(codexHome, "provider-runtime"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(agyHome, "config", "mcp_config.json"), "{}\n");
  writeFileSync(
    join(agyCliDir, "settings.json"),
    '{"permissions":{"allow":[],"deny":[]}}\n'
  );
  writeFileSync(
    join(codexHome, "provider-runtime", "mcp-servers.json"),
    JSON.stringify({
      playwright: { command: process.execPath, args: [] }
    })
  );
  writeFileSync(fakeAgy, `#!/usr/bin/env node\n${PARALLEL_AGY}`, {
    mode: 0o755
  });
  writeFileSync(agyLog, "");

  const bridge = spawn(
    process.execPath,
    ["runtime/src/providers/antigravity.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        AGY_PROXY_PORT: String(port),
        AGY_CLI_PATH: fakeAgy,
        AGY_SKIP_PERMISSIONS: "true",
        FAKE_AGY_LOG: agyLog,
        LITELLM_API_KEY: ""
      },
      stdio: ["ignore", "ignore", "pipe"]
    }
  );

  // Each call is answered with the path it asked for, so a call that reached
  // agy is distinguishable from one the bridge never emitted.
  const callItems = (body: string) =>
    sseEvents(body)
      .filter(
        (event) =>
          event.type === "response.output_item.done" &&
          event.item?.type === "function_call"
      )
      .map((event) => event.item as Record<string, any>);
  const answer = (item: Record<string, any>) => [
    item,
    {
      type: "function_call_output",
      call_id: item.call_id,
      output: "out:" + JSON.parse(item.arguments).path
    }
  ];

  try {
    await waitForBridge(bridge);

    const input = [
      ...TOOLS,
      { type: "message", role: "user", content: "read both" }
    ];
    const first = await post(
      port,
      {
        cwd: workspace,
        input,
        model: "gemini-3.8-flash-medium",
        stream: true
      },
      AbortSignal.timeout(20_000)
    );
    assert.equal(first.status, 200, first.body);

    const answered = new Set<string>();
    let carried: Record<string, any>[] = [...input];
    for (const item of callItems(first.body)) {
      answered.add(item.call_id);
      carried = [...carried, ...answer(item)];
    }
    assert.ok(answered.size > 0, `expected a first call: ${first.body}`);

    // Keep answering whatever the bridge still owes Codex. A queued call that
    // is never emitted shows up as a turn completing with only one answered.
    let body = "";
    for (let round = 0; round < 4; round += 1) {
      const response = await post(
        port,
        {
          cwd: workspace,
          input: carried,
          model: "gemini-3.8-flash-medium",
          stream: true
        },
        AbortSignal.timeout(20_000)
      );
      assert.equal(response.status, 200, response.body);
      body = response.body;
      const fresh = callItems(body).filter(
        (item) => !answered.has(item.call_id)
      );
      for (const item of fresh) {
        answered.add(item.call_id);
        carried = [...carried, ...answer(item)];
      }
      if (
        fresh.length === 0 &&
        sseEvents(body).some((event) => event.type === "response.completed")
      )
        break;
    }

    assert.equal(
      answered.size,
      2,
      `both calls must reach Codex; answered ${answered.size}: ${body}`
    );
    assert.match(body, /read both: out:first\.md, out:second\.md/);
    const launches = readFileSync(agyLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
    assert.equal(
      launches.filter((entry) => typeof entry.pid === "number").length,
      1,
      "one agy for the whole exchange"
    );
  } finally {
    await stopChild(bridge);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a continuation for a call no live turn owns starts a turn instead of hanging", async () => {
  const root = mkdtempSync(join(tmpdir(), "autodev-agy-codex-lost-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  const workspace = join(root, "workspace");
  const agyHome = join(home, ".gemini");
  const agyCliDir = join(agyHome, "antigravity-cli");
  const agyLog = join(root, "agy.jsonl");
  const fakeAgy = join(root, "fake-agy.mjs");
  const port = await reservePort();

  mkdirSync(join(agyHome, "config"), { recursive: true });
  mkdirSync(agyCliDir, { recursive: true });
  mkdirSync(join(agyHome, "antigravity-browser-profile"), {
    recursive: true
  });
  mkdirSync(join(codexHome, "provider-runtime"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(agyHome, "config", "mcp_config.json"), "{}\n");
  writeFileSync(
    join(agyCliDir, "settings.json"),
    '{"permissions":{"allow":[],"deny":[]}}\n'
  );
  writeFileSync(
    join(codexHome, "provider-runtime", "mcp-servers.json"),
    JSON.stringify({
      playwright: { command: process.execPath, args: [] }
    })
  );
  writeFileSync(
    fakeAgy,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(agyLog)}, process.pid + ${JSON.stringify("\n")});`,
      String.raw`process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "fresh turn" } }) + "\n");`,
      "process.exit(0);",
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  writeFileSync(agyLog, "");

  const bridge = spawn(
    process.execPath,
    ["runtime/src/providers/antigravity.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        AGY_PROXY_PORT: String(port),
        AGY_CLI_PATH: fakeAgy,
        AGY_SKIP_PERMISSIONS: "true",
        LITELLM_API_KEY: ""
      },
      stdio: ["ignore", "ignore", "pipe"]
    }
  );

  try {
    await waitForBridge(bridge);
    // The call id belongs to nothing: its turn ended, or never existed here.
    // Resuming must not be attempted, and the request must still be answered.
    const response = await post(
      port,
      {
        cwd: workspace,
        input: [
          ...TOOLS,
          { type: "message", role: "user", content: "carry on" },
          {
            type: "function_call_output",
            call_id: "call_from_a_turn_that_is_gone",
            output: "stale"
          }
        ],
        model: "gemini-3.8-flash-medium",
        stream: true
      },
      AbortSignal.timeout(20_000)
    );
    assert.equal(response.status, 200, response.body);
    const completed = sseEvents(response.body).find(
      (event) => event.type === "response.completed"
    );
    assert.ok(completed, `the request must be answered: ${response.body}`);
    assert.match(completed.response.output_text, /fresh turn/);
    assert.equal(
      readFileSync(agyLog, "utf8").trim().split("\n").length,
      1,
      "a stale continuation is a new turn, not a resume"
    );
  } finally {
    await stopChild(bridge);
    rmSync(root, { recursive: true, force: true });
  }
});
