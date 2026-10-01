# Memory Target State

> **Authority:** Focused target-state design for AutoDev memory. It is subordinate to [`autodev-console-target-state.md`](autodev-console-target-state.md), which remains authoritative for repository-wide architecture, module ownership, Console behavior, RuleSync ownership, and observability/control-plane boundaries.
>
> **Goal:** Give agents useful cross-task experience without turning stale model-generated summaries into hidden policy or a competing source of truth.

## 1. Design principles

AutoDev memory follows five rules:

1. **Keep raw experience.** Preserve task trajectories and outcomes as historical evidence instead of relying only on summaries created before future needs are known.
2. **Curate at read time.** Retrieve narrowly for the current task, compare memories with current authoritative state, then reconstruct a small task-specific memory packet.
3. **Treat memory as evidence, not authority.** Repository state, version-controlled policy, canonical configuration, and live runtime state override remembered claims.
4. **Separate memory types and scopes.** Episodic, semantic, and procedural memory have different lifecycles; task-private, role, workspace/repository, and global memory must not collapse into one shared store.
5. **Promote proven procedures out of fuzzy memory.** Repeatedly validated procedures should become version-controlled skills, rules, tests, or documentation when appropriate.

The target is therefore not "conversation history plus vector search." It is an evidence-backed memory lifecycle with provenance, temporal validity, scoped retrieval, and current-state validation.

## 2. Architecture

```text
execution
   │
   ▼
raw experience log
(prompts/plans/tool calls/observations/diffs/reviews/outcomes)
   │
   ├───────────────┬────────────────┐
   ▼               ▼                ▼
episodic         semantic         procedural
what happened?   what is true?    how do we do this?
   │               │                │
   └───────────────┴────────────────┘
                   │
current task ──────┤
current state ─────┤
                   ▼
          scoped candidate retrieval
                   │
                   ▼
           JIT research / curation
       inspect • critique • reconcile
         retain • revise • reject
                   │
                   ▼
        compact task-specific packet
                   │
                   ▼
                 agent
```

Raw experience is the durable historical record of what an agent observed and did. Derived memories accelerate retrieval and reuse, but they must retain provenance back to evidence.

The current repository/runtime remains authoritative for what is true **now**.

## 3. Memory tiers

### Raw experience

Persist enough of each meaningful execution to reconstruct why an outcome occurred:

- task and plan;
- delegations and agent roles;
- relevant prompts/context references;
- tool calls and observations;
- code/config/document changes;
- validation and review evidence;
- failures, retries, corrections, and final outcome;
- workspace/repository, refs/SHAs, timestamps, model/provider, and relevant entities.

Store references to large artifacts where possible rather than duplicating them.

### Episodic memory

Indexes specific prior experiences:

- attempts and outcomes;
- failures and recoveries;
- reviews and rejected approaches;
- decisions made under specific conditions.

Episodes should point back to raw trajectories.

### Semantic memory

Stores durable claims that are useful across tasks:

- ownership and architecture;
- relationships and constraints;
- intentional product/design decisions;
- known environment behavior.

Every semantic memory needs provenance and temporal validity. It may be superseded; it must not be silently rewritten into an ahistorical "truth."

### Procedural memory

Stores reusable methods:

- investigation strategies;
- validation workflows;
- recurring fixes;
- review procedures;
- tool-use patterns.

Repeatedly successful, stable procedures should be promoted into explicit Agent Skills, rules, tests, or documentation. Memory remains useful for situational tactics that are not yet stable enough to become policy.

## 4. Memory is not policy or canonical state

Do not use memory for information that should be deterministic and version-controlled.

```text
policy / instructions        → RuleSync / AGENTS.md / skills
repository truth             → git + repository files
desired configuration        → canonical RuleSync / AutoDev config
actual runtime state         → runtime / Control API
historical observability     → OpenTelemetry / OpenLIT
historical agent experience  → memory
```

A remembered claim must never override a contradictory authoritative source.

## 5. Scope and sharing

Memory visibility is explicit and hierarchical:

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

Workers may:

- append their raw execution evidence;
- write task-local findings;
- propose durable memories.

Workers must not freely publish unverified claims into global/shared semantic or procedural memory. Durable shared memories require promotion by the root, a memory curator, or an equivalent evidence-based process.

## 6. Write lifecycle

Do not aggressively summarize every execution into permanent guidance.

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
episodic, semantic, or procedural memory
   ↓
repeated + proven procedure?
   ↓
promote to skill/rule/test/doc when appropriate
```

A memory candidate should include at minimum:

- type and scope;
- concise claim/lesson;
- source trajectory/evidence;
- creation time;
- repository/workspace and relevant refs;
- confidence or validation state;
- validity/supersession metadata where applicable.

Failures are valuable memories when they capture **conditions and evidence**, not merely "do not do X."

## 7. Read lifecycle: Just-In-Time memory

Memory retrieval happens because a current task needs it, not because old content happens to be semantically similar.

```text
current task
   ↓
query decomposition
   ↓
hard scope / validity filters
   ↓
hybrid candidate retrieval
   ↓
rerank + diversify
   ↓
inspect authoritative current state
   ↓
critique / reconstruct
   ↓
retain • revise • reject
   ↓
