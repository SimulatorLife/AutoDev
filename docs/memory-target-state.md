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
- workspace/repository, refs/SHAs, timestamps, provider/model, and relevant entities.

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
- **`console/`** — Memory browse/search, provenance/history, scope/status, and management UX.

Physical storage may combine append-oriented events, structured records, full-text search, vector indexes, and optional temporal/entity graphs.

Use graph indexes only where relationships materially help: ownership, dependencies, PR/issue/commit links, supersession, temporal changes, and agent/skill/tool/workspace relationships. Do not force every trajectory or observation into graph form.

Memory must not become an unbounded secret/context copy: redact credentials and unnecessary sensitive payloads, prefer references over duplication, retain provenance, and support retention/deletion by memory class.

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
 AutoDev memory runtime   optional Graphiti
 JIT/governance/curator   temporal graph index
          │
          ▼
 official MCP TypeScript SDK
          │
          ▼
 AutoDev Memory MCP / native API
          │
          ▼
 root + workers + reviewers
~~~

### Direct dependencies

| Dependency | Use directly for | Why | Boundary |
| --- | --- | --- | --- |
| [OpenTelemetry](https://opentelemetry.io/) + [OpenLIT](https://github.com/openlit/openlit) | Execution traces, tool/LLM/subagent activity, costs, evaluations, and source evidence | AutoDev already uses the OTel/OpenLIT observability plane; do not build a second execution logger | OpenLIT is evidence/observability, not canonical mutable memory |
| [@letta-ai/trajectory](https://github.com/letta-ai/trajectory) | Normalize supported Codex, Claude Code, Copilot CLI, Gemini CLI, OpenHands, Letta, and other native transcripts into deterministic records | Avoid writing/maintaining one transcript decoder per harness; it is TypeScript and exposes a validated shared trajectory schema | AutoDev still owns repository/task/run/PR/commit/outcome metadata and any unsupported adapters |
| PostgreSQL | Canonical durable memory records, provenance, scopes, lifecycle state, supersession, utility/evaluation metadata | Memory is mostly structured mutable state requiring transactions, joins, filters, and history | Do not use ClickHouse telemetry tables as the canonical mutable memory database |
| [pgvector](https://github.com/pgvector/pgvector) | Semantic retrieval inside the same PostgreSQL store | Adds vector/HNSW or IVFFlat search without introducing a separate vector database | Vector similarity is one ranking signal, never the applicability decision |
| PostgreSQL full-text/GIN indexes | Exact/lexical retrieval for symbols, filenames, errors, PRs, SHAs, and technical phrases | Coding memory frequently depends on exact identifiers that embeddings can miss | Combine with structured filters and vector ranking |
| [official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Standard agent-facing memory server/client transport | Keeps memory usable across Codex, Claude, Copilot, Antigravity, and other MCP-capable agents without coupling the memory core to one harness | AutoDev owns the tools and authorization semantics; MCP is transport/interoperability |
| Git/GitHub + RuleSync/AutoDev configuration | Current-state verification and canonical-source checks | These are the authoritative sources needed to decide whether old memory still applies | Query them during JIT validation; never copy their authority into memory |

Prefer the existing provider/model abstraction for embeddings and reconstruction models. Do not create a dedicated model-routing subsystem for memory.

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
| **Memory MCP facade** | Expose governed search/read/history/propose/invalidate/research operations to heterogeneous agents | Direct PostgreSQL/Graphiti access would bypass authorization, provenance, validation, and promotion rules |

The custom layer should orchestrate existing dependencies, not reimplement their storage/indexing/transport capabilities.

### Agent-facing interface

Expose memory through a small native/MCP contract, for example:

~~~text
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

Workers should normally append experience and **propose** durable memory. Promotion/invalidation of shared memory follows governance. Agents do not write directly to PostgreSQL or Graphiti.

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

1. **Foundation:** keep OpenLIT/OTel as execution evidence; adopt @letta-ai/trajectory where its harness adapters fit; add PostgreSQL + pgvector/full-text persistence; implement AutoDev schemas, governance, JIT researcher/validator/curator, packet builder, and MCP facade.
2. **Coding-aware retrieval:** add path proximity, commit ancestry/file-change checks, PR/issue relationships, and measured retrieval/ablation telemetry.
3. **Temporal graph only when justified:** project selected entities/relationships to Graphiti if graph queries measurably improve results.
4. **Extractor experiments:** benchmark native extraction against Mem0/LangMem-derived candidate generators behind the same interface.
5. **Specialized researcher/training only if needed:** use JIT-memory/MemHarness techniques or trained policies only when evaluation shows the frontier-model JIT researcher is a material bottleneck.

Do not introduce Qdrant, Milvus, Pinecone, a second agent framework, or another memory control plane by default. Add specialized infrastructure only after Postgres/hybrid retrieval or the custom JIT layer shows a measured limitation.

## 11. Console target

The Memory surface should expose the lifecycle rather than treating every record as equivalent.

Support:

- browse/search across episodes, semantic memories, procedures, and source trajectories;
- repository/workspace, role, type, status, and time filters;
- provenance and source evidence;
- active/superseded/invalidated state;
- relationship/history views where useful;
- observed use in agent runs when evidence exists;
- correction/invalidation without erasing historical evidence;
- promotion of suitable procedures through the canonical skill/configuration path.

Do not restore organization/project/environment tenancy concepts removed by the Console target.

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
- memory use is observable and can be compared with no-memory/simpler-memory baselines;
- secrets and unnecessary sensitive payloads are not persisted by default.

Measure memory changes with outcomes such as task/PR success, repeated failures, tool calls/tokens to completion, stale-memory rejection, retrieval/use rate, harmful memory application, and successful transfer to new tasks. Prefer controlled ablations over assuming more context is better.

## 13. Design basis

This target combines the strongest recurring ideas in agent-memory work:

- **Just-In-Time Memory:** preserve experience and perform task-aware curation at retrieval time.
- **MemHarness:** critique/reconstruct retrieved experience against current state; raw replay can cause negative transfer.
- **MemGPT/Letta:** separate bounded working context from larger archival memory.
- **Voyager:** promote reusable procedures into explicit skills.
- **MemoryArena:** external memory does not replace reasoning and can fail on deeply interdependent tasks.
- **Governed shared-memory work:** multi-agent memory requires scope, provenance, supersession, and controlled propagation.

These are design inputs, not dependencies on a specific memory product. AutoDev may reuse OpenLIT memory primitives or another implementation when it satisfies this contract without creating a competing architecture.
