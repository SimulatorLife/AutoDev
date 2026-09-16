import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";

import { classifyCliLimit, limitPayload } from "../src/shared/provider-limits.ts";
import { extractSkillReadPath, matchSkillReadPath } from "../scripts/codex-antigravity-cli-responses-proxy.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PROXY = join(REPO_ROOT, "scripts/codex-antigravity-cli-responses-proxy.mjs");
const CONTRACT_PATH = join(REPO_ROOT, "tests/fixtures/contracts/antigravity-responses-contract.json");
const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));

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

function waitForListening(child) {
  return new Promise((resolveListening, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`proxy did not start: ${stderr}`)), 5000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (!stderr.includes("Antigravity Responses proxy listening")) return;
      clearTimeout(timer);
      resolveListening();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code !== null) {
        clearTimeout(timer);
        reject(new Error(`proxy exited before listening (${code}/${signal}): ${stderr}`));
      }
    });
  });
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
    .replace(/"sequence_number":\d+/g, '"sequence_number":<SEQUENCE>');
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
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      for (const event of payload.events ?? []) events.push({ ...event, requestId: payload.requestId });
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

async function runCase(name, rawCase, telemetry) {
  const item = replaceTokens(rawCase);
  const temp = await mkdtemp(join(tmpdir(), "autodev-antigravity-contract-"));
  const fakeAgy = join(temp, "fake-agy.mjs");
  const proxyPort = await freePort();
  const fakeSource = `
const fixture = JSON.parse(process.env.AGY_CONTRACT_CASE);
for (const event of fixture.events ?? []) process.stdout.write(JSON.stringify(event) + "\\n");
if (fixture.stderr) process.stderr.write(fixture.stderr);
process.exitCode = fixture.exitCode ?? 0;
`;
  await writeFile(fakeAgy, `#!/usr/bin/env node\n${fakeSource}`, "utf8");
  await chmod(fakeAgy, 0o755);
  const child = spawn(process.execPath, [PROXY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AUTODEV_REPO_ROOT: REPO_ROOT,
      CODEX_PROJECT_ROOT: REPO_ROOT,
      AGY_CLI_PATH: fakeAgy,
      AGY_PROXY_HOST: "127.0.0.1",
      AGY_PROXY_PORT: String(proxyPort),
      AGY_PRINT_TIMEOUT: "5s",
      LITELLM_API_KEY: "",
      AGY_CONTRACT_CASE: JSON.stringify(item.cli),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await waitForListening(child);
    const requestId = `antigravity-contract-${name}`;
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-autodev-request-id": requestId,
        "x-autodev-agent-events-url": telemetry.url,
      },
      body: JSON.stringify({ model: "antigravity-subscription", input: [{ role: "user", content: "contract task" }], cwd: REPO_ROOT, ...item.request }),
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
      assert.deepEqual(limitPayload(classifyCliLimit(item.cli.stderr, item.cli.exitCode)), item.expected.limit, `${name}: classified limit payload`);
    }
    assert.equal(sse.filter(({ event }) => event === "response.completed").length, 1, `${name}: one completion`);
    for (const entry of sse.filter(({ data }) => data?.sequence_number !== undefined)) assert.equal(typeof entry.data.sequence_number, "number");

    await new Promise((resolveEvents) => setTimeout(resolveEvents, 100));
    const reported = telemetry.events.filter((event) => event.requestId === requestId);
    for (const type of item.expected.telemetryTypes ?? []) assert.ok(reported.some((event) => event.type === type), `${name}: telemetry ${type}: ${JSON.stringify(reported)}`);
    if (item.expected.tool) assert.ok(reported.some((event) => event.type === "tool_requested" && event.tool === item.expected.tool), `${name}: requested tool telemetry`);
    if (item.expected.unavailableReason) assert.ok(reported.some((event) => event.type === "tool_unavailable" && event.tool === item.expected.tool && event.reason === item.expected.unavailableReason), `${name}: denial telemetry`);
    if (item.expected.skill) assert.ok(reported.some((event) => event.type === "skill_used" && event.skill === item.expected.skill && event.source === "skill_read"), `${name}: skill telemetry`);
    if (item.expected.directRead !== undefined) {
      const update = item.cli.events[0].step_update;
      const args = update.tool_info.args;
      const skillPath = extractSkillReadPath(update.tool_name, args);
      assert.equal(update.tool_name.toLowerCase() === "read_file", item.expected.directRead, `${name}: direct-vs-shell read shape`);
      assert.equal(skillPath, `${REPO_ROOT}/.rulesync/skills/ccc/SKILL.md`, `${name}: extracted skill path`);
      assert.equal(matchSkillReadPath(skillPath), "ccc", `${name}: matched skill name`);
    }
    assert.doesNotMatch(JSON.stringify(sse), new RegExp(item.expected.privacyToken), `${name}: prompt content must not be in SSE`);
    assert.doesNotMatch(JSON.stringify(reported), new RegExp(item.expected.privacyToken), `${name}: prompt content must not be in telemetry`);
    const normalizedSse = scrub(sse);
    assert.match(JSON.stringify(normalizedSse), /<RESPONSE_ID>/, `${name}: response IDs must be normalized`);
    assert.match(JSON.stringify(normalizedSse), /<CREATED_AT>/, `${name}: timestamps must be normalized`);
    return normalizedSse;
  } finally {
    await stop(child);
    await rm(temp, { recursive: true, force: true });
  }
}

test("Antigravity Responses contract fixture is exercised through the offline proxy boundary", async () => {
  assert.equal(contract.schema, "autodev-antigravity-responses-contract-v1");
  const before = await readFile(CONTRACT_PATH);
  const telemetry = await startTelemetryServer();
  try {
    for (const [name, item] of Object.entries(contract.cases)) await runCase(name, item, telemetry);
  } finally {
    await new Promise((resolveClosed) => telemetry.server.close(resolveClosed));
  }
  assert.deepEqual(await readFile(CONTRACT_PATH), before, "contract fixture must not be mutated");
});
