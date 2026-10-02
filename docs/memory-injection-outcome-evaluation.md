# Memory injection outcome reports

AutoDev records packet exposure separately from raw experience envelopes so
Runtime can observe what it actually attached without mutating append-only
trajectory history.

## Injection event

For a trusted orchestrator request, Runtime appends a `MemoryInjectionEvent`
after packet assembly and before provider dispatch. It records the
host-selected memory mode, whether a packet was injected, empty, or skipped,
bounded packet size, the durable memory IDs in the packet, request/session
scope, and an opaque correlation token. It never stores the task prompt,
instructions, transcript, or packet claims in this event. Event persistence is
best-effort for the routed task: if storage is unavailable, the request
continues and the evaluation cohort remains unknown.

When the configured memory database is available, `disabled` and `invalid`
modes also record a content-free `skipped` decision without performing memory
search, validation, or reconstruction. This makes an explicit no-memory cohort
distinguishable from a missing observation. If the database is unavailable, no
synthetic row is created. An untrusted/unknown workspace or missing absolute
repository root likewise produces no skip row; scope cannot be inferred from a
SessionEnd hook's caller-provided `cwd`.

## Reporter-supplied outcome

An operator can inspect injection events associated with a captured experience
and append a task, pull-request, issue, or other outcome report using:

```text
GET  /control/memory/experiences/:id/outcomes
POST /control/memory/experiences/:id/outcomes
```

Both routes require operator access, an explicit workspace/repository scope,
and `includeTaskHistory=true` while
`AUTODEV_MEMORY_READ_TASK_HISTORY=1` is enabled. The service derives the
session/task identity from the visible captured experience; callers cannot
choose another workspace, repository, task, run, agent, reporter, or authority.
The POST body contains only the correlation token, outcome category, report
kind, and evidence references. Non-`unknown` outcomes require evidence. AutoDev
stores the authenticated operator as reporter and appends the report through
`MemoryService`/Data; one report is permitted per injection token. An identical
retry is idempotent; a conflicting report for that token is rejected.

The retained OpenLIT experience detail provides a form to append a reporter-
supplied outcome for each observed injection. The browser submits only the
experience ID, injection event ID, chosen outcome/report categories, and
bounded evidence to a same-origin server route. The server resolves the opaque
correlation token from the authorized, scope-filtered join and posts it through
the Control API; neither the token, report ID, nor reporter identity is
returned in browser metadata or telemetry. Unknown outcomes may omit evidence;
other outcome categories require it. Reports stay append-only and the form
never infers success from retrieval, provider status, or a PR link.

Outcome claims are reporter-supplied. The API does not query GitHub or CI to
verify PR status, and a PR/commit reference is provenance, not proof of success.
Neither retrieval nor a successful provider request is treated as task success.

## Bounded outcome cohorts

Operators can query aggregates over the canonical append-only event tables:

```text
GET /control/memory/cohorts?workspaceId=...&repositoryId=...&includeTaskHistory=true&occurredFrom=...&occurredUntil=...
```

The route requires an operator and the explicit
`AUTODEV_MEMORY_READ_TASK_HISTORY=1` grant, a repository scope, and both
inclusive occurrence-time bounds. A single query is limited to 365 days.
Optional bounded filters select `memoryMode`, `injectionResult`, `reportKind`,
and reporter-supplied `outcomeKind`. Callers cannot select task, run, agent, or
role identities; the aggregate is deliberately workspace/repository/time
scoped.

Cells group the fixed tuple `(memoryMode, injectionResult, reportKind,
outcomeKind)`. With no matching report, the cell retains `reportKind: null`,
`outcomeKind: null`, and `reportCount: 0` so unreported exposure is visible.
`exposureCount` counts observed injection decisions and `reportCount` counts
joined reports; `reportCount <= exposureCount` is guaranteed by the one-report-
per-token constraint. These are counts, not success rates: an outcome is only
what an operator reported with evidence. The aggregate contains no correlation
token, task/run/agent identity, memory ID, evidence URI, or reporter identity.
Filtering on a report or outcome category naturally selects reported cells only.

The retained OpenLIT Memory page includes an AutoDev-only "Outcome cohorts"
table on the same server-side Control API proxy. It renders bounded counts and
explicit unreported cells without converting them to rates or claiming
downstream use. The tested 17-patch prefix applies to pinned OpenLIT; seven focused
upstream Jest suites pass (66/66) and its patched client typecheck passes. Patches
18–21 remove Controller/OpAMP discovery, image artifacts, stale message constants, and Controller table initialization while retaining the authenticated first-party OTLP receiver with PID-1 signal supervision. The full
21-patch apply, patched client typecheck, and eight focused upstream Jest suites
(58/58) pass. The `linux/arm64` p21 validation image `autodev-openlit:p21-validation`
was built with a scratch lock under `/tmp`. The standard lock and running OpenLIT
container remain on p14, so deployed UI and actual receiver drain acceptance remain
pending.

