import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { copilotMcpArgs, runCopilot } from "../src/providers/copilot.ts";
import {
  classifyCliLimit,
  limitPayload
} from "../src/shared/provider-limits.ts";
import { createBridgeMcpHomes } from "./bridge-mcp-fixture.ts";

const REPO_ROOT = resolvePath(import.meta.dirname, "..");
// The bridge reads the MCP catalogue and user-level Copilot MCP file an install
// materializes; give it hermetic copies instead of this machine's install.
const homes = createBridgeMcpHomes();
process.env.CODEX_HOME = homes.codexHome;
process.env.COPILOT_HOME = homes.copilotHome;
test.after(async () => {
  await rm(homes.root, { recursive: true, force: true });
});
const PROXY = join(REPO_ROOT, "src/providers/copilot.ts");
const CONTRACT_PATH = join(
  REPO_ROOT,
  "tests/fixtures/contracts/copilot-responses-contract.json"
);

type JsonRecord = Record<string, any>;
type ContractCase = JsonRecord & {
  cli: JsonRecord;
  request?: JsonRecord;
  expected: JsonRecord;
};
type Contract = { schema: string; cases: Record<string, ContractCase> };

const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8")) as Contract;
const cases = Object.entries(contract.cases);

function replaceTokens(value: any): any {
  if (typeof value === "string")
    return value.replaceAll("<REPO_ROOT>", REPO_ROOT);
  if (Array.isArray(value)) return value.map(replaceTokens);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, replaceTokens(nested)])
    );
  return value;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not expose a TCP address"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForListening(child: any): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`proxy did not start: ${stderr}`)),
      5000
    );
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.includes("Copilot Responses proxy listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== null) {
        clearTimeout(timer);
        reject(
          new Error(
            `proxy exited before listening (${code}/${signal}): ${stderr}`
          )
        );
      }
    });
  });
}

function parseSse(text: string): Array<{ event: string; data: any }> {
  return text
    .trimEnd()
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      if (chunk === "data: [DONE]") return { event: "[DONE]", data: null };
      const lines = chunk.split("\n");
      const event =
        lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      return { event, data: data ? JSON.parse(data) : null };
    });
}

function scrub(value: any): any {
  if (typeof value === "string")
    return value
      .replaceAll(REPO_ROOT, "<REPO_ROOT>")
      .replaceAll(/resp_[0-9a-f]+/g, "<RESPONSE_ID>")
      .replaceAll(/rs_[0-9a-f]+/g, "<REASONING_ID>")
      .replaceAll(/msg_[0-9a-f]+/g, "<MESSAGE_ID>")
      .replaceAll(/"sequence_number":\d+/g, '"sequence_number":<SEQUENCE>');
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        key === "created_at"
          ? "<CREATED_AT>"
          : key === "sequence_number"
            ? "<SEQUENCE>"
            : scrub(nested)
      ])
    );
  return value;
}

interface TelemetryHandle {
  events: any[];
  server: any;
  url: string;
}

async function startTelemetryServer(): Promise<TelemetryHandle> {
  const events: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (request.method === "POST") {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        for (const event of payload.events ?? [])
          events.push({ ...event, requestId: payload.requestId });
      } catch {
        response.statusCode = 400;
      }
    }
    response.end("ok");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  return { events, server, url: `http://127.0.0.1:${port}/events` };
}

