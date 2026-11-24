# Memory Target State

> **Authority:** Focused target-state design for AutoDev memory. It is subordinate to [`autodev-console-target-state.md`](autodev-console-target-state.md), which remains authoritative for repository-wide architecture, module ownership, Console behavior, RuleSync ownership, and observability/control-plane boundaries.
>
> **Goal:** Reuse useful cross-task experience without turning stale model-generated summaries into hidden policy or a competing source of truth.
>
> **Selected target (decision):** Use **self-hosted Mem0 OSS** as the sole long-term memory engine, exposed to agents by a **self-hosted Python Mem0 MCP server with OpenLIT initialized in that same Python process**; neither Mem0 Platform nor its hosted MCP is the target. Use **OpenLIT/OpenTelemetry** for memory management UI and telemetry inside the **AutoDev Console**. AutoDev owns only integration, trusted identity/scoping, current-state applicability checks, bounded injection, and effectiveness evaluation—not a custom durable memory database, extractor, indexer, consolidator, general-purpose memory server, or second memory UI.
>
> **Status:** This is a **migration target, not a claim of implementation**. The currently deployed/code-backed memory foundation remains AutoDev PostgreSQL/pgvector + `MemoryService` + its own MCP; see [current local setup](../config/memory/README.md) and [evaluation contracts](memory-injection-outcome-evaluation.md). Do not remove working paths or claim Mem0/OpenLIT parity until tested.

## 1. Principles

1. **Keep raw experience.** Preserve meaningful trajectories and outcomes instead of relying only on summaries written before future needs are known.
2. **Curate at read time.** Retrieve for the current task, compare with current authoritative state, then reconstruct a small task-specific memory packet.
3. **Treat memory as evidence, not authority.** Git/repository state, RuleSync, version-controlled policy, and live runtime state override remembered claims.
4. **Separate types and scopes.** Episodic, semantic, and procedural memory have different lifecycles; task-private, role, repository/workspace, and global memory must not collapse into one shared store.
5. **Promote proven procedures.** Stable, repeatedly validated procedures should become explicit skills, rules, tests, or documentation.
6. **Reuse the memory engine, keep policy thin.** Mem0 owns learning, consolidation, persistence, indexing, and retrieval; AutoDev retains only responsibilities coupled to its execution, Git, authorization, and product contracts.

The target is not conversation history plus vector search. It is a provenance-bearing, scoped, temporal memory lifecycle.

## 2. Target architecture

~~~text
AutoDev execution / tool evidence / native transcripts
       |  bounded, redacted, provenance-bearing capture
       v
AutoDev integration (trusted repository/task/agent scope)
       |  Local Python Mem0 OSS SDK: add + search
       v
Self-hosted Mem0 OSS (local memory authority)
       |  extraction, consolidation, storage, semantic recall, updates
       +------------------------+
       |                        |
       v                        v
AutoDev JIT retrieval      Self-hosted Python Mem0 MCP
       |                   (only trusted/scoped clients)
       v
Scope + Git/current-state verification
       |
       v
Small, cited advisory memory packet -> agent

OpenLIT SDK in Python MCP process -> OTLP -> OpenLIT / AutoDev Console
OpenLIT Mem0 operator adapter (OSS parity verified) -> Console /memory
~~~

**Single durable memory authority:** Mem0. AutoDev's existing PostgreSQL memory records, full-text/pgvector search, consolidator/curator, and `autodev_memory` MCP are **transitional implementations**, not components to maintain indefinitely alongside Mem0. Do not instantiate both active memory write paths in production.

**Distinct non-memory authorities:** Git/RuleSync/runtime configuration remains authoritative for current code and policy. AutoDev retains its existing execution evidence and telemetry contracts; that evidence is not a second searchable long-term memory product.

**Transport is not authority:** the self-hosted Python Mem0 OSS SDK is the memory engine API; the local Python MCP server exposes narrowly scoped memory tools to approved agents. Internal orchestrator code can use trusted local SDK/API calls rather than routing every call through MCP. Do not connect agents to the hosted Mem0 Platform MCP or rely on Mem0 Cloud for durable storage.

