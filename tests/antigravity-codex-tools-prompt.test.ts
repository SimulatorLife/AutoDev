import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
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

/**
 * The tool surface Codex offered on the failing turn: code mode's `exec`
 * custom tool plus the plain function tools, and nothing else.
 */
const CODEX_TOOLS = {
  type: "additional_tools",
  tools: [
    {
      type: "custom",
      name: "exec",
      description:
        "Run JavaScript code to orchestrate/compose tool calls\n- Evaluates the JavaScript in a fresh V8 isolate\n- The first line must be a comment"
    },
    {
      type: "function",
      name: "wait",
      description: "Wait for a running exec call to finish.",
      parameters: { type: "object", properties: {} }
    }
  ]
};

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

function waitForListening(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`proxy did not start: ${stderr}`)),
      15_000
    );
    child.stderr?.on("data", (chunk: Buffer | string) => {
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

async function waitForFile(
  path: string,
  stderr: () => string,
  deadlineMs = 20_000
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() > deadline)
        throw new Error(`the CLI was never invoked: ${path}\n${stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/**
 * Run one turn through the Antigravity bridge and return the prompt the
 * bridge handed the CLI.
 *
 * The CLI is a stub that records its own argv: the bridge passes the prompt
 * as the CLI's `-p` argument, so this reads what the model would actually
 * have been told.
 */
async function promptForTurn(input: unknown[]): Promise<string> {
  const temp = await mkdtemp(
    join(tmpdir(), "autodev-antigravity-codex-tools-")
  );
  const fakeAgy = join(temp, "fake-agy.mjs");
  const argvFile = join(temp, "argv.json");
  const proxyPort = await freePort();
  const fakeSource = String.raw`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.AGY_ARGV_FILE, JSON.stringify(process.argv));
process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_type: "text", text_delta: "looking" } }) + "\n");
setInterval(() => {}, 1000);
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
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  try {
    await waitForListening(child);
    void fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-autodev-agent-role": "explorer",
        "x-autodev-request-id": "codex-tools-request",
        "x-autodev-session-id": "codex-tools-session",
        "x-autodev-session-scope": "identified"
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash-medium",
        input,
        cwd: REPO_ROOT,
        stream: true
      })
    }).catch(() => undefined);
    const argv = JSON.parse(
      await waitForFile(argvFile, () => stderr)
    ) as string[];
    const promptIndex = argv.indexOf("-p");
    assert.notEqual(
      promptIndex,
      -1,
      `the bridge must pass the prompt to the CLI: ${stderr}`
    );
    return argv[promptIndex + 1] ?? "";
  } finally {
    child.kill("SIGKILL");
    await rm(temp, { recursive: true, force: true });
  }
}

test("the Antigravity bridge tells the model how to reach the Codex tools it was given", async () => {
  // Observed 2026-10-31: the bridge offered Codex's `exec` on the `codex` MCP
  // server, whose description points at a "Codex tools" section in the model's
  // instructions. The Antigravity bridge published no such section, so the
  // model guessed the tool's name -- `read_file`, `exec_command`, `shell` --
  // and every guess was refused with "Codex did not offer a tool named ...",
  // which ended the turn as a capability failure.
  const prompt = await promptForTurn([
    CODEX_TOOLS,
    { type: "message", role: "user", content: "read the repository" }
  ]);
  // The reference the tool descriptions point at has to exist.
  assert.match(prompt, /## Codex tools/);
  // It has to name the tool the server actually offers, or the model guesses
  // another one.
  assert.match(prompt, /### `exec`/);
  // And it has to say how to call it: agy reaches every MCP server through
  // one built-in, so the tool is named twice.
  assert.match(prompt, /call_mcp_tool/);
  assert.match(prompt, /`codex` MCP server/);
  assert.match(prompt, /ServerName/);
  assert.match(prompt, /ToolName/);
  // The tool's own description has to survive: it carries the names of the
  // nested tools `exec` evaluates against.
  assert.match(
    prompt,
    /Run JavaScript code to orchestrate\/compose tool calls/
  );
});

test("a turn with no Codex tools is told about none", async () => {
  // A turn told about a server it does not have would look for tools that
  // are not there.
  const prompt = await promptForTurn([
    { type: "message", role: "user", content: "read the repository" }
  ]);
  assert.doesNotMatch(prompt, /## Codex tools/);
  assert.doesNotMatch(prompt, /call_mcp_tool/);
});
