import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryScope } from "@simulatorlife/autodev-core";

import { MemoryHydrationError } from "../../src/memory/errors.ts";
import {
  buildExperienceScopeFilterSql,
  buildScopeFilterSql,
  columnsToScope,
  SCOPE_COLUMNS,
  scopeToColumns,
  SqlParams
} from "../../src/memory/scope-sql.ts";
import { makeContext } from "./fixtures/builders.ts";

const TABLE = "memory_experiences";

/**
 * Split a disjunction into its top-level clauses. The role clause contains an
 * inner `(... IS NULL OR ... = $3)`, so a plain `split(" OR ")` would tear it in
 * half; only separators at depth zero separate scope clauses.
 */
function scopeClauses(sql: string): string[] {
  const inner =
    sql.startsWith("(") && sql.endsWith(")") ? sql.slice(1, -1) : sql;
  const clauses: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]!;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && inner.startsWith(" OR ", index)) {
      clauses.push(current);
      current = "";
      index += 3;
      continue;
    }
    current += character;
  }
  clauses.push(current);
  return clauses;
}

/** Every kind the flattened scope columns can represent. */
const SCOPES: readonly MemoryScope[] = [
  { kind: "global" },
  { kind: "workspace", workspaceId: "ws-1" },
  { kind: "repository", workspaceId: "ws-1", repositoryId: "repo-1" },
  { kind: "role", workspaceId: "ws-1", role: "worker", repositoryId: "repo-1" },
  { kind: "role", workspaceId: "ws-1", role: "worker" },
  { kind: "task", workspaceId: "ws-1", taskId: "task-1", runId: "run-1" },
  {
    kind: "agent",
    workspaceId: "ws-1",
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1"
  }
];

test("every scope kind survives the write/read round trip", () => {
  for (const scope of SCOPES) {
    const restored = columnsToScope(TABLE, scopeToColumns(scope));
    assert.deepEqual(
      restored,
      scope,
      `${scope.kind} scope must read back exactly as it was written`
    );
  }
});

test("a global scope is written without any workspace constraint", () => {
  const columns = scopeToColumns({ kind: "global" });
  assert.equal(columns.scope_kind, "global");
  // The global kind is the only scope with no workspace, so it must not carry
  // one: a stale workspace id here would make a global row invisible to every
  // reader, and a global row that matched a workspace predicate would be
  // readable by a caller that was never granted it.
  for (const column of [
    "scope_workspace_id",
    "scope_repository_id",
    "scope_role",
    "scope_task_id",
    "scope_run_id",
    "scope_agent_id"
  ] as const) {
    assert.equal(
      columns[column],
      null,
      `${column} must be null for a global row`
    );
  }
  assert.deepEqual(columnsToScope(TABLE, columns), { kind: "global" });
});

test("a role scope without a repository round-trips without inventing one", () => {
  const columns = scopeToColumns({
    kind: "role",
    workspaceId: "ws-1",
    role: "worker"
  });
  assert.equal(columns.scope_repository_id, null);
  assert.equal(columns.scope_role, "worker");
  // `repositoryId` is optional on this kind only. Reading it back must omit the
  // key entirely rather than carry an empty string, because the visibility
  // predicate compares the column to the caller's repository id.
  const restored = columnsToScope(TABLE, columns);
  assert.deepEqual(restored, {
    kind: "role",
    workspaceId: "ws-1",
    role: "worker"
  });
  assert.ok(
    !("repositoryId" in restored),
    "an absent repository must not be reconstructed as a present empty one"
  );
});

test("an agent scope records only the columns it owns", () => {
  const columns = scopeToColumns({
    kind: "agent",
    workspaceId: "ws-1",
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1"
  });
  assert.equal(columns.scope_repository_id, null);
  assert.equal(columns.scope_role, null);
  assert.equal(columns.scope_agent_id, "agent-1");
});

test("an unknown scope kind is refused in both directions", () => {
  const unknown = {
    kind: "team",
    workspaceId: "ws-1"
  } as unknown as MemoryScope;
  assert.throws(() => scopeToColumns(unknown), /Unhandled MemoryScope kind/u);
  assert.throws(
    () => columnsToScope(TABLE, { scope_kind: "team" }),
    (error: unknown) => {
      assert.ok(error instanceof MemoryHydrationError);
      assert.match(error.message, /memory_experiences\.scope_kind/u);
      assert.match(error.message, /unsupported value team/u);
      return true;
    }
  );
});

test("a malformed scope column is refused instead of becoming undefined", () => {
  // A missing, empty, or non-string identity column must fail loudly. Silently
  // coercing it to `undefined` would put an undefined into a scope field that
  // the visibility predicate compares, which is how a row stops belonging to
  // the caller that owns it.
  for (const bad of [undefined, "", 7, null]) {
    assert.throws(
      () =>
        columnsToScope(TABLE, {
          scope_kind: "agent",
          scope_workspace_id: "ws-1",
          scope_task_id: "task-1",
          scope_run_id: "run-1",
          scope_agent_id: bad
        }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryHydrationError);
        assert.match(
          error.message,
          /Invalid memory_experiences\.scope_agent_id: expected a non-empty string/u
        );
        return true;
      },
      `scope_agent_id=${JSON.stringify(bad)} must be rejected`
    );
  }
});

test("SqlParams numbers placeholders densely in insertion order", () => {
  const params = new SqlParams();
  assert.deepEqual(params.all, []);
  assert.equal(params.add("a"), "$1");
  assert.equal(params.add("b"), "$2");
  assert.equal(params.add("c"), "$3");
  assert.deepEqual(params.all, ["a", "b", "c"]);
});

