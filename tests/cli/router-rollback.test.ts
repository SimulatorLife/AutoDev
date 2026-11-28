import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runMain } from "@simulatorlife/autodev-runtime/cli";
import {
  ingressControlSocketPath,
  ingressControlTokenFile,
  ingressSocketDirectory
} from "@simulatorlife/autodev-runtime/platform";

import {
  generationIdForRelease,
  uniqueGenerationId
} from "../../runtime/src/router/ingress-client.ts";

const TOKEN = "t".repeat(48);

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

/**
A stand-in ingress control socket at the path the installer provisions for
`codexHome`, answering status and rollback the way `ingress-control.ts` does.
*/
async function withIngress(
  status: Record<string, unknown>,
  run: (recorded: Recorded[]) => Promise<void>
): Promise<void> {
  const codexHome = mkdtempSync(path.join(tmpdir(), "rb-"));
  const directory = ingressSocketDirectory(codexHome);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(ingressControlTokenFile(codexHome), TOKEN, { mode: 0o600 });
  const recorded: Recorded[] = [];
  const answer = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const body = await readBody(request);
    recorded.push({
      method: request.method ?? "",
      path: request.url ?? "",
      authorization: request.headers.authorization,
      body
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/v1/status"
          ? status
          : {
              activeGenerationId: (body as { id: string }).id,
              retiringGenerationId: status.activeGenerationId
            }
      )
    );
  };
  const server = createServer((request, response) => {
    void answer(request, response);
  });
  const socket = ingressControlSocketPath(codexHome);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    await run(recorded);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
}

async function captureStdout(run: () => Promise<unknown>): Promise<string> {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  // Only the command's own text: the test runner's reporter shares stdout
  // and writes serialized buffers.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") output.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output.join("");
}

test("router rollback reactivates the retained release through the authenticated control socket", async () => {
  await withIngress(
    {
      ready: true,
      activeGenerationId: "src-new",
      rollbackGenerationId: "src-old",
      generations: [
        { id: "src-old", state: "retired", inFlight: 0 },
        { id: "src-new", state: "active", inFlight: 1 }
      ]
    },
    async (recorded) => {
      let exitCode: unknown;
      const output = await captureStdout(async () => {
        exitCode = await runMain(["router", "rollback"]);
      });
      assert.equal(exitCode, 0);
      assert.deepEqual(JSON.parse(output), {
        activeGenerationId: "src-old.2",
        retiringGenerationId: "src-new"
      });
      assert.deepEqual(
        recorded.map(({ method, path: requestPath }) => [method, requestPath]),
        [
          ["GET", "/v1/status"],
          ["POST", "/v1/rollback"]
        ]
      );
      for (const request of recorded)
        assert.equal(request.authorization, `Bearer ${TOKEN}`);
      // Named after the restored release, unique among live generation ids.
      assert.deepEqual(recorded[1]?.body, { id: "src-old.2" });
    }
  );
});

test("router rollback refuses when the ingress retains no prior generation", async () => {
  await withIngress(
    {
      ready: true,
      activeGenerationId: "src-new",
      rollbackGenerationId: null,
      generations: [{ id: "src-new", state: "active", inFlight: 0 }]
    },
    async (recorded) => {
      await assert.rejects(
        async () => runMain(["router", "rollback"]),
        /retains no prior generation/u
      );
      assert.deepEqual(
        recorded.map((request) => request.path),
        ["/v1/status"]
      );
    }
  );
});

test("router rollback refuses without the installed ingress control secret", async () => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "rb-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    await assert.rejects(
      async () => runMain(["router", "rollback"]),
      /control secret is not installed/u
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("generation ids stay within the ingress grammar and unique among live generations", () => {
  const status = {
    ready: true,
    activeGenerationId: "src-a",
    rollbackGenerationId: null,
    generations: [
      { id: "src-a", state: "active" as const, inFlight: 0 },
      { id: "src-a.2", state: "retired" as const, inFlight: 0 }
    ]
  };
  assert.equal(uniqueGenerationId("src-b", status), "src-b");
  assert.equal(uniqueGenerationId("src-a", status), "src-a.3");
  assert.equal(uniqueGenerationId("../escape", null), "release");
  assert.equal(uniqueGenerationId("x".repeat(200), null), "release");
  assert.equal(
    generationIdForRelease("/home/.codex/.src-a/router/server.ts", status),
    "src-a.3"
  );
});
