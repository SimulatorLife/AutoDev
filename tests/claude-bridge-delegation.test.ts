import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";

const REPO_ROOT = resolvePath(import.meta.dirname, "..");
const BRIDGE = join(REPO_ROOT, "runtime/src/providers/claude.ts");
const BRIDGE_TOKEN = "claude-bridge-token";

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
      () => reject(new Error(`bridge did not start: ${stderr}`)),
      15_000
    );
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (!stderr.includes("Claude Responses proxy listening")) return;
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
        reject(
          new Error(`bridge exited before listening (${code}): ${stderr}`)
        );
      }
    });
  });
}

/**
 * The stub CLI.
 *
 * It stands in for the real Claude CLI: it records the argv the bridge built,
 * drains the transcript the bridge wrote on stdin, and -- when the bridge
 * offered it a delegation surface -- asks that surface for a child, exactly
 * as the spawn shim does on the model's behalf. The call it makes is the
 * shim's own protocol, read out of the MCP config the bridge handed it.
 */
const STUB_CLI = String.raw`
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
writeFileSync(process.env.CLAUDE_ARGV_FILE, JSON.stringify(argv));

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk.toString();
writeFileSync(process.env.CLAUDE_STDIN_FILE, stdin);

const configIndex = argv.indexOf("--mcp-config");
const config = configIndex === -1 ? {} : JSON.parse(argv[configIndex + 1] ?? "{}");
const spawn = config?.mcpServers?.autodev_spawn;
if (spawn) {
  const env = spawn.env ?? {};
  const response = await fetch(new URL("/v1/bridge-spawn/call", env.AUTODEV_BRIDGE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + env.AUTODEV_BRIDGE_TOKEN
    },
    body: JSON.stringify({
      session: env.AUTODEV_SPAWN_SESSION,
      children: [{ agent_type: "explorer", message: "look at the router" }]
    })
  });
  writeFileSync(process.env.CLAUDE_SPAWN_RESULT_FILE, await response.text());
}

process.stdout.write(
  JSON.stringify({
    type: "result",
    result: "delegated",
    usage: { input_tokens: 3, output_tokens: 4 }
  }) + "\n"
);
`;

interface BridgeTurn {
  argv: string[];
  stdin: string;
  spawnResult: string;
  response: any;
  stderr: string;
}

/**
 * Run one turn through the Claude bridge and return what the CLI was given
 * and what the bridge answered.
 */
