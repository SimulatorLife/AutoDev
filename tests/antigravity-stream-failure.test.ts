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

test("streamed headless read_file denial is an incomplete response with a safe cause", async () => {
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
  writeFileSync(
    fakeAgy,
    String.raw`#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

assert.ok(process.argv.includes("--sandbox"));
assert.ok(!process.argv.includes("--dangerously-skip-permissions"));
const settings = JSON.parse(readFileSync(join(process.env.HOME, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
assert.ok(settings.permissions);
process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_type:"tool",tool_name:"view_file",state:"ACTIVE"}}) + "\n");
process.stderr.write(${JSON.stringify(PERMISSION_DIAGNOSTIC)});
process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:""}}) + "\n");
process.exit(0);
`,
    { mode: 0o755 }
  );

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
    await stopChild(bridge);
    rmSync(root, { recursive: true, force: true });
  }
});