async function runCase(
  name: string,
  rawCase: ContractCase,
  telemetry: TelemetryHandle
): Promise<any> {
  const item = replaceTokens(rawCase);
  const temp = await mkdtemp(join(tmpdir(), "autodev-copilot-contract-"));
  const fakeCli = join(temp, "fake-copilot.mjs");
  const proxyPort = await freePort();
  const fakeSource = `
const fixture = JSON.parse(process.env.COPILOT_CONTRACT_CASE);
for (const event of fixture.events ?? []) console.log(JSON.stringify(event));
if (fixture.stderr) process.stderr.write(fixture.stderr);
process.exitCode = fixture.exitCode ?? 0;
`;
  await writeFile(fakeCli, `#!/usr/bin/env node\n${fakeSource}`, "utf8");
  await chmod(fakeCli, 0o755);
  const child = spawn(process.execPath, [PROXY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AUTODEV_REPO_ROOT: REPO_ROOT,
      CODEX_PROJECT_ROOT: REPO_ROOT,
      COPILOT_BIN: fakeCli,
      COPILOT_PROXY_HOST: "127.0.0.1",
      COPILOT_PROXY_PORT: String(proxyPort),
      COPILOT_PROXY_TIMEOUT_MS: "5000",
      COPILOT_CONTRACT_CASE: JSON.stringify(item.cli)
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  try {
    await waitForListening(child);
    const requestId = `copilot-contract-${name}`;
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-autodev-request-id": requestId,
        "x-autodev-agent-events-url": telemetry.url
      },
      body: JSON.stringify({
        model: "copilot",
        input: [{ role: "user", content: "contract task" }],
        cwd: REPO_ROOT,
        ...item.request
      })
    });
    const body = await response.text();
    assert.equal(response.status, item.expected.status, `${name}: HTTP status`);
    assert.equal(
      response.headers.get("content-type"),
      "text/event-stream",
      `${name}: SSE content type`
    );
    const sse = parseSse(body);
    assert.deepEqual(
      sse.map(({ event }) => event),
      item.expected.eventTypes,
      `${name}: SSE lifecycle`
    );
    assert.equal(sse.at(-1)?.event, "[DONE]", `${name}: terminal sentinel`);
    const completed = sse.find(({ event }) => event === "response.completed")
      ?.data?.response;
    const completedText = completed.output_text;
    if (item.expected.outputText !== undefined)
      assert.equal(
        completedText,
        item.expected.outputText,
        `${name}: output text`
      );
    if (item.expected.outputTextPrefix !== undefined)
      assert.ok(
        completedText.startsWith(item.expected.outputTextPrefix),
        `${name}: partial output text`
      );
    assert.equal(
      completed.status,
      item.expected.completedStatus,
      `${name}: completion status`
    );
    if (item.expected.incompleteReason) {
      assert.equal(
        completed.incomplete_details.reason,
        item.expected.incompleteReason,
        `${name}: incomplete reason`
      );
      assert.deepEqual(
        completed.incomplete_details.provider_limit,
        item.expected.limit,
        `${name}: limit payload`
      );
      assert.deepEqual(
        limitPayload(classifyCliLimit(item.cli.stderr, item.cli.exitCode)),
        item.expected.limit,
        `${name}: classified limit payload`
      );
    }
    assert.equal(
      sse.filter(({ event }) => event === "response.completed").length,
      1,
      `${name}: one completion`
    );
    for (const entry of sse.filter(
      ({ data }) => data?.sequence_number !== undefined
    ))
      assert.equal(typeof entry.data.sequence_number, "number");
    await delay(100);
    const reported = telemetry.events.filter(
      (event) => event.requestId === requestId
    );
    for (const type of item.expected.telemetryTypes ?? [])
      assert.ok(
        reported.some((event: any) => event.type === type),
        `${name}: telemetry ${type}: ${JSON.stringify(reported)}`
      );
    if (item.expected.directEventTypes) {
      const previousCopilotBin = process.env.COPILOT_BIN;
      const previousContractCase = process.env.COPILOT_CONTRACT_CASE;
      process.env.COPILOT_BIN = fakeCli;
      process.env.COPILOT_CONTRACT_CASE = JSON.stringify(item.cli);
      try {
        const directEvents: any[] = [];
        await runCopilot("contract task", "copilot", REPO_ROOT, (event) =>
          directEvents.push(event)
        );
        for (const type of item.expected.directEventTypes)
          assert.ok(
            directEvents.some((event) => event.type === type),
            `${name}: direct parser event ${type}`
          );
        if (item.expected.skill)
          assert.ok(
            directEvents.some(
              (event) =>
                event.type === "skill_used" &&
                event.skill === item.expected.skill
            ),
            `${name}: direct skill parser event`
          );
      } finally {
        if (previousCopilotBin === undefined) delete process.env.COPILOT_BIN;
        else process.env.COPILOT_BIN = previousCopilotBin;
        if (previousContractCase === undefined)
          delete process.env.COPILOT_CONTRACT_CASE;
        else process.env.COPILOT_CONTRACT_CASE = previousContractCase;
      }
    }
    if (item.expected.tool) {
      const toolEvents = reported.filter(
        (event) => event.tool === item.expected.tool
      );
      assert.ok(toolEvents.length > 0, `${name}: tool telemetry`);
    }
    if (item.expected.unavailableReason)
      assert.ok(
        reported.some(
          (event: any) =>
            event.type === "tool_unavailable" &&
            event.reason === item.expected.unavailableReason
        ),
        `${name}: denial telemetry`
      );
    const normalizedSse = scrub(sse);
    assert.match(
      JSON.stringify(normalizedSse),
      /<RESPONSE_ID>/,
      `${name}: response IDs must be normalized`
    );
    assert.match(
      JSON.stringify(normalizedSse),
      /<CREATED_AT>/,
      `${name}: timestamps must be normalized`
    );
    assert.doesNotMatch(
      JSON.stringify(normalizedSse),
      /contract task/,
      `${name}: prompt content must not be in SSE`
    );
    assert.doesNotMatch(
      JSON.stringify(reported),
      /contract task/,
      `${name}: prompt content must not be in telemetry`
    );
    return scrub(sse);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(temp, { recursive: true, force: true });
  }
}

test("Copilot orchestrator receives only its identified AutoDev spawn shim", () => {
  const args = copilotMcpArgs("orchestrator", "copilot-session");
  const configIndex = args.indexOf("--additional-mcp-config");
  assert.notEqual(configIndex, -1);
  const config = JSON.parse(args[configIndex + 1] ?? "{}");
  const shim = config.mcpServers.autodev_spawn;
  assert.equal(shim.type, "stdio");
  assert.equal(shim.command, process.execPath);
  assert.equal(shim.env.AUTODEV_SPAWN_SESSION, "copilot-session");
  assert.equal(
    copilotMcpArgs("worker").some((arg) => arg.includes("autodev_spawn")),
    false
  );
});

test("Copilot Responses contract fixture is exercised through the offline proxy boundary", async () => {
  const before = await readFile(CONTRACT_PATH);
  const telemetry = await startTelemetryServer();
  try {
    for (const [name, item] of cases) await runCase(name, item, telemetry);
  } finally {
    await new Promise<void>((resolve) =>
      telemetry.server.close(() => resolve())
    );
  }
  assert.deepEqual(
    await readFile(CONTRACT_PATH),
    before,
    "contract fixture must not be mutated"
  );
});
