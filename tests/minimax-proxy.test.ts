import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AGENT_ROLE_HEADER } from "../src/agents/bridge-role.ts";
import { coerceResponseBody, freeformInputFromArguments, unrecognisedFreeformFeedback } from "../src/providers/minimax.ts";
import { downstreamHeaders } from "../src/router/proxy.ts";
import { upstreamPayload } from "../src/router/responses.ts";
import { ROUTING_POLICY as routing } from "../src/router/routing.ts";
import { FORWARDED_REQUEST_HEADERS, SESSION_ID_HEADER, SESSION_SCOPE_HEADER } from "../src/router/subagents.ts";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const PROXY = new URL("../src/providers/minimax.ts", import.meta.url).pathname;

test("the MiniMax proxy is an AutoDev-tracked source, not an inline heredoc", () => {
  const ensure = read("scripts/ensure-codex-minimax-proxy.sh");
  assert.match(ensure, /src\/providers\/minimax\.ts/);
  assert.match(ensure, /src\/platform\/minimax-ensure\.ts/);
  assert.match(ensure, /src\/providers\/minimax\.ts/);
  assert.doesNotMatch(ensure, /<<'NODE'/);
  assert.doesNotMatch(ensure, /createServer/);

  const materializer = read("src/platform/install-materializer.ts");
  assert.ok(
    materializer.includes("src/providers/minimax.ts"),
    "the installer must deploy the proxy beside the hook that launches it",
  );
});

async function withProxy(
  upstreamHandler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (proxyPort: number) => Promise<void>,
): Promise<void> {
  const upstream = createServer(upstreamHandler);
  await new Promise<void>((resolve) => { upstream.listen(0, "127.0.0.1", () => resolve()); });
  const proxyPort = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      MINIMAX_PROXY_HOST: "127.0.0.1",
      MINIMAX_PROXY_PORT: String(proxyPort),
      MINIMAX_PROXY_UPSTREAM_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => {
        if (String(chunk).includes("listening")) resolve();
      });
      child.once("error", reject);
      setTimeout(() => reject(new Error("MiniMax proxy did not start")), 10000).unref();
    });
    await run(proxyPort);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => { upstream.close(() => resolve()); });
  }
}

test("only the credential and content negotiation headers leave the machine", async () => {
  const previousKey = process.env.MINIMAX_API_KEY;
  process.env.MINIMAX_API_KEY = "minimax-key";
  const routerHeaders = downstreamHeaders(
    routing.routeForModel("MiniMax-M3")!,
    null,
    JSON.stringify({ workspaces: { "/Users/someone/private-repo": { associated_remote_urls: { origin: "git@example.invalid:private/repo.git" } } } }),
    "worker",
    "req-local-1",
    { key: "session-local-1", scope: "identified" },
  );
  if (previousKey === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = previousKey;
  const codexHeaders: Record<string, string> = {
    "session-id": "01a0a60e-local-session",
    "thread-id": "01a0a60e-local-thread",
    "x-codex-window-id": "01a0a60e-local-window:0",
    "x-client-request-id": "01a0a60e-local-request",
    "x-codex-beta-features": "remote_compaction_v2",
    "x-openai-internal-codex-responses-lite": "true",
    originator: "codex_exec",
  };
  const localHeaders = [...Object.keys(routerHeaders), ...Object.keys(codexHeaders)].filter((name) => !["accept", "authorization", "content-type"].includes(name));
  assert.ok(localHeaders.includes(FORWARDED_REQUEST_HEADERS[0]!));
  assert.ok(localHeaders.includes(AGENT_ROLE_HEADER));
  assert.ok(localHeaders.includes(SESSION_ID_HEADER));
  assert.ok(localHeaders.includes(SESSION_SCOPE_HEADER));
  assert.ok(localHeaders.includes("x-autodev-request-id"));
  assert.ok(localHeaders.includes("x-autodev-agent-events-url"));

  let upstreamRequest: { headers: Record<string, unknown>; body: Record<string, unknown> } | null = null;
  await withProxy((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequest = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: [] }));
    });
  }, async (proxyPort) => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { ...(routerHeaders as Record<string, string>), ...codexHeaders },
      body: JSON.stringify({
        model: "MiniMax-M3",
        input: "hello",
        prompt_cache_key: "cache-key",
        client_metadata: { session_id: "01a0a60e-local-session", "x-codex-turn-metadata": JSON.stringify({ workspaces: { "/Users/someone/private-repo": {} } }) },
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.equal(upstreamRequest!.headers.authorization, "Bearer minimax-key", "the provider credential must still reach the API");
  assert.equal(upstreamRequest!.headers["content-type"], "application/json");
  for (const name of localHeaders) {
    assert.equal(upstreamRequest!.headers[name], undefined, `${name} must never be forwarded to api.minimax.io`);
  }
  assert.equal("client_metadata" in upstreamRequest!.body, false, "body-embedded turn metadata must not leave the machine");
  assert.equal(JSON.stringify(upstreamRequest).includes("private-repo"), false);
  assert.equal(upstreamRequest!.body["prompt_cache_key"], "cache-key", "the caller's own documented fields are forwarded");
});