async function runTurn(headers: Record<string, string>): Promise<BridgeTurn> {
  const temp = await mkdtemp(join(tmpdir(), "autodev-claude-delegation-"));
  const cliPath = join(temp, "fake-claude.mjs");
  const argvFile = join(temp, "argv.json");
  const stdinFile = join(temp, "stdin.txt");
  const spawnResultFile = join(temp, "spawn-result.json");
  const port = await freePort();
  await writeFile(cliPath, `#!/usr/bin/env node\n${STUB_CLI}`, "utf8");
  await chmod(cliPath, 0o755);
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_BIN: cliPath,
      CLAUDE_BRIDGE_HOST: "127.0.0.1",
      CLAUDE_BRIDGE_PORT: String(port),
      CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
      CLAUDE_ARGV_FILE: argvFile,
      CLAUDE_STDIN_FILE: stdinFile,
      CLAUDE_SPAWN_RESULT_FILE: spawnResultFile,
      CODEX_PROJECT_ROOT: REPO_ROOT,
      LITELLM_API_KEY: BRIDGE_TOKEN
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  try {
    await waitForListening(child);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${BRIDGE_TOKEN}`,
        ...headers
      },
      body: JSON.stringify({
        model: "claude-subscription",
        input: [{ role: "user", content: "delegate this" }],
        cwd: REPO_ROOT
      })
    });
    const body = await response.text();
    const read = async (path: string): Promise<string> => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return "";
      }
    };
    return {
      argv: JSON.parse((await read(argvFile)) || "[]") as string[],
      stdin: await read(stdinFile),
      spawnResult: await read(spawnResultFile),
      response: body ? JSON.parse(body) : null,
      stderr
    };
  } finally {
    child.kill("SIGKILL");
    await rm(temp, { recursive: true, force: true });
  }
}

const ORCHESTRATOR_HEADERS = {
  "x-autodev-agent-role": "orchestrator",
  "x-autodev-session-id": "claude-delegation-session",
  "x-autodev-session-scope": "identified"
};

function mcpConfigOf(argv: string[]): any {
  const index = argv.indexOf("--mcp-config");
  if (index === -1) return null;
  return JSON.parse(argv[index + 1] ?? "{}");
}

function argValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  return index === -1 ? "" : (argv[index + 1] ?? "");
}

test("an orchestrator turn is offered delegation even when Codex offered no tools", async () => {
  const turn = await runTurn(ORCHESTRATOR_HEADERS);
  const config = mcpConfigOf(turn.argv);
  assert.ok(config, "the bridge must hand the CLI an MCP config");
  // The request declared no tools, so there is no Codex tool server to mirror.
  assert.equal(config.mcpServers.codex, undefined);
  // The delegation surface is the bridge's own, and it is offered anyway.
  const spawnServer = config.mcpServers.autodev_spawn;
  assert.ok(spawnServer, "the bridge must offer the spawn server");
  assert.match(spawnServer.args[0], /spawn-shim\.ts$/);
  assert.equal(
    spawnServer.env.AUTODEV_SPAWN_SESSION,
    "claude-delegation-session"
  );
  assert.match(
    spawnServer.env.AUTODEV_BRIDGE_URL,
    /^http:\/\/127\.0\.0\.1:\d+$/
  );
  assert.equal(spawnServer.env.AUTODEV_BRIDGE_TOKEN, BRIDGE_TOKEN);
  // The CLI must be allowed to call it.
  assert.match(argValue(turn.argv, "--allowed-tools"), /mcp__autodev_spawn/);
  // And the model must be told the call in the shape its CLI can make.
  const systemPrompt = argValue(turn.argv, "--system-prompt");
  assert.match(systemPrompt, /## Delegation on this provider/);
  assert.match(systemPrompt, /mcp__autodev_spawn__spawn_subagent/);
  // A turn with no Codex tools must not be told it has none at all.
  assert.match(systemPrompt, /You may still delegate through the bridge/);
});

test("a leaf turn is offered no delegation surface and told nothing about delegating", async () => {
  const turn = await runTurn({
    "x-autodev-agent-role": "explorer",
    "x-autodev-session-id": "claude-leaf-session",
    "x-autodev-session-scope": "identified"
  });
  const config = mcpConfigOf(turn.argv);
  assert.equal(config?.mcpServers?.autodev_spawn, undefined);
  assert.doesNotMatch(argValue(turn.argv, "--allowed-tools"), /autodev_spawn/);
  const systemPrompt = argValue(turn.argv, "--system-prompt");
  assert.doesNotMatch(systemPrompt, /## Delegation on this provider/);
  assert.doesNotMatch(systemPrompt, /spawn_subagent/);
});

test("a delegated turn hands Codex one exec call that creates the children", async () => {
  const turn = await runTurn(ORCHESTRATOR_HEADERS);
  // The shim's own call is accepted: the bridge collected the child.
  assert.match(turn.spawnResult, /Dispatched 1 subagent\(s\): explorer/);
  // And the bridge turned it into Codex's own spawn, on one exec call.
  const output = turn.response?.output ?? [];
  const exec = output.find(
    (item: any) => item.type === "custom_tool_call" && item.name === "exec"
  );
  assert.ok(
    exec,
    `the response must carry one exec call: ${JSON.stringify(output)}`
  );
  assert.match(exec.input, /spawn_agent/);
  assert.match(exec.input, /"agent_type":"explorer"/);
  assert.match(exec.input, /look at the router/);
  assert.equal(exec.status, "completed");
});
