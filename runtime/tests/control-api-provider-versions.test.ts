import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  handleControlApiRequest,
  setControlApiProviderCliVersionSource
} from "../src/control-api/index.ts";
import { ProviderCliVersionService } from "../src/providers/cli-versions.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "provider-versions-secret-token-0123456789abcdef";
const OPERATOR_ACTOR = "provider-operator";

interface ProviderVersionEntry {
  readonly provider: string;
  readonly cli: {
    readonly status: string;
    readonly kind?: string;
    readonly command: string | null;
    readonly version?: string;
    readonly reason?: string;
    readonly observedAt?: string;
  };
}

function request(method: string, url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method,
    url,
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-autodev-actor": OPERATOR_ACTOR
    }
  }) as unknown as IncomingMessage;
}

async function readVersions(): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}> {
  const response = responseRecorder();
  await handleControlApiRequest(
    request("GET", "/control/provider-versions"),
    response,
    "/control/provider-versions"
  );
  let parsed: Record<string, unknown> | null = null;
  if (response.body) {
    try {
      parsed = JSON.parse(response.body) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  return { status: response.statusCode, body: parsed };
}

test("a Runtime that has not read the versions says so for every provider", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  setControlApiProviderCliVersionSource(null);
  try {
    const read = await readVersions();
    assert.equal(read.status, 200);
    assert.equal(read.body?.schema, "autodev-control-provider-versions-v1");
    assert.equal(read.body?.source, "runtime-provider-cli-versions");
    const providers = read.body?.providers as ProviderVersionEntry[];
    assert.ok(providers.length > 0);
    for (const entry of providers) {
      // No version was read, so none is reported. An empty version would read
      // as "the CLI is on version nothing", which is not a thing.
      assert.equal(entry.cli.status, "unavailable");
      assert.equal(entry.cli.version, undefined);
      assert.equal(
        entry.cli.reason,
        "Runtime has not started provider CLI version discovery."
      );
    }
  } finally {
    if (previousToken === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  }
});

test("the versions read carries the version the Runtime observed", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  const service = new ProviderCliVersionService({
    providerIds: () => ["claude"],
    locate: () => ({
      command: "claude",
      program: "/opt/bin/claude",
      args: []
    }),
    capture: () => Promise.resolve({ ok: true, version: "2.1.280" }),
    now: () => new Date("2026-11-09T12:00:00.000Z")
  });
  await service.refresh();
  setControlApiProviderCliVersionSource(() => service.snapshot());
  try {
    const read = await readVersions();
    assert.equal(read.status, 200);
    const providers = read.body?.providers as ProviderVersionEntry[];
    const claude = providers.find((entry) => entry.provider === "claude");
    assert.equal(claude?.cli.status, "observed");
    assert.equal(claude?.cli.command, "claude");
    assert.equal(claude?.cli.version, "2.1.280");
    assert.equal(claude?.cli.observedAt, "2026-11-09T12:00:00.000Z");
  } finally {
    setControlApiProviderCliVersionSource(null);
    if (previousToken === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  }
});
