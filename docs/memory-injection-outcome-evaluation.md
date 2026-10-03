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
Separately, the JIT Git verifier rejects a conventional descendant `git revert`
whose `Revert` subject and body marker name the exact cited source commit and
touch a cited path, even if a later commit restores identical file bytes. This narrow local
history check does not validate nonstandard reverts, review threads, CI/checks,
issue state, reopened PRs, or superseding changes.

## Reporter-supplied session outcome

In addition to per-token injection exposure reports, an operator can append a single session-level outcome report for a task/session using:

```text
GET  /control/memory/experiences/:id/session-outcomes
POST /control/memory/experiences/:id/session-outcomes
```
(and their singular aliases `/session-outcome`).

Both routes require operator access, explicit workspace/repository scope, and `includeTaskHistory=true` while `AUTODEV_MEMORY_READ_TASK_HISTORY=1` is enabled. Identity is derived strictly from the visible captured `ExperienceEnvelope`; caller-selected IDs are rejected. Exactly one report is permitted per unique `(workspace_id, repository_id, task_id)` key and stored in the append-only `memory_session_outcome_reports` table (migration 10). Writing a session outcome report requires that at least one injection event exists for that session key. The POST body contains only `outcomeKind`, `reportKind`, and `evidence`. Non-`unknown` outcomes require evidence. Same-body retries are idempotent (`appended: false`); conflicting bodies fail closed (`409 Conflict`). Reporter authority and ID come strictly from the authenticated actor.

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

