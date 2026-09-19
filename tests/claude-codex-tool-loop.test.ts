import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

// The Claude bridge serves Claude as the model behind a Codex turn: every
// action is a Codex tool call Codex executes and the app renders. These tests
// drive the real bridge and the real MCP shim with a fake Claude CLI that
// speaks MCP exactly as the CLI does, across the requests Codex would send.

const REPO_ROOT = resolvePath(import.meta.dirname, "..");
const BRIDGE = join(REPO_ROOT, "src/providers/claude.ts");
type JsonRecord = Record<string, any>;

// A stand-in for `claude -p --output-format stream-json`: reads the prompt on
// stdin, starts the MCP server named in --mcp-config, and follows the script
// in CLAUDE_FAKE_SCRIPT. `call` blocks on a real MCP tools/call.
const FAKE_CLI = String.raw`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const stream = (event) => out({ type: "stream_event", event });
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const record = { argv: args, prompt, pid: process.pid };
writeFileSync(process.env.CLAUDE_FAKE_RECORD, JSON.stringify(record));
let server = null, nextId = 1;
const pending = new Map();
let buffer = "";
function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolveCall) => pending.set(id, resolveCall));
}
const config = flag("--mcp-config");
if (config) {
  const [, definition] = Object.entries(JSON.parse(config).mcpServers)[0];
  server = spawn(definition.command, definition.args, { env: { ...process.env, ...definition.env }, stdio: ["pipe", "pipe", "inherit"] });
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message.result ?? message.error);
      pending.delete(message.id);
    }
  });
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  const listed = await rpc("tools/list", {});
  record.tools = listed.tools.map((tool) => tool.name);
  writeFileSync(process.env.CLAUDE_FAKE_RECORD, JSON.stringify(record));
}
for (const step of JSON.parse(process.env.CLAUDE_FAKE_SCRIPT)) {
  if (step.think !== undefined) {
    stream({ type: "message_start" });
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: step.think } });
    stream({ type: "content_block_stop", index: 0 });
  } else if (step.call !== undefined) {
    stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__codex__" + step.call, input: {} } });
    stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.arguments) } });
    stream({ type: "content_block_stop", index: 1 });
    stream({ type: "message_stop" });
    const result = await rpc("tools/call", { name: step.call, arguments: step.arguments });
    record.results = [...(record.results ?? []), result];
    writeFileSync(process.env.CLAUDE_FAKE_RECORD, JSON.stringify(record));
  } else if (step.say !== undefined) {
    const text = step.say.replace("{result}", record.results?.at(-1)?.content?.[0]?.text ?? "");
    stream({ type: "message_start" });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    stream({ type: "content_block_stop", index: 0 });
    stream({ type: "message_stop" });
    out({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 3, output_tokens: 2 } });
  } else if (step.sleep !== undefined) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, step.sleep));
  }
}
server?.kill();
`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function parseSse(
  text: string
): Array<{ event: string; data: JsonRecord | null }> {
  return text
    .trimEnd()
    .split("\n\n")
    .filter((chunk) => chunk && !chunk.startsWith(":"))
    .map((chunk) => {
      if (chunk === "data: [DONE]") return { event: "[DONE]", data: null };
      const lines = chunk.split("\n");
      const event =
        lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      return { event, data: data ? JSON.parse(data) : null };
    });
}

function completedResponse(
  sse: Array<{ event: string; data: JsonRecord | null }>
): JsonRecord {
  const completed = sse.find(({ event }) => event === "response.completed");
  assert.ok(completed?.data, "response.completed present");
  return completed.data.response;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exitsWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) await delay(25);
  return !isAlive(pid);
}

