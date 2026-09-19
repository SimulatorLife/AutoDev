import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runner = join(
  repositoryRoot,
  "scripts/otel/run-autodev-otel-collector.sh"
);
const fixturePath = join(
  repositoryRoot,
  "tests/fixtures/otel/collector-forwarded-otlp.json"
);
const configuredBinary = process.env.AUTODEV_OTELCOL_BIN ?? null;

type JsonObject = Record<string, unknown>;
type Forwarded = { path: string; body: string };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not determine free port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForPort(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const socket = createConnection({ host, port });
      await once(socket, "connect");
      socket.destroy();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Collector did not bind ${host}:${port}`);
}

function replaceFixtureTimes(value: string): string {
  return value
    .replaceAll("__OTEL_T0__", "1700000000000000000")
    .replaceAll("__OTEL_T500MS__", "1700000000500000000")
    .replaceAll("__OTEL_T900MS__", "1700000000900000000")
    .replaceAll("__OTEL_T1200MS__", "1700000001200000000")
    .replaceAll("__OTEL_T2S__", "1700000002000000000")
    .replaceAll("__OTEL_T6MS__", "1700000000006000000")
    .replaceAll("__OTEL_T13MS__", "1700000000013000000")
    .replaceAll("__OTEL_T20MS__", "1700000000020000000");
}

async function post(
  port: number,
  path: string,
  payload: unknown
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(
    response.status,
    200,
    `Collector returned HTTP ${response.status} for ${path}`
  );
}

// The live smoke test needs the pinned Collector binary; without an
// executable one it is skipped with the reason, never silently passed.
function collectorSkipReason(binary: string | null): string | false {
  if (!binary)
    return "set AUTODEV_OTELCOL_BIN to the pinned v0.160.0 binary for the live Collector smoke test";
  try {
    accessSync(binary, fsConstants.X_OK);
  } catch {
    return `Collector binary is not executable: ${binary}`;
  }
  return false;
}

test(
  "the pinned Collector forwards all signals without prompt logging",
  { skip: collectorSkipReason(configuredBinary) },
  async () => {
  const binary = configuredBinary!;
  const temporary = mkdtempSync(join(tmpdir(), "autodev-otel-integration-"));
  const receiverPort = await freePort();
  const collectorPort = await freePort();
  const config = join(temporary, "collector.yaml");
  writeFileSync(
    config,
    readFileSync(join(repositoryRoot, "config/otel/collector.yaml"), "utf8")
      .replaceAll("127.0.0.1:4318", `127.0.0.1:${collectorPort}`)
      .replaceAll("127.0.0.1:4100", `127.0.0.1:${receiverPort}`)
  );
  const forwarded: Forwarded[] = [];
  const receiver = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        forwarded.push({
          path: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8")
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    }
  );
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(receiverPort, "127.0.0.1", () => resolve());
  });
  const environment = {
    ...process.env,
    AUTODEV_OTELCOL_BIN: binary,
    AUTODEV_OTEL_CONFIG: config,
    AUTODEV_OTEL_VERSION_FILE: join(
      repositoryRoot,
      "config/otel/collector.version"
    ),
    AUTODEV_OTEL_HOST: "127.0.0.1",
    AUTODEV_OTEL_PORT: String(collectorPort)
  };
  const processHandle = spawn(runner, [], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForPort("127.0.0.1", collectorPort);
    const fixture = JSON.parse(
      replaceFixtureTimes(readFileSync(fixturePath, "utf8"))
    ) as JsonObject;
    for (const [path, key] of [
      ["/v1/logs", "logs"],
      ["/v1/traces", "traces"],
      ["/v1/metrics", "metrics"]
    ] as const)
      await post(collectorPort, path, fixture[key]);
    await post(collectorPort, "/v1/metrics", fixture.metrics);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(forwarded.map((entry) => entry.path).sort(), [
      "/v1/logs",
      "/v1/metrics",
      "/v1/metrics",
      "/v1/traces"
    ]);
  } finally {
    processHandle.kill("SIGTERM");
    await once(processHandle, "close").catch(() => undefined);
    const stderr = processHandle.stderr?.read()?.toString("utf8") ?? "";
    assert.doesNotMatch(stderr, /do-not-store-this-collector-forwarded-secret/);
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
  }
);