Cells group the fixed tuple `(memoryMode, injectionResult, sessionCardinality,
reportKind, outcomeKind)`, where `sessionCardinality` is `"single"` or
`"multiple"` depending on whether the session (workspace, repository,
task/session id) backing that cell's exposures captured exactly one or more
than one injection event in its full event set (see
[Injection cardinality](#injection-cardinality)). With no matching report,
the cell retains `reportKind: null`, `outcomeKind: null`, and
`reportCount: 0` so unreported exposure is visible.
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
(58/58) pass. The linux/arm64 p21 image autodev-openlit:openlit-9938c6663866-p01204b3d1c6d87af (sha256:e18e53a018a3a5baaa81e7cac4b4fb089faddac9847abab2d72e77963cff8729) was built with the separate .tmp/openlit-p21-validation.lock. The standard lock and running OpenLIT
container remain on p14, an isolated p21 stack returned 401 without OTLP auth and 200 with a bearer token, persisted a span, had no Controller tables on fresh ClickHouse initialization, and completed Collector shutdown on docker stop. Existing volumes are not purged automatically; deployed UI/receiver acceptance remains pending.

## Bounded session outcome cohorts

While `GET /control/memory/cohorts` aggregates request-level injection exposures,
operators can query deduplicated unique session outcomes across the canonical
append-only event tables and session outcome reports using:

```text
GET /control/memory/session-cohorts?workspaceId=...&repositoryId=...&includeTaskHistory=true&occurredFrom=...&occurredUntil=...
```

The endpoint requires operator authority with the explicit
`AUTODEV_MEMORY_READ_TASK_HISTORY=1` grant, repository scope, and an inclusive
time window of at most 365 days. Optional bounded filters accept assigned
`memoryMode` values (`jit`, `retrieval-only`, `disabled`), `injectionResult`,
`reportKind`, and `outcomeKind`. Caller-selected identities
(`taskId`, `runId`, `agentId`, `role`) are rejected.

### Sampling unit and consensus rules

1. **Sampling unit:** The sampling unit is the canonical session key
   `(workspace_id, repository_id, task_id)`, not an individual injection or request.
2. **Full-session mode classification:** Session mode is derived from each
   session's complete append-only injection event set across all time.
   Sibling events outside the time window or omitted by the memory-mode
   filter still contribute to full-session classification.
   - If every injection event in the session shares the same mode and that
     mode is one of the three assigned modes (`jit`, `retrieval-only`,
     `disabled`), the session is eligible and surfaces as a cell in that mode.
   - If the session's events span more than one distinct mode, the session is
     `"mixed"`: it is excluded from `cells` and from `sessionCount`, and is
     counted only in `mixedModeSessionCount`.
   - If every injection event in the session shares a single `invalid` or
     `unknown` mode, the session is excluded from this response entirely --
     it is never coerced into the `"disabled"` cell and never counted in
     `sessionCount` or `mixedModeSessionCount`.
3. **Session outcome join:** The session outcome is joined from the single row in
   `memory_session_outcome_reports` for `(workspace_id, repository_id, task_id)`.
   Unreported eligible sessions have `outcomeKind: null`.
4. **Conflicting-outcome diagnostic:** `conflictingOutcomeSessionCount` is a
   diagnostic derived from the session's per-injection-token
   `memory_outcome_reports` rows disagreeing on outcome kind. It never
   overrides the canonical session outcome report above, and may overlap
   with `mixedModeSessionCount` (a mixed-mode session can also have
   conflicting per-injection token reports).
5. **Grouped cells:** Cells group only eligible (single-assigned-mode)
   sessions by `(memoryMode, outcomeKind)` and count `sessionCount` (unique
   sessions). There is no request-exposure count in this response; use
   `GET /control/memory/cohorts` for exposure-level counts.
6. **Counts, not rates:** `sessionCount = reportedSessionCount +
   unreportedSessionCount`, and `sessionCount` sums only the eligible
   single-assigned-mode cells -- it excludes mixed-mode and invalid/unknown-only
   sessions.
7. **Response contract:** Response adheres to schema `autodev-memory-session-outcome-cohorts-v1`,
   with cells shaped `{ memoryMode, outcomeKind, sessionCount }` and totals
   `(sessionCount, reportedSessionCount, unreportedSessionCount,
   conflictingOutcomeSessionCount, mixedModeSessionCount)`.
8. **Retained non-goals:** Outcomes remain reporter-supplied. Session deduplication
   does not claim verified task success, per-turn attribution, retrieval-to-use
   evidence, or causal effectiveness.

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

### Injection cardinality

Because a session may contain multiple request-level injections, every
observed-injection read exposes a bounded, read-time-derived cardinality
signal so operators can distinguish "this session injected once" from "this
session injected repeatedly" without inferring task success or memory use.

The per-injection outcome join (`GET /control/memory/experiences/:id/outcomes`)
adds `sessionInjectionCount` to each row: the count of every injection event
captured for that row's exact session key (workspace, repository, captured
task/session id), inclusive of the row itself. This count is computed over
the session's full append-only event set, not the filtered rows the current
read happens to return -- `memoryMode`, `injectionResult`, `reportKind`, and
`outcomeKind` filters on the surrounding query never change it.

The bounded outcome cohort read (`GET /control/memory/cohorts`) adds a
`sessionCardinality` dimension (`"single"` or `"multiple"`) to the grouped
tuple, so a cell's exposures can be read as "one-shot sessions" or
"repeated-injection sessions" without exposing the underlying count, session
identity, or any request/thread run/agent id. Like `sessionInjectionCount`,
`sessionCardinality` is derived from each row's full session event set, not
from the cohort's own `memoryMode`/`injectionResult`/`reportKind`/
`outcomeKind` filters, so filtering a cohort read never reclassifies a
multi-injection session as `"single"`.

Neither signal narrows the gaps above: a `sessionInjectionCount` or
`sessionCardinality` of more than one still does not identify which request
within the session the reporter's outcome actually describes, still does not
attribute request/thread `runId`/`agentId` to the session-level outcome, and
still is not evidence that any injected packet was read, relied on, or used.
Precise per-turn task attribution and retrieval-to-use rates remain
unimplemented.

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

The environment-gated `tests/router/memory-injection.integration.test.ts`
exercises all three deterministic arms through real Router injection-event
writes, including two request events per session and the disabled skip path,
then appends session outcomes through the Control API and verifies the unique
session cohort aggregate. This proves the assignment-to-report wiring and
session deduplication; it does not establish per-turn outcomes, memory use, or
effectiveness.
