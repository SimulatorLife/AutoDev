import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";

import { createBridgeMcpHomes } from "./bridge-mcp-fixture.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PROXY = join(REPO_ROOT, "scripts/codex-claude-cli-responses-proxy.py");
const CONTRACT_PATH = join(REPO_ROOT, "tests/fixtures/contracts/claude-responses-contract.json");
const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));

const BRIDGE_ROLE = "browser-tester";
const PRIVACY_TOKEN = "contract task";
// The bridge reads the MCP catalogue an install materializes. Keep this
// contract hermetic and derive the catalogue from the canonical Rulesync
// source rather than depending on the operator's installed CODEX_HOME.
const homes = createBridgeMcpHomes();
process.env.CODEX_HOME = homes.codexHome;
test.after(async () => {
  await rm(homes.root, { recursive: true, force: true });
});

function replaceTokens(value) {
  if (typeof value === "string") return value.replaceAll("<REPO_ROOT>", REPO_ROOT);
  if (Array.isArray(value)) return value.map(replaceTokens);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, replaceTokens(nested)]));
  return value;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForHealth(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error(`Claude bridge did not become healthy on port ${port}: ${lastError?.message ?? lastError}`);
}

function parseSse(text) {
  return text.trimEnd().split("\n\n").filter(Boolean).map((chunk) => {
    if (chunk === "data: [DONE]") return { event: "[DONE]", data: null };
    const lines = chunk.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    return { event, data: data ? JSON.parse(data) : null };
  });
}

function scrub(value) {
  if (typeof value === "string") return value
    .replaceAll(REPO_ROOT, "<REPO_ROOT>")
    .replace(/resp_[0-9a-f]+/g, "<RESPONSE_ID>")
    .replace(/rs_[0-9a-f]+/g, "<REASONING_ID>")
    .replace(/msg_[0-9a-f]+/g, "<MESSAGE_ID>")
    .replace(/ctc_[0-9a-f]+/g, "<CUSTOM_TOOL_CALL_ID>")
    .replace(/call_[0-9a-f]+/g, "<CALL_ID>")
    .replace(/"sequence_number":\d+/g, "\"sequence_number\":<SEQUENCE>");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    key === "created_at" ? "<CREATED_AT>" : key === "sequence_number" ? "<SEQUENCE>" : scrub(nested),
  ]));
  return value;
}

async function startTelemetryServer() {
  const events = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.method === "POST") {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        for (const event of payload.events ?? []) events.push({ ...event, requestId: payload.requestId });
      } catch (error) { response.statusCode = 400; }
    }
    response.end("ok");
  });
  await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  return { events, server, url: `http://127.0.0.1:${server.address().port}/events` };
}

async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
}

function buildFakeCliSource() {
  return `#!/usr/bin/env python3
import json
import os
import sys

fixture = json.loads(os.environ.get("CLAUDE_CONTRACT_CASE") or "{}")
events = fixture.get("events") or []
for event in events:
    sys.stdout.write(json.dumps(event) + "\\n")
    sys.stdout.flush()
stderr_text = fixture.get("stderr") or ""
if stderr_text:
    sys.stderr.write(stderr_text)
    sys.stderr.flush()
sys.exit(fixture.get("exitCode") or 0)
`;
}

