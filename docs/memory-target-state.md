# Memory Target State

> **Authority:** Focused target-state design for AutoDev memory. It is subordinate to [`autodev-console-target-state.md`](autodev-console-target-state.md), which remains authoritative for repository-wide architecture, module ownership, Console behavior, RuleSync ownership, and observability/control-plane boundaries.
>
> **Goal:** Reuse useful cross-task experience without turning stale model-generated summaries into hidden policy or a competing source of truth.

## 1. Principles

1. **Keep raw experience.** Preserve meaningful trajectories and outcomes instead of relying only on summaries written before future needs are known.
2. **Curate at read time.** Retrieve for the current task, compare with current authoritative state, then reconstruct a small task-specific memory packet.
3. **Treat memory as evidence, not authority.** Git/repository state, RuleSync, version-controlled policy, and live runtime state override remembered claims.
4. **Separate types and scopes.** Episodic, semantic, and procedural memory have different lifecycles; task-private, role, repository/workspace, and global memory must not collapse into one shared store.
5. **Promote proven procedures.** Stable, repeatedly validated procedures should become explicit skills, rules, tests, or documentation.

The target is not conversation history plus vector search. It is a provenance-bearing, scoped, temporal memory lifecycle.

## 2. Target architecture

```text
execution
   ↓
raw experience
   ├── episodic memory    (what happened?)
   ├── semantic memory    (what appears true?)
   └── procedural memory  (how did we succeed?)
             │
current task ┤
current state┤
             ↓
scoped retrieval
             ↓
JIT research / curation
inspect • critique • reconcile
retain • revise • reject
             ↓
compact task-specific packet
             ↓
agent
```

Raw experience is the historical evidence for what agents observed and did. Derived memories accelerate reuse but retain provenance back to that evidence.

The current repository/runtime remains authoritative for what is true **now**.

## 3. Memory model

### Raw experience

Retain enough of each meaningful execution to reconstruct its outcome:

- task, plan, delegation, and agent role;
- relevant context references, tool calls, and observations;
- code/config/document changes;
- validation, reviews, failures, retries, corrections, and outcome;
- workspace/repository, refs/SHAs, timestamps, provider/model, selected memory mode, and relevant entities.

Prefer references to large source artifacts over duplicated copies.

### Episodic

Specific prior experiences: attempts, failures, recoveries, reviews, outcomes, and context-dependent decisions. Episodes point back to raw trajectories.

### Semantic

Durable claims such as ownership, architecture, relationships, constraints, intentional decisions, and known environment behavior.

Semantic memory requires provenance and temporal validity. It may be superseded; never silently rewrite history.

### Procedural

Reusable methods such as investigation strategies, validation workflows, recurring fixes, review procedures, and tool-use patterns.

Stable procedures should graduate to version-controlled skills/rules/tests/docs rather than remaining permanently fuzzy memory.

## 4. Memory is not canonical state

```text
policy / instructions        → RuleSync / AGENTS.md / skills
repository truth             → git + repository files
desired configuration        → RuleSync / AutoDev config
actual runtime state         → runtime / Control API
historical observability     → OpenTelemetry / OpenLIT
historical agent experience  → memory
```

A remembered claim never overrides a contradictory authoritative source.

## 5. Multi-agent scope and governance

Use explicit hierarchical scope:

```text
global
└── workspace / repository
    ├── shared durable memory
    ├── role-scoped memory
    └── task / run
        ├── root working memory
        ├── agent-private working memory
        └── shared task findings
```

Default to the narrowest useful scope.

Workers may append raw execution evidence, write task-local findings, and propose durable memories. They must not freely publish unverified claims into shared semantic/procedural memory.

Promotion to durable shared memory requires the root, a memory curator, or an equivalent evidence-based process. This prevents one agent's incorrect inference from contaminating later agents.

## 6. Write lifecycle

```text
execution
   ↓
append raw experience
   ↓
record outcome + evidence
   ↓
optional memory candidates
   ↓
validate / consolidate
   ↓
episodic | semantic | procedural
   ↓
repeated + proven procedure?
   ↓
promote to skill/rule/test/doc
```

A durable memory candidate should contain:

- type and scope;
- concise claim/lesson;
- source evidence/trajectory;
- repository/workspace and relevant refs;
- creation time;
- validation/confidence state;
- validity/supersession metadata where applicable.

Failures should capture conditions and evidence, not merely "do not do X."

## 7. Read lifecycle: Just-In-Time memory

Retrieval is driven by the current task, not merely semantic similarity.

```text
current task
   ↓
query decomposition
   ↓
hard scope / validity filters
   ↓
hybrid retrieval + reranking
   ↓
inspect authoritative current state
   ↓
critique / reconstruct
   ↓
retain • revise • reject
   ↓
bounded memory packet
```

Filter before ranking where possible by:

- workspace/repository;
- subsystem/entities/files;
- task type and agent role;
- memory type;
- branch/commit lineage;
- validity/supersession;
- time when relevant.

Ranking may combine lexical/semantic relevance, entity overlap, provenance quality, historical utility, validated outcome, recency, and current-state compatibility. Embedding similarity alone is not evidence of applicability.