test("the proxy forwards the caller's payload and credential upstream while withholding local routing metadata", async () => {
  let upstreamRequest: { headers: Record<string, unknown>; body: string } | null = null;
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequest = { headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: [{ type: "function_call", name: "spawn_agent", namespace: "multi_agent_v1" }] }));
    });
  });
  await new Promise<void>((resolve) => { upstream.listen(0, "127.0.0.1", () => resolve()); });
  const upstreamPort = (upstream.address() as { port: number }).port;

  const proxyPort = 18700 + (process.pid % 500);
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      MINIMAX_PROXY_HOST: "127.0.0.1",
      MINIMAX_PROXY_PORT: String(proxyPort),
      MINIMAX_PROXY_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => { if (String(chunk).includes("listening")) resolve(); });
      child.once("error", reject);
      setTimeout(() => reject(new Error("MiniMax proxy did not start")), 10000).unref();
    });

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer minimax-key",
        [FORWARDED_REQUEST_HEADERS[0]!]: JSON.stringify({ workspaces: { "/Users/someone/private-repo": {} } }),
        [AGENT_ROLE_HEADER]: "orchestrator",
      },
      body: JSON.stringify({ model: "MiniMax-M3", input: "hello" }),
    });
    assert.equal(response.status, 200);

    assert.equal(upstreamRequest!.headers.authorization, "Bearer minimax-key", "the provider credential must still reach the API");
    assert.equal((JSON.parse(upstreamRequest!.body) as { model: string }).model, "MiniMax-M3", "the parent's own payload is forwarded unchanged");
    assert.equal(upstreamRequest!.headers[FORWARDED_REQUEST_HEADERS[0]!], undefined, "workspace paths must not leave the machine");
    assert.equal(upstreamRequest!.headers[AGENT_ROLE_HEADER], undefined, "local routing classification must not leave the machine");

    const body = await response.json() as { output: unknown[] };
    assert.deepEqual(body.output[0], { type: "function_call", name: "spawn_agent", namespace: "multi_agent_v1" });
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => { upstream.close(() => resolve()); });
  }
});