small memory context packet
```

### Retrieval

Use structured filters before similarity ranking where available:

- workspace/repository;
- subsystem/entities/files;
- task type;
- agent role;
- memory type;
- branch/commit lineage;
- validity/supersession state;
- recency when relevant.

Ranking may combine:

- semantic and lexical relevance;
- entity overlap;
- provenance quality;
- observed historical utility;
- outcome/validation quality;
- recency;
- compatibility with current state.

Embedding similarity alone is not evidence that a memory applies.

### Reconstruction

Before injecting retrieved memory, the curator should answer:

1. What happened previously?
2. Why is it relevant to this task?
3. What has changed since then?
4. Which parts still apply?
5. Which parts are stale, contradicted, or uncertain?
6. What concise guidance/evidence should the active agent receive?

When tools can cheaply verify a remembered fact against the current repository/runtime, do so before using it.

If no memory survives validation, proceed without memory.

## 8. Task-specific memory packet

Agents receive a compact, provenance-bearing packet rather than arbitrary historical chunks.

A packet may contain:

- relevant prior decisions;
- applicable successes/failures;
- reusable procedures;
- known conflicts or superseded assumptions;
- links/references to source evidence;
- explicit uncertainty or applicability notes.

The packet is advisory context. The agent remains responsible for verifying it against current evidence.

## 9. Temporal validity and contradiction handling

Memory is append-oriented. Do not silently overwrite history.

A durable memory can be:

- active;
- superseded;
- invalidated;
- uncertain;
- scope-limited.

Where useful, retain:

```text
valid_from
valid_to
supersedes
superseded_by
last_verified_at
verification_source
```

Contradictory memories should trigger reconciliation, not winner-takes-all similarity ranking. Historical episodes remain queryable even after their conclusions are superseded.

## 10. Storage and indexing

The logical model matters more than a particular database.

Target responsibilities:

- **`runtime/`** owns trajectory capture, retrieval orchestration, JIT research/curation, memory promotion, and agent-facing context assembly.
- **`data/`** owns typed persistence/search adapters for trajectories, memories, indexes, and any retained OpenLIT memory integration.
- **`core/`** owns infrastructure-independent memory types, scopes, provenance, lifecycle states, and contracts.
- **`console/`** owns Memory browsing/search, provenance/history, scope, status, and management UX.

The physical implementation may combine:

- append-oriented trajectory/event storage;
- structured relational/document records;
- lexical/full-text search;
- vector indexes;
- optional temporal/entity graph indexes for relationships and supersession.

Do not require one giant vector database or graph as the primary model.

## 11. Graph/relationship memory

Use graph-style indexes where relationships materially improve retrieval:

- subsystem ownership;
- dependency relationships;
- issue/PR/commit links;
- supersession;
- agent/skill/tool/workspace relationships;
- temporal changes.

Do not force detailed trajectories, procedures, or every model observation into graph form.

## 12. Privacy, retention, and provenance

Memory must not become an unbounded copy of secrets or transient context.

- redact or exclude credentials, secrets, and unnecessary sensitive payloads before persistence;
- retain references instead of large duplicated artifacts where practical;
- record source, actor/agent, timestamp, workspace, and evidence identifiers;
- support explicit retention/deletion policies by memory class;
- keep telemetry/observability records and agent memory logically distinct even when OpenLIT supplies storage/UI primitives.

## 13. Console target

The Memory surface should expose the lifecycle rather than pretending all records are equivalent.

At minimum support:

- search/browse across episodes, semantic memories, procedures, and source trajectories;
- workspace/repository, role, type, status, and time filters;
- provenance and source evidence;
- active/superseded/invalidated state;
- relationship/history view;
- observed use in agent runs where evidence exists;
- promotion of suitable procedures to explicit skills through the canonical configuration path;
- correction/invalidation without deleting historical evidence.

Do not add organization/project/environment tenancy concepts removed by the Console target state.

## 14. Acceptance criteria

The memory target is satisfied only when:

- raw trajectories can be retained independently of derived summaries;
- derived memories preserve provenance to evidence;
- retrieval respects workspace/repository/task/role scope;
- stale or superseded memory can be identified and excluded;
- current authoritative state is consulted before high-impact remembered guidance is used;
- retrieved memories can be retained, revised, or rejected before agent injection;
- the agent receives a bounded task-specific packet rather than an unbounded history dump;
- shared durable memory cannot be freely polluted by any worker;
- repeated validated procedures have a path to explicit skills/rules/tests/docs;
- memory use is observable enough to evaluate whether it improves outcomes;
- secrets and unnecessary sensitive payloads are not persisted by default.

## 15. Evaluation

Memory changes should be measured against equivalent no-memory or simpler-memory baselines where practical.

Track outcomes such as:

- task success / accepted PR rate;
- repeated-failure rate;
- time/tool calls/tokens to successful completion;
- stale-memory rejection rate;
- memory retrieval and actual-use rate;
- false or harmful memory application;
- successful transfer of prior solutions to new tasks.

Prefer controlled ablations over assuming that more retrieved context is better.

## 16. Design basis

This target incorporates the common architectural lessons from recent agent-memory research:

- **Just-In-Time Memory:** preserve experience and perform task-aware curation at retrieval time rather than depending only on write-time summarization.
- **MemHarness:** critique and reconstruct retrieved experience against the current state; raw replay can cause negative transfer.
- **MemGPT/Letta:** separate bounded working context from larger archival memory.
- **Voyager:** promote durable reusable procedures into an explicit skill library.
- **MemoryArena:** external memory does not remove the need for reasoning and can fail on deeply interdependent tasks.
- **Governed shared-memory work:** multi-agent memory requires scope, provenance, supersession, and controlled propagation.

These are design inputs, not dependencies on any single memory product. AutoDev may reuse OpenLIT memory primitives or another implementation where they satisfy this contract without creating a competing architecture.
