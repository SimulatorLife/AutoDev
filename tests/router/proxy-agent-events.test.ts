import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const proxyModule = "@simulatorlife/autodev-runtime/router/proxy";

test("downstream bridge headers use the configured router listener URL", () => {
  const host = "localhost";
  const port = "43217";
  const script = `
    const { downstreamHeaders } = await import(${JSON.stringify(proxyModule)});
    const headers = downstreamHeaders(
      { provider: "claude" },
      null,
      null,
      null,
      "request-1"
    );
    process.stdout.write(headers["x-autodev-agent-events-url"] ?? "");
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_MODEL_ROUTER_HOST: host,
        CODEX_MODEL_ROUTER_PORT: port
      }
    }
  );

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `http://${host}:${port}/v1/agent-events`);
});