async function startBridge({ proxyPort, bearerToken, oauthToken, fakeCli, contractCase }) {
  const env = {
    ...process.env,
    AUTODEV_REPO_ROOT: REPO_ROOT,
    CODEX_PROJECT_ROOT: REPO_ROOT,
    CLAUDE_BRIDGE_HOST: "127.0.0.1",
    CLAUDE_BRIDGE_PORT: String(proxyPort),
    CLAUDE_BIN: fakeCli,
    CLAUDE_CODE_BRIDGE_TIMEOUT_SECONDS: "10",
    LITELLM_API_KEY: bearerToken ?? "",
  };
  if (contractCase !== undefined) env.CLAUDE_CONTRACT_CASE = JSON.stringify(contractCase);
  if (oauthToken === null) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken ?? "fake-oauth-token";
  }
  const child = spawn(process.execPath === "node" ? "python3" : "python3", [PROXY], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function runStreamingCase(name, rawCase, telemetry) {
  const item = replaceTokens(rawCase);
  const temp = await mkdtemp(join(tmpdir(), "autodev-claude-contract-"));
  const fakeCli = join(temp, "fake-claude.py");
  const proxyPort = await freePort();
  await writeFile(fakeCli, buildFakeCliSource(), "utf8");
  await chmod(fakeCli, 0o755);
  const child = await startBridge({ proxyPort, bearerToken: "", fakeCli, contractCase: item.cli });
  try {
    await waitForHealth(proxyPort);
    const requestId = `claude-contract-${name}`;
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-autodev-agent-role": BRIDGE_ROLE,
        "x-autodev-request-id": requestId,
        "x-autodev-agent-events-url": telemetry.url,
      },
      body: JSON.stringify({
        model: "claude-subscription",
        input: [{ role: "user", content: PRIVACY_TOKEN }],
        cwd: REPO_ROOT,
        stream: true,
        ...item.request,
      }),
    });
    const body = await response.text();
    assert.equal(response.status, item.expected.status, `${name}: HTTP status`);
    assert.equal(response.headers.get("content-type"), "text/event-stream", `${name}: SSE content type`);
    const sse = parseSse(body);
    assert.deepEqual(sse.map(({ event }) => event), item.expected.eventTypes, `${name}: SSE lifecycle`);
    assert.equal(sse.at(-1).event, "[DONE]", `${name}: terminal sentinel`);
    const completed = sse.find(({ event }) => event === "response.completed").data.response;
    if (item.expected.outputText !== undefined) assert.equal(completed.output_text, item.expected.outputText, `${name}: output text`);
    if (item.expected.outputTextPrefix !== undefined) assert.ok(completed.output_text.startsWith(item.expected.outputTextPrefix), `${name}: partial output text`);
    assert.equal(completed.status, item.expected.completedStatus, `${name}: completion status`);
    if (item.expected.incompleteReason) {
      assert.equal(completed.incomplete_details.reason, item.expected.incompleteReason, `${name}: incomplete reason`);
      assert.deepEqual(completed.incomplete_details.provider_limit, item.expected.limit, `${name}: limit payload`);
    }
    assert.equal(sse.filter(({ event }) => event === "response.completed").length, 1, `${name}: one completion`);
    for (const entry of sse.filter(({ data }) => data?.sequence_number !== undefined)) assert.equal(typeof entry.data.sequence_number, "number");
    if (item.expected.tool || item.expected.tools) {
      const expectedTools = new Set([...(item.expected.tool ? [item.expected.tool] : []), ...(item.expected.tools ?? [])]);
      assert.ok(expectedTools.size > 0, `${name}: expected tool set must be non-empty`);
      assert.ok(sse.find(({ event }) => event === "response.created"), `${name}: response.created present`);
    }
    const itemIds = collectItemIds(sse);
    if (itemIds.length > 0) {
      const created = sse.find(({ event }) => event === "response.created").data.response;
      const completed2 = sse.find(({ event }) => event === "response.completed").data.response;
      assert.equal(created.id, completed2.id, `${name}: response id continuity`);
    }
    await new Promise((resolveEvents) => setTimeout(resolveEvents, 150));
    const reported = telemetry.events.filter((event) => event.requestId === requestId);
    for (const type of item.expected.telemetryTypes ?? []) assert.ok(reported.some((event) => event.type === type), `${name}: telemetry ${type}: ${JSON.stringify(reported.map(e => e.type))}`);
    if (item.expected.tool) assert.ok(reported.some((event) => event.type === "tool_requested" && event.tool === item.expected.tool), `${name}: requested tool telemetry`);
    if (item.expected.tools) {
      for (const tool of item.expected.tools) assert.ok(reported.some((event) => event.type === "tool_requested" && event.tool === tool), `${name}: requested tool ${tool} telemetry`);
      for (const tool of item.expected.tools) assert.ok(reported.some((event) => event.type === "tool_executed" && event.tool === tool), `${name}: executed tool ${tool} telemetry`);
    }
    if (item.expected.skill) {
      const skillUses = reported.filter((event) => event.type === "skill_used");
      assert.ok(skillUses.some((event) => event.skill === item.expected.skill), `${name}: skill_used for ${item.expected.skill}`);
    }
    if (item.expected.skills) {
      const skillUses = reported.filter((event) => event.type === "skill_used");
      for (const skill of item.expected.skills) assert.ok(skillUses.some((event) => event.skill === skill), `${name}: skill_used for ${skill}`);
    }
    if (item.expected.unavailableReason) {
      assert.ok(reported.some((event) => event.type === "tool_unavailable" && event.tool === item.expected.tool && event.reason === item.expected.unavailableReason), `${name}: denial telemetry`);
    }
    const normalizedSse = scrub(sse);
    const serializedSse = JSON.stringify(normalizedSse);
    assert.match(serializedSse, /<RESPONSE_ID>/, `${name}: response IDs must be normalized`);
    assert.match(serializedSse, /<CREATED_AT>/, `${name}: timestamps must be normalized`);
    assert.doesNotMatch(serializedSse, new RegExp(PRIVACY_TOKEN), `${name}: prompt content must not be in SSE`);
    assert.doesNotMatch(JSON.stringify(reported), new RegExp(PRIVACY_TOKEN), `${name}: prompt content must not be in telemetry`);
    return normalizedSse;
  } finally {
    await stop(child);
    await rm(temp, { recursive: true, force: true });
  }
}