**Instrumentation boundary (required):** initialize OpenLIT inside the **same Python process** that hosts the Mem0 MCP tools, before loading/using the Mem0 library. Instrument both compatible MCP operations and Mem0 `Memory`/`AsyncMemory` methods; export OpenTelemetry spans to the existing OpenLIT OTLP receiver. A separate OpenLIT process or MCP-side tool-call telemetry alone does **not** provide visibility into Mem0 internals. Verify correlated end-to-end spans, including Mem0 add/search/update/delete, with a real local deployment. OpenLIT instrumentation is version-sensitive and may not cover arbitrary internal storage calls.

**Local operation:** deploy and persist Mem0's local store/vector database and configure an approved local embedding/LLM backend if a fully offline installation is required. Validate storage, model, OS, resource, and backup requirements; self-hosted does not imply offline unless every dependency is local. Reuse a maintained community/local Python MCP adapter only after security and compatibility validation; do not assume Mem0's official hosted MCP supports OSS.

## 3. Memory model

### Raw experience

Retain enough of each meaningful execution to reconstruct its outcome:

- task, plan, delegation, and agent role;
- relevant context references, tool calls, and observations;
- code/config/document changes;
- validation, reviews, failures, retries, corrections, and outcome;
- workspace/repository, refs/SHAs, timestamps, provider/model, selected memory mode, and relevant entities.

Prefer references to large source artifacts over duplicated copies.
Native transcript captures also retain the source-adapter identifier,
normalizer package/version, and distinct normalization diagnostic codes beside
the trajectory reference. These fields are omitted for historical or manually
appended envelopes when provenance is unavailable. Persist codes only, never
diagnostic free text, normalized records, transcript payloads, prompts, or tool
arguments/results.

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

~~~text
Agent activity -> AutoDev captures trustworthy, bounded evidence references
               -> redaction/egress review and explicit scope
               -> trusted Mem0 add/ingestion
               -> Mem0 extraction, deduplication and memory updates
               -> Mem0 long-term memory available for future scoped recall
~~~

Use Mem0's maintained extraction, update, consolidation, and lifecycle facilities rather than implementing equivalent AutoDev memory algorithms. Prefer asynchronously ingesting completed and validated executions; optional interim capture must not block tools or the agent's response stream.

**Boundary:** AutoDev constructs the payload and validates who may publish it. It supplies only approved, minimal context (task/role/repo, relevant result, redacted facts/lessons, source references, verified outcome status) rather than raw tool arguments, secrets, private files, or whole transcripts by default. `@letta-ai/trajectory` can normalize native captures before a privacy-safe summary is sent. If provider ingestion requires more content, obtain an explicit egress decision and retention policy; never silently widen capture.

Map AutoDev's trusted workspace/repository, role, task/run, agent, and source identity to Mem0's supported identity fields and metadata. **Do not assume** a `user_id`, `agent_id`, `app_id`, `run_id`, tags, or provider-side search filters alone enforce AutoDev's access-control hierarchy: define an unambiguous mapping and test every cross-scope read/write, including source attribution in extracted memories. Never accept agent-authored tenant IDs as authority.

Workers may record authorized task-local evidence. Publishing to shared repository knowledge must pass a host/root/curator approval policy, or be constrained to a dedicated untrusted candidate area until verified. Mem0's automatic updates must not silently promote an unsupported claim into policy. Preserve source evidence and provider record IDs so an operator can inspect, correct, supersede, or delete provider memories.

Failures should retain conditions and evidence; treat unknown outcomes as unknown. Proven procedures graduate into version-controlled RuleSync skills/tests/docs, not another provider-controlled policy plane.

## 7. Read lifecycle: Just-In-Time memory

~~~text
Current task and trusted workspace/repository context
       -> host-authorized Mem0 recall/search
       -> narrow, bounded candidate set
       -> cite origin, verify current Git/RuleSync/runtime state
       -> retain / revise-for-this-task / reject / mark uncertain
       -> one deduplicated, token-bounded, advisory packet
       -> agent
~~~

AutoDev should retrieve automatically at **root-turn/task boundaries** so usefulness does not depend on a model remembering an MCP tool. Direct Mem0 MCP search is an optional follow-up for trusted agents, **never a bypass** around the normal authorization and injection path.

Retrieval must enforce scope before request and after results; missing, ambiguous, or mismatched workspace identity fails closed to **no memory**. Favor coding-specific signals—exact symbols, paths, errors, repository and role, task type, commit lineage, PR/issue links, current file content, temporal validity, provenance quality, and observed utility—where provider filtering/ranking permits. Do **not** rebuild an independent AutoDev vector/BM25/graph reranker to duplicate Mem0; reserve a small applicability filter for provider results.

