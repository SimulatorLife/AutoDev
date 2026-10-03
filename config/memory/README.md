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
1536-dimensional. Retrieval is lexical by default. To enable vector search,
set `AUTODEV_MEMORY_EMBEDDING_MODEL` to an embedding-capable model already
recognized by AutoDev's `config/model-routing.json` provider route. The selected
provider must expose an OpenAI-compatible `/embeddings` endpoint and return
1536-dimensional vectors; the adapter reuses that route's base URL and `envKey`
credential, and does not create a separate model router or API key. Missing
routing/credentials or a recoverable provider outage keeps lexical retrieval
available. No embedding model is selected by default. Embedding requests contain
the memory claim or bounded task query, never raw transcript contents; configure
only a provider route approved to process that data and restart the router after
changing the embedding model setting.

The root JIT path reconstructs at most two top-ranked candidates through the
already configured orchestrator model over the local AutoDev router. It does
not create a separate memory model router; the `memory.reconstruct` span covers
the bounded call, and invalid/unavailable model output is classified uncertain
and excluded. `AUTODEV_MEMORY_RECONSTRUCTION=deterministic` selects the
verified-claim baseline for isolated tests. Configured embedding requests emit a
child GenAI embeddings span with bounded model/provider metadata and observed
input-token usage. Recoverable provider failures are traced and fall back to
full-text retrieval; malformed vectors remain hard errors.
Full-text
matching allows partial task/claim term overlap so JIT validation can evaluate
candidates whose wording differs from the task; zero-signal records remain
excluded.

Data migration v6 adds repository, commit, task/plan, validation, and evidence
references to the experience GIN search vector. This enables exact full-text
lookup of filenames and PR/issue links without indexing transcript payloads.
Data migration v7 stores the host-selected memory mode beside each experience
and indexes it with run outcomes for scoped ablation browsing. Existing rows
remain `unknown`/unset rather than being backfilled from current process state.

The Docker volume `autodev-memory-postgres` is durable. Configure backups,
retention/deletion policy, and production credentials before storing production
memory. Never check in `AUTODEV_MEMORY_DB_PASSWORD` or the database URL.

## Raw-experience retention job

Runtime exposes a one-shot curator sweep via
`pnpm --filter @simulatorlife/autodev-runtime memory:retention`. It is disabled
unless
`AUTODEV_MEMORY_RETENTION_ENABLED=1`; operators must explicitly configure
`AUTODEV_MEMORY_EXPERIENCE_RETENTION_DAYS`, `AUTODEV_MEMORY_DATABASE_URL`,
`AUTODEV_MEMORY_WORKSPACE_ID`, and `AUTODEV_MEMORY_REPOSITORY_ID`. Historical
task/agent scope requires `AUTODEV_MEMORY_READ_TASK_HISTORY=1`. The optional
`AUTODEV_MEMORY_RETENTION_BATCH_SIZE` is bounded to 100 and defaults to 100.

The job considers only completed task/agent experiences older than the configured
cutoff, within that workspace/repository, and not referenced by any durable
memory. Each row is still purged through MemoryService's locked, audited
transaction; output contains counts and cutoff, not experience IDs. No retention
age or schedule is enabled by default. Schedule this one-shot command only after
selecting a policy appropriate for the deployment; durable claims remain soft
invalidations rather than part of this raw-experience sweep.

## Explicit native transcript capture

