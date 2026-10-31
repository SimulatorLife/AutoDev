import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";

const REPO_ROOT = resolvePath(import.meta.dirname, "..");
const PROXY = join(REPO_ROOT, "runtime/src/providers/antigravity.ts");

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
      15_000
    );
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (!stderr.includes("Antigravity Responses proxy listening")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code: number | null) => {
      if (code !== null) {
        clearTimeout(timer);
        reject(new Error(`proxy exited before listening (${code}): ${stderr}`));
      }
    });
  });
}

/**
 * Run one turn through the Antigravity bridge and return the prompt the
 * bridge handed the CLI.
 *
 * The CLI is a stub that records its own argv: the bridge passes the prompt
 * as the CLI's `-p` argument, so this reads what the model would actually
 * have been told.
 */
async function promptForTurn(headers: Record<string, string>): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), "autodev-antigravity-delegation-"));
  const fakeAgy = join(temp, "fake-agy.mjs");
  const argvFile = join(temp, "argv.json");
  const proxyPort = await freePort();
  const fakeSource = String.raw`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.AGY_ARGV_FILE, JSON.stringify(process.argv));
process.stdout.write(JSON.stringify({ type: "result", text: "done" }) + "\n");
`;
  await writeFile(fakeAgy, `#!/usr/bin/env node\n${fakeSource}`, "utf8");
  await chmod(fakeAgy, 0o755);
  const isolatedCodexHome = join(temp, "codex");
  const isolatedUserHome = join(temp, "user");
  await mkdir(join(isolatedCodexHome, "provider-runtime"), { recursive: true });
  await mkdir(join(isolatedUserHome, ".gemini"), { recursive: true });
  await writeFile(
    join(isolatedCodexHome, "provider-runtime", "mcp-servers.json"),
    JSON.stringify({
      lsp: { command: "node", args: [] },
      "cocoindex-code": { command: "node", args: [] },
      codegraphcontext: { command: "node", args: [] },
      codex_app: { command: "node", args: [] },
      context7: { url: "https://mcp.context7.com/mcp" }
    })
  );
  const child = spawn(process.execPath, [PROXY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: isolatedUserHome,
      CODEX_HOME: isolatedCodexHome,
      AUTODEV_REPO_ROOT: REPO_ROOT,
      CODEX_PROJECT_ROOT: REPO_ROOT,
      AGY_CLI_PATH: fakeAgy,
      AGY_PROXY_HOST: "127.0.0.1",
      AGY_PROXY_PORT: String(proxyPort),
      AGY_PRINT_TIMEOUT: "5s",
      AGY_ARGV_FILE: argvFile,
      LITELLM_API_KEY: ""
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  try {
    await waitForListening(child);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: "antigravity-subscription",
        input: [{ role: "user", content: "delegate this" }],
        cwd: REPO_ROOT
      })
    });
    const body = await response.text();
    let argv: string[];
    try {
      argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
    } catch (error) {
      assert.fail(
        `the CLI was not invoked (${response.status}): ${body}\n${stderr}\n${String(error)}`
      );
    }
    const promptIndex = argv.indexOf("-p");
    assert.notEqual(
      promptIndex,
      -1,
      "the bridge must pass the prompt to the CLI"
    );
    return argv[promptIndex + 1] ?? "";
  } finally {
    child.kill("SIGKILL");
    await rm(temp, { recursive: true, force: true });
  }
}

test("the Antigravity bridge tells an orchestrator the delegation call its CLI can make", async () => {
  const prompt = await promptForTurn({
    "x-autodev-request-id": "delegation-request",
    "x-autodev-agent-role": "orchestrator",
    "x-autodev-session-id": "delegation-session",
    "x-autodev-session-scope": "identified"
  });
  // The model must be told, in its own surface, the call that creates a child
  // Codex can see.
  assert.match(prompt, /## Delegation on this provider/);
  assert.match(prompt, /call_mcp_tool/);
  assert.match(prompt, /"ServerName": "autodev_spawn"/);
  assert.match(prompt, /"ToolName": "spawn_subagent"/);
  assert.match(prompt, /"agent_type": "<role>"/);
  // The shared policy still reaches the model: the delegation section names
  // the surface the provider offers rather than only Codex's own.
  assert.match(prompt, /## Delegation/);
  assert.match(prompt, /the delegation surface is the one your provider/i);
});

test("a turn the bridge cannot delegate in is told nothing about delegating", async () => {
  const prompt = await promptForTurn({
    "x-autodev-request-id": "leaf-request",
    "x-autodev-agent-role": "explorer",
    "x-autodev-session-id": "leaf-session",
    "x-autodev-session-scope": "identified"
  });
  assert.doesNotMatch(prompt, /## Delegation on this provider/);
  assert.doesNotMatch(prompt, /spawn_subagent/);
});