**Applicability check:** Mem0 recall indicates historical relevance, not current truth. Before presenting high-impact advice, check cited code/commit/PR/RuleSync references against the current repository. Reject stale, reverted, superseded, scope-incompatible, or unverifiable statements; do not let an LLM's summary override fresh source evidence. For older unverified memories return no packet (or explicitly uncertain non-directive history), not invented confidence.

Preserve current AutoDev behavior where useful: no memory injection for compaction/tool-result continuations, bounded provider calls and concurrency, failure without blocking the task, minimal evidence references, prompt-injection-safe quoting, one advisory packet only, and OTel spans for each stage. Provider outage or rate limit means an explicitly observed skip/fallback, not silently switching back to an independent production memory database.

Mem0 `search` is a candidate source, not authorization or proof of downstream use. Record retrieved, screened, rejected, injected, and **assessed-used** outcomes separately. Retain controlled no-memory baseline behavior, including disconnecting independent MCP access in disabled cohorts.

## 8. Task-specific packet, validity, and provenance

Agents receive a compact advisory packet, not arbitrary historical chunks. It may contain relevant decisions, successes/failures, procedures, conflicts, uncertainty, and source references.

Mem0 manages durable memory writes, updates and deletes under its own provider semantics; **do not assume provider memory is append-only** or that it supports AutoDev's entire former lifecycle schema. The integration should convey vetted applicability and display only statuses backed by observed evidence, including active, stale/uncertain, superseded, or deleted **when determinable**. Unknown lifecycle facts remain unknown.

Preserve source and temporal metadata when supported by the selected Mem0 API and approved retention policy:

~~~text
source / trajectory reference
created_at / observed_at
valid_from / valid_to (if supported)
last_verified_at / verification_source (if observed)
supersedes / superseded_by (if supported)
~~~

Link to existing execution/evaluation evidence for history the provider does not preserve; do not invent a second AutoDev memory database to recreate unavailable provider features. Contradictions trigger current-state screening before injection. Superseded episodes remain inspectable from retained approved source evidence where permitted, not by assuming Mem0 preserves every prior version.

## 9. Storage, retention, and module ownership

| Concern | Target owner | Boundary |
| --- | --- | --- |
| Durable memories, extraction, updates, storage, indexing, search, consolidation | **Self-hosted Mem0 OSS** | One local memory authority; avoid custom PostgreSQL/pgvector tables or duplicate search pipelines |
| Local Mem0 lifecycle, Python MCP tool interface and SDK compatibility | **Mem0 OSS + self-hosted Python MCP adapter** | Pin and validate the SDK/tool contract and local persistence; do not assume Platform API parity |
| Historical task execution and trajectory source references | **AutoDev runtime + approved existing telemetry/artifacts** | Evidence and outcome events are not a second long-term memory store |
| Trusted identity, allowlists, scope policy, Git/current-state verification, injection budgets, experiment assignment | **AutoDev runtime/core** | Thin integration/safety wrapper; do not rebuild general memory logic |
| Memory operator browse/manage, connector health, search/detail/graph/chart primitives | **OpenLIT provider connector adapted into AutoDev Console** | Single operator surface; provider mutations happen only through authorized server routes |
| Memory latency/tokens/cost, traces, cohorts and evaluated outcomes | **OpenTelemetry/OpenLIT + AutoDev outcome attribution** | Historical observations, not authoritative memory state |

The existing `runtime/src/memory/`, `data/src/memory/`, PostgreSQL migrations, `autodev_memory` MCP, and PostgreSQL-backed Control API are **current implementation only**. During migration, isolate their writes and keep them readable for audit/rollback. After parity and data portability gates pass, retire redundant memory storage, indexes, service methods, custom MCP facade, UI proxies, migrations, and dependencies. Preserve distinct execution evidence/telemetry and needed historical outcome comparisons; never destructively purge prior evidence without retention approval.

Privacy must be explicit: forbid unapproved external memory/model data egress by repository/workspace; redact secrets and unnecessary sensitive files; avoid exporting raw transcripts by default; restrict keys to server-side trusted processes and do not expose them to browser, tool subprocesses, or arbitrary agents. Define provider retention, delete propagation, export/backup, tenant isolation, breach response and reversible cutover **before** ingesting production code-derived memory.

