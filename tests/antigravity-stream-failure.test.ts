import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";

const REPO_ROOT = resolvePath(import.meta.dirname, "..");
const PERMISSION_DIAGNOSTIC =
  'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied. private target: /private/workspace/source.ts';

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

function waitForBridge(child: ChildProcess): Promise<string> {
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
        resolve(stderr);
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

interface BridgeFixture {
  bridge: ChildProcess;
  home: string;
  port: number;
  root: string;
  workspace: string;
}

/**
 * Start the real bridge against an isolated HOME/CODEX_HOME and a fake agy
 * whose behaviour is the given script body.
 */
async function startBridge(
  fakeAgyBody: string,
  env: Record<string, string> = {}
): Promise<BridgeFixture> {
  const root = mkdtempSync(join(tmpdir(), "autodev-agy-stream-error-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  const workspace = join(root, "workspace");
  const agyHome = join(home, ".gemini");
  const agyCliDir = join(agyHome, "antigravity-cli");
  const codexRuntime = join(codexHome, "provider-runtime");
  const fakeAgy = join(root, "fake-agy.mjs");
  const port = await reservePort();

  mkdirSync(join(agyHome, "config"), { recursive: true });
  mkdirSync(agyCliDir, { recursive: true });
  mkdirSync(join(agyHome, "antigravity-browser-profile"), {
    recursive: true
  });
  mkdirSync(codexRuntime, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(agyHome, "config", "mcp_config.json"), "{}\n");
  writeFileSync(
    join(agyCliDir, "settings.json"),
    '{"permissions":{"allow":[],"deny":[]}}\n'
  );
  writeFileSync(
    join(codexRuntime, "mcp-servers.json"),
    JSON.stringify({ playwright: { command: process.execPath, args: [] } })
  );
  writeFileSync(fakeAgy, `#!/usr/bin/env node\n${fakeAgyBody}`, {
    mode: 0o755
  });

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
        LITELLM_API_KEY: "",
        ...env
      },
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  try {
    await waitForBridge(bridge);
  } catch (error) {
    await stopChild(bridge);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { bridge, home, port, root, workspace };
}

async function stopBridge(fixture: BridgeFixture): Promise<void> {
  await stopChild(fixture.bridge);
  rmSync(fixture.root, { recursive: true, force: true });
}

test("streamed headless read_file denial is an incomplete response with a safe cause", async () => {
  const fixture = await startBridge(String.raw`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

assert.ok(process.argv.includes("--sandbox"));
assert.ok(process.argv.includes("--dangerously-skip-permissions"));
const settings = JSON.parse(readFileSync(join(process.env.HOME, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
assert.ok(settings.permissions);
process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_type:"tool",tool_name:"view_file",state:"ACTIVE"}}) + "\n");
process.stderr.write(${JSON.stringify(PERMISSION_DIAGNOSTIC)});
process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:""}}) + "\n");
process.exit(0);
`);
  const { home, port, workspace } = fixture;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-autodev-agent-role": "browser-tester"
      },
      body: JSON.stringify({
        cwd: workspace,
        input: "inspect this page",
        model: "gemini-3.8-flash-medium",
        stream: true
      }),
      signal: AbortSignal.timeout(10_000)
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const terminalLine = body
      .split("\n")
      .find(
        (line) =>
          line.startsWith("data: ") &&
          line.includes('"type":"response.completed"')
      );
    assert.ok(terminalLine, body);
    const terminal = JSON.parse(terminalLine.slice("data: ".length));
    assert.equal(terminal.response.status, "incomplete");
    assert.deepEqual(terminal.response.incomplete_details.provider_failure, {
      code: "AGY_PERMISSION_DENIED",
      phase: "tool_permission",
      tool: "read_file"
    });
    assert.match(
      terminal.response.output_text,
      /read_file permission was denied in headless mode/
    );
    assert.match(terminal.response.output_text, /nothing after it ran/);
    assert.doesNotMatch(body, /private target|\/private\/workspace|stderr:/);
    assert.equal(
      existsSync(join(home, ".gemini", "antigravity-cli", "settings.json")),
      true
    );
  } finally {
    await stopBridge(fixture);
  }
});

// One fake agy for every turn-outcome case: the prompt it is handed names the
// outcome, so a single bridge serves them all.
const OUTCOME_AGY = String.raw`
const prompt = process.argv.join(" ");
if (prompt.includes("CASE_LIMIT")) {
  process.stderr.write("Antigravity usage limit reached; reset at 2099-01-02T03:04:05Z");
  process.exit(1);
} else if (prompt.includes("CASE_CRASH")) {
  process.stderr.write("agy crashed");
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"turn done",usage:{input_tokens:7,output_tokens:5}}}) + "\n");
  process.exit(0);
}
`;

async function postTurn(
  port: number,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-autodev-agent-role": "browser-tester",
      "x-autodev-request-id": "req-outcome"
    },
    body: JSON.stringify({ model: "gemini-3.8-flash-medium", ...body }),
    signal: AbortSignal.timeout(10_000)
  });
}

test("Antigravity turn outcomes keep their HTTP status, body, headers, and usage", async () => {
  const fixture = await startBridge(OUTCOME_AGY, { CODEX_PROJECT_ROOT: "" });
  const { port, workspace } = fixture;
  try {
    // A non-streamed success reports agy's own usage and echoes the model.
    const ok = await postTurn(port, {
      cwd: workspace,
      input: "CASE_OK",
      stream: false
    });
    const okBody = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(okBody));
    assert.equal(okBody.model, "gemini-3.8-flash-medium");
    assert.equal(okBody.output_text, "turn done");
    assert.deepEqual(okBody.usage, {
      input_tokens: 7,
      output_tokens: 5,
      total_tokens: 12
    });

    // A non-streamed failure is a 502 naming the router's request id.
    const failed = await postTurn(port, {
      cwd: workspace,
      input: "CASE_CRASH",
      stream: false
    });
    const failedBody = await failed.json();
    assert.equal(failed.status, 502, JSON.stringify(failedBody));
    assert.equal(failedBody.error.provider, "antigravity");
    assert.equal(failedBody.error.requestId, "req-outcome");
    assert.equal(failedBody.error.role, "browser-tester");

    // A streamed turn that fails before any provider work is still an HTTP
    // status: a recognised usage limit is a 429 with a retry hint ...
    const limited = await postTurn(port, {
      cwd: workspace,
      input: "CASE_LIMIT",
      stream: true
    });
    const limitedBody = await limited.json();
    assert.equal(limited.status, 429, JSON.stringify(limitedBody));
    assert.equal(limited.headers.get("content-type"), "application/json");
    assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
    assert.equal(limitedBody.error.limit.class, "quota_exhausted");
    assert.equal(limitedBody.error.requestId, "req-outcome");

    // ... and anything else is a 503 without one.
    const crashed = await postTurn(port, {
      cwd: workspace,
      input: "CASE_CRASH",
      stream: true
    });
    const crashedBody = await crashed.json();
    assert.equal(crashed.status, 503, JSON.stringify(crashedBody));
    assert.equal(crashed.headers.get("retry-after"), null);
    assert.equal(crashedBody.error.limit, undefined);

    // A request whose workspace cannot be resolved is rejected before agy
    // starts.
    const unresolved = await postTurn(port, { input: "CASE_OK", stream: true });
    const unresolvedBody = await unresolved.json();
    assert.equal(unresolved.status, 400, JSON.stringify(unresolvedBody));
    assert.equal(unresolvedBody.error.type, "invalid_request_error");
  } finally {
    await stopBridge(fixture);
  }
});
