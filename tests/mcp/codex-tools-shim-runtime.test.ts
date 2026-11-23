import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  codexToolsMcpServer,
  handleMessage
} from "@simulatorlife/autodev-runtime/mcp/codex-tools-shim";

const REPO_ROOT = new URL("../../", import.meta.url);

async function listen(
  server: ReturnType<typeof createServer>
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind an IP port");
  }
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test("a launch definition names the turn its shim reports back on", async () => {
  const exportedBodies: Buffer[] = [];
  const exporter = createServer(async (request, response) => {
    exportedBodies.push(await requestBody(request));
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  // The turn the shim reports is the whole contract between the launcher and
  // the bridge: a shim that launched with one key and reports another reaches a
  // turn that does not exist, and every call is refused.
  const reportedTurns: unknown[] = [];
  const bridge = createServer(async (request, response) => {
    const payload = JSON.parse((await requestBody(request)).toString("utf8"));
    assert.equal(payload.name, "read_file");
    reportedTurns.push(payload.turn);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "private tool output" }],
        isError: false
      })
    );
  });

  const exporterPort = await listen(exporter);
  const bridgePort = await listen(bridge);
  // Launched exactly as a bridge launches it, from the definition the launcher
  // produced rather than a hand-written copy of its env.
  const server = codexToolsMcpServer(
    "turn-runtime-test",
    { url: `http://127.0.0.1:${bridgePort}`, token: "" },
    {
      OTEL_RESOURCE_ATTRIBUTES:
        "autodev.workspace=workspace-runtime-test,autodev.agent.role=worker"
    }
  );
  const child = spawn(server.command, server.args, {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      ...server.env,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${exporterPort}/v1/traces`
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const replies = createInterface({ input: child.stdout });
  const replyLines = replies[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`
    );
    const initialize = await replyLines.next();
    assert.equal(JSON.parse(initialize.value ?? "{}").id, 1);

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "read_file",
          arguments: { path: "/private/secret.txt", token: "do-not-export" }
        }
      })}\n`
    );
    const call = await replyLines.next();
    const callReply = JSON.parse(call.value ?? "{}");
    assert.equal(callReply.id, 2);
    assert.equal(callReply.result?.content?.[0]?.text, "private tool output");
    assert.deepEqual(reportedTurns, ["turn-runtime-test"]);

    child.stdin.end();
    const [exitCode] = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`shim did not shut down: ${stderr}`)),
          5000
        )
      )
    ]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(exportedBodies.length, 1, "shutdown flushes the queued span");

    const wire = Buffer.concat(exportedBodies).toString("utf8");
    for (const expected of [
      "autodev-codex-tools-mcp",
      "workspace-runtime-test",
      "autodev.agent.role",
      "worker",
      "mcp.method.name",
      "tools/call",
      "gen_ai.tool.name",
      "read_file",
      "gen_ai.operation.name",
      "execute_tool"
    ]) {
      assert.ok(
        wire.includes(expected),
        `OTLP export must include ${expected}`
      );
    }
    assert.equal(wire.includes("/private/secret.txt"), false);
    assert.equal(wire.includes("do-not-export"), false);
    assert.equal(wire.includes("private tool output"), false);
  } finally {
    replies.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await Promise.all([close(bridge), close(exporter)]);
  }
});

test("codex-tools-shim starts and executes tools when telemetry module fails to load", async () => {
  const repositoryRoot = fileURLToPath(REPO_ROOT);
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-shim-broken-telemetry-")
  );
  let bridgeCalls = 0;
  const bridge = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    await requestBody(request);
    response.writeHead(200, { "content-type": "application/json" });
    if (pathname.endsWith("/list")) {
      response.end(
        JSON.stringify({
          tools: [
            {
              name: "exec",
              description: "run",
              inputSchema: { type: "object" }
            }
          ]
        })
      );
      return;
    }
    bridgeCalls += 1;
    response.end(
      JSON.stringify({
        content: [{ type: "text", text: "ok-output" }],
        isError: false
      })
    );
  });

  const bridgePort = await listen(bridge);
  let replies: ReturnType<typeof createInterface> | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  try {
    await mkdir(path.join(temporaryRoot, "mcp"), { recursive: true });
    await copyFile(
      path.join(repositoryRoot, "runtime/src/mcp/codex-tools-shim.ts"),
      path.join(temporaryRoot, "mcp/codex-tools-shim.ts")
    );
    await writeFile(
      path.join(temporaryRoot, "mcp/codex-tools-shim-telemetry.ts"),
      'import "@opentelemetry/sdk-trace-missing-test";\nexport {};\n',
      "utf8"
    );
    await symlink(
      path.join(repositoryRoot, "runtime/src/shared"),
      path.join(temporaryRoot, "shared")
    );
    await symlink(
      path.join(repositoryRoot, "runtime/src/telemetry"),
      path.join(temporaryRoot, "telemetry")
    );
    await symlink(
      path.join(repositoryRoot, "runtime/node_modules"),
      path.join(temporaryRoot, "node_modules")
    );
    await writeFile(
      path.join(temporaryRoot, "package.json"),
      JSON.stringify({
        name: "@simulatorlife/autodev-runtime",
        type: "module",
        exports: {
          "./shared/entry-point": "./shared/entry-point.ts",
          "./shared/runtime-source-root": "./shared/runtime-source-root.ts",
          "./telemetry/resource-context":
            "./telemetry/resource-context/index.ts",
          "./telemetry/tracer-provider": "./telemetry/tracer-provider.ts"
        }
      }),
      "utf8"
    );

    child = spawn(
      process.execPath,
      [path.join(temporaryRoot, "mcp/codex-tools-shim.ts")],
      {
        cwd: temporaryRoot,
        env: {
          PATH: process.env.PATH ?? "",
          AUTODEV_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
          AUTODEV_BRIDGE_TURN: "turn-broken-telemetry"
        },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    replies = createInterface({ input: child.stdout! });
    const replyLines = replies[Symbol.asyncIterator]();
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exitedEarly = (async () => {
      const [code] = await once(child, "exit");
      return { exited: true as const, code };
    })();
    const nextReply = async (): Promise<Record<string, unknown>> => {
      const readLine = async () => ({
        exited: false as const,
        entry: await replyLines.next()
      });
      const result = await Promise.race([readLine(), exitedEarly]);
      if (result.exited) {
        throw new Error(
          `shim exited (${result.code}) before replying: ${stderr}`
        );
      }
      assert.equal(
        result.entry.done,
        false,
        `shim closed stdout unexpectedly: ${stderr}`
      );
      return JSON.parse(result.entry.value) as Record<string, unknown>;
    };

    child.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`
    );
    const initReply = await nextReply();
    assert.equal(initReply.id, 1);
    assert.equal(
      (initReply.result as { serverInfo?: { name?: string } })?.serverInfo?.name,
      "autodev-codex-tools"
    );

    child.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`
    );
    const listReply = await nextReply();
    assert.equal(listReply.id, 2);
    assert.deepEqual(
      (listReply.result as { tools?: Array<{ name?: string }> })?.tools?.map(
        (tool) => tool.name
      ),
      ["exec"]
    );

    for (const id of [3, 4]) {
      child.stdin!.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "exec",
            arguments: { token: "secret-arg" }
          }
        })}\n`
      );
      const callReply = await nextReply();
      assert.equal(callReply.id, id);
      assert.equal(
        (callReply.result as { content?: Array<{ text?: string }> })
          ?.content?.[0]?.text,
        "ok-output"
      );
    }
    assert.equal(bridgeCalls, 2);

    child.stdin!.end();
    const [exitCode] = await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`shim did not shut down: ${stderr}`)),
          5000
        )
      )
    ]);
    assert.equal(exitCode, 0, stderr);
    const failureMatches = stderr.match(
      /\[autodev-codex-tools-telemetry\] telemetry_module_load_failed/gu
    );
    assert.equal(failureMatches?.length, 1, stderr);
    assert.equal(stderr.includes("secret-arg"), false);
    assert.equal(stderr.includes("ok-output"), false);
  } finally {
    replies?.close();
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await close(bridge);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("handleMessage executes tools/call once when injected telemetryLoader rejects", async () => {
  const emitted: Array<Record<string, unknown>> = [];
  let bridgeCalls = 0;
  let loaderCalls = 0;
  await handleMessage(
    {
      id: 7,
      method: "tools/call",
      params: { name: "exec", arguments: { input: "text(1)" } }
    },
    (message) => {
      emitted.push(message);
    },
    async () => {
      bridgeCalls += 1;
      return {
        status: 200,
        body: {
          content: [{ type: "text", text: "bridge-result" }],
          isError: false
        }
      };
    },
    async () => {
      loaderCalls += 1;
      throw new Error("missing dep");
    }
  );
  assert.equal(loaderCalls, 1);
  assert.equal(bridgeCalls, 1);
  assert.deepEqual(emitted, [
    {
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "bridge-result" }],
        isError: false
      }
    }
  ]);
});
