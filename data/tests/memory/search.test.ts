import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExperienceListQuery,
  buildExperienceSearchQuery,
  buildMemoryListQuery,
  buildMemorySearchQuery
} from "../../src/memory/search.ts";
import { makeContext } from "./fixtures/builders.ts";

test("buildMemorySearchQuery applies scope/status/validity filters inside a CTE before any ranking expression", () => {
  const { text, params } = buildMemorySearchQuery({
    query: "config loader",
    context: makeContext({ workspaceId: "ws-1" }),
    kinds: ["semantic"],
    limit: 5
  });

  const cteStart = text.indexOf("WITH scoped AS (");
  const whereIndex = text.indexOf("WHERE");
  const cteClose = text.indexOf(")\nSELECT");
  const outerSelectIndex = text.indexOf("SELECT *,", cteClose);
  const orderByIndex = text.indexOf("ORDER BY score");

  assert.ok(cteStart === 0, "query must start with the scoped CTE");
  assert.ok(whereIndex > cteStart, "WHERE must be inside the CTE");
  assert.ok(cteClose > whereIndex, "the CTE must close after its WHERE clause");
  assert.ok(
    outerSelectIndex > cteClose,
    "the ranking SELECT must be the outer query"
  );
  assert.ok(
    orderByIndex > outerSelectIndex,
    "ORDER BY must follow the ranking SELECT"
  );

  // The hard filters themselves must live inside the CTE, not the outer query.
  const cteBody = text.slice(cteStart, cteClose);
  const outerBody = text.slice(cteClose);
  assert.match(cteBody, /status = 'active'/);
  assert.match(cteBody, /validity_state = 'verified'/);
  assert.match(
    cteBody,
    /validity_valid_to IS NULL OR validity_valid_to > \$\d+/
  );
  assert.match(cteBody, /kind = ANY\(\$\d+::text\[\]\)/);
  assert.match(cteBody, /scope_kind = 'workspace'/);

  // Ranking expressions must never appear inside the filter stage.
  assert.doesNotMatch(cteBody, /ts_rank/);
  assert.doesNotMatch(cteBody, /AS score/);
  assert.match(outerBody, /ts_rank\(claim_search/);

  assert.ok(params.length > 0);
});

test("buildMemorySearchQuery includes vector ranking only in the outer query when the request supplies queryEmbedding", () => {
  const { text } = buildMemorySearchQuery({
    query: "config loader",
    context: makeContext(),
    limit: 5,
    queryEmbedding: [0.1, 0.2, 0.3]
  });

  const cteClose = text.indexOf(")\nSELECT");
  const cteBody = text.slice(0, cteClose);
  const outerBody = text.slice(cteClose);

  assert.doesNotMatch(cteBody, /<=>/);
  assert.match(outerBody, /embedding <=> \$\d+::vector/);
});

test("buildMemorySearchQuery runs lexical-only when no queryEmbedding is supplied", () => {
  const { text } = buildMemorySearchQuery({
    query: "config loader",
    context: makeContext(),
    limit: 5
  });
  assert.doesNotMatch(text, /<=>/);
  assert.doesNotMatch(text, /vector/);
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

test("buildMemorySearchQuery hard-filters relevant file evidence before ranking", () => {
  const path = "file:///workspace/repo/src/router/proxy.ts";
  const { text, params } = buildMemorySearchQuery({
    query: "fallback routing",
    context: makeContext({ workspaceId: "ws-1" }),
    relevantPaths: [path],
    asOf: "2026-09-30T12:00:00.000Z"
  });
  const cteClose = text.indexOf(")\nSELECT");
  const cteBody = text.slice(0, cteClose);
  const outerBody = text.slice(cteClose);

  assert.match(
    cteBody,
    /jsonb_array_elements\(COALESCE\(memory_records\.provenance->'evidence'/
  );
  assert.match(cteBody, /evidence_ref->>'kind' = 'file'/);
  assert.match(cteBody, /evidence_ref->>'uri' = ANY\(\$\d+::text\[\]\)/);
  assert.doesNotMatch(outerBody, /jsonb_array_elements/);
  assert.ok(
    params.some(
      (parameter) => Array.isArray(parameter) && parameter.includes(path)
    )
  );
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
