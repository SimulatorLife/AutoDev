# AutoDev memory database (local development)

The canonical memory repository is PostgreSQL with the `pgvector` extension and
PostgreSQL full-text indexes. It is separate from OpenLIT/ClickHouse: those
stores remain historical telemetry, not mutable memory authority.

## Start and migrate the local database

The database binds only to loopback. Supply its password from the process
environment; do not write it to a tracked file.

```sh
export AUTODEV_MEMORY_DB_PASSWORD="$(openssl rand -hex 32)"
docker compose -f config/memory/compose.yaml up -d
export AUTODEV_MEMORY_DATABASE_URL="postgresql://autodev_memory:${AUTODEV_MEMORY_DB_PASSWORD}@127.0.0.1:5433/autodev_memory"
pnpm --filter @simulatorlife/autodev-data memory:migrate
```

The migration fails if pgvector cannot be installed; lexical-only operation is
not presented as a complete canonical deployment. The current vector column is
1536-dimensional. The router has no embedding model configured by default, so
it uses PostgreSQL full-text retrieval until an adapter from AutoDev's existing
provider/model abstraction is supplied. No memory-specific model router is
created.

The root JIT path reconstructs at most two top-ranked candidates through the
already configured orchestrator model over the local AutoDev router. It does
not create a separate memory model router; the `memory.reconstruct` span covers
the bounded call, and invalid/unavailable model output is classified uncertain
and excluded. `AUTODEV_MEMORY_RECONSTRUCTION=deterministic` selects the
verified-claim baseline for isolated tests. Embedding generation is still not
configured, so retrieval remains PostgreSQL full-text until the existing
provider layer exposes a compatible embedding capability.

The Docker volume `autodev-memory-postgres` is durable. Configure backups,
retention/deletion policy, and production credentials before storing production
memory. Never check in `AUTODEV_MEMORY_DB_PASSWORD` or the database URL.

## Automatic router JIT

When `AUTODEV_MEMORY_DATABASE_URL` is present in the router environment (the
installed launcher sources `$CODEX_HOME/.env`), root orchestrator user turns
with a trusted, absolute workspace path call `MemoryService.research` before
provider selection. A bounded JSON-quoted advisory packet is appended to the
request instructions; tool-result continuations without a new human steer are
not re-researched. The default verifier requires a source commit in current Git
history and unchanged cited tracked files; canonical RuleSync skill URIs resolve
to their `.rulesync/skills/.../SKILL.md` source files. Missing evidence, stale files, or a storage
failure yields no packet and does not block the task. Global memory reads are
disabled by default; set `AUTODEV_MEMORY_READ_GLOBAL=1` only when the operator
intends to grant that scope.

The authenticated Control API exposes scoped Memory browsing at
`GET /control/memory/records` and `GET /control/memory/experiences`, along with
record detail, history, and provenance (`/why`) routes. Every request must name
`workspaceId`; optional `repositoryId`, `role`, `taskId` + `runId`, and
`agentId` filters narrow visibility. Task/agent-scoped raw experiences stay
private by default; an operator can request `includeTaskHistory=true` only when
`AUTODEV_MEMORY_READ_TASK_HISTORY=1` is set, and that grant remains bounded to
the selected workspace/repository. Both lists support `query`, `limit` (1–100),
and `offset`; record lists also accept repeated or comma-delimited `kind` and
`status` filters. The API uses the normal Control API service token and actor
allowlist, and records remain scoped by `MemoryService`/PostgreSQL visibility.
The Codex SessionEnd hook uses the fixed `autodev-local` actor; when explicit
Control API allowlists are configured, include that actor in
`AUTODEV_CONTROL_OPERATORS` for capture to work. Operator-only `POST` actions expose `propose`, `revise`, `verify`/`promote`,
`invalidate`, `supersede`, and `promote-skill`; every action writes through
MemoryService and its append-only lifecycle history. Skill promotion requires a
procedural memory with two distinct successful runs and passing validation
evidence, re-verifies current repository state, writes an operator-authored
`.rulesync/skills/<name>/SKILL.md` without overwriting existing content, then
invalidates the redundant fuzzy memory while retaining its history. Workers and
viewers cannot mutate through this Control API. OpenLIT patch `08-autodev-memory-connector.patch` adds the `autodev` connector
to the retained Memory registry/page, and patch
`09-autodev-memory-lifecycle-actions.patch` adds a capability-driven,
evidence-backed invalidation action for live durable records. The connector
continues to reject generic CRUD writes.
Configure `AUTODEV_CONTROL_API_URL` and the server-only
`AUTODEV_CONTROL_API_TOKEN` in the OpenLIT server environment, then configure a
connector with its AutoDev `workspaceId` and optional repository/role/task/run/
agent scope. Enable its task-history option only for an operator actor after
setting `AUTODEV_MEMORY_READ_TASK_HISTORY=1` on the Control API. The Memory page
reuses its generic list/search/detail UI; it does
not create another AutoDev admin page or connect directly to PostgreSQL. The
detail sheet exposes only the descriptor-advertised invalidation action; the
other lifecycle controls, current-state validation UI, and memory-specific
analytics remain unimplemented.

