import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CodexStateCollector, loadCodexStateCollectorConfig } from "../scripts/codex/lib/codex-state-collector.mjs";

// A minimal in-memory stub of the `node:sqlite` binding. The collector only
// needs `prepare(...).all()` to return rows and `prepare(...).get()` to return
// a single row, both of which the test scenarios drive explicitly. The shape
// matches Codex's `state_5.sqlite` tables that the collector introspects.
function createInMemoryDatabase() {
  const tables = {
    threads: [],
    projects: [],
    thread_spawn_edges: [],
    thread_sections: [],
  };
  function tableInfo(name) {
    if (!tables[name]) return [];
    const rows = tables[name];
    if (rows.length === 0) {
      return [
        { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "position", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { name: "created_at_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { name: "updated_at_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      ];
    }
    const sample = rows[0];
    return Object.keys(sample).map((column, index) => ({ name: column, type: "TEXT", notnull: 0, dflt_value: null, pk: index === 0 ? 1 : 0 }));
  }
  function records(name) {
    if (!tables[name]) return [];
    return tables[name].map((row) => ({ ...row }));
  }
  return {
    tables,
    tableInfo,
    records,
    addThread(row) { tables.threads.push({ ...row }); },
    addProject(row) { tables.projects.push({ ...row }); },
    addEdge(row) { tables.thread_spawn_edges.push({ ...row }); },
  };
}

function fakeSqliteBinding(db) {
  return {
    available: true,
    open: () => ({
      prepare(sql) {
        const statement = sql.replace(/\s+/g, " ").trim();
        const tableMatch = statement.match(/^PRAGMA table_info\((\w+)\)/);
        if (tableMatch) {
          return {
            all: () => db.tableInfo(tableMatch[1]),
          };
        }
        const existsMatch = statement.match(/^SELECT name FROM sqlite_master WHERE type = 'table' AND name = \?$/);
        if (existsMatch) {
          return {
            get: (name) => (db.tables[name] ? { name } : undefined),
          };
        }
        const columnsMatch = statement.match(/^SELECT (.+?) FROM (\w+)(?:\s+WHERE\s+COALESCE\("?(\w+)"?, 0\) >= \?)?(?:\s+ORDER BY "?(\w+)"? DESC)?\s+LIMIT \d+$/);
        if (columnsMatch) {
          const selectList = columnsMatch[1].split(/,\s*/).map((col) => col.replace(/^"|"$/g, ""));
          const tableName = columnsMatch[2];
          const orderColumn = columnsMatch[4] ?? null;
          return {
            all: (...params) => {
              let rows = db.records(tableName).map((row) => Object.fromEntries(selectList.map((column) => [column, row[column]])));
              if (columnsMatch[3]) {
                const filterColumn = columnsMatch[3];
                const cutoff = params[0];
                rows = rows.filter((row) => Number(row[filterColumn]) >= cutoff);
              }
              if (orderColumn) {
                rows.sort((a, b) => Number(b[orderColumn]) - Number(a[orderColumn]));
              }
              return rows;
            },
          };
        }
        const projectsQuery = statement.match(/^SELECT (.+?) FROM projects ORDER BY position ASC$/);
        if (projectsQuery) {
          const selectList = projectsQuery[1].split(/,\s*/).map((col) => col.replace(/^"|"$/g, ""));
          return {
            all: () => db.records("projects").map((row) => Object.fromEntries(selectList.map((column) => [column, row[column]]))).sort((a, b) => Number(a.position) - Number(b.position)),
          };
        }
        const edgesQuery = statement.match(/^SELECT (.+?) FROM thread_spawn_edges$/);
        if (edgesQuery) {
          const selectList = edgesQuery[1].split(/,\s*/).map((col) => col.replace(/^"|"$/g, ""));
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

test("loadCodexStateCollectorConfig returns defaults and parses overrides", () => {
  const defaults = loadCodexStateCollectorConfig({}, {});
  assert.ok(typeof defaults.path === "string");
  assert.equal(defaults.recencyWindowMs > 0, true);
  assert.equal(defaults.limit > 0, true);
  const overrides = loadCodexStateCollectorConfig({
    CODEX_STATE_DB_PATH: "/tmp/test.sqlite",
    CODEX_STATE_COLLECTOR_WINDOW_MS: "1234",
    CODEX_STATE_COLLECTOR_LIMIT: "12",
    CODEX_STATE_COLLECTOR_POLL_MS: "600",
  }, {});
  assert.equal(overrides.path, "/tmp/test.sqlite");
  assert.equal(overrides.recencyWindowMs, 1234);
  assert.equal(overrides.limit, 12);
  assert.equal(overrides.pollIntervalMs, 600);
});

test("collector reports `missing` when the configured file does not exist", async () => {
  const collector = new CodexStateCollector({ path: "/nonexistent/state.sqlite", openSqlite: async () => fakeSqliteBinding(createInMemoryDatabase()) });
  const snapshot = await collector.collectSnapshot();
  assert.equal(snapshot.localTelemetry.status, "missing");
  assert.equal(snapshot.localTelemetry.reason, "file_not_found");
});

test("collector reports `error` when the binding throws", async () => {
  const collector = new CodexStateCollector({
    path: "/dev/null/error.sqlite",
    openSqlite: async () => ({ available: true, open: () => { throw new Error("boom"); } }),
  });
  // Provide a real (empty) file so existsSync returns true; the binding throw
  // is the failure mode under test, not the missing-file branch.
  writeFileSync("/tmp/state-collector-error.sqlite", "");
  collector.path = "/tmp/state-collector-error.sqlite";
  const snapshot = await collector.collectSnapshot();
  assert.equal(snapshot.localTelemetry.status, "error");
  assert.match(snapshot.localTelemetry.reason, /boom/);
});

test("collector reports `schema_only` when node:sqlite is unavailable", async () => {
  const collector = new CodexStateCollector({ path: "/tmp/state-collector-stub.sqlite", openSqlite: async () => ({ available: false }) });
  writeFileSync("/tmp/state-collector-stub.sqlite", "");
  collector.path = "/tmp/state-collector-stub.sqlite";
  const snapshot = await collector.collectSnapshot();
  assert.equal(snapshot.localTelemetry.status, "schema_only");
  assert.equal(snapshot.localTelemetry.reason, "node_sqlite_unavailable");
});

test("collector introspects an in-memory state_5.sqlite and produces a normalized snapshot", async () => {
  const db = createInMemoryDatabase();
  const now = Date.now();
  db.addProject({ id: "proj-A", name: "RacingGame", position: 0, created_at_ms: now - 1000, updated_at_ms: now - 100 });
  db.addProject({ id: "proj-B", name: "AutoDev", position: 1, created_at_ms: now - 2000, updated_at_ms: now - 200 });
  db.addThread({
    id: "thread-1",
    cwd: "/Users/henrykirk/Desktop/RacingGame",
    git_origin_url: "https://github.com/SimulatorLife/RacingGame.git",
    git_branch: "main",
    model_provider: "local_model_router",
    source: "vscode",
    title: "Test",
    sandbox_policy: "workspace-write",
    approval_mode: "on-request",
    tokens_used: 1000,
    has_user_event: 1,
    archived: 0,
    cli_version: "0.1.0",
    model: "gpt-5.6-luna",
    agent_role: "default",
    is_pinned: 0,
    updated_at_ms: now,
    created_at_ms: now - 500,
    project_id: "proj-A",
  });
  db.addThread({
    id: "thread-2",
    cwd: "/Users/henrykirk/Desktop/AutoDev",
    git_origin_url: "git@github.com:SimulatorLife/AutoDev.git",
    git_branch: "main",
    model_provider: "local_model_router",
    source: "vscode",
    title: "Test 2",
    sandbox_policy: "workspace-write",
    approval_mode: "on-request",
    tokens_used: 5,
    has_user_event: 1,
    archived: 0,
    cli_version: "0.1.0",
    model: "gpt-5.6-luna",
    agent_role: "smart",
    is_pinned: 1,
    updated_at_ms: now - 100,
    created_at_ms: now - 1000,
    project_id: "proj-B",
  });
  db.addEdge({ parent_thread_id: "thread-2", child_thread_id: "thread-1", status: "active" });

  const collector = new CodexStateCollector({
    path: "/tmp/state-collector-ok.sqlite",
    recencyWindowMs: 60_000,
    limit: 10,
    openSqlite: async () => fakeSqliteBinding(db),
    now: () => now,
  });
  // The collector reads `existsSync(path)` which would refuse /tmp files.
  // Use a deterministic file path that always exists.
  const file = join(mkdtempSync(join(tmpdir(), "codex-state-")), "state.sqlite");
  writeFileSync(file, "");
  collector.path = file;
  const snapshot = await collector.collectSnapshot();

  assert.equal(snapshot.localTelemetry.status, "ok");
  assert.equal(snapshot.threadCount, 2);
  assert.equal(snapshot.projectCount, 2);
  assert.equal(snapshot.edgeCount, 1);
  // Workspace identity lines up with the privacy-safe `owner/repository`
  // label the router already uses.
  const racingThread = snapshot.recentThreads.find((thread) => thread.id === "thread-1");
  assert.equal(racingThread.workspaceKey, "SimulatorLife/RacingGame");
  assert.equal(racingThread.repository, "SimulatorLife/RacingGame");
  assert.equal(racingThread.cwdBasename, "RacingGame");
  assert.equal(racingThread.project.name, "RacingGame");
  assert.equal(racingThread.gitOriginUrl, "SimulatorLife/RacingGame");
  assert.equal(snapshot.conversationThreads["thread-1"].workspaceKey, "SimulatorLife/RacingGame");
  assert.equal(snapshot.spawnEdges[0].parentThreadId, "thread-2");
  assert.equal(snapshot.spawnEdges[0].childThreadId, "thread-1");
  // The collector hashes path-like workspace_ids into `ws_` digests; raw
  // absolute paths must never leak into the snapshot.
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("/Users/henrykirk"), false);
});

test("collector hashes path-like workspace IDs and reports a stable schema fingerprint", async () => {
  const db = createInMemoryDatabase();
  const now = Date.now();
  db.addThread({
    id: "thread-secret",
    cwd: "/Users/henrykirk/Desktop/SecretProject",
    git_origin_url: "https://github.com/Confidential/SecretProject.git",
    model_provider: "local_model_router",
    source: "vscode",
    title: "Secret",
    sandbox_policy: "workspace-write",
    approval_mode: "on-request",
    tokens_used: 0,
    has_user_event: 1,
    archived: 0,
    cli_version: "0.1.0",
    model: "autodev/default",
    is_pinned: 0,
    updated_at_ms: now,
    created_at_ms: now,
    project_id: null,
  });
  const collector = new CodexStateCollector({
    path: "/tmp/state-collector-schema.sqlite",
    recencyWindowMs: 60_000,
    limit: 5,
    openSqlite: async () => fakeSqliteBinding(db),
    now: () => now,
  });
  const file = join(mkdtempSync(join(tmpdir(), "codex-state-")), "state.sqlite");
  writeFileSync(file, "");
  collector.path = file;
  const snapshot = await collector.collectSnapshot();
  assert.equal(snapshot.schema.startsWith("autodev-codex-state-collector-v1-"), true);
  assert.equal(snapshot.recentThreads[0].workspaceKey, "Confidential/SecretProject");
  const reserialized = JSON.stringify(snapshot);
  assert.equal(reserialized.includes("/Users/henrykirk"), false);
});

test("live poll delivers subsequent snapshots to subscribers without blocking", async () => {
  const db = createInMemoryDatabase();
  const now = Date.now();
  db.addThread({ id: "t-1", cwd: "/Users/henrykirk/Desktop/RacingGame", git_origin_url: "https://github.com/SimulatorLife/RacingGame.git", model_provider: "local_model_router", source: "vscode", title: "T", sandbox_policy: "workspace-write", approval_mode: "on-request", tokens_used: 0, has_user_event: 1, archived: 0, cli_version: "0", model: "gpt-5.6-luna", agent_role: "default", is_pinned: 0, updated_at_ms: now, created_at_ms: now, project_id: null });
  const collector = new CodexStateCollector({
    path: "/tmp/state-collector-poll.sqlite",
    recencyWindowMs: 60_000,
    limit: 5,
    pollIntervalMs: 50,
    openSqlite: async () => fakeSqliteBinding(db),
    now: () => now,
  });
  const file = join(mkdtempSync(join(tmpdir(), "codex-state-")), "state.sqlite");
  writeFileSync(file, "");
  collector.path = file;
  let received = 0;
  collector.startLivePoll({ onSnapshot: () => { received += 1; } });
  await new Promise((resolve) => setTimeout(resolve, 700));
  collector.stopLivePoll();
  assert.ok(received >= 1, "subscriber must be invoked at least once by the poll");
});