PostgreSQL retrieval returns only records with an actual lexical, vector, or path signal instead of filling top-k with zero-score records. Disjunctive English full-text matching preserves claims with partial task-term overlap for JIT reconstruction; lexical relevance still ranks candidates, and applicability is decided only after validation. Relevant file evidence is a soft signal after hard scope, status, and validity filters: an exact file reference receives the maximum path score, while shared path prefixes contribute proportionally. A supplied task-kind signal adds a small ranking bonus for records citing scope-visible experiences of that kind, but cannot make an otherwise irrelevant candidate eligible; private task/agent episodes cannot influence another run's ranking. Raw-experience full-text search indexes repository, branch/commit, trajectory, task/plan, validation, and evidence-reference metadata (including file, PR, and issue locators) without copying transcript payloads. The Runtime Git verifier accepts a pull-request reference's explicit commit revision as lineage evidence. If no explicit revision exists, it may make at most one bounded lookup per research context for a canonical GitHub pull request belonging to the trusted current repository, and uses the merge commit only when GitHub reports the PR merged. A PR reference alone is never sufficient: the commit must be locally verifiable as an ancestor and every cited file must still match current repository state. Canonical RuleSync skill, command, hook, and MCP references resolve to tracked source files. The verifier additionally scans cited paths for the standard Git revert subject and body marker naming the exact source commit, even when a later commit restores the cited bytes. This detects conventional direct reverts in reachable local history; it does not detect manual/nonstandard reverts, review threads, CI/check status, issue state, reopened PRs, or superseding changes.

Before injection, reconstruct the memory for the current task:

1. What happened previously?
2. Why is it relevant?
3. What changed since then?
4. What still applies?
5. What is stale, contradicted, or uncertain?
6. What concise evidence/guidance should the agent receive?

Verify remembered facts against current tools/state when practical. If nothing survives validation, proceed without memory.

## 8. Task-specific packet, validity, and provenance

Agents receive a compact advisory packet, not arbitrary historical chunks. It may contain relevant decisions, successes/failures, procedures, conflicts, uncertainty, and source references.

Durable memories are append-oriented and can be:

- active;
- superseded;
- invalidated;
- uncertain;
- scope-limited.

Retain temporal/provenance fields where useful:

```text
source / trajectory
created_at
valid_from / valid_to
last_verified_at
verification_source
supersedes / superseded_by
```

Contradictions trigger reconciliation rather than winner-takes-all similarity ranking. Superseded episodes remain queryable as historical evidence.

## 9. Storage and module ownership

The logical contract matters more than a particular database.

- **`runtime/`** — trajectory capture, retrieval orchestration, JIT research/curation, promotion, and agent-facing context assembly.
- **`data/`** — typed persistence/search adapters for trajectories, memories, indexes, and retained OpenLIT memory integration.
- **`core/`** — infrastructure-independent memory types, scopes, provenance, lifecycle states, and contracts.
- **`console/`** — retained/adapted OpenLIT Memory connector/page primitives plus AutoDev-specific provenance, lifecycle, scope/status, analytics, and management UX.

Physical storage may combine append-oriented events, structured records, full-text search, vector indexes, and optional temporal/entity graphs.

Use graph indexes only where relationships materially help: ownership, dependencies, PR/issue/commit links, supersession, temporal changes, and agent/skill/tool/workspace relationships. Do not force every trajectory or observation into graph form.

Memory must not become an unbounded secret/context copy: redact credentials and unnecessary sensitive payloads, prefer references over duplication, retain provenance, and support retention/deletion by memory class.

Raw experiences are append-only during their useful retention period. Privacy or retention erasure is a curator-only operation, scoped to the authorized workspace/repository, and is refused while any durable memory cites the experience. Successful erasure removes the raw envelope and retains only an append-only tombstone containing a one-way fingerprint, actor, reason, and timestamp. Durable memory is invalidated or superseded by default rather than physically erased; its source history remains available for governance unless a separate privacy process explicitly handles it.
The operator Control API exposes `POST /control/memory/experiences/:id/purge` with `privacy_request` or `retention_expired`; invisible experiences return not-found, and provenance references return conflict rather than being broken.

Runtime also provides a one-shot `memory:retention` curator job. It requires an explicit age and workspace/repository, is opt-in, bounds each run to 100 records, and leaves scheduling to the deployment; it erases only completed, unreferenced raw experiences through the same purge transaction.

Purge scope is narrow and explicit: it erases only the raw `memory_experiences` envelope identified by `experienceId`. It does not touch, and is not blocked by, the independent append-only injection events, reporter-supplied outcome reports, curator-assessed use reports, or session outcome reports recorded for that session -- those tables hold bounded IDs, correlation tokens, and references rather than the raw transcript payload, and the purge eligibility check only inspects `memory_records.provenance.experienceIds`. Their bounded aggregates (`aggregateInjectionOutcomeCohorts`, `aggregateInjectionUseCohorts`, `aggregateSessionOutcomeCohorts`) count eligible events by their own `occurred_at`/`reported_at`, so a purge changes nothing about counts already recorded before it ran. If an erasure request covers those separate audit records themselves, or the external captured trajectory that an evidence reference points at, that is a distinct privacy process with its own scope and authorization; the experience-envelope purge described here does not claim to perform it.

## 10. Implementation and dependency strategy