test("every context value reaches the query as a bound parameter", () => {
  const params = new SqlParams();
  const context = makeContext({
    workspaceId: "ws ' OR 1=1 --",
    repositoryId: "repo-1",
    role: "worker",
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1"
  });
  const sql = buildScopeFilterSql("m", context, params);

  // Nothing from the caller's context may appear in the statement text. The
  // workspace id here is deliberately hostile; a context value inlined into
  // the SQL would turn a scoping predicate into caller-controlled SQL.
  assert.doesNotMatch(sql, /ws ' OR 1=1 --/u);
  for (const value of [
    context.workspaceId,
    "repo-1",
    "worker",
    "task-1",
    "run-1",
    "agent-1"
  ]) {
    assert.ok(
      !sql.includes(value),
      `${value} must not be inlined into the SQL`
    );
  }
  // Dense numbering with no gaps, in the order the builder bound them.
  assert.deepEqual(params.all, [
    false,
    context.workspaceId,
    "repo-1",
    "worker",
    "task-1",
    "run-1",
    "agent-1"
  ]);
  // Dense numbering with no gaps. Placeholders legitimately repeat -- each
  // clause rebinds the workspace it shares with its neighbours -- so the
  // property worth pinning is that the distinct set is exactly $1..$N in bind
  // order, which is what stops one clause reading another's value.
  const distinct = [
    ...new Set(Array.from(sql.matchAll(/\$(\d+)/gu), (match) => match[1]!))
  ];
  assert.deepEqual(distinct, ["1", "2", "3", "4", "5", "6", "7"]);
});

test("only the global clause escapes the workspace boundary", () => {
  const context = makeContext({
    repositoryId: "repo-1",
    role: "worker",
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1"
  });
  const sql = buildScopeFilterSql("m", context, new SqlParams());
  const clauses = scopeClauses(sql);
  assert.equal(clauses.length, 6, "one clause per scope kind");
  for (const kind of [
    "global",
    "workspace",
    "repository",
    "role",
    "task",
    "agent"
  ]) {
    assert.equal(
      clauses.filter((clause) => clause.includes(`= '${kind}'`)).length,
      1,
      `exactly one clause for the ${kind} scope`
    );
  }

  const workspaceBound = clauses.filter((clause) =>
    clause.includes(`.${SCOPE_COLUMNS.workspaceId}`)
  );
  assert.equal(
    workspaceBound.length,
    5,
    "every scope except global must be workspace-bounded"
  );
  const global = clauses.find((clause) => clause.includes(`= 'global'`));
  assert.ok(global);
  assert.doesNotMatch(
    global,
    new RegExp(String.raw`\.${SCOPE_COLUMNS.workspaceId}`, "u"),
    "a global clause must not be narrowed to one workspace"
  );
  assert.match(global, /\$\d+::boolean/u, "global reads stay behind the grant");

  // The workspace placeholder is the same binding in every clause that uses
  // it. Divergence here would let one scope kind match a different workspace
  // than the caller asked about -- the repository, role, task and agent
  // clauses all reach back to the identical parameter.
  const workspacePlaceholders = new Set(
    workspaceBound.map(
      (clause) =>
        new RegExp(
          String.raw`\.${SCOPE_COLUMNS.workspaceId} = (\$\d+)`,
          "u"
        ).exec(clause)?.[1]
    )
  );
  assert.deepEqual([...workspacePlaceholders], ["$2"]);
});

test("task history access widens only to task and agent scopes", () => {
  const withoutGrant = makeContext({
    repositoryId: "repo-1",
    taskId: "task-1",
    runId: "run-1",
    canReadTaskHistory: false
  });
  // Separate accumulators: `SqlParams` is stateful, so sharing one would number
  // the second predicate from where the first left off.
  assert.equal(
    buildExperienceScopeFilterSql("m", withoutGrant, new SqlParams()),
    buildScopeFilterSql("m", withoutGrant, new SqlParams()),
    "without the curator grant the two predicates must be identical"
  );

  const withGrant = makeContext({
    repositoryId: "repo-1",
    taskId: "task-1",
    runId: "run-1",
    canReadTaskHistory: true
  });
  const widened = buildExperienceScopeFilterSql(
    "m",
    withGrant,
    new SqlParams()
  );
  const outer = scopeClauses(widened);
  assert.equal(outer.length, 2, "the grant is exactly one added alternative");
  // The grant is scoped to exactly the two raw kinds, and stays inside the
  // caller's workspace and repository.
  const granted = outer[1]!;
  assert.match(
    granted,
    new RegExp(String.raw`\.${SCOPE_COLUMNS.kind} = ANY`, "u")
  );
  assert.match(
    granted,
    new RegExp(String.raw`\.${SCOPE_COLUMNS.workspaceId} = \$\d+`, "u")
  );
  assert.match(granted, /\.repository_id = \$\d+/u);
  assert.doesNotMatch(
    granted,
    new RegExp(String.raw`\.${SCOPE_COLUMNS.agentId}`, "u"),
    "the grant must not narrow to one agent"
  );
  assert.doesNotMatch(
    granted,
    new RegExp(String.raw`\.${SCOPE_COLUMNS.role}`, "u")
  );
});

test("task history access without a repository widens no further", () => {
  const context = makeContext({
    taskId: "task-1",
    runId: "run-1",
    canReadTaskHistory: true
  });
  const widened = buildExperienceScopeFilterSql("m", context, new SqlParams());
  const granted = scopeClauses(widened)[1]!;
  assert.match(
    granted,
    new RegExp(String.raw`\.${SCOPE_COLUMNS.workspaceId} = \$\d+`, "u")
  );
  assert.doesNotMatch(
    granted,
    /repository_id/u,
    "without a repository to bind, the grant is still workspace-bounded"
  );
});
