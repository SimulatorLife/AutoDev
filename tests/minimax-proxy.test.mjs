import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AGENT_ROLE_HEADER, FORWARDED_REQUEST_HEADERS } from "../scripts/codex-model-router.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const PROXY = new URL("../scripts/codex-minimax-responses-proxy.mjs", import.meta.url).pathname;

test("the MiniMax proxy is an AutoDev-tracked source, not an inline heredoc", () => {
  const ensure = read("scripts/ensure-codex-minimax-proxy.sh");
  assert.match(ensure, /node "\$proxy_script"/);
  assert.match(ensure, /codex-minimax-responses-proxy\.mjs/);
  // A heredoc'd server cannot be syntax-checked, tested, or drift-detected as
  // a source of its own, which is what made this proxy look externally owned.
  assert.doesNotMatch(ensure, /<<'NODE'/);
  assert.doesNotMatch(ensure, /createServer/);

  const installer = read("scripts/codex/install-codex-integration.sh");
  assert.ok(
    installer.includes("codex-minimax-responses-proxy.mjs"),
    "the installer must deploy the proxy beside the hook that launches it",
  );
});

test("every local-only routing header the router emits is stripped before it reaches the remote API", () => {
  const proxy = read("scripts/codex-minimax-responses-proxy.mjs");
  const stripped = proxy.slice(proxy.indexOf("const strippedRequestHeaders"), proxy.indexOf("const flattenedNamespaces"));
  for (const header of [ ...FORWARDED_REQUEST_HEADERS, AGENT_ROLE_HEADER ]) {
    assert.ok(stripped.includes(`"${header}"`), `${header} must never be forwarded to api.minimax.io`);
  }
});

test("the proxy forwards the caller's payload and credential upstream while withholding local routing metadata", async () => {
  let upstreamRequest = null;
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequest = { headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      response.writeHead(200, { "content-type": "application/json" });
      // MiniMax flattens namespaced tools; the proxy must re-expand them.
      response.end(JSON.stringify({ output: [ { name: "agents__spawn_agent" } ] }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  const proxyPort = 18700 + (process.pid % 500);
  const child = spawn(process.execPath, [ PROXY ], {
    env: {
      ...process.env,
      MINIMAX_PROXY_HOST: "127.0.0.1",
      MINIMAX_PROXY_PORT: String(proxyPort),
      MINIMAX_PROXY_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: [ "ignore", "pipe", "pipe" ],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stderr.on("data", (chunk) => { if (String(chunk).includes("listening")) resolve(); });
      child.once("error", reject);
      setTimeout(() => reject(new Error("MiniMax proxy did not start")), 10000).unref();
    });

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer minimax-key",
        [ FORWARDED_REQUEST_HEADERS[ 0 ] ]: JSON.stringify({ workspaces: { "/Users/someone/private-repo": {} } }),
        [ AGENT_ROLE_HEADER ]: "orchestrator",
      },
      body: JSON.stringify({ model: "MiniMax-M3", input: "hello" }),
    });
    assert.equal(response.status, 200);

    assert.equal(upstreamRequest.headers.authorization, "Bearer minimax-key", "the provider credential must still reach the API");
    assert.equal(JSON.parse(upstreamRequest.body).model, "MiniMax-M3", "the parent's own payload is forwarded unchanged");
    assert.equal(upstreamRequest.headers[ FORWARDED_REQUEST_HEADERS[ 0 ] ], undefined, "workspace paths must not leave the machine");
    assert.equal(upstreamRequest.headers[ AGENT_ROLE_HEADER ], undefined, "local routing classification must not leave the machine");

    const body = await response.json();
    assert.deepEqual(body.output[ 0 ], { name: "spawn_agent", namespace: "agents" });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("the proxy flattens namespaced tools in outbound HTTP requests sent to MiniMax", async () => {
  let upstreamRequestBody = null;
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: [] }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  const proxyPort = 18750 + (process.pid % 500);
  const child = spawn(process.execPath, [ PROXY ], {
    env: {
      ...process.env,
      MINIMAX_PROXY_HOST: "127.0.0.1",
      MINIMAX_PROXY_PORT: String(proxyPort),
      MINIMAX_PROXY_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: [ "ignore", "pipe", "pipe" ],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stderr.on("data", (chunk) => { if (String(chunk).includes("listening")) resolve(); });
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
              { type: "function", name: "spawn_agent", description: "Spawn child agent" }
            ]
          },
          {
            type: "function",
            namespace: "collaboration",
            name: "send_message"
          },
          {
            type: "function",
            name: "read_file"
          }
        ]
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamRequestBody.tools, [
      { type: "function", name: "multi_agent_v1__spawn_agent", description: "Spawn child agent" },
      { type: "function", name: "collaboration__send_message" },
      { type: "function", name: "read_file" }
    ]);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => upstream.close(resolve));
  }
});
