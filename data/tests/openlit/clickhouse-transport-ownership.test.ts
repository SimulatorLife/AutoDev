import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dataRoot = path.join(repositoryRoot, "data/src");
const clientModule = "data/src/clickhouse/clickhouse-client.ts";

function collectTypeScript(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectTypeScript(absolute, found);
    else if (entry.name.endsWith(".ts")) found.push(absolute);
  }
  return found;
}

const dataSources = collectTypeScript(dataRoot).map((file) => ({
  path: path.relative(repositoryRoot, file),
  source: readFileSync(file, "utf8")
}));

test("the Data sources are the domain this rule governs", () => {
  assert.ok(
    dataSources.length > 15,
    `expected the whole Data package to be scanned, found ${dataSources.length} files`
  );
  assert.ok(
    dataSources.some((file) => file.path === clientModule),
    `the ClickHouse client this rule centres on must exist at ${clientModule}`
  );
  for (const adapter of ["data/src/openlit/sync-rulesync-models.ts"]) {
    assert.ok(
      dataSources.some((file) => file.path === adapter),
      `the ${adapter} adapter this rule governs must exist`
    );
  }
});

test("no adapter assembles a ClickHouse request of its own", () => {
  // The catalog tables are the one projection left, and it has a protocol of
  // its own: `FORMAT JSONEachRow` reads and `application/x-ndjson` writes.
  // That protocol is the adapter's business; the request itself -- the URL,
  // the content type, the ceiling, the error -- belongs to the shared client.
  // An adapter that calls `fetch` itself has taken that back, and a second
  // place that decides how a request is made is a second way for it to be
  // wrong.
  const adapters = dataSources.filter((file) => file.path !== clientModule);
  assert.ok(
    adapters.length > 15,
    "expected the whole Data package to be scanned"
  );

  for (const adapter of adapters) {
    assert.doesNotMatch(
      adapter.source,
      /\bfetch\s*\(/u,
      `${adapter.path} must go through the shared ClickHouse client, not call fetch itself`
    );
  }
});