function collectItemIds(sse) {
  const ids = [];
  for (const entry of sse) {
    if (!entry.data || typeof entry.data !== "object") continue;
    if (typeof entry.data.item_id === "string") ids.push({ key: `${entry.event}.item_id`, value: entry.data.item_id });
    if (typeof entry.data.id === "string") ids.push({ key: `${entry.event}.id`, value: entry.data.id });
    if (entry.data.response && typeof entry.data.response.id === "string") ids.push({ key: `${entry.event}.response.id`, value: entry.data.response.id });
  }
  return ids;
}

async function runAuthFailureCase(name, rawCase) {
  const item = replaceTokens(rawCase);
  const temp = await mkdtemp(join(tmpdir(), "autodev-claude-contract-"));
  const fakeCli = join(temp, "fake-claude.py");
  const proxyPort = await freePort();
  await writeFile(fakeCli, buildFakeCliSource(), "utf8");
  await chmod(fakeCli, 0o755);
  const child = await startBridge({ proxyPort, bearerToken: "expected-bearer-token", oauthToken: "fake-oauth-token", fakeCli, contractCase: item.cli });
  try {
    await waitForHealth(proxyPort);
    const requestId = `claude-contract-${name}`;
    const headers = {
      "content-type": "application/json",
      "x-autodev-agent-role": BRIDGE_ROLE,
      "x-autodev-request-id": requestId,
    };
    if (item.auth?.bearer !== "missing") headers.authorization = `Bearer ${item.auth?.bearer ?? ""}`;
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-subscription",
        input: [{ role: "user", content: PRIVACY_TOKEN }],
        cwd: REPO_ROOT,
        stream: true,
        ...item.request,
      }),
    });
    const body = await response.text();
    assert.equal(response.status, item.expected.status, `${name}: HTTP status`);
    const payload = JSON.parse(body);
    assert.equal(payload.error?.type, item.expected.errorType, `${name}: error type`);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(PRIVACY_TOKEN), `${name}: prompt content must not be in error body`);
  } finally {
    await stop(child);
    await rm(temp, { recursive: true, force: true });
  }
}

async function runOauthMissingCase(name, rawCase) {
  const item = replaceTokens(rawCase);
  const temp = await mkdtemp(join(tmpdir(), "autodev-claude-contract-"));
  const fakeCli = join(temp, "fake-claude.py");
  const proxyPort = await freePort();
  await writeFile(fakeCli, buildFakeCliSource(), "utf8");
  await chmod(fakeCli, 0o755);
  const child = await startBridge({ proxyPort, bearerToken: "", oauthToken: null, fakeCli, contractCase: item.cli });
  try {
    await waitForHealth(proxyPort);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-autodev-agent-role": BRIDGE_ROLE,
        "x-autodev-request-id": `claude-contract-${name}`,
      },
      body: JSON.stringify({
        model: "claude-subscription",
        input: [{ role: "user", content: PRIVACY_TOKEN }],
        cwd: REPO_ROOT,
        stream: true,
        ...item.request,
      }),
    });
    const body = await response.text();
    assert.equal(response.status, item.expected.status, `${name}: HTTP status`);
    const payload = JSON.parse(body);
    assert.equal(payload.error?.type, item.expected.errorType, `${name}: error type`);
    assert.match(payload.error?.message ?? "", new RegExp(item.expected.errorMessageContains), `${name}: error message contains marker`);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(PRIVACY_TOKEN), `${name}: prompt content must not be in error body`);
  } finally {
    await stop(child);
    await rm(temp, { recursive: true, force: true });
  }
}

test("Claude Responses contract fixture is exercised through the offline proxy boundary", async () => {
  assert.equal(contract.schema, "autodev-claude-responses-contract-v1");
  const before = await readFile(CONTRACT_PATH);
  const telemetry = await startTelemetryServer();
  try {
    const streamingCases = ["normal_stream", "direct_skill_read", "shell_skill_read", "tool_continuation", "permission_denied", "provider_limit_incomplete"];
    for (const name of streamingCases) {
      const entry = contract.cases[name];
      assert.ok(entry, `${name}: contract case must exist`);
      await runStreamingCase(name, entry, telemetry);
    }
    await runAuthFailureCase("auth_token_failure", contract.cases.auth_token_failure);
    await runOauthMissingCase("oauth_token_missing", contract.cases.oauth_token_missing);
  } finally {
    await new Promise((resolveClosed) => telemetry.server.close(resolveClosed));
  }
  assert.deepEqual(await readFile(CONTRACT_PATH), before, "contract fixture must not be mutated");
});