## Correlation limits

The current automatic Codex capture envelope represents a session, while each
router request has its own request ID and may inject a separate packet. The
persisted join is therefore scoped to workspace, repository, and captured
task/session ID; it intentionally does not equate request-level run or thread
IDs with the captured session's run/agent IDs. One session may contain multiple
request-level injections, and the operator reports each observed token
separately for the session-level task outcome. This supports reporter-supplied
outcome cohorts, not precise per-turn PR attribution.

An `injected` event proves only that a non-empty packet was appended to the
provider request. It does not prove that the model read, relied on, or correctly
applied the packet. Retrieval-to-use rates and automatic PR verification
still need trustworthy downstream outcomes and explicit evidence of use.

## Controlled ablation assignment

When `AUTODEV_MEMORY_EXPERIMENT_ID` is set, Runtime assigns one stable memory
arm per trusted Codex session using deterministic hash bucketing across
`jit`, `retrieval-only`, and `disabled`.

### Experimental unit and assignment

The experimental unit is the trusted Codex session (`sessionKey`), not
individual requests or runs. Every request within the same trusted session maps
to the identical arm deterministically via SHA-256 bucketing over
`(experimentId, workspaceId, repositoryId, sessionKey)`. The opaque experiment
ID is an operator-chosen salt, is not stored with injection records, and is
excluded from telemetry; record it and the experiment window outside Memory.
All router replicas in one experiment must use the same ID. Do not overlap
different experiments in the same repository/time window because cohort rows
carry the selected arm but not the experiment ID. Bucketing is reproducible and
approximately even over many sessions, not a fixed-size balanced allocation.
When no experiment is configured, Runtime preserves the default
`AUTODEV_MEMORY_MODE` behavior.

### Preconditions and fail-closed safety

Controlled ablation assignment enforces strict fail-closed constraints:

1. **Ablation gating:** Controlled experiments require `AUTODEV_MEMORY_ABLATION=1`.
   Without this flag, the router selects `invalid` (no memory injection), not
   the `disabled` control arm, so an unassigned request cannot contaminate that
   cohort.
2. **Trusted absolute workspace:** The request must provide a validated,
   absolute repository workspace (`workspace.cwd`) and known repository key.
   Missing, relative, or `unknown` workspaces select `invalid`.
3. **Router-identified session:** `sessionKey` must be present, bounded, and
   have Router scope `identified`. Runtime never uses `requestId` as a
   per-request substitute. Missing, process-fallback, or cross-workspace
   conflicted identities select `invalid` and do not record a synthetic skip
   observation.
4. **Mode semantics:** When prerequisites are valid, the experiment arm
   overrides `AUTODEV_MEMORY_MODE`; `retrieval-only` is enabled only under the
   required ablation gate. `invalid` is never counted as one of the three arms.
5. **Experiment ID:** The ID must be 1–128 ASCII characters, start with a
   letter or digit, and contain only letters, digits, `.`, `_`, or `-`.

### Strict cohort setup

To evaluate an ablation arm without confounding, participating agents must not
have explicit access to Memory MCP tools. Direct tool calls bypass orchestrator
injection controls, including in a `disabled` arm. Keep one experiment active per
repository/time window and record its opaque ID outside Memory; injection events
retain the assigned mode but not the experiment ID. Cohort aggregates count
request-level exposures, not unique randomized sessions. For comparisons, use
sessions containing one target task and do not treat multiple request injections
from one session as independent observations. The report form is per injection
while task outcomes are session-level; repeated reports do not establish
per-turn outcomes or independent task successes.

### Telemetry privacy and outcomes

The experiment ID and session identifiers are deliberately excluded from
telemetry labels, span attributes, and metric dimensions to maintain bounded
cardinality and protect session privacy. Spans and metrics record only the
standard bounded `autodev.memory.mode` and `autodev.memory.injection.result`
categories.

Outcomes remain strictly reporter-supplied with evidence. AutoDev does not
infer task success, PR verification, or model packet usage from retrieval or
provider routing outcomes. Retrieval-to-use rates and automatic PR verification
remain separate future capabilities.