For a run whose host can identify its provider transcript, Runtime also exposes a
one-shot importer: `pnpm --filter @simulatorlife/autodev-runtime memory:capture`.
It supports Codex, Claude Code, Copilot CLI, Gemini CLI, OpenHands, Letta Code,
OpenCode, and Cursor through `@letta-ai/trajectory`. This is an explicit import path, not a background
scanner or default hook. Set `AUTODEV_MEMORY_CAPTURE_ENABLED=1`,
`AUTODEV_MEMORY_DATABASE_URL`, `AUTODEV_MEMORY_WORKSPACE_ID`,
`AUTODEV_MEMORY_REPOSITORY_ID`, `AUTODEV_MEMORY_REPOSITORY_ROOT`,
`AUTODEV_MEMORY_CAPTURE_ROOT`, `AUTODEV_MEMORY_CAPTURE_PATH` (relative to the
root), `AUTODEV_MEMORY_CAPTURE_SOURCE`, `AUTODEV_MEMORY_TASK_ID`,
`AUTODEV_MEMORY_RUN_ID`, and `AUTODEV_MEMORY_AGENT_ID`. The source path must
resolve to a non-empty regular file beneath the configured root and is limited
to 32 MiB. Optional `AUTODEV_MEMORY_CAPTURE_TASK_KIND`, `_PROVIDER`, `_MODEL`,
`_BRANCH`, `_BASE_COMMIT`, and `_HEAD_COMMIT` attach bounded execution metadata.
`AUTODEV_MEMORY_CAPTURE_OUTCOME` accepts `success`, `partial`, `failure`,
`cancelled`, or `unknown` (default). `AUTODEV_MEMORY_CAPTURE_MODE` overrides
`AUTODEV_MEMORY_MODE` and defaults to `unknown`; `retrieval-only` also requires
`AUTODEV_MEMORY_ABLATION=1`. To include validation, set
`AUTODEV_MEMORY_CAPTURE_VALIDATION_STATE` and a bounded JSON array of evidence
references in `AUTODEV_MEMORY_CAPTURE_VALIDATION_EVIDENCE`; `not_run` may omit
references, while reported validation states require at least one. These fields
are host-reported historical evidence, not canonical task status. Re-capturing
the same transcript is idempotent and keeps the original
outcome/validation/memory mode.

The importer normalizes the transcript in memory and persists only the scoped
experience envelope, a source URI, and digests/counts; it does not store
transcript contents. Source timestamps are used only when the normalizer reports
them as native; its deterministic synthesized timestamps are never persisted as
historical run times. The transcript root should therefore be the narrowest
provider-history directory appropriate for the selected run, and the host must
not point it at unrelated session history. Re-running the same capture is
idempotent.

## Automatic router JIT

When `AUTODEV_MEMORY_DATABASE_URL` is present in the router environment (the
installed launcher sources `$CODEX_HOME/.env`), root orchestrator user turns
with a trusted, absolute workspace path call `MemoryService.research` before
provider selection. A bounded JSON-quoted advisory packet is appended to the
request instructions; tool-result continuations without a new human steer are
not re-researched. The default verifier requires a source commit in current Git
history and unchanged cited tracked files; canonical RuleSync skill, command,
hook, and MCP references resolve to tracked source files. A revisionless
canonical GitHub pull request for the trusted repository may supply its merge
commit through at most one bounded lookup per research context, but only when
GitHub reports the PR merged. The commit must still be a local ancestor and
cited files must remain unchanged. This does not validate reviews/checks, issue
state, reverts, reopened PRs, or superseding changes. Missing evidence, stale
files, or a storage failure yields no packet and does not block the task.
Global memory reads are
disabled by default; set `AUTODEV_MEMORY_READ_GLOBAL=1` only when the operator
intends to grant that scope.
Set `AUTODEV_MEMORY_MODE=disabled` on a separate router process to run a
no-automatic-JIT baseline. For an isolated retrieval-only ablation, set both
`AUTODEV_MEMORY_MODE=retrieval-only` and `AUTODEV_MEMORY_ABLATION=1`; it injects
at most two hard-scope/status/validity-filtered claims without Git validation or
reconstruction and labels their disposition `not_evaluated`. Never enable this ablation in normal
production routing. Unset or `jit` keeps the default path, and unknown values
disable memory. For a strict no-memory cohort, also do not connect an explicit
memory MCP client. `autodev.memory.mode` is attached to the active request span
and the bounded injection metric. This distinguishes request-level cohorts; it
does not claim task or PR success.

