import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveOpenLitClickHouseConnection } from "@simulatorlife/autodev-data/openlit";

test("OpenLIT ClickHouse connection reads the private CODEX_HOME credential", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-openlit-data-"));
  const codexHome = path.join(home, "codex");
  try {
    const secret = "private-clickhouse-password";
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      path.join(codexHome, "openlit-secrets.env"),
      `OPENLIT_DB_PASSWORD=${secret}\n`
    );
    const connection = resolveOpenLitClickHouseConnection(
      { codexHome },
      { HOME: home }
    );
    const endpoint = new URL(connection.endpoint);
    assert.equal(connection.clickhouseUrl, "http://127.0.0.1:8123");
    assert.equal(endpoint.searchParams.get("user"), "default");
    assert.equal(endpoint.searchParams.get("password"), secret);
    assert.equal(endpoint.searchParams.get("database"), "openlit");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("explicit ClickHouse options override environment defaults", () => {
  const connection = resolveOpenLitClickHouseConnection(
    {
      clickhouseUrl: "https://clickhouse.example:8443",
      dbUser: "adapter-user",
      dbPassword: "adapter-secret",
      dbName: "adapter-db"
    },
    {
      CLICKHOUSE_URL: "http://environment.example:8123",
      OPENLIT_DB_USER: "environment-user",
      OPENLIT_DB_PASSWORD: "environment-secret",
      OPENLIT_DB_NAME: "environment-db"
    }
  );
  const endpoint = new URL(connection.endpoint);
  assert.equal(connection.clickhouseUrl, "https://clickhouse.example:8443");
  assert.equal(endpoint.searchParams.get("user"), "adapter-user");
  assert.equal(endpoint.searchParams.get("password"), "adapter-secret");
  assert.equal(endpoint.searchParams.get("database"), "adapter-db");
});
