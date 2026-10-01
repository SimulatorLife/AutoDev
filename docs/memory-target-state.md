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

## 10. Console target

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

## 11. Acceptance and evaluation

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

## 12. Design basis

This target combines the strongest recurring ideas in agent-memory work:

- **Just-In-Time Memory:** preserve experience and perform task-aware curation at retrieval time.
- **MemHarness:** critique/reconstruct retrieved experience against current state; raw replay can cause negative transfer.
- **MemGPT/Letta:** separate bounded working context from larger archival memory.
- **Voyager:** promote reusable procedures into explicit skills.
- **MemoryArena:** external memory does not replace reasoning and can fail on deeply interdependent tasks.
- **Governed shared-memory work:** multi-agent memory requires scope, provenance, supersession, and controlled propagation.

These are design inputs, not dependencies on a specific memory product. AutoDev may reuse OpenLIT memory primitives or another implementation when it satisfies this contract without creating a competing architecture.