test("the proxy forwards namespace tools unchanged instead of flattening them", async () => {
  let upstreamRequestBody: { tools: unknown[] } | null = null;
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools: unknown[] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: [] }));
    });
  });
  await new Promise<void>((resolve) => { upstream.listen(0, "127.0.0.1", () => resolve()); });
  const upstreamPort = (upstream.address() as { port: number }).port;

  const portProbe = createServer();
  await new Promise<void>((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", () => resolve());
  });
  const proxyPort = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve) => { portProbe.close(() => resolve()); });
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      MINIMAX_PROXY_HOST: "127.0.0.1",
      MINIMAX_PROXY_PORT: String(proxyPort),
      MINIMAX_PROXY_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => { if (String(chunk).includes("listening")) resolve(); });
      child.once("error", reject);
      setTimeout(() => reject(new Error("MiniMax proxy did not start")), 10000).unref();
    });

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "MiniMax-M3",
        tools: [
          {
            type: "namespace",
            name: "multi_agent_v1",
            tools: [
              { type: "function", name: "spawn_agent", description: "Spawn child agent" },
            ],
          },
          {
            type: "function",
            namespace: "collaboration",
            name: "send_message",
          },
          {
            type: "function",
            name: "read_file",
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamRequestBody!.tools, [
      { type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "spawn_agent", description: "Spawn child agent" }] },
      { type: "function", namespace: "collaboration", name: "send_message" },
      { type: "function", name: "read_file" },
    ]);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => { upstream.close(() => resolve()); });
  }
});

test("the proxy preserves web search and fetch tools instead of treating them as code-mode tools", async () => {
  let upstreamRequestBody: { tools: unknown[] } | null = null;
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools: unknown[] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: [] }));
    });
  });
  await new Promise<void>((resolve) => { upstream.listen(0, "127.0.0.1", () => resolve()); });
  const upstreamPort = (upstream.address() as { port: number }).port;
  const proxyPort = 18800 + (process.pid % 500);
  const child = spawn(process.execPath, [PROXY], {
    env: { ...process.env, MINIMAX_PROXY_HOST: "127.0.0.1", MINIMAX_PROXY_PORT: String(proxyPort), MINIMAX_PROXY_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => { if (String(chunk).includes("listening")) resolve(); });
      child.once("error", reject);
      setTimeout(() => reject(new Error("MiniMax proxy did not start")), 10000).unref();
    });
    const webTools = [
      { type: "web_search", name: "web_search", queries: ["Codex web search"] },
      { type: "web_fetch", name: "web_fetch", url: "https://developers.openai.com/codex" },
    ];
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "MiniMax-M3", tools: webTools }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamRequestBody!.tools, webTools);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => { upstream.close(() => resolve()); });
  }
});

