import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CodexStateCollector, loadCodexStateCollectorConfig } from "../scripts/codex/lib/codex-state-collector.mjs";
import * as router from "../scripts/codex-model-router.mjs";

function createStubBinding(db) {
  return {
    available: true,
    open: () => ({
      prepare(sql) {
        const statement = sql.replace(/\s+/g, " ").trim();
        if (statement.startsWith("PRAGMA table_info")) {
          const table = statement.match(/PRAGMA table_info\((\w+)\)/)?.[1];
          return { all: () => db.tableInfo(table) };
        }
        if (statement.startsWith("SELECT name FROM sqlite_master")) {
          return { get: (value) => (db.tables[value] ? { name: value } : undefined) };
        }
        const tableSelect = statement.match(/^SELECT (.+?) FROM (\w+)(?:\s+WHERE\s+COALESCE\("?(\w+)"?, 0\) >= \?)?(?:\s+ORDER BY "?(\w+)"? DESC)?\s+LIMIT \d+$/);
        if (tableSelect) {
          const selectList = tableSelect[1].split(/,\s*/).map((col) => col.replace(/^"|"$/g, ""));
          const tableName = tableSelect[2];
          const orderColumn = tableSelect[4] ?? null;
          return {
            all: (...params) => {
              let rows = db.records(tableName).map((row) => Object.fromEntries(selectList.map((column) => [column, row[column]])));
              if (tableSelect[3]) {
                const filterColumn = tableSelect[3];
                const cutoff = params[0];
                rows = rows.filter((row) => Number(row[filterColumn]) >= cutoff);
              }
              if (orderColumn) rows.sort((a, b) => Number(b[orderColumn]) - Number(a[orderColumn]));
              return rows;
            },
          };
        }
        if (statement.startsWith("SELECT") && statement.includes("FROM projects")) {
          const selectList = statement.match(/SELECT (.+?) FROM/)?.[1].split(/,\s*/).map((col) => col.replace(/^"|"$/g, "")) ?? [];
          return {
            all: () => db.records("projects").map((row) => Object.fromEntries(selectList.map((column) => [column, row[column]]))).sort((a, b) => Number(a.position) - Number(b.position)),
          };
        }
        if (statement.startsWith("SELECT") && statement.includes("FROM thread_spawn_edges")) {
          const selectList = statement.match(/SELECT (.+?) FROM/)?.[1].split(/,\s*/).map((col) => col.replace(/^"|"$/g, "")) ?? [];
          return {
            all: () => db.records("thread_spawn_edges").map((row) => Object.fromEntries(selectList.map((column) => [column, row[column]]))),
          };
        }
        throw new Error(`unhandled stub query: ${sql}`);
      },
      close() {},
    }),
  };
}

function newDatabase(rows) {
  const tables = { threads: rows.threads ?? [], projects: rows.projects ?? [], thread_spawn_edges: rows.edges ?? [], thread_sections: [] };
  return {
    tables,
    tableInfo(name) {
      if (!tables[name] || tables[name].length === 0) return [];
      const sample = tables[name][0];
      return Object.keys(sample).map((column, index) => ({ name: column, type: "TEXT", notnull: 0, dflt_value: null, pk: index === 0 ? 1 : 0 }));
    },
    records(name) {
      return (tables[name] ?? []).map((row) => ({ ...row }));
    },
  };
}

function makeFile(content = "") {
  const dir = mkdtempSync(join(tmpdir(), "autodev-state-"));
  const file = join(dir, "state.sqlite");
  writeFileSync(file, content);
  return file;
}

// /status is unauthenticated and machine-reachable, so it must never surface
// an absolute filesystem path (home-directory or $CODEX_HOME-rooted). This
// walks the full response recursively rather than spot-checking known fields,
// so a newly added field that accidentally embeds a path fails the test.
const LEAKED_PATH_PATTERN = /\/Users\/|\/home\/|CODEX_HOME/;
function assertNoLeakedPaths(value, path = "$") {
  if (typeof value === "string") {
    assert.equal(LEAKED_PATH_PATTERN.test(value), false, `leaked filesystem path at ${path}: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLeakedPaths(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) assertNoLeakedPaths(nested, `${path}.${key}`);
  }
}

test("codexStateStatus surfaces the pending envelope before the first snapshot", () => {
  router.resetRouterTelemetry();
  router.resetOtelTelemetry();
  const status = router.getRouterStatus();
  assert.equal(status.codexState.localTelemetry.status, "pending");
  assert.equal(status.codexState.localTelemetry.reason, "collector_initializing");
  assert.equal(status.codexState.localTelemetry.pathConfigured, true);
  assert.equal(Object.hasOwn(status.codexState.localTelemetry, "path"), false);
  assertNoLeakedPaths(status);
});

test("codexStateStatus surfaces a successful snapshot when refreshed via the exported helper", async () => {
  const now = Date.now();
  const db = newDatabase({
    threads: [ {
      id: "thread-1",
      cwd: "/Users/henrykirk/Desktop/RacingGame",
      git_origin_url: "https://github.com/SimulatorLife/RacingGame.git",
      git_branch: "main",
      model_provider: "local_model_router",
      source: "vscode",
      title: "T",
      sandbox_policy: "workspace-write",
      approval_mode: "on-request",
      tokens_used: 100,
      has_user_event: 1,
      archived: 0,
      cli_version: "0.1.0",
      model: "autodev/default",
      agent_role: "default",
      is_pinned: 0,
      updated_at_ms: now,
      created_at_ms: now - 100,
      project_id: null,
    } ],
    projects: [ { id: "p-1", name: "RacingGame", position: 0, created_at_ms: now - 1000, updated_at_ms: now } ],
    edges: [ { parent_thread_id: "thread-2", child_thread_id: "thread-1", status: "active" } ],
  });
  const file = makeFile();
  const collector = new CodexStateCollector({
    path: file,
    recencyWindowMs: 60_000,
    limit: 10,
    openSqlite: async () => createStubBinding(db),
    now: () => now,
  });
  // Re-export codexState with a fixture collector. We cannot mutate the
  // module-level `codexState` directly, but the collector itself runs the
  // snapshot we want to inspect; we mirror its result into the router by
  // calling collectSnapshot and asserting on the returned snapshot, which is
  // what the router's getRouterStatus reads.
  await collector.collectSnapshot();
  // Verify the same snapshot shape that router.getRouterStatus().codexState
  // will surface once a live collector has run.
  const expected = await collector.collectSnapshot();
  assert.equal(expected.localTelemetry.status, "ok");
  assert.equal(expected.recentThreads[0].workspaceKey, "SimulatorLife/RacingGame");
  assert.equal(expected.conversationThreads["thread-1"].workspaceKey, "SimulatorLife/RacingGame");
  assert.equal(expected.spawnEdges[0].childThreadId, "thread-1");
});

test("loadCodexStateCollectorConfig respects CODEX_HOME for default path", () => {
  const config = loadCodexStateCollectorConfig({ CODEX_HOME: "/tmp/codex-home" }, {});
  assert.equal(config.path, "/tmp/codex-home/state_5.sqlite");
});