async function readRecord(path: string): Promise<JsonRecord | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function withBridge(
  script: JsonRecord[],
  body: (context: {
    port: number;
    record: () => Promise<JsonRecord>;
    stopBridge: () => Promise<void>;
  }) => Promise<void>
): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "autodev-claude-loop-"));
  const cli = join(temp, "fake-claude.mjs");
  const recordPath = join(temp, "record.json");
  await writeFile(cli, FAKE_CLI, "utf8");
  await chmod(cli, 0o755);
  const port = await freePort();
  const bridge = spawn(process.execPath, [BRIDGE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CODEX_PROJECT_ROOT: REPO_ROOT,
      CLAUDE_BRIDGE_HOST: "127.0.0.1",
      CLAUDE_BRIDGE_PORT: String(port),
      CLAUDE_BIN: cli,
      CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-token",
      CLAUDE_CODE_BRIDGE_TIMEOUT_SECONDS: "10",
      LITELLM_API_KEY: "",
      AUTODEV_NODE_BIN: process.execPath,
      CLAUDE_FAKE_SCRIPT: JSON.stringify(script),
      CLAUDE_FAKE_RECORD: recordPath
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  bridge.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const stopBridge = async (): Promise<void> => {
    if (bridge.exitCode !== null || bridge.signalCode !== null) return;
    const exited = once(bridge, "exit");
    bridge.kill("SIGTERM");
    await exited;
  };
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline)
        throw new Error(`bridge did not start: ${stderr}`);
      await delay(50);
    }
    await body({
      port,
      record: async () => JSON.parse(await readFile(recordPath, "utf8")),
      stopBridge
    });
    // Stopping the bridge must stop every CLI it started; a survivor is an
    // orphan that keeps acting on the workspace.
    await stopBridge();
    const cliRecord = await readRecord(recordPath);
    if (cliRecord)
      assert.ok(
        await exitsWithin(cliRecord.pid, 5000),
        `the CLI (pid ${cliRecord.pid}) outlived its bridge`
      );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.stack : error}\n--- bridge stderr ---\n${stderr}`
    );
  } finally {
    await stopBridge();
    await rm(temp, { recursive: true, force: true });
  }
}

// The code-mode tool surface Codex 0.154.0 sends a worker, reduced to shape.
const CODEX_TOOLS = {
  type: "additional_tools",
  role: "developer",
  tools: [
    {
      type: "namespace",
      name: "functions",
      description: "",
      tools: [
        {
          type: "custom",
          name: "exec",
          description: "Run JavaScript code to orchestrate/compose tool calls",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" }
        },
        {
          type: "function",
          name: "wait",
          description: "Wait on an exec cell",
          parameters: {
            type: "object",
            properties: { cell_id: { type: "string" } },
            required: ["cell_id"]
          }
        }
      ]
    }
  ]
};

function codexRequest(
  port: number,
  input: JsonRecord[],
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-autodev-agent-role": "worker"
    },
    body: JSON.stringify({
      model: "claude-subscription",
      stream: true,
      cwd: REPO_ROOT,
      input
    }),
    ...(signal ? { signal } : {})
  });
}

test("a Claude turn acts only through Codex tools that Codex executes", async () => {
  const script = [
    { think: "I should list the files." },
    {
      call: "exec",
      arguments: { input: "text(await tools.exec_command({ cmd: 'ls' }))" }
    },
    { say: "Codex ran it: {result}" }
  ];
  await withBridge(script, async ({ port, record }) => {
    const history: JsonRecord[] = [
      CODEX_TOOLS,
      {
        type: "message",
        role: "developer",
        content: [
          { type: "input_text", text: "role policy from the worker TOML" }
        ]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "List the workspace." }]
      }
    ];
    const first = parseSse(await (await codexRequest(port, history)).text());
    const firstResponse = completedResponse(first);
    assert.equal(firstResponse.status, "completed");
    // Thinking is its own finished item, ahead of the call it led to.
    assert.deepEqual(
      firstResponse.output.map((item: JsonRecord) => item.type),
      ["reasoning", "custom_tool_call"]
    );
    assert.equal(
      firstResponse.output[0].summary[0].text,
      "I should list the files."
    );
    const call = firstResponse.output[1];
    assert.equal(call.name, "exec");
    assert.equal(call.input, "text(await tools.exec_command({ cmd: 'ls' }))");
    assert.match(call.id, /^ctc_/);
    assert.equal(
      first.filter(({ event }) => event === "response.output_item.done").length,
      2,
      "each item is finished as it completes"
    );

    const cli = await record();
    // No built-in tool may act inside the CLI; Codex's tools are its only tools.
    assert.equal(cli.argv[cli.argv.indexOf("--tools") + 1], "");
    assert.deepEqual(cli.tools, ["exec", "wait"]);
    // The CLI sees Codex's own context, developer instructions included.
    assert.match(
      cli.prompt,
      /<developer>\nrole policy from the worker TOML\n<\/developer>/
    );
    assert.match(cli.prompt, /<user>\nList the workspace\.\n<\/user>/);
    assert.ok(
      isAlive(cli.pid),
      "the CLI stays parked on the call between requests"
    );

    const continuation = [
      ...history,
      call,
      {
        type: "custom_tool_call_output",
        call_id: call.call_id,
        output: [
          { type: "input_text", text: "Script completed\nOutput:\n" },
          { type: "input_text", text: "README.md" }
        ]
      }
    ];
    const second = parseSse(
      await (await codexRequest(port, continuation)).text()
    );
    const secondResponse = completedResponse(second);
    assert.equal(secondResponse.status, "completed");
    assert.deepEqual(
      secondResponse.output.map((item: JsonRecord) => item.type),
      ["message"]
    );
    assert.equal(
      secondResponse.output_text,
      "Codex ran it: Script completed\nOutput:\n"
    );
    const finished = await record();
    assert.deepEqual(
      finished.results[0].content.map((part: JsonRecord) => part.text),
      ["Script completed\nOutput:\n", "README.md"]
    );
  });
});

test("a continuation carrying Codex's own notification resumes the same parked turn", async () => {
  // Codex appends a <subagent_notification> (or a user's steer) after the
  // output; the parked CLI must still be the one that continues, and it must
  // see what was added.
  await withBridge(
    [
      { call: "exec", arguments: { input: "text(1)" } },
      { say: "saw {result}" }
    ],
    async ({ port, record }) => {
      const history: JsonRecord[] = [
        CODEX_TOOLS,
        { type: "message", role: "user", content: "go" }
      ];
      const call = completedResponse(
        parseSse(await (await codexRequest(port, history)).text())
      ).output.at(-1);
      const { pid } = await record();
      const continuation = [
        ...history,
        call,
        {
          type: "custom_tool_call_output",
          call_id: call.call_id,
          output: "Script completed"
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<subagent_notification>child done</subagent_notification>"
            }
          ]
        }
      ];
      const response = completedResponse(
        parseSse(await (await codexRequest(port, continuation)).text())
      );
      assert.equal(response.output_text, "saw Script completed");
      const finished = await record();
      assert.equal(
        finished.pid,
        pid,
        "the parked CLI continued; no fresh CLI was started"
      );
      assert.match(
        finished.results[0].content.at(-1).text,
        /Codex added to the conversation while this ran:[\s\S]*<subagent_notification>child done<\/subagent_notification>/
      );
    }
  );
});

test("a function tool call carries JSON arguments back to Codex", async () => {
  await withBridge(
    [{ call: "wait", arguments: { cell_id: "7" } }, { say: "done" }],
    async ({ port }) => {
      const response = completedResponse(
        parseSse(
          await (
            await codexRequest(port, [
              CODEX_TOOLS,
              { type: "message", role: "user", content: "go" }
            ])
          ).text()
        )
      );
      const call = response.output.at(-1);
      assert.equal(call.type, "function_call");
      assert.equal(call.name, "wait");
      assert.deepEqual(JSON.parse(call.arguments), { cell_id: "7" });
      assert.match(call.id, /^fc_/);
    }
  );
});

test("a continuation for a turn the bridge no longer holds starts over from the transcript", async () => {
  await withBridge([{ say: "resumed" }], async ({ port, record }) => {
    const input = [
      CODEX_TOOLS,
      { type: "message", role: "user", content: "go" },
      {
        type: "custom_tool_call",
        call_id: "call_elsewhere_1",
        name: "exec",
        input: "text(1)"
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_elsewhere_1",
        output: "earlier output"
      }
    ];
    const response = completedResponse(
      parseSse(await (await codexRequest(port, input)).text())
    );
    assert.equal(response.output_text, "resumed");
    const cli = await record();
    assert.match(
      cli.prompt,
      /<tool_call name="exec" call_id="call_elsewhere_1">\ntext\(1\)\n<\/tool_call>/
    );
    assert.match(
      cli.prompt,
      /<tool_output call_id="call_elsewhere_1">\nearlier output\n<\/tool_output>/
    );
  });
});

test("stopping the bridge stops the CLIs parked on Codex", async () => {
  // A launchd restart or reinstall signals the bridge. Its parked CLI is a
  // child that survives a signalled parent, and the real CLI keeps working
  // after its tool call fails -- here it goes on "working" for 30 seconds.
  await withBridge(
    [
      { call: "exec", arguments: { input: "text(1)" } },
      { sleep: 30_000 },
      { say: "orphaned" }
    ],
    async ({ port, record, stopBridge }) => {
      await (
        await codexRequest(port, [
          CODEX_TOOLS,
          { type: "message", role: "user", content: "go" }
        ])
      ).text();
      const { pid } = await record();
      assert.ok(isAlive(pid), "parked on the call");
      await stopBridge();
      assert.ok(
        await exitsWithin(pid, 5000),
        "the parked CLI must not outlive its bridge"
      );
    }
  );
});

test("a client that disconnects mid-turn takes the CLI down with it", async () => {
  await withBridge(
    [{ think: "working" }, { sleep: 30_000 }, { say: "too late" }],
    async ({ port, record }) => {
      const controller = new AbortController();
      const response = await codexRequest(
        port,
        [{ type: "message", role: "user", content: "go" }],
        controller.signal
      );
      const reader = response.body!.getReader();
      await reader.read();
      const { pid } = await record();
      assert.ok(isAlive(pid));
      controller.abort();
      const deadline = Date.now() + 5000;
      while (isAlive(pid) && Date.now() < deadline) await delay(50);
      assert.equal(
        isAlive(pid),
        false,
        "the CLI must not keep working after its client went away"
      );
    }
  );
});