test("exec called as though it were exec_command becomes a runnable script", () => {
  const source = freeformInputFromArguments(
    '{"cmd":"wc -l < scripts/codex/prompts/leaf.md","workdir":"/Users/henrykirk/AutoDev"}',
  );
  assert.ok(source);
  assert.match(source, /await tools\.exec_command\(/);
  assert.match(source, /text\(/);
  const match = source.match(/exec_command\((\{.*?\})\);/);
  assert.ok(match && match[1]);
  const call = JSON.parse(match[1]) as { cmd: string; workdir: string };
  assert.deepEqual(call, { cmd: "wc -l < scripts/codex/prompts/leaf.md", workdir: "/Users/henrykirk/AutoDev" });
  assert.doesNotThrow(() => new Function(`return (async () => {\n${source}\n});`));
});

test("a model that already understood code mode is passed through", () => {
  assert.equal(freeformInputFromArguments('{"input":"text(1 + 1)"}'), "text(1 + 1)");
  assert.equal(freeformInputFromArguments('{"code":"text(2)"}'), "text(2)");
  assert.equal(freeformInputFromArguments("text(3)"), "text(3)");
  assert.equal(freeformInputFromArguments('"text(4)"'), "text(4)");
});

test("an unrecognised argument shape is left alone rather than guessed at", () => {
  assert.equal(freeformInputFromArguments('{"unexpected":"shape"}'), null);
  assert.equal(freeformInputFromArguments("[1,2,3]"), null);
  assert.equal(freeformInputFromArguments(""), null);
  assert.equal(freeformInputFromArguments(undefined), null);
});

test("`command` is accepted as an alias for `cmd`", () => {
  const source = freeformInputFromArguments('{"command":"ls","workdir":"/tmp"}');
  assert.ok(source);
  const match = source.match(/exec_command\((\{.*?\})\);/);
  assert.ok(match && match[1]);
  const call = JSON.parse(match[1]) as { cmd: string; workdir: string };
  assert.deepEqual(call, { cmd: "ls", workdir: "/tmp" });
});

test("a non-streaming response has its freeform call coerced too", () => {
  const body = {
    response: {
      output: [
        { type: "reasoning", id: "rs_1" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec", namespace: "functions", arguments: '{"cmd":"ls","workdir":"/tmp"}' },
        { type: "function_call", id: "fc_2", call_id: "call_2", name: "some_real_function", arguments: '{"a":1}' },
      ],
    },
  };
  const coerced = coerceResponseBody(body, new Set(["exec"])) as {
    response: {
      output: Array<{
        type: string;
        input?: string;
        arguments?: unknown;
        namespace?: unknown;
        call_id?: string;
      }>;
    };
  };
  const [, execItem, otherItem] = coerced.response.output;
  assert.ok(execItem);
  assert.equal(execItem.type, "custom_tool_call");
  assert.match(execItem.input!, /exec_command/);
  assert.equal(execItem.arguments, undefined);
  assert.equal(execItem.namespace, undefined);
  assert.equal(execItem.call_id, "call_1");
  assert.deepEqual(otherItem, body.response.output[2]);
});

test("a response declaring no freeform tools is returned unchanged", () => {
  const body = { response: { output: [{ type: "function_call", id: "fc_1", name: "exec", arguments: "{}" }] } };
  assert.equal(coerceResponseBody(body, new Set()), body);
  assert.equal(coerceResponseBody(body, null as unknown as Set<string>), body);
});

test("normalising item ids upstream leaves everything MiniMax relies on intact", async () => {
  let upstreamRequestBody: { input: Array<Record<string, unknown>>; tools: Array<{ name: string }> } | null = null;
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input: Array<Record<string, unknown>>; tools: Array<{ name: string }> };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: [] }));
    });
  });
  await new Promise<void>((resolve) => { upstream.listen(0, "127.0.0.1", () => resolve()); });
  const upstreamPort = (upstream.address() as { port: number }).port;

  const proxyPort = 18800 + (process.pid % 500);
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      MINIMAX_PROXY_HOST: "127.0.0.1",
      MINIMAX_PROXY_PORT: String(proxyPort),
      MINIMAX_PROXY_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk: Buffer) => { if (String(chunk).includes("listening")) resolve(); });
      child.once("error", reject);
      setTimeout(() => reject(new Error("MiniMax proxy did not start")), 10000).unref();
    });

    const history = [
      { type: "message", id: "msg_1", role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "reasoning", id: "06eea1506b9c37f6f3f4bb02f90abd28_rs", summary: [] },
      { type: "custom_tool_call", id: "06ef3bc08924acade1facee14da0af2e_fc_0", call_id: "call_8ec20ad454e0460d9d4b6662", name: "exec", input: "text()" },
      { type: "custom_tool_call_output", call_id: "call_8ec20ad454e0460d9d4b6662", output: "ok" },
    ];
    const payload = upstreamPayload(routing.routeForModel("MiniMax-M3") as unknown as Parameters<typeof upstreamPayload>[0], {
      model: "MiniMax-M3",
      input: history,
      tools: [{ type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "spawn_agent" }] }],
    }, false);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);

    const sent = upstreamRequestBody!.input;
    assert.match(sent[2]!["id"] as string, /^ctc_/);
    assert.equal(sent[1]!["id"], "06eea1506b9c37f6f3f4bb02f90abd28_rs");
    assert.equal(sent[2]!["call_id"], "call_8ec20ad454e0460d9d4b6662");
    assert.equal(sent[3]!["call_id"], "call_8ec20ad454e0460d9d4b6662");
    assert.deepEqual(sent.map((item) => item["call_id"]), history.map((item) => item.call_id));
    assert.equal("id" in sent[3]!, false);
    assert.equal(sent[2]!["name"], "exec");
    assert.equal(sent[2]!["input"], "text()");
    assert.equal(sent[0]!["id"], "msg_1");
    assert.deepEqual(sent[0]!["content"], history[0]!.content);
    assert.equal(upstreamRequestBody!.tools[0]!.name, "multi_agent_v1__spawn_agent");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => { upstream.close(() => resolve()); });
  }
});