AutoDev should own the **memory lifecycle and semantics**, not adopt a second agent framework merely to obtain memory. Reuse mature components for telemetry, transcript normalization, persistence, indexing, and protocol transport; keep repository-aware governance, validation, reconstruction, and promotion in AutoDev.

Target stack:

~~~text
agent/provider executions
        │
        ├── OpenTelemetry / OpenLIT ──► historical execution evidence
        │
        └── native harness transcripts
                    │
                    ▼
          @letta-ai/trajectory
          normalized trajectory records
                    │
             AutoDev experience envelope
                    │
                    ▼
          PostgreSQL + pgvector
        structured + lexical + vector
                    │
          ┌─────────┴─────────┐
          │                   │
          ▼                   ▼
 AutoDev MemoryService    optional Graphiti
 JIT/governance/curator   temporal graph index
          │
   ┌──────┼──────────────────┐
   │      │                  │
   ▼      ▼                  ▼
native   Control API +     MCP adapter
runtime  OpenLIT Memory    (official TS SDK)
   │      connector/page      │
   ▼      │                  ▼
agents    operators/UI     external agents +
JIT       analytics        explicit follow-up
~~~

### Direct dependencies

| Dependency | Use directly for | Why | Boundary |
| --- | --- | --- | --- |
| [OpenTelemetry](https://opentelemetry.io/) + [OpenLIT](https://github.com/openlit/openlit) | Execution evidence **and** the retained memory connector/operator UI, graph/detail/list primitives, connector management, and dashboard/trace surfaces | AutoDev already uses the OTel/OpenLIT foundation, and OpenLIT's memory connector layer is vendor-agnostic and capability-driven | OpenLIT is the primary operator/observability surface, but AutoDev `MemoryService` remains the memory semantic/runtime authority |
| [@letta-ai/trajectory](https://github.com/letta-ai/trajectory) | Normalize supported Codex, Claude Code, Copilot CLI, Gemini CLI, OpenHands, Letta, and other native transcripts into deterministic records | Avoid writing/maintaining one transcript decoder per harness; it is TypeScript and exposes a validated shared trajectory schema | AutoDev still owns repository/task/run/PR/commit/outcome metadata and any unsupported adapters |
| PostgreSQL | Canonical durable memory records, provenance, scopes, lifecycle state, supersession, utility/evaluation metadata | Memory is mostly structured mutable state requiring transactions, joins, filters, and history | Do not use ClickHouse telemetry tables as the canonical mutable memory database |
| [pgvector](https://github.com/pgvector/pgvector) | Semantic retrieval inside the same PostgreSQL store | Adds vector/HNSW or IVFFlat search without introducing a separate vector database | Vector similarity is one ranking signal, never the applicability decision |
| PostgreSQL full-text/GIN indexes | Exact/lexical retrieval for symbols, filenames, errors, PRs, SHAs, and technical phrases | Coding memory frequently depends on exact identifiers that embeddings can miss | Combine with structured filters and vector ranking |
| [official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Standard agent-facing memory server/client transport | Keeps memory usable across Codex, Claude, Copilot, Antigravity, and other MCP-capable agents without coupling the memory core to one harness | AutoDev owns the tools and authorization semantics; MCP is transport/interoperability |
| Git/GitHub + RuleSync/AutoDev configuration | Current-state verification and canonical-source checks | These are the authoritative sources needed to decide whether old memory still applies | Query them during JIT validation; never copy their authority into memory |

Prefer the existing provider/model abstraction for embeddings and reconstruction models. Do not create a dedicated model-routing subsystem for memory. Runtime resolves the optional embedding model through the existing provider routes and their configured credentials; no embedding model is selected by default.

### Retained OpenLIT memory surface

AutoDev should **reuse and adapt OpenLIT's memory connector framework and Memory page instead of building a second memory administration UI**. OpenLIT's current connector layer is descriptor- and capability-driven: a memory adapter advertises supported operations and filter/configuration fields, while shared forms, routes, list/detail/graph UI, pagination, and tool availability respond to those capabilities.

Implement an **AutoDev Memory connector/adapter** over the canonical `MemoryService`. The connector is a presentation/integration adapter; it does not become the memory authority.

~~~text
AutoDev MemoryService
      │
      ├── native orchestrator/JIT path
      ├── Control API
      │      ↓
      │   AutoDev Memory connector
      │      ↓
      │   retained OpenLIT Memory UI
      │
      └── MCP facade
~~~

#### Reuse directly or with light adaptation

| OpenLIT capability | AutoDev use |
| --- | --- |
| **Memory connector registry + descriptors** | Register AutoDev Memory alongside optional external/experimental stores without adding per-vendor forms or switches |
| **Capability-driven UI/actions** | Advertise only operations AutoDev safely supports; hide unsupported actions automatically |
| **Connector configuration and health** | Reuse connector status/test/health patterns and external-backend endpoint/secret handling when applicable |
| **Connector-defined filters** | Drive Memory filters from AutoDev scope metadata rather than bespoke page controls |
| **List/search/pagination** | Reuse the generic memory browser over AutoDev's indexed records |
| **Detail sheet/panels** | Reuse the shell and extend it with provenance, lifecycle, verification, source evidence, and usage |
| **Graph view / graph model** | Reuse for AutoDev relationships; feed native relationships or Graphiti-derived edges when enabled |
| **Copy/import plumbing** | Reuse for migration/experiments across AutoDev, Mem0, Zep, Claude, or other write-capable connectors while retaining provenance |
| **Audit/access hooks** | Retain equivalent access/audit integration where the reduced AutoDev Console still needs it |
| **Otter memory tools, if Otter is retained** | Human/operator Q&A and investigation over memory records; never part of the automatic agent JIT path |
| **OpenLIT trace/dashboard primitives** | Display memory-pipeline latency, token/cost, retrieval quality, lifecycle activity, and ablation/effectiveness metrics |

Do not duplicate those generic capabilities in a separate AutoDev-only Memory application unless the retained OpenLIT primitive cannot represent the required semantics cleanly.

#### Adapt the OpenLIT domain model

Stock OpenLIT memory connectors are generic external-memory CRUD integrations. AutoDev adds stronger semantics and has removed OpenLIT tenancy concepts.

Map the retained machinery as follows:

~~~text
OpenLIT project/environment  → remove; use AutoDev workspace/repository scope
user                         → only where a real external connector requires it
session/run                  → AutoDev task/run
agent                        → AutoDev agent/role

generic memory record        → AutoDev episodic/semantic/procedural memory
generic metadata             → provenance + validity + source/evidence references
delete                       → invalidate/supersede by default for durable knowledge
hard delete                  → retention/privacy/admin operation only
~~~

The generic list/detail/filter UI should therefore expose AutoDev concepts such as:

- memory type: episodic / semantic / procedural;
- scope: task/run / role / workspace/repository / global;
- status: active / superseded / invalidated / uncertain;
- source task/run, agent/role, PR/issue, commit/SHA, relevant files/entities;
- created/valid/last-verified timestamps;
- supersedes/superseded-by and related-memory links;
- retrieval, reconstruction, rejection, injection, and observed-use counts;
- current-state compatibility/verification evidence where available.

Do not recreate OpenLIT organization, account, project, or environment scoping to satisfy the stock connector model.

#### Extend actions where CRUD is insufficient

AutoDev's durable-memory lifecycle is not plain CRUD. The UI/API should expose domain actions where appropriate:

~~~text
propose
verify
revise
invalidate
supersede
promote
inspect provenance/history
~~~

Generic `add/update/delete` may remain for external connectors and low-level compatibility, but AutoDev Memory must preserve its governance rules. In particular, deleting a stale semantic memory from the page must not silently erase the historical episode/evidence that produced it.

#### Memory observability in OpenLIT

Instrument the AutoDev memory pipeline with OpenTelemetry so OpenLIT can show the same execution end-to-end:

~~~text
memory.research
  ├── memory.query
  ├── memory.retrieve
  ├── memory.rerank
  ├── memory.validate
  ├── memory.reconstruct
  └── memory.packet
~~~

Emit bounded attributes/metrics sufficient to answer:

- candidates retrieved / retained / revised / rejected;
- rejection reason such as stale, contradicted, superseded, or low relevance;
- episodic/semantic/procedural composition;
- packet size/tokens;
- research/reconstruction latency and cost;
- retrieval-to-injection/use rate;
- memory-enabled versus no-memory task outcomes;
- invalidation/supersession/promotion activity;
- procedures promoted into skills/rules/tests/docs.

Prefer OpenLIT's retained trace, dashboard, widget, filtering, and resource-detail infrastructure for these views rather than a parallel memory analytics backend.

The PostgreSQL injection/outcome store is at migration 10: migration 8 owns the
append-only injection and reporter-outcome tables, migration 9 adds the
B-tree index on `(workspace_id, repository_id, task_id)` used for session-wide
injection counting, and migration 10 adds the append-only `memory_session_outcome_reports`
table keyed uniquely on `(workspace_id, repository_id, task_id)` with validation and append-only triggers.
Data derives join counts with one grouped session-key
aggregate and cohort cardinality with a preaggregated session-key CTE; both use
the complete event set, including siblings outside the selected time window or
memory/outcome filters. These dimensions describe exposure cardinality only:
task outcomes remain session-level and reporter-supplied, with no trustworthy
per-turn attribution. Injection-use evidence is a separate curator assessment,
not an automatic inference or causal claim.

Each experience can retain the host-selected memory mode beside its reporter-supplied outcome for scoped cohort analysis; historical rows remain unknown rather than being backfilled, and the field does not prove a packet was injected. The router annotates each logical request span with the bounded `autodev.memory.mode` category (`jit`, `retrieval-only`, `disabled`, or `invalid`); unknown values disable automatic retrieval. `retrieval-only` is gated by `AUTODEV_MEMORY_ABLATION=1` and injects only hard-scope/status/validity-filtered candidates, explicitly marked `not_evaluated` and without current-state validation/reconstruction; it is for isolated evaluation, not production. A strict no-memory cohort must also avoid separate explicit MCP access. These modes identify request cohorts but do not infer task success. The current Runtime producer exports bounded operation/duration, candidate-stage, packet-size, and actual packet-injection metrics through the OpenTelemetry API. Orchestrator memory preparation now runs within the same logical routed-request trace as provider attempts: the `memory.research` stages are children of that request, and its span records the selected mode plus whether a packet was actually appended and its bounded size. The logical request's success/failure remains a provider-routing outcome, not a task/PR outcome or proof that the agent used the packet. Configured provider-backed embedding calls use a child GenAI embeddings span with bounded model/provider metadata and observed input-token usage. When an optional embedding provider reports an unavailable condition, Runtime marks the embedding span as an error and falls back to lexical retrieval; invalid vector output remains a hard error. Memory metric dimensions are fixed operation/outcome, memory kind, lifecycle stage, and reason-code categories; the injection counter additionally uses bounded result and mode categories. The `autodev.memory.outcome_reports` counter increments only for newly appended reports, never idempotent retries, and uses bounded report-kind/outcome/mode/injection-result values from the matched event; it contains no correlation token or task/session/memory identifiers. The `autodev.memory.session_outcome_reports` counter increments only for newly appended session-level reports, keyed uniquely on `(workspace_id, repository_id, task_id)`. Packet tokens are reported only when a token counter exists. Injection counts distinguish a non-empty packet actually appended to the provider request from an empty research result; they do not assert downstream use or task success. Model cost remains owned by GenAI telemetry. Runtime now stores an append-only, content-free injection decision for each observed request (mode, injected/empty/skipped result, packet size, and durable memory IDs), including disabled/invalid skip decisions when the memory database is available and a validated repository workspace is present; missing or untrusted workspace identity leaves the cohort unknown. Disposable PostgreSQL/pgvector integration verified migrations 8–10, the end-to-end operator Control API report/join across distinct request run/thread IDs, idempotent concurrent reports, and append-only event triggers. Operators with the explicit task-history grant can inspect those events on a captured experience and append one evidence-backed report per correlation token through `GET/POST /control/memory/experiences/:id/outcomes` or a single session-level outcome report through `GET/POST /control/memory/experiences/:id/session-outcomes` (or `/session-outcome`); raw experience rows remain immutable, outcomes are never inferred from provider request success, retrieval, or a PR link, and the opaque token never enters prompts or telemetry attributes. The join is session/task-level: one captured Codex session can contain multiple request-level injections, so this does not establish a one-to-one task/run mapping or prove downstream model use. The persisted join powers `GET /control/memory/cohorts`, an operator/task-history-granted repository/time-scoped read capped at 365 days that groups observed injection exposures with reporter-supplied outcomes and retains explicit unreported cells; it returns counts and bounded dimensions, not task success or model use. The append-only store and session outcome reports power `GET /control/memory/session-cohorts`, an operator/task-history-granted repository/time-scoped read that deduplicates outcomes to unique sessions by canonical session key `(workspace_id, repository_id, task_id)`. Session mode is derived from the session's complete injection set so filters never reclassify a session. Sessions with multiple distinct modes derive mode `mixed`, are excluded from `cells`/`sessionCount`, and are counted only in `mixedModeSessionCount`; sessions whose complete injection set is a single `invalid` or `unknown` mode are excluded from this response entirely, never coerced to `disabled` and never counted in `sessionCount` or `mixedModeSessionCount`. Conflicting session outcome reports fail closed with 409 Conflict at write time; `conflictingOutcomeSessionCount` is a separate per-injection-token-report diagnostic that never overrides the canonical session report and may overlap with `mixedModeSessionCount`. Cells group only eligible single-assigned-mode sessions by `(memoryMode, outcomeKind)`, returning `sessionCount`, `reportedSessionCount`, `unreportedSessionCount`, `conflictingOutcomeSessionCount`, and `mixedModeSessionCount` matching schema `autodev-memory-session-outcome-cohorts-v1`. These counts represent intention-to-treat session outcomes, not verified task success, retrieval-to-use, or causal effect. The retained OpenLIT Memory page exposes an outcome-cohort table with bounded filters and explicit unreported cells; the tested 17-patch OpenLIT prefix passes seven focused upstream Jest suites (66/66) and its patched-client typecheck; the full 21-patch apply test passes, patched-client typecheck passes, eight focused upstream Jest suites pass (61/61), and the p21 `linux/arm64` image builds in an isolated pinned-source worktree. The validation image is not in the standard lock; the running deployment remains at p14 and deployed receiver/UI acceptance is pending. It presents reporter-supplied counts only, not task success, model use, PR verification, or causal effectiveness. The live OpenLIT deployment remains on its previous image; the Next Console `/memory` route now provides only a validated portal link to the retained page, not a second memory UI. When `AUTODEV_MEMORY_EXPERIMENT_ID` is set, Runtime assigns one stable memory arm per Router-identified Codex session using SHA-256 bucketing across the opaque experiment salt, workspace, repository, and session key. All router replicas must share the same experiment ID. The experimental unit is a session, not an individual request; assignment requires `AUTODEV_MEMORY_ABLATION=1` and a trusted absolute workspace. Missing, process-fallback, or conflicting identity selects `invalid` (no injection), never the `disabled` control arm, and never substitutes `requestId`. Invalid requests without an identified session do not emit a synthetic exposure. When no experiment is configured, Runtime preserves the default `AUTODEV_MEMORY_MODE` behavior. The experiment ID is not persisted in injection records, so operators must record it and isolate experiments by repository and time window; deterministic hashing is approximately balanced, not fixed-block allocation. To preserve strict cohort isolation, participating agents must not have explicit Memory MCP access enabled. Cohort aggregates count request-level exposures, not unique sessions or independent tasks; outcome reports remain session-level and reporter-supplied, so sessions with multiple tasks or injections cannot support precise per-turn attribution. Experiment IDs and session identifiers remain excluded from telemetry labels. AutoDev does not infer task success, PR verification, or model use from retrieval or provider routing. The Git verifier detects conventional direct reverts of cited source commits in reachable local history by requiring the standard `Revert` subject and exact body marker, but not manual/nonstandard reverts. Automatic PR review/check validation, issue-state validation, reopened-PR and superseding-change detection, trustworthy per-turn task outcomes and controlled real-task effectiveness measurements remain unimplemented; automatic memory-use inference is intentionally not used. Curator-assessed injection-use counts are separately stored and queryable, but the retained OpenLIT use-report/cohort UI is pending and those assessments are not objective or causal use rates.

### Optional secondary dependency: Graphiti

[Graphiti](https://github.com/getzep/graphiti) is the preferred optional temporal graph index when relationship traversal becomes valuable. It is strong at incrementally building temporally-aware entity/relationship graphs, preserving event/reference time, and querying changing relationships. Its MCP server can also support exploratory graph access.

Use it for relationships such as:

~~~text
subsystem ──owns──> responsibility
PR ──fixes──> issue
commit ──supersedes──> prior implementation
skill ──applies-to──> subsystem
decision ──valid-during──> commit range
~~~

Do **not** make Graphiti the canonical memory store. PostgreSQL remains authoritative and selected memories/episodes are projected into Graphiti. Detailed trajectories, permissions, promotion state, evidence links, and procedures remain relational/document records.

Do not add Graphiti initially unless measured workloads demonstrate that graph/temporal relationship queries improve retrieval. Its MCP server should be treated as an optional research/read surface; durable writes still pass through AutoDev governance.

### Reuse ideas or components selectively

These systems contain useful mechanisms, but should not become AutoDev's memory authority:

| System | Reuse / learn from | Does well | Do not adopt wholesale because |
| --- | --- | --- | --- |
| [Mem0](https://github.com/mem0ai/mem0) | Candidate extraction, consolidation/reranking experiments, entity/run scoping patterns | Packaged memory extraction/search, multiple stores/providers, scoped memory APIs | Its normal lifecycle emphasizes write-time extracted facts; AutoDev requires retained raw evidence plus task-time reconstruction. OSS graph memory is no longer available as the former external graph-store feature, while richer graph behavior is Platform-owned |
| [LangMem](https://github.com/langchain-ai/langmem) | Extraction/consolidation prompts, hot-path/background memory-manager patterns, procedural/semantic memory concepts | Functional memory primitives decoupled from persistence and mature reflection patterns | Python/LangGraph adoption would introduce another orchestration/runtime stack beside AutoDev's TypeScript architecture |
| [Letta / MemFS](https://github.com/letta-ai/letta-code) | Tiered working/external memory, git-backed versioning, shared attached memory, dreaming/reflection, memory hygiene | Strong stateful-agent and inspectable/versioned memory UX | Letta brings its own agent identity/runtime/harness model and would duplicate AutoDev orchestration; borrow mechanisms rather than replacing the runtime |
| [Pathrule](https://github.com/pathrule/core) | Repository-path proximity as a first-class retrieval/injection signal | Coding-specific, path-scoped JIT context; avoids relying only on similarity | Its rules/skills/context authority overlaps RuleSync and AutoDev; incorporate path scoring rather than add a competing policy/context plane |
| [General Agentic Memory](https://github.com/VectorSpaceLab/general-agentic-memory) / JIT-memory research | Deep-research-style memory researcher, hierarchical navigation, raw-history-first retrieval | Demonstrates iterative research over preserved experience rather than one-shot top-k injection | Research-oriented Python stack and memory product are unnecessary if AutoDev implements the researcher behind its own contracts |
| [MemHarness](https://github.com/KnowledgeXLab/MemHarness) | Critique → reconstruct → reject/fallback stage and utility-based pruning ideas | Demonstrates that state-aligned reconstruction can outperform raw replay and avoid negative transfer | Its GRPO/verl/vLLM/Milvus research training stack is not required for AutoDev; use a strong existing model for reconstruction first |
| Voyager-style skill libraries | Trajectory → validated procedure → explicit skill promotion | Converts repeated successful behavior into deterministic reusable capability | The useful idea is already compatible with RuleSync/Agent Skills; no separate Voyager runtime is needed |

Any extractor from Mem0/LangMem or another project must produce **candidate** memories behind the AutoDev interface. It does not receive direct authority to mutate shared durable memory.

### Components AutoDev must own

The following encode AutoDev-specific semantics and should remain custom TypeScript contracts/services:

| Component | Responsibility | Why it must be AutoDev-owned |
| --- | --- | --- |
| **Experience envelope** | Wrap normalized trajectory records with workspace, repository, task/run, agent/role, branch, base/head SHA, PR/issue, outcome, validation, and evidence references | Generic transcript formats cannot know AutoDev/GitHub lifecycle semantics |
| **Memory schema** | Episodic/semantic/procedural types, scope, provenance, validity, supersession, confidence/validation state, utility | These states define AutoDev's durable-memory contract |
| **Scope/governance** | Decide who can see, propose, promote, invalidate, or supersede task/role/repository/global memory | Generic stores cannot safely infer AutoDev's root/worker/reviewer authority model |
| **JIT researcher** | Decompose the task, retrieve candidates, follow evidence, and request additional current/historical context | Must understand repositories, paths, commits, PRs, skills, roles, and AutoDev task types |
| **Current-state validator** | Check branch/commit ancestry, changed files/symbols, reverts/superseding PRs, current RuleSync policy, runtime/config state | This is the core protection against historically correct but currently wrong memory |
| **Curator/reconstructor** | Compare historical and current evidence; classify candidate as applicable, partial, stale, contradicted, or uncertain; produce adapted guidance | Applicability is task/state dependent and cannot be delegated to vector ranking |
| **Context packet builder** | Bound, deduplicate, prioritize, and cite reconstructed memories for the active agent | Controls context cost and prevents arbitrary history dumps |
| **Promotion pipeline** | Move repeated/validated procedures into canonical skills/rules/tests/docs and invalidate redundant fuzzy memories | Only AutoDev knows its explicit configuration and development-lifecycle authorities |
| **Evaluation/ablation layer** | Compare no-memory, retrieval-only, and JIT-reconstructed variants using real task outcomes | Memory must prove value in AutoDev's workload rather than inherit benchmark claims |
| **Memory MCP facade** | Expose run-bound experience append plus governed search/read/history/propose/invalidate/research operations to heterogeneous agents | Direct PostgreSQL/Graphiti access would bypass authorization, provenance, validation, and promotion rules |

The custom layer should orchestrate existing dependencies, not reimplement their storage/indexing/transport capabilities.

### Memory access paths

Do **not** route every memory interaction through MCP. The canonical implementation is one shared TypeScript `MemoryService` with multiple adapters.

Normal AutoDev memory use is automatic and orchestrator-driven:

~~~text
task arrives
    ↓
AutoDev orchestrator
    ↓
MemoryService.research(...)
    ↓
JIT retrieval + current-state validation + reconstruction
    ↓
bounded memory packet
    ↓
agent context
~~~

The active agent should generally begin with relevant memory already present. Memory quality must not depend on the model remembering to call a tool.

Use these access paths:

| Interaction | Access path |
| --- | --- |
| Raw trajectory/execution capture | Native runtime + OpenTelemetry/transcript ingestion; explicit MCP append accepts host-scoped metadata and source references without transcript payloads |
| Durable memory persistence/search internals | `MemoryService` → `data/` adapters |
| Automatic pre-delegation JIT research | Native orchestrator → `MemoryService.research(...)` |
| Automatic memory-packet injection | Native runtime/context assembly |
| Consolidation, promotion, supersession, retention | Internal runtime/background workflows |
| Console browse/manage operations | Control API → AutoDev Memory connector/adapted OpenLIT Memory surface → shared memory contracts |
| Operator investigation/analytics | Adapted OpenLIT Memory page, traces, dashboards, and optional Otter tools |
| Agent discovers a new memory need during execution | Memory MCP tool call or equivalent native tool adapter |
| External Codex/Claude/Gemini/other client | Memory MCP facade |
| Direct PostgreSQL/Graphiti access by agents | **Never** |

Automatic native capture is wired for Codex and opt-in Claude Code SessionEnd
hooks; the other supported trajectory formats remain manually importable.
Claude Code's `session_id`, `cwd`, and `transcript_path` are not treated as an
AutoDev Router session key or as workspace authority. Capture requires an
operator-owned binding that maps one canonical repository root and its
workspace/repository identity to that workspace's distinct, non-overlapping
transcript directory. The Control API rejects missing/ambiguous bindings,
nested or ancestor cwd matches, transcript paths outside the matched
workspace's directory, and a transcript basename that does not match the hook
session ID. Claude session
outcome remains `unknown`; capture does not claim a router-session mapping or
task success. See the [official Claude Code hook reference](https://code.claude.com/docs/en/hooks)
and the local [memory capture notes](../config/memory/README.md).

Internal AutoDev callers must invoke the shared service directly rather than serializing an in-process request through MCP:

~~~text
AutoDev runtime ─────────────────────────► MemoryService
Console ──Control API/OpenLIT adapter─────► MemoryService
external/loosely-coupled agent ─MCP──────► MemoryService
~~~

MCP is therefore an **interoperability and explicit follow-up boundary**, not the internal memory architecture. It is appropriate when an agent learns something during execution that changes what history it needs, for provenance/history inspection, for proposing a durable memory, or when the caller is outside the AutoDev runtime.

### Agent-facing interface

Expose memory through a small native/MCP contract, for example:

~~~text
experience.append  # host-bound task/run/agent; source reference and digest only
experience.search
experience.get

memory.search
memory.get
memory.history
memory.why
memory.propose
memory.invalidate
memory.research
~~~

Exact tools may be combined as the API matures. Read results should include scope, status, provenance, source evidence, and applicability/validation information.

Workers can append host-bound experience envelopes with source references through `experience_append`; the MCP tool does not accept transcript payloads or caller-selected scope. Workers should normally append experience and **propose** durable memory. Promotion/invalidation of shared memory follows governance. Agents do not write directly to PostgreSQL or Graphiti.

### Retrieval signals for coding work

AutoDev's reranker should explicitly include signals generic memory systems often lack:

~~~text
repository/workspace match
path proximity
symbol/entity overlap
branch/commit ancestry
relevant-file change since source memory
PR/issue/commit relationship
task type + agent role
semantic similarity
lexical/exact match
provenance/validation quality
historical utility
recency / temporal validity
~~~

Path and Git lineage are first-class evidence, not merely metadata.

### Implementation order

1. **Foundation:** keep OpenLIT/OTel as execution evidence **and retain/adapt the OpenLIT Memory connector/page**; implement an AutoDev Memory connector over `MemoryService`; adopt @letta-ai/trajectory where its harness adapters fit; add PostgreSQL + pgvector/full-text persistence; implement AutoDev schemas, governance, JIT researcher/validator/curator, packet builder, and MCP facade.
2. **Coding-aware retrieval:** add path proximity, commit ancestry/file-change checks, PR/issue relationships, and measured retrieval/ablation telemetry.
3. **Temporal graph only when justified:** project selected entities/relationships to Graphiti if graph queries measurably improve results.
4. **Extractor experiments:** benchmark native extraction against Mem0/LangMem-derived candidate generators behind the same interface.
5. **Specialized researcher/training only if needed:** use JIT-memory/MemHarness techniques or trained policies only when evaluation shows the frontier-model JIT researcher is a material bottleneck.

Do not introduce Qdrant, Milvus, Pinecone, a second agent framework, or another memory control plane by default. Add specialized infrastructure only after Postgres/hybrid retrieval or the custom JIT layer shows a measured limitation.

## 11. Console target

The **adapted OpenLIT Memory page is the primary AutoDev Memory operator surface**. Extend it; do not create a parallel memory admin/dashboard application. The Next Console `/memory` route is only an entry card to the browser-reachable OpenLIT Memory page (`AUTODEV_OPENLIT_UI_URL`); it does not duplicate list/detail/cohort or mutation UI.

It should combine:

- connector selection/configuration/health where multiple or external stores exist;
- browse/search/pagination across episodes, semantic memories, procedures, and source trajectories;
- repository/workspace, role, task/run, type, status, and time filters;
- provenance, source evidence, PR/commit/file/entity links, and current-state verification;
- active/superseded/invalidated/uncertain lifecycle state;
- relationship/history/graph views where useful;
- observed retrieval/reconstruction/injection/use and related traces;
- memory effectiveness, quality, latency/cost, and lifecycle analytics from OpenLIT telemetry;
- governed propose/verify/revise/invalidate/supersede/promote actions and an evidence-backed operator report form for observed injection outcomes;
- promotion of suitable procedures through the canonical skill/configuration path;
- optional operator Q&A through retained Otter memory tools when Otter remains in the AutoDev distribution.

Reuse OpenLIT's shared table, filter, detail, graph, connector, chart, status, loading/error, and trace-linking primitives so Memory behaves like the rest of the AutoDev Console.

Do not restore organization/project/environment/account tenancy concepts removed by the Console target, and do not let the OpenLIT connector/UI layer become a second memory source of truth.

## 12. Acceptance and evaluation

The target is satisfied when:

- raw trajectories survive independently of derived summaries;
- derived memories retain evidence provenance;
- retrieval respects repository/workspace/task/role scope;
- stale/superseded memories can be identified and excluded;
- current authoritative state is consulted before high-impact remembered guidance is used;
- retrieval can retain, revise, or reject candidates before injection;
- agents receive bounded task-specific packets rather than unbounded history;
- workers cannot freely pollute shared durable memory;
- proven procedures can graduate into explicit skills/rules/tests/docs;
- memory use is observable in OpenLIT and can be compared with no-memory/simpler-memory baselines;
- the retained OpenLIT Memory connector/page can browse and inspect AutoDev memory without bypassing `MemoryService` governance;
- secrets and unnecessary sensitive payloads are not persisted by default.

Measure memory changes with outcomes such as task/PR success, repeated failures, tool calls/tokens to completion, stale-memory rejection, retrieval/use rate, harmful memory application, and successful transfer to new tasks. Prefer controlled ablations over assuming more context is better. See [memory injection outcome evaluation](memory-injection-outcome-evaluation.md#controlled-ablation-assignment) for experimental unit (`sessionKey`), deterministic hash bucketing across `jit` / `retrieval-only` / `disabled`, strict cohort setup, and reporter-supplied outcomes.

## 13. Design basis

This target combines the strongest recurring ideas in agent-memory work:

- **Just-In-Time Memory:** preserve experience and perform task-aware curation at retrieval time.
- **MemHarness:** critique/reconstruct retrieved experience against current state; raw replay can cause negative transfer.
- **MemGPT/Letta:** separate bounded working context from larger archival memory.
- **Voyager:** promote reusable procedures into explicit skills.
- **MemoryArena:** external memory does not replace reasoning and can fail on deeply interdependent tasks.
- **Governed shared-memory work:** multi-agent memory requires scope, provenance, supersession, and controlled propagation.

These are design inputs, not dependencies on a specific memory product. AutoDev may reuse OpenLIT memory primitives or another implementation when it satisfies this contract without creating a competing architecture.