For an opt-in session-level assignment experiment, set
`AUTODEV_MEMORY_EXPERIMENT_ID` to the same opaque salt on every router replica
and set `AUTODEV_MEMORY_ABLATION=1`. This takes precedence over
`AUTODEV_MEMORY_MODE` and reproducibly assigns trusted Router-identified Codex
sessions to `jit`, `retrieval-only`, or `disabled` using the workspace,
repository, and session key. Missing/untrusted session or workspace identity
selects `invalid` rather than being counted as a control-arm exposure. The ID is
not persisted with injection events or telemetry; record it and isolate each
experiment to a non-overlapping repository/time window. This hashes sessions
into approximately even arms; it is not fixed-block allocation. Session-level
assignment does not establish per-turn outcomes: the cohort API counts request
exposures, and outcomes remain operator-reported. Strict no-memory cohorts must
also omit direct Memory MCP access. Do not interpret multiple injections from
one session as independent tasks or successes.

## Per-run Codex Memory MCP

`run-provider-agent.sh` adds a run-scoped `autodev_memory` MCP server to Codex
only for an ordinary JIT run when the host supplies the Memory database URL,
workspace/repository IDs, and an absolute repository root matching the selected
workspace. The database URL remains in the child process environment; it is not
copied into Codex command-line arguments or prompts, and Codex excludes it from
model-spawned tool commands. Each server gets a fresh
host-generated task/run/actor identity, the selected host role, and `worker`
authority. Operator-only global and task-history grants are removed, and model
tool arguments cannot change the workspace or identity. Incomplete or
mismatched host scope disables the server rather than guessing.

The provider runner explicitly disables this server for `retrieval-only`,
`disabled`, `invalid`, or `unknown` memory modes, whenever
`AUTODEV_MEMORY_ABLATION=1`, or whenever an experiment ID is configured. This
keeps direct MCP calls from bypassing controlled router-injection arms. Strict
cohort deployments must also keep other external Memory MCP clients disconnected;
the per-run Codex override cannot govern independently launched clients. The
generic `.rulesync/mcp.jsonc` catalog remains free of a process-global Memory
server because only the runtime can bind trusted per-run context.

The authenticated Control API exposes scoped Memory browsing at
`GET /control/memory/records` and `GET /control/memory/experiences`, along with
record detail, history, and provenance (`/why`) routes. Every request must name
`workspaceId`; optional `repositoryId`, `role`, `taskId` + `runId`, and
`agentId` filters narrow visibility. Experience lists also accept `memoryMode`
and `outcome` filters for the host-reported cohort metadata. Task/agent-scoped raw experiences stay
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
to the retained Memory registry/page. Patches
`09-autodev-memory-lifecycle-actions.patch` and
`10-autodev-memory-action-hardening.patch` add and harden evidence-backed
invalidation. Patch `11-autodev-memory-lifecycle-ui.patch` adds status-gated
verify, revise, supersede, and procedure-to-skill promotion actions plus
provenance/history detail through the same capability-driven UI. All mutations
still pass through Control API and MemoryService governance; generic CRUD writes
remain disabled for this connector.
Configure `AUTODEV_CONTROL_API_URL` and the server-only
`AUTODEV_CONTROL_API_TOKEN` in the OpenLIT server environment, then configure a
connector with its AutoDev `workspaceId` and optional repository/role/task/run/
agent scope. Enable its task-history option only for an operator actor after
setting `AUTODEV_MEMORY_READ_TASK_HISTORY=1` on the Control API. The Memory page
reuses its generic list/search/detail UI; it does
not create another AutoDev admin page or connect directly to PostgreSQL. The
detail sheet exposes only descriptor-advertised, status-appropriate actions;
current-state validation is performed by MemoryService when an action is
submitted. Memory-specific analytics and deployed-image acceptance remain
unverified.

