/**
 * Focused tests for the one owner of AutoDev's OTLP exporter configuration.
 *
 * The Router and the Codex tools MCP shim are separate processes that install
 * the official OTLP HTTP exporter, and they read the same operator-facing
 * environment: a generic endpoint or a signal-specific endpoint, plus the
 * headers that authenticate the export. The parsing of that environment has
 * exactly one implementation, so these tests pin the owner's behavior and pin
 * the ownership itself -- no other module under `runtime/src` may read an
 * OTLP exporter variable, because a second copy is exactly how the two
 * producers would drift apart.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseOtlpHeaders,
  readOtlpHeaders,
  readOtlpMetricEndpoint,
  readOtlpTraceEndpoint,
  resolveOtlpSignalEndpoint
} from "@simulatorlife/autodev-runtime/telemetry/otlp-config";

const PATH_COLLATOR = new Intl.Collator("en");
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNTIME_SRC = join(REPO_ROOT, "runtime/src");
const OWNER_PATH = "runtime/src/telemetry/otlp-config.ts";
const PRODUCERS = [
  "runtime/src/router/telemetry.ts",
  "runtime/src/mcp/mcp-telemetry.ts"
];

async function runtimeSourceFiles(): Promise<string[]> {
  const entries = await readdir(RUNTIME_SRC, {
    recursive: true,
    withFileTypes: true
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

test("a generic OTLP endpoint resolves to distinct signal paths", () => {
  assert.equal(
    resolveOtlpSignalEndpoint("http://127.0.0.1:4318/", "traces"),
    "http://127.0.0.1:4318/v1/traces"
  );
  assert.equal(
    resolveOtlpSignalEndpoint("http://127.0.0.1:4318/v1/logs", "metrics"),
    "http://127.0.0.1:4318/v1/metrics"
  );
  assert.equal(resolveOtlpSignalEndpoint("not-a-url", "metrics"), null);
});

test("the signal-specific endpoint wins over the generic endpoint", () => {
  const environment = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4319/v1/traces",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4319/v1/metrics"
  };
  assert.equal(
    readOtlpTraceEndpoint(environment),
    "http://127.0.0.1:4319/v1/traces"
  );
  assert.equal(
    readOtlpMetricEndpoint(environment),
    "http://127.0.0.1:4319/v1/metrics"
  );
});

test("an unconfigured signal has no endpoint to export to", () => {
  assert.equal(readOtlpTraceEndpoint({}), null);
  assert.equal(readOtlpMetricEndpoint({}), null);
  assert.equal(
    readOtlpTraceEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: " ".repeat(3),
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "  "
    }),
    null
  );
});

test("the generic endpoint is resolved per signal when no signal endpoint is set", () => {
  const environment = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/" };
  assert.equal(
    readOtlpTraceEndpoint(environment),
    "http://127.0.0.1:4318/v1/traces"
  );
  assert.equal(
    readOtlpMetricEndpoint(environment),
    "http://127.0.0.1:4318/v1/metrics"
  );
});

test("export headers are parsed, percent-decoded, and kept verbatim when undecodable", () => {
  assert.deepEqual(
    parseOtlpHeaders("authorization=Bearer%20token", "x-tenant=acme"),
    { authorization: "Bearer token", "x-tenant": "acme" }
  );
  assert.deepEqual(parseOtlpHeaders("x-tenant=100%"), { "x-tenant": "100%" });
  assert.deepEqual(parseOtlpHeaders("=orphan,novalue=,good=1"), { good: "1" });
  assert.deepEqual(parseOtlpHeaders(undefined, ""), {});
});

test("the signal-specific headers win over the shared headers", () => {
  const environment = {
    OTEL_EXPORTER_OTLP_HEADERS: "x-source=shared,x-shared=kept",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-source=traces",
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: "x-source=metrics"
  };
  assert.deepEqual(readOtlpHeaders("traces", environment), {
    "x-source": "traces",
    "x-shared": "kept"
  });
  assert.deepEqual(readOtlpHeaders("metrics", environment), {
    "x-source": "metrics",
    "x-shared": "kept"
  });
});

test("only the OTLP configuration owner reads the exporter environment", async () => {
  const readers: string[] = [];
  const files = await runtimeSourceFiles();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (/\.OTEL_EXPORTER_OTLP/u.test(source)) {
      readers.push(relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(readers.sort(PATH_COLLATOR.compare), [OWNER_PATH]);
});

test("every OTLP producer reads its configuration from the owner", async () => {
  for (const producer of PRODUCERS) {
    const source = await readFile(join(REPO_ROOT, producer), "utf8");
    assert.match(
      source,
      /from "@simulatorlife\/autodev-runtime\/telemetry\/otlp-config"/u,
      `${producer} must read its OTLP configuration from the owner`
    );
  }
});
