import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExperienceListQuery,
  buildExperienceSearchQuery,
  buildExpiredExperienceQuery,
  buildMemoryListQuery,
  buildMemorySearchQuery
} from "../../src/memory/search.ts";
import { makeContext } from "./fixtures/builders.ts";

test("buildMemorySearchQuery applies hard scope/status/validity filters before ranking", () => {
  const { text, params } = buildMemorySearchQuery({
    query: "config loader",
    context: makeContext({ workspaceId: "ws-1" }),
    kinds: ["semantic"],
    limit: 5
  });

  const cteStart = text.indexOf("WITH scoped AS (");
  const whereIndex = text.indexOf("WHERE");
  const rankedStart = text.indexOf("), ranked AS (");
  const rankedEnd = text.indexOf(")\nSELECT", rankedStart);
  const outerSelectIndex = text.indexOf("SELECT *,", rankedEnd);
  const orderByIndex = text.indexOf("ORDER BY score");

  assert.ok(cteStart === 0, "query must start with the scoped CTE");
  assert.ok(whereIndex > cteStart, "WHERE must be inside the CTE");
  assert.ok(
    rankedStart > whereIndex,
    "the filtered CTE must close after its WHERE clause"
  );
  assert.ok(
    rankedEnd > rankedStart && outerSelectIndex > rankedEnd,
    "ranking must occur after the filtered CTE"
  );
  assert.ok(
    orderByIndex > outerSelectIndex,
    "ORDER BY must follow the ranking SELECT"
  );

  // The hard filters themselves must live inside the CTE, not the outer query.
  const cteBody = text.slice(cteStart, rankedStart);
  const rankingBody = text.slice(rankedStart, rankedEnd);
  const outerBody = text.slice(rankedEnd);
  assert.match(cteBody, /status = 'active'/);
  assert.match(cteBody, /validity_state = 'verified'/);
  assert.match(
    cteBody,
    /validity_valid_to IS NULL OR validity_valid_to > \$\d+/
  );
  assert.match(cteBody, /kind = ANY\(\$\d+::text\[\]\)/);
  assert.match(cteBody, /scope_kind = 'workspace'/);
  assert.match(
    cteBody,
    /claim_search @@ replace\(plainto_tsquery\('english', \$\d+\)::text, ' & ', ' \| '\)::tsquery/
  );

  // Ranking expressions must never appear inside the filter stage.
  assert.doesNotMatch(cteBody, /ts_rank|<=>/);
  assert.match(rankingBody, /ts_rank\(scoped\.claim_search/);
  assert.doesNotMatch(outerBody, /ts_rank|<=>/);

  assert.ok(params.length > 0);
});

test("buildMemorySearchQuery includes vector ranking only in the outer query when the request supplies queryEmbedding", () => {
  const { text } = buildMemorySearchQuery({
    query: "config loader",
    context: makeContext(),
    limit: 5,
    queryEmbedding: [0.1, 0.2, 0.3]
  });

  const cteClose = text.indexOf("), ranked AS (");
  const rankedEnd = text.indexOf(")\nSELECT", cteClose);
  const cteBody = text.slice(0, cteClose);
  const rankingBody = text.slice(cteClose, rankedEnd);

  assert.doesNotMatch(cteBody, /<=>/);
  assert.match(rankingBody, /scoped\.embedding <=> \$\d+::vector/);
});

test("buildMemorySearchQuery runs lexical-only when no queryEmbedding is supplied", () => {
  const { text } = buildMemorySearchQuery({
    query: "config loader",
    context: makeContext(),
    limit: 5
  });
  assert.doesNotMatch(text, /<=>/);
  assert.doesNotMatch(text, /<=>|::vector/);
});

test("buildExperienceSearchQuery filters by scope visibility inside the CTE before ranking", () => {
  const { text } = buildExperienceSearchQuery({
    query: "retry logic",
    context: makeContext({
      workspaceId: "ws-1",
      taskId: "task-1",
      runId: "run-1"
    }),
    limit: 10
  });

  const cteClose = text.indexOf(")\nSELECT");
  const cteBody = text.slice(0, cteClose);
  const outerBody = text.slice(cteClose);

  assert.match(cteBody, /scope_kind = 'task'/);
  assert.doesNotMatch(cteBody, /ts_rank/);
  assert.match(outerBody, /ts_rank\(search_vector/);
});

test("buildMemorySearchQuery omits the global scope branch's grant unless the context allows it", () => {
  const { text, params } = buildMemorySearchQuery({
    query: "x",
    context: makeContext({ canReadGlobal: false }),
    limit: 1
  });
  assert.match(text, /\$1::boolean AND memory_records\.scope_kind = 'global'/);
  assert.equal(params[0], false);
});

test("buildMemorySearchQuery uses exact and nearby file evidence as a post-filter ranking signal", () => {
  const path = "file:///workspace/repo/runtime/src/router/proxy.ts";
  const { text, params } = buildMemorySearchQuery({
    query: "fallback routing",
    context: makeContext({ workspaceId: "ws-1" }),
    relevantPaths: [path],
    asOf: "2026-09-30T12:00:00.000Z"
  });
  const cteClose = text.indexOf("), ranked AS (");
  const cteBody = text.slice(0, cteClose);
  const rankingBody = text.slice(cteClose);

  assert.doesNotMatch(cteBody, /relevantPaths|jsonb_array_elements/);
  assert.match(
    rankingBody,
    /jsonb_array_elements\(COALESCE\(scoped\.provenance->'evidence'/
  );
  assert.match(rankingBody, /evidence_ref->>'kind' = 'file'/);
  assert.match(rankingBody, /evidence_ref->>'uri' = requested_path\.uri/);
  assert.match(rankingBody, /generate_series\(/);
  assert.match(rankingBody, /path_score \* 0\.2/);
  assert.ok(
    params.some(
      (parameter) => Array.isArray(parameter) && parameter.includes(path)
    )
  );
});

test("buildMemorySearchQuery scores task-kind provenance only from scope-visible source experiences", () => {
  const { text, params } = buildMemorySearchQuery({
    query: "configuration workflow",
    taskKind: "bugfix",
    context: makeContext({
      taskId: "task-current",
      runId: "run-current",
      agentId: "agent-current"
    }),
    limit: 5
  });
  const rankedStart = text.indexOf("), ranked AS (");
  const rankedEnd = text.indexOf(")\nSELECT", rankedStart);
  const rankedBody = text.slice(rankedStart, rankedEnd);
  const candidateFilter = text.slice(
    text.indexOf("WHERE lexical_score"),
    text.indexOf("ORDER BY score")
  );

  assert.match(
    rankedBody,
    /jsonb_array_elements_text\(COALESCE\(scoped\.provenance->'experienceIds'/
  );
  assert.match(rankedBody, /source_experience\.task_kind = \$\d+/);
  assert.match(rankedBody, /source_experience\.scope_task_id =/);
  assert.match(rankedBody, /source_experience\.scope_run_id =/);
  assert.match(rankedBody, /source_experience\.scope_agent_id =/);
  assert.match(text, /task_kind_score \* 0\.1/);
  assert.doesNotMatch(candidateFilter, /task_kind_score/);
  assert.ok(params.includes("bugfix"));
});

test("memory browser pagination scopes rows and includes non-active lifecycle records", () => {
  const query = buildMemoryListQuery({
    context: makeContext({ workspaceId: "ws-1", canReadGlobal: false }),
    query: "retry settings",
    kinds: ["procedural"],
    statuses: ["proposed", "uncertain"],
    limit: 10,
    offset: 20
  });
  assert.match(query.countText, /scope_kind = 'workspace'/);
  assert.match(query.countText, /status = ANY\(\$\d+::text\[\]\)/);
  assert.match(query.text, /status = ANY\(\$\d+::text\[\]\)/);
  assert.match(query.text, /claim_search @@ plainto_tsquery/);
  assert.match(query.text, /ORDER BY ts_rank\(claim_search/);
  assert.match(query.text, /LIMIT \$\d+ OFFSET \$\d+/);
  assert.equal(query.params.at(-2), 10);
  assert.equal(query.params.at(-1), 20);
  assert.ok(query.countParams.includes(false));
});

test("experience browser can filter by recorded memory mode", () => {
  const query = buildExperienceListQuery({
    context: makeContext({ workspaceId: "ws-1" }),
    memoryModes: ["disabled", "retrieval-only"],
    outcomes: ["failure", "partial"],
    limit: 10
  });
  assert.match(query.countText, /memory_mode = ANY\(\$\d+::text\[\]\)/);
  assert.match(query.text, /memory_mode = ANY\(\$\d+::text\[\]\)/);
  assert.match(query.countText, /outcome = ANY\(\$\d+::text\[\]\)/);
  assert.match(query.text, /outcome = ANY\(\$\d+::text\[\]\)/);
  assert.ok(
    query.countParams.some(
      (parameter) =>
        Array.isArray(parameter) &&
        parameter.includes("disabled") &&
        parameter.includes("retrieval-only")
    )
  );
  assert.ok(
    query.countParams.some(
      (parameter) =>
        Array.isArray(parameter) &&
        parameter.includes("failure") &&
        parameter.includes("partial")
    )
  );
});

test("unknown-mode experience filters include legacy rows without a mode column value", () => {
  const query = buildExperienceListQuery({
    context: makeContext({ workspaceId: "ws-1" }),
    memoryModes: ["unknown"],
    limit: 10
  });
  assert.match(
    query.countText,
    /memory_mode IS NULL OR memory_mode = 'unknown'/
  );
  assert.match(query.text, /memory_mode IS NULL OR memory_mode = 'unknown'/);
});

test("experience browser supports scoped pagination and lexical ordering", () => {
  const query = buildExperienceListQuery({
    context: makeContext({ taskId: "task-1", runId: "run-1" }),
    query: "tool failure",
    limit: 5,
    offset: 3
  });
  assert.match(query.countText, /scope_kind = 'task'/);
  assert.match(query.text, /search_vector @@ plainto_tsquery/);
  assert.match(query.text, /ORDER BY ts_rank\(search_vector/);
  assert.match(query.text, /LIMIT \$\d+ OFFSET \$\d+/);
  assert.equal(query.params.at(-2), 5);
  assert.equal(query.params.at(-1), 3);
});

test("experience history SQL requires the explicit workspace-bounded task-history grant", () => {
  const query = buildExperienceListQuery({
    context: makeContext({
      workspaceId: "ws-1",
      repositoryId: "owner/repo",
      canReadTaskHistory: true
    }),
    limit: 10,
    offset: 0
  });
  assert.match(query.countText, /scope_kind = ANY\(\$\d+::text\[\]\)/);
  assert.match(query.countText, /memory_experiences\.repository_id = \$\d+/);
  assert.match(query.text, /scope_workspace_id = \$\d+/);
  assert.match(query.params.join(" "), /ws-1/);
  assert.match(query.params.join(" "), /owner\/repo/);
});

test("retention candidate scans are workspace/repository scoped, bounded, and provenance-safe", () => {
  const query = buildExpiredExperienceQuery({
    context: makeContext({
      workspaceId: "ws-1",
      repositoryId: "owner/repo",
      canReadTaskHistory: true
    }),
    completedBefore: "2026-01-01T00:00:00.000Z",
    limit: 25
  });
  assert.match(query.text, /completed_at IS NOT NULL/);
  assert.match(query.text, /completed_at < \$\d+/);
  assert.match(query.text, /NOT EXISTS/);
  assert.match(query.text, /provenance->'experienceIds'/);
  assert.match(query.text, /ORDER BY memory_experiences\.completed_at ASC/);
  assert.match(query.text, /LIMIT \$\d+$/);
  assert.equal(query.params.at(-2), "2026-01-01T00:00:00.000Z");
  assert.equal(query.params.at(-1), 25);
  assert.ok(query.params.includes("ws-1"));
  assert.ok(query.params.includes("owner/repo"));
});
