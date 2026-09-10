import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AGENT_ROLE_HEADER, FORWARDED_REQUEST_HEADERS, routeForModel, upstreamPayload } from "../scripts/codex-model-router.mjs";
import { coerceResponseBody, freeformInputFromArguments } from "../scripts/codex-minimax-responses-proxy.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const PROXY = new URL("../scripts/codex-minimax-responses-proxy.mjs", import.meta.url).pathname;

test("the MiniMax proxy is an AutoDev-tracked source, not an inline heredoc", () => {
  const ensure = read("scripts/ensure-codex-minimax-proxy.sh");
  assert.match(ensure, /node_bin.*proxy_script|nohup "\$node_bin" "\$proxy_script"/s);
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

test("the proxy preserves web search and fetch tools instead of treating them as code-mode tools", async () => {
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
  const proxyPort = 18800 + (process.pid % 500);
  const child = spawn(process.execPath, [ PROXY ], {
    env: { ...process.env, MINIMAX_PROXY_HOST: "127.0.0.1", MINIMAX_PROXY_PORT: String(proxyPort), MINIMAX_PROXY_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}` },
    stdio: [ "ignore", "pipe", "pipe" ],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stderr.on("data", (chunk) => { if (String(chunk).includes("listening")) resolve(); });
      child.once("error", reject);
      setTimeout(() => reject(new Error("MiniMax proxy did not start")), 10000).unref();
    });
    const webTools = [
      { type: "web_search", name: "web_search", queries: [ "Codex web search" ] },
      { type: "web_fetch", name: "web_fetch", url: "https://developers.openai.com/codex" },
    ];
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "MiniMax-M3", tools: webTools }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamRequestBody.tools, webTools);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => upstream.close(resolve));
  }
});

// --- Freeform (code-mode) tool coercion -------------------------------------
//
// Codex runs these models in code mode: the only tool is `exec`, declared with
// `"type": "custom"`, and its payload is raw JavaScript rather than JSON
// arguments. MiniMax has no notion of a freeform tool and answers with an
// ordinary function_call, which Codex rejects outright with "tool exec invoked
// with incompatible payload" -- so before this coercion a MiniMax-served turn
// could reason but could never run anything. Shapes below are taken verbatim
// from live MiniMax responses.

test("exec called as though it were exec_command becomes a runnable script", () => {
  const source = freeformInputFromArguments(
    '{"cmd":"wc -l < scripts/codex/prompts/leaf.md","workdir":"/Users/henrykirk/AutoDev"}',
  );
  assert.match(source, /await tools\.exec_command\(/);
  assert.match(source, /text\(/);
  // The model's intent is preserved exactly, not paraphrased.
  const call = JSON.parse(source.match(/exec_command\((\{.*?\})\);/)[ 1 ]);
  assert.deepEqual(call, { cmd: "wc -l < scripts/codex/prompts/leaf.md", workdir: "/Users/henrykirk/AutoDev" });
  assert.doesNotThrow(() => new Function(`return (async () => {\n${source}\n});`));
});

test("a model that already understood code mode is passed through", () => {
  assert.equal(freeformInputFromArguments('{"input":"text(1 + 1)"}'), "text(1 + 1)");
  assert.equal(freeformInputFromArguments('{"code":"text(2)"}'), "text(2)");
  // Raw source that is not JSON at all is exactly what the tool wants.
  assert.equal(freeformInputFromArguments("text(3)"), "text(3)");
  assert.equal(freeformInputFromArguments('"text(4)"'), "text(4)");
});

test("an unrecognised argument shape is left alone rather than guessed at", () => {
  // Guessing would swap one broken call for a differently broken one, and hide
  // the failure behind a script that runs but does the wrong thing.
  assert.equal(freeformInputFromArguments('{"unexpected":"shape"}'), null);
  assert.equal(freeformInputFromArguments("[1,2,3]"), null);
  assert.equal(freeformInputFromArguments(""), null);
  assert.equal(freeformInputFromArguments(undefined), null);
});

test("`command` is accepted as an alias for `cmd`", () => {
  const source = freeformInputFromArguments('{"command":"ls","workdir":"/tmp"}');
  const call = JSON.parse(source.match(/exec_command\((\{.*?\})\);/)[ 1 ]);
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
  const coerced = coerceResponseBody(body, new Set([ "exec" ]));
  const [ , execItem, otherItem ] = coerced.response.output;
  assert.equal(execItem.type, "custom_tool_call");
  assert.match(execItem.input, /exec_command/);
  // The function-shaped fields must not survive onto a custom tool call.
  assert.equal(execItem.arguments, undefined);
  assert.equal(execItem.namespace, undefined);
  assert.equal(execItem.call_id, "call_1");
  // A genuine function tool is untouched.
  assert.deepEqual(otherItem, body.response.output[ 2 ]);
});

test("a response declaring no freeform tools is returned unchanged", () => {
  const body = { response: { output: [ { type: "function_call", id: "fc_1", name: "exec", arguments: "{}" } ] } };
  assert.equal(coerceResponseBody(body, new Set()), body);
  assert.equal(coerceResponseBody(body, null), body);
});

// MiniMax mints item ids the Responses contract rejects (`<hex>_rs`,
// `<hex>_fc_<n>`), and the router now corrects them on every route rather than
// only the one that complained. Correcting them must not disturb anything
// MiniMax itself relies on -- above all the call_id pairing that attaches a
// tool result to the call that produced it, which the proxy's own freeform
// coercion depends on.
test("normalising item ids upstream leaves everything MiniMax relies on intact", async () => {
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

  const proxyPort = 18800 + (process.pid % 500);
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

    // History as MiniMax itself would have written it on an earlier turn.
    const history = [
      { type: "message", id: "msg_1", role: "user", content: [ { type: "input_text", text: "go" } ] },
      { type: "reasoning", id: "06eea1506b9c37f6f3f4bb02f90abd28_rs", summary: [] },
      { type: "custom_tool_call", id: "06ef3bc08924acade1facee14da0af2e_fc_0", call_id: "call_8ec20ad454e0460d9d4b6662", name: "exec", input: "text()" },
      { type: "custom_tool_call_output", call_id: "call_8ec20ad454e0460d9d4b6662", output: "ok" },
    ];
    const payload = upstreamPayload(routeForModel("MiniMax-M3"), {
      model: "MiniMax-M3",
      input: history,
      tools: [ { type: "namespace", name: "multi_agent_v1", tools: [ { type: "function", name: "spawn_agent" } ] } ],
    }, false);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);

    const sent = upstreamRequestBody.input;

    // The contract is enforced on self-contained items like tool calls.
    assert.match(sent[ 2 ].id, /^ctc_/);

    // Reasoning items are not self-contained and are excluded from normalisation,
    // preserving MiniMax's own reasoning continuity on its own route.
    assert.equal(sent[ 1 ].id, "06eea1506b9c37f6f3f4bb02f90abd28_rs");

    // The pairing MiniMax reads is byte-identical to what it minted, on both
    // sides of the pair.
    assert.equal(sent[ 2 ].call_id, "call_8ec20ad454e0460d9d4b6662");
    assert.equal(sent[ 3 ].call_id, "call_8ec20ad454e0460d9d4b6662");
    assert.deepEqual(sent.map((item) => item.call_id), history.map((item) => item.call_id));

    // An item MiniMax sent without an id must not acquire one.
    assert.equal("id" in sent[ 3 ], false);

    // Everything else about the item survives untouched.
    assert.equal(sent[ 2 ].name, "exec");
    assert.equal(sent[ 2 ].input, "text()");
    assert.equal(sent[ 0 ].id, "msg_1");
    assert.deepEqual(sent[ 0 ].content, history[ 0 ].content);

    // The proxy's other outbound rewrite still happens.
    assert.equal(upstreamRequestBody.tools[ 0 ].name, "multi_agent_v1__spawn_agent");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => upstream.close(resolve));
  }
});
