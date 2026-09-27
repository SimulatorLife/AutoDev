import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RouterStatus } from "../../src/router/status.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const statusPayload: RouterStatus = {
  router: "test-router",
  providers: {},
  usage: {
    byOrigin: {
      orchestrator: {
        active: 2,
        attempts: 5,
        successes: 4,
        failures: 1,
        averageDurationMs: 12_345,
        toolCalls: 3
      },
      direct: {
        attempts: 3,
        successes: 2,
        failures: 1,
        averageDurationMs: 1500,
        toolCalls: 1
      }
    },
    byRole: {
      worker: {
        attempts: 7,
        successes: 6,
        failures: 1,
        averageDurationMs: 5432,
        toolCalls: 2
      },
      validator: {
        attempts: 2,
        successes: 2,
        failures: 0,
        averageDurationMs: 1000,
        toolCalls: 0
      }
    },
    byModel: {
      "gpt-6": {
        attempts: 10,
        successes: 9,
        failures: 1,
        averageDurationMs: 8765,
        toolCalls: 4
      }
    }
  }
};

async function runStatusCli(
  payload: RouterStatus,
  args: string[] = [],
  entrypoint = "src/cli/router-status.ts"
): Promise<{ stdout: string; stderr: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("mock status server failed to bind");
  }

  try {
    return await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [entrypoint, ...args], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            CODEX_MODEL_ROUTER_HOST: "127.0.0.1",
            CODEX_MODEL_ROUTER_PORT: String(address.port)
          },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve({ stdout, stderr })
            : reject(new Error(`status CLI exited ${code}: ${stderr}`))
        );
      }
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("router status groups usage sections and preserves each row's fields", async () => {
  const { stdout } = await runStatusCli(statusPayload);
  const lines = stdout.split("\n");
  const originHeading = lines.indexOf("Usage by origin:");
  const roleHeading = lines.indexOf("Usage by role:");
  const modelHeading = lines.indexOf("Usage by resolved model:");

  assert.ok(originHeading > 0, "Usage by origin heading must appear");
  assert.equal(lines[originHeading - 1], "");
  assert.match(lines[originHeading - 2] ?? "", /^Concurrency:/);
  assert.equal(roleHeading - originHeading, 3);
  assert.equal(modelHeading - roleHeading, 3);
  assert.deepEqual(lines.slice(originHeading, modelHeading + 2), [
    "Usage by origin:",
    "  orchestrator: 2 active, 5 attempts, 4 successes, 1 failures, avg 12s, 3 tool calls",
    "  direct: 0 active, 3 attempts, 2 successes, 1 failures, avg 2s, 1 tool calls",
    "Usage by role:",
    "  worker: 7 attempts, 6 successes, 1 failures, avg 5s, 2 tool calls",
    "  validator: 2 attempts, 2 successes, 0 failures, avg 1s, 0 tool calls",
    "Usage by resolved model:",
    "  gpt-6: 10 attempts, 9 successes, 1 failures, avg 9s, 4 tool calls"
  ]);
});

test("router status leaves --json output unchanged", async () => {
  const { stdout } = await runStatusCli(statusPayload, ["--json"]);
  assert.deepEqual(JSON.parse(stdout), statusPayload);
});

test("router status retains headings for empty usage buckets", async () => {
  const { stdout } = await runStatusCli({ ...statusPayload, usage: {} });
  const lines = stdout.split("\n");
  const originHeading = lines.indexOf("Usage by origin:");
  const roleHeading = lines.indexOf("Usage by role:");
  const modelHeading = lines.indexOf("Usage by resolved model:");

  assert.ok(originHeading !== -1, "Usage by origin heading must appear");
  assert.equal(roleHeading, originHeading + 1);
  assert.equal(modelHeading, roleHeading + 1);
  assert.deepEqual(lines.slice(originHeading, modelHeading + 1), [
    "Usage by origin:",
    "Usage by role:",
    "Usage by resolved model:"
  ]);
});

test("autodev router status uses the default backend against the configured router", async () => {
  const { stdout } = await runStatusCli(
    statusPayload,
    ["router", "status"],
    "src/cli/autodev.ts"
  );
  assert.deepEqual(JSON.parse(stdout), statusPayload);
});