The Codex SessionEnd configuration is wired to a best-effort hook that sends only the session id,
workspace path, and transcript path to the authenticated capture route. The
router accepts a transcript only when its session/workspace pair was previously
observed on a trusted request and the resolved file remains inside
`$CODEX_HOME/sessions`; transcript contents are normalized in memory and are
not stored, only a digest, bounded metadata, and a `codex://session/...`
reference.

Claude Code SessionEnd capture posts to
`POST /control/memory/claude-code/capture`, but remains disabled unless an
operator authors a binding file (default:
`$CLAUDE_HOME/claude-code-memory.toml`, or `~/.claude/claude-code-memory.toml`).
Use absolute paths; tilde expansion is not performed. For example:

```toml
optIn = true

[[workspace]]
root = "/Users/operator/src/example"
workspaceId = "workspace-example"
repositoryId = "owner/example"
transcriptRoot = "/Users/operator/.claude/projects/-Users-operator-src-example"
```

Each workspace `transcriptRoot` must resolve to a distinct, non-overlapping
transcript directory for that workspace; `root` must resolve to the exact
repository workspace root. Binding disjoint transcript roots per workspace
prevents a hook from pairing a transcript from one authorized repository with
another workspace's `cwd`. The
Control API is the only consumer of this operator-owned file. It requires
exactly one matching realpath for the hook's `cwd` (subdirectories, ancestors,
ambiguous roots, and unbound workspaces are rejected) and a transcript
realpath strictly beneath that workspace's configured transcript root. The
transcript basename must equal `<session_id>.jsonl`; an unrecognized naming
scheme fails closed rather than weakening the session-to-transcript check. The hook's session ID only identifies a
session-scoped task/run/agent; it does not establish a Router session mapping.
The captured outcome is always `unknown` absent a separate trusted task report.
Transcript contents are normalized in memory and are not persisted; only a
digest, bounded metadata, and a `claude-code://session/...` reference are
retained. Capture is best-effort and fails closed without an opted-in binding.
The shared hook uses actor `autodev-local`; if Control API actor allowlists are
configured, include it in `AUTODEV_CONTROL_OPERATORS`.

Copilot CLI, Gemini CLI, and other harnesses remain manually importable only.
See the [official Claude Code hook reference](https://code.claude.com/docs/en/hooks)
and the [memory injection/outcome evaluation notes](../../docs/memory-injection-outcome-evaluation.md).
The installed Runtime hook file is now materialized and executed in an isolated
CODEX_HOME test against a local Control API stub; actual Codex desktop hook
trust/approval still needs live operator verification.

The MCP stdio factory is likewise an adapter surface, not a configured global
server: it requires a trusted host to supply the repository, task, and agent
context. See
[`../../docs/memory-target-state.md`](../../docs/memory-target-state.md) for the
full target architecture and remaining integration requirements.

## Integration tests

- Data migration/repository test: set `AUTODEV_MEMORY_TEST_DATABASE_URL` and run
  `pnpm --filter @simulatorlife/autodev-data test`.
- Runtime PostgreSQL + Git-curation + native-capture test: set
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
arguments cannot change that identity or scope. If
`AUTODEV_MEMORY_EMBEDDING_MODEL` is configured, MCP search and proposals reuse
the same provider route and credential; without it, operations remain
lexical-only. `experience_append` records a run-bound envelope with a source
format, stable URI, and caller-reported
SHA-256 digest; it never accepts transcript contents. Workspace/task/run/agent
scope comes from the trusted process, and repeated appends for the same source
artifact are idempotent. Outcome and validation fields are reporter-supplied
historical evidence, not canonical status; durable promotion still requires
curator verification. Credentials are stripped from trajectory and evidence
locators before persistence.

Do not expose a root/curator authority to a general-purpose model process.
The generic `.rulesync/mcp.jsonc` catalog does not launch this server by
default because it cannot bind each provider run's trusted workspace/task
context. Native AutoDev root turns receive memory through the router JIT path
above, not by calling MCP.