The Codex SessionEnd configuration is wired to a best-effort hook that sends only the session id,
workspace path, and transcript path to the authenticated capture route. The
router accepts a transcript only when its session/workspace pair was previously
observed on a trusted request and the resolved file remains inside
`$CODEX_HOME/sessions`; transcript contents are normalized in memory and are
not stored, only a digest, bounded metadata, and a `codex://session/...`
reference. Claude Code, Copilot CLI, Gemini CLI, and other harnesses do not yet
have native capture hooks. The real installed Codex hook-trust/runtime path is
not yet independently verified.

The MCP stdio factory is likewise an adapter surface, not a configured global
server: it requires a trusted host to supply the repository, task, and agent
context. See
[`../../docs/memory-target-state.md`](../../docs/memory-target-state.md) for the
full target architecture and remaining integration requirements.

## Integration tests

- Data migration/repository test: set `AUTODEV_MEMORY_TEST_DATABASE_URL` and run
  `pnpm --filter @simulatorlife/autodev-data test`.
- Runtime PostgreSQL + Git-curation test: set
  `AUTODEV_MEMORY_RUNTIME_TEST_DATABASE_URL` and run
  `pnpm --filter @simulatorlife/autodev-runtime test`.
- Official stdio MCP process test: set `AUTODEV_MEMORY_MCP_TEST_DATABASE_URL`
  and run `pnpm --filter @simulatorlife/autodev-runtime test`.
- Root-router JIT injection test: set `AUTODEV_MEMORY_ROUTER_TEST_DATABASE_URL`
  and run `node --test tests/router/memory-injection.integration.test.ts`.

These optional tests use unique records and do not truncate the configured
PostgreSQL database. Use disposable test databases; do not point them at
production memory.

## Explicit external-agent MCP

A trusted external client can start the official stdio server with
`pnpm --filter @simulatorlife/autodev-runtime memory:mcp`. Bind the process to
one run by setting `AUTODEV_MEMORY_DATABASE_URL`,
`AUTODEV_MEMORY_WORKSPACE_ID`, `AUTODEV_MEMORY_REPOSITORY_ID`, and an absolute
`AUTODEV_MEMORY_REPOSITORY_ROOT`. `AUTODEV_MEMORY_ACTOR_ID`, `AUTODEV_MEMORY_ROLE`,
`AUTODEV_MEMORY_TASK_ID`, and `AUTODEV_MEMORY_RUN_ID` may further identify the
host-owned context; the server defaults to worker authority, and global/task-history reads
remain disabled unless explicitly granted to a root/curator process with
`AUTODEV_MEMORY_READ_GLOBAL=1` or `AUTODEV_MEMORY_READ_TASK_HISTORY=1`. Tool
arguments cannot change that identity or scope.

Do not expose a root/curator authority to a general-purpose model process.
The generic `.rulesync/mcp.jsonc` catalog does not launch this server by
default because it cannot bind each provider run's trusted workspace/task
context. Native AutoDev root turns receive memory through the router JIT path
above, not by calling MCP.
