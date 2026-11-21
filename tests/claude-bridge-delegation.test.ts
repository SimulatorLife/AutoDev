import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";

import { NODE_SHEBANG } from "./node-shebang.ts";

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
 * drains the transcript the bridge wrote on stdin, and ends the turn. An
 * orchestrator delegates through Codex's own `exec` tool, which the bridge
 * mirrors like any other Codex tool, so the stub has nothing to call to
 * delegate.
 */
const STUB_CLI = String.raw`
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
writeFileSync(process.env.CLAUDE_ARGV_FILE, JSON.stringify(argv));

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk.toString();
writeFileSync(process.env.CLAUDE_STDIN_FILE, stdin);

process.stdout.write(
  JSON.stringify({
    type: "result",
    result: "done",
    usage: { input_tokens: 3, output_tokens: 4 }
  }) + "\n"
);
`;

interface BridgeTurn {
  argv: string[];
  stdin: string;
  response: any;
  stderr: string;
}

/**
 * Run one turn through the Claude bridge and return what the CLI was given
 * and what the bridge answered.
 */
async function runTurn(
  headers: Record<string, string>,
  tools: unknown[] = []
): Promise<BridgeTurn> {
  const temp = await mkdtemp(join(tmpdir(), "autodev-claude-delegation-"));
  const cliPath = join(temp, "fake-claude.mjs");
  const argvFile = join(temp, "argv.json");
  const stdinFile = join(temp, "stdin.txt");
  const port = await freePort();
  await writeFile(cliPath, `${NODE_SHEBANG}\n${STUB_CLI}`, "utf8");
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
        tools,
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

// Codex's code-mode surface: one `exec` custom tool whose description declares
// the nested functions, the orchestrator's spawn functions among them.
const EXEC_TOOL = {
  type: "custom",
  name: "exec",
  description:
    "Run JavaScript. declare const tools: { exec_command(args): Promise<unknown>; multi_agent_v1__spawn_agent(args): Promise<unknown>; multi_agent_v1__wait_agent(args): Promise<unknown>; }"
};

test("an orchestrator delegates through the mirrored exec tool, with no spawn server of the bridge's own", async () => {
  const turn = await runTurn(ORCHESTRATOR_HEADERS, [EXEC_TOOL]);
  const config = mcpConfigOf(turn.argv);
  assert.ok(config, "the bridge must hand the CLI an MCP config");
  // The only server is the mirror of Codex's own tools.
  assert.deepEqual(Object.keys(config.mcpServers), ["codex"]);
  assert.equal(argValue(turn.argv, "--allowed-tools"), "mcp__codex");
  const systemPrompt = argValue(turn.argv, "--system-prompt");
  // No provider-specific delegation section: the spawn functions are named
  // where every provider finds them, on exec's tools global.
  assert.doesNotMatch(systemPrompt, /Delegation on this provider/);
  assert.doesNotMatch(systemPrompt, /spawn_subagent|autodev_spawn/);
  assert.match(systemPrompt, /tools\.multi_agent_v1__spawn_agent/);
});

test("an orchestrator turn Codex offered no tools has no delegation surface to invent", async () => {
  const turn = await runTurn(ORCHESTRATOR_HEADERS);
  assert.equal(mcpConfigOf(turn.argv), null);
  const systemPrompt = argValue(turn.argv, "--system-prompt");
  assert.match(systemPrompt, /No Codex tools are available on this turn/);
  assert.doesNotMatch(systemPrompt, /spawn server|spawn_subagent/);
});

test("the bridge never writes a spawn call of its own into the response", async () => {
  const turn = await runTurn(ORCHESTRATOR_HEADERS, [EXEC_TOOL]);
  const output = turn.response?.output ?? [];
  assert.equal(
    output.some((item: any) => item.type === "custom_tool_call"),
    false,
    `a turn whose model made no call must carry no tool call: ${JSON.stringify(output)}`
  );
});
