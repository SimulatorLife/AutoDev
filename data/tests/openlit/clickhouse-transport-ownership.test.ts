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

const declaresJsonInsert = (source: string): boolean =>
  source.includes(`"Content-Type": "application/json"`) &&
  source.includes("INSERT INTO");

test("the Data sources are the domain this rule governs", () => {
  assert.ok(
    dataSources.length > 15,
    `expected the whole Data package to be scanned, found ${dataSources.length} files`
  );
  assert.ok(
    dataSources.some((file) => file.path === clientModule),
    `the ClickHouse client this rule centres on must exist at ${clientModule}`
  );
  for (const adapter of [
    "data/src/openlit/sync-rulesync-agents.ts",
    "data/src/openlit/sync-rulesync-prompts.ts"
  ]) {
    assert.ok(
      dataSources.some((file) => file.path === adapter),
      `the ${adapter} adapter this rule governs must exist`
    );
  }
});

test("the JSON-bodied ClickHouse insert protocol has exactly one owner", () => {
  const owners = dataSources
    .filter((file) => declaresJsonInsert(file.source))
    .map((file) => file.path);

  assert.deepEqual(
    owners,
    [clientModule],
    `every adapter posting newline-terminated JSONEachRow to ClickHouse must call the shared insert; the request is hand-built in ${owners.join(", ")}`
  );
});

test("the shared ClickHouse wire helpers have exactly one declaration each", () => {
  const helpers = ["selectRows", "insertRows", "removeStaleRows"];
  const owners = new Map<string, string[]>();

  for (const file of dataSources) {
    for (const helper of helpers) {
      // Generics sit between the name and the parameter list, so match past them.
      const declaration = new RegExp(
        String.raw`^(?:export )?(?:async )?function ${helper}(?:<[\w, <>]*>)?\(`,
        "mu"
      );
      if (declaration.test(file.source)) {
        owners.set(helper, [...(owners.get(helper) ?? []), file.path]);
      }
    }
  }

  assert.deepEqual(
    helpers.map((helper) => [helper, owners.get(helper)]),
    helpers.map((helper) => [helper, [clientModule]]),
    "each ClickHouse wire helper must have exactly one owner"
  );
});