Mem0's delete/update history and retention semantics must be tested; do not claim its API provides immutable append-only evidence or all current AutoDev provenance guarantees. Preserve an independently auditable, minimal **non-memory** action/outcome trail in existing telemetry where necessary, with no extra long-term memory database.

## 10. Product and dependency strategy

### Selection and rationale

**Adopt self-hosted [Mem0 OSS](https://github.com/mem0ai/mem0) as the sole long-term memory engine.** Use a **local Python MCP server** that calls Mem0's Python SDK and initializes **OpenLIT in the same server process** before invoking Mem0. Mem0 owns extraction, consolidation, indexing, search, updates and deletion; AutoDev owns deployment/configuration, boundary enforcement and operational validation, not a competing memory engine. The MCP adapter is an integration layer, not a second durable memory store.

**Keep [OpenLIT](https://github.com/openlit/openlit) as AutoDev's memory UI/telemetry framework.** OpenLIT has a Mem0 provider connector and reusable list/search/detail/action/chart and trace/metric patterns. Port/adapt these **into the sole AutoDev Console**; do not restore a separate OpenLIT Memory page, generic dashboard builder, Otter/chat, or another operator console. Verify that the adapted connector actually supports the selected Mem0 OSS API and AutoDev's pinned/forked OpenLIT components; the upstream Platform connector's existence is **not** proof of OSS compatibility.

**Why not maintain the native engine?** It duplicates a general memory product inside a coding orchestrator and increases storage, retrieval, extraction, migration, test, and UI maintenance. AutoDev's differentiator is execution orchestration plus current-repository applicability, not owning a vector store. Hindsight/Claude-Mem/Graphiti remain comparison benchmarks or references, not parallel production memory authorities.

### Integration surfaces

~~~text
AutoDev runtime capture -> trusted local Mem0 Python SDK (add/ingest)
AutoDev root-turn JIT  -> trusted local Mem0 Python SDK (search)
                             -> AutoDev minimal validation + packet builder
Authorized agent -> self-hosted Python Mem0 MCP (enforced scope)
Mem0 operator reads/writes -> OpenLIT Mem0 connector/adapted server API
                                  -> AutoDev Console /memory
AutoDev runtime/provider calls -> OpenTelemetry/OTLP -> OpenLIT -> Console
~~~

Use the **local Mem0 SDK/API for internal orchestrator calls**, not serializing every in-process call through MCP. Agent-facing interoperability uses the **self-hosted Python Mem0 MCP server**, with OpenLIT initialized in that exact process. The adapter must enforce authenticated/host-verified workspace, repository, agent and role scope on every read/write; do not expose unrestricted local memory tools or model-selected identities. No second AutoDev-owned memory engine or generic memory database is a target. If the MCP adapter cannot enforce scope, omit direct agent MCP and use trusted server-side operations.

### Minimal AutoDev-owned contract

- Associate Mem0 memory IDs with opaque, stable, validated scope and evidence references. Do not let the model choose provider credentials, identity filters, or publication privileges.
- Translate AutoDev capture into a minimal allowed ingestion payload, with idempotency/deduplication handling and rate limits; don't implement memory extraction itself.
- Translate a task into scoped recall; reject out-of-scope/stale results, verify current Git/RuleSync compatibility, and form a bounded advisory packet.
- Record attempted/retrieved/injected/used outcomes and attribution through existing execution telemetry and evaluator reports, not an alternative memory store.
- Keep operator mutations permission-checked, display provider-side failures honestly, and never label provider memory presence as proof of agent usage or task success.

### Self-hosted OSS deployment and compatibility

**Self-hosted Python Mem0 OSS + co-process OpenLIT + local MCP is the selected target**, not a fallback to managed Platform. Pin compatible `mem0ai`, Python MCP SDK, OpenLIT and backing-store versions. Initialize OpenLIT before Mem0/MCP handler imports where auto-instrumentation requires it; configure a protected OTLP exporter and test parent/child trace correlation across inbound MCP calls, Mem0 operations and underlying model/embedding calls. Test process restarts, persistent data, offline/no-egress expectations, multi-agent concurrency, read/write scoping and retention/backup. Do not assume Mem0 Platform API/hosted MCP/UI connector parity, or adopt archived `mem0-mcp` / OpenMemory repositories.

### OpenLIT and Console reuse

Reuse the upstream Mem0 connector's capability/descriptor patterns and useful React list/search/detail/forms/graph/chart primitives where they survive AutoDev's OpenLIT reductions. Use one canonical server-side adapter with explicit workspace/repository/role authorization, protected Mem0 credentials and bounded list/search/update/delete operations. The current `autodev` PostgreSQL connector and legacy OpenLIT Memory patches are transitional. Console Memory should inspect **Mem0's actual state**, show provider and scope health, memory source/metadata, edits/deletes where supported, trace links, lifecycle activity, and unknown/not-observed states; do not fabricate provider features or rewrite vendor CRUD semantics as guaranteed immutable lifecycle history.

### Memory observability through OpenTelemetry/OpenLIT

Preserve the existing `autodev.memory.*` operation, candidate, injection, outcome, use, and packet-size metrics wherever their meanings still apply; adapt internal stage labels to the real Mem0 operations and distinguish **provider-observed** from **AutoDev-assessed** facts. Include capture queue/ingestion result, provider read/write/update/delete/timeout/error, filter-rejection reason, packet bytes/characters/tokens, retries, provider latency, additional model/embedding charges where observed, and end-to-end task outcome comparisons.

Initialize OpenLIT inside the self-hosted Python Mem0 MCP process and trace memory calls inside the same logical agent execution, with bounded operation names and status. Verify MCP tool spans and Mem0 SDK spans are both emitted and correlated; tracing only the MCP boundary is insufficient. Keep workspace/repository IDs, provider memory IDs, claims, transcripts, evidence paths, and correlation tokens **out of metric dimensions**; identifiers can appear only in appropriately protected, sampled and retention-governed traces/records. Do not double-count Mem0 and AutoDev token/cost observations. Unknown or vendor-unreported provider costs stay unknown.

Maintain explicit cohort isolation: `disabled` cannot call Mem0 or offer an alternative memory MCP; `retrieval-only` and `jit` experiments must have defined, matched capture histories and session-level assignment. Outcomes and use assessments are not inferred from successful API calls, packet injection, PR links, or provider status. See [memory injection/outcome evaluation](memory-injection-outcome-evaluation.md).

### Migration and rollout gates (documentation target, not implementation claim)

1. **Compatibility/discovery:** pin Mem0 OSS Python SDK, Python MCP SDK, OpenLIT instrumentation, local vector store and model/embedding versions; test local add/search/update/delete, access scopes, metadata, pagination, UI action compatibility and error mapping in a non-production deployment.
2. **Security:** enforce no unapproved repository-data egress, redaction, local service identity, per-workspace/agent isolation, data retention, backup/export/deletion and outage behavior; no unrestricted shared agent MCP access.
3. **Adapter/observability prototype:** run a self-hosted Python Mem0 MCP server with OpenLIT initialized in the same Python process, export OTLP to OpenLIT, and verify correlated MCP + Mem0 add/search/update/delete spans. Keep the native trusted capture/recall wrapper thin; leave legacy read-only memory and historical telemetry intact; disable duplicate write/injection paths.
4. **Controlled evaluation:** compare no memory, current AutoDev JIT, and Mem0 JIT on matched coding tasks. Measure task/PR success, repeated investigation, memory usefulness, retrieval accuracy, stale advice, token and provider costs, p50/p95 latency, and missed/erroneous memory.
5. **Console parity:** port/reuse OpenLIT Mem0 UI primitives in `console/`, expose provider health, browse/search/detail, supported CRUD and trace-linked metrics; verify browser acceptance and unavailable/error states.
6. **Reversible cutover:** export/verify historical useful memories with evidence and scope mapping; switch the canonical production memory owner to Mem0 only after parity and rollback tests; freeze legacy writes, preserve audit data, and then retire redundant PostgreSQL, custom search, `MemoryService` memory CRUD, custom memory MCP, and legacy UI plumbing.

If the pilot fails quality, privacy, isolation, service reliability, or cost gates, do **not** silently deploy it or retain a permanent dual-write architecture. Record a deliberate decision and revisit the provider choice.

## 11. Console target

The **AutoDev Console /memory feature is the sole operator surface**, using the same dark-only shell, navigation, tables, forms, filters, detail panels and failure-state semantics as other Console resources.

The selected provider is **Mem0**. Reuse/adapt OpenLIT's Mem0 provider connector and UI primitives inside `console/` rather than maintaining AutoDev-owned memory browsing logic or re-exposing the retired standalone OpenLIT Memory page.

Surface only capabilities confirmed by the pinned API/connector:

- provider connection/auth status and operational failure/latency;
- scoped search, list, details and supported add/update/delete actions;
- provider memory IDs, source metadata, freshness and source evidence links where available;
- source trajectories, PR/commit/file links through existing AutoDev evidence surfaces, without inventing Mem0-native governance history;
- retrieval, injection, rejected/stale candidates and provenance verification where observed in AutoDev traces;
- memory usage/cost, memory effectiveness, task outcomes and controlled cohort comparisons;
- retention/deletion and provider-export state, respecting permissions;
- not-observed/error states instead of invented counts, judgments, or causal effects.

Provider CRUD is not a substitute for AutoDev's permission checks. Provider-owned memory **must not** become RuleSync/skills/policy, the operator memory page must not become a second memory database, and source/telemetry identifiers must remain private. Do not resurrect OpenLIT tenancy concepts, Otter/chat, a second UI, or generic dashboard authoring.

## 12. Acceptance and evaluation

The target is achieved only when all of the following are demonstrated:

- A supported, version-pinned **Mem0 Platform** account owns production long-term memories, extraction, deduplication/updates, and retrieval. There is no active competing AutoDev long-term memory database/search or general-purpose MCP server after cutover.
- Automatic capture from supported agent/provider paths yields useful, source-linked memories without blocking tools or exposing unapproved source content. Failed and unknown outcomes remain distinguishable.
- Trusted workspace/repository/agent identity and publication controls prevent cross-repo leakage and unauthorized shared-memory writes, including through hosted MCP tools and the Console connector.
- The JIT path rejects out-of-scope, stale or unsupported claims against current Git/RuleSync/runtime facts and injects only a small advisory packet. Unavailable Mem0 skips clearly and does not block execution.
- The official Mem0 MCP is used only where its authentication/scope are actually enforceable; AutoDev does not maintain a replacement generic memory MCP.
- OpenLIT's Mem0 connector/UI capabilities appear **within AutoDev Console**, including real read/write error states and trace-linked latency, token/cost, capture, retrieval and injection telemetry.
- Operator mutation, exports, deletions and retention follow explicit policy. Credentials never appear in prompts, browser code or model-spawned tools.
- No-memory and incumbent-memory baselines demonstrate that Mem0 improves or at least meets task outcomes within accepted cost/latency limits; extraction/ingestion cost and actual memory use are measured, not inferred.
- Migration is reversible, historical evidence/outcome reports survive by defined retention rules, and old PostgreSQL/pgvector memory, bespoke indexers, generic MemoryService engine and old MCP/UI plumbing are removed **only after** validated parity.

Use [injection/outcome evaluation](memory-injection-outcome-evaluation.md) for the currently implemented experimental attribution rules and update it during the cutover so provider operations remain measured under the same session/cohort contract. A successful provider request or a PR link is never automatically a task-success report.

## 13. Design basis and references

This decision adopts a maintained memory product rather than assembling a custom one. Ideas retained from existing agent-memory work are: just-in-time state-aware retrieval, explicit evidence provenance, compact working-context packets, task-scoped multi-agent isolation, and promoting repeatedly verified procedures into canonical skills/rules/tests/docs.

- [Mem0 Platform quickstart/API](https://docs.mem0.ai/platform/quickstart) — managed memory storage, extraction and retrieval SDK/API.
- [Official Mem0 MCP](https://docs.mem0.ai/platform/mem0-mcp) — supported agent tool transport. Archived historical MCP repositories are not the target.
- [OpenLIT](https://github.com/openlit/openlit) — Mem0 memory connector and telemetry/UI building blocks; verify compatibility with AutoDev's pinned fork.
- [AutoDev operational memory notes](../config/memory/README.md) — **current implementation** and migration baseline, not the new provider target.
- [AutoDev evaluation and outcome rules](memory-injection-outcome-evaluation.md) — current append-only reporting/attribution rules that must survive provider cutover.

Hindsight, Claude-Mem, LangMem, Letta and Graphiti may be used in comparative evaluations, but they are not simultaneous production memory authorities. No parallel custom memory engine is part of the target.