test("an unrecognised exec call becomes a failing script that tells the model what exec expects", () => {
  for (const [argumentsText, shape] of [
    ["{}", "an empty JSON object"],
    ['{"text":"do-not-echo-this-value"}', 'a JSON object with keys "text"'],
    ["[1,2,3]", "a JSON array"],
    ["", "no arguments"],
  ]) {
    const script = unrecognisedFreeformFeedback("exec", argumentsText);
    assert.match(script, /^throw new Error\(/);
    const message = JSON.parse(script.slice("throw new Error(".length, script.lastIndexOf(")"))) as string;
    assert.ok(message.includes(shape!), `${argumentsText}: ${message}`);
    assert.ok(message.includes("raw JavaScript source"));
    assert.ok(message.includes("tools.exec_command({ cmd"));
    assert.equal(script.includes("do-not-echo-this-value"), false, "argument values must never be echoed");
    assert.doesNotThrow(() => new Function(`return (async () => {\n${script}\n});`));
  }
});

test("a recognised exec call is still translated, not replaced with feedback", () => {
  const body = { output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "exec", arguments: '{"cmd":"ls"}' }] };
  const [item] = (coerceResponseBody(body, new Set(["exec"])) as { output: Array<{ type: string; input?: string }> }).output;
  assert.ok(item);
  assert.equal(item.type, "custom_tool_call");
  assert.match(item.input!, /await tools\.exec_command\(/);
});

test("a non-streaming unrecognised exec call is coerced into the feedback script", () => {
  const body = { output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "exec", namespace: "functions", arguments: "{}" }] };
  const [item] = (coerceResponseBody(body, new Set(["exec"])) as { output: Array<{ type: string; call_id: string; arguments?: unknown; input: string }> }).output;
  assert.ok(item);
  assert.equal(item.type, "custom_tool_call");
  assert.equal(item.call_id, "call_1");
  assert.equal(item.arguments, undefined);
  assert.equal(item.input, unrecognisedFreeformFeedback("exec", "{}"));
});

test("a streamed unrecognised exec call reaches Codex as a custom tool call carrying the feedback script", async () => {
  const item = { id: "06f8b0803f8f804f65cab7da91194351_fc_0", type: "function_call", status: "completed", name: "exec", call_id: "call_stream_1", arguments: "{}" };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: "{}" },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: "{}" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item] } },
  ];
  let streamed = "";
  await withProxy((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
  }, async (proxyPort) => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "MiniMax-M3", stream: true, input: "go", tools: [{ type: "custom", name: "exec" }] }),
    });
    streamed = await response.text();
  });
  const received = streamed.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as { type: string; input?: string; item?: { type: string }; response?: { output: Array<{ input: string }> } });
  const types = received.map((event) => event.type);
  assert.equal(types.includes("response.function_call_arguments.delta"), false);
  assert.ok(types.includes("response.custom_tool_call_input.done"));
  const feedback = unrecognisedFreeformFeedback("exec", "{}");
  assert.equal(received.find((event) => event.type === "response.custom_tool_call_input.done")!.input, feedback);
  assert.equal(received.find((event) => event.type === "response.output_item.done")!.item!.type, "custom_tool_call");
  assert.equal(received.find((event) => event.type === "response.completed")!.response!.output[0]!.input, feedback);
  const headers = streamed.split("\n").filter((line) => line.startsWith("event: ")).map((line) => line.slice(7));
  assert.deepEqual(headers, types);
});
