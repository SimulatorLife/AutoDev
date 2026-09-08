# Codex agent and provider routing

This is the canonical repository guide for choosing and invoking agents across
the OpenAI, Claude, MiniMax, Antigravity, and GitHub Copilot providers. Role files and scripts
remain the source of truth for exact model settings; this document owns the
routing policy, execution boundaries, and the setup needed to use the
versioned local integration safely.

## Available roles

Callers select a capability role, never a provider or model:

| Role | Capability | Sandbox |
| --- | --- | --- |
| `default` | General-purpose development | workspace-write |
| `docs-researcher` | Targeted documentation research | read-only |
| `browser-tester` | Browser/runtime evidence | read-only |
| `explorer` | Architecture and dependency exploration | read-only |
| `worker` | Bounded implementation | workspace-write |
| `validator` | Independent validation | workspace-write |
| `smart` | Full-capability browser/docs/implementation agent | workspace-write |

All roles except `smart` use the configured `default` model tier. Only `smart` uses the configured `smart` tier. Every role uses the `local_model_router` with an `autodev/<role>` model alias.
The editable provider/model choices live in
`scripts/codex/model-routing.json`: `providerGroups` defines ordered fallback groups per capability tier,
`providers.<name>.models` contains named tiers such as `default` and `smart` (specific tiers like `smart` are optional and fall back to that provider's `default` model if omitted), and
`roles.<role>.tier` selects the tier for each capability role. For example, set
Claude's smart model to `claude-opus-5` or Codex's to `gpt-5.6-sol` there; providers like MiniMax or Copilot that use the same model across tiers only need to define `default`. The installer materializes this file as
`$CODEX_HOME/codex-model-routing.json`.
For the `default` capability tier, the router randomizes Claude, Gemini/Antigravity, and MiniMax, then falls back to Copilot and OpenAI/Codex. For `smart`, it randomizes Claude and Gemini/Antigravity, then falls back directly to OpenAI/Codex Sol. Providers that are unavailable or return fallbackable limit errors are skipped and the next provider in the current group is tried before progressing to the next group. A skipped provider is not forgotten: if no candidate serves the turn, the router reconsiders the ones it skipped as a bounded last resort before giving up (see "Cooldowns and provider selection"):

1. `default`: Claude, Gemini/Antigravity, MiniMax (randomized), then Copilot, then OpenAI/Codex Luna
2. `smart`: Claude, Gemini/Antigravity (randomized), then OpenAI/Codex Sol

### Orchestrator routing and fallback

The root Codex orchestrator is not a leaf role, but it uses the same
`providerGroups` fallback machinery through a dedicated `autodev/orchestrator`
alias. `scripts/codex/config.toml` sets the parent `model` to that alias, and
`scripts/codex/model-routing.json` defines its chain under the top-level
`orchestrator` block (`alias`, `tier`, and an optional per-provider
`reasoningEffort` map) plus a `providerGroups.orchestrator` tier and an
`orchestrator` entry in each provider's `models`.

The default order pins the primary provider and load-balances the rest:

3. `orchestrator`: OpenAI/Codex Luna (pinned first), then Claude Opus, MiniMax, and Gemini/Antigravity (randomized)

Differences from a role request:

- The orchestrator never consumes a per-session subagent slot; it is gated by
  neither `max_concurrent_threads_per_session` nor the process-fallback bucket.
- The primary provider is dispatched with the caller's own reasoning effort
  (`model_reasoning_effort` in the parent config). Each fallback provider is
  dispatched with the effort pinned in `orchestrator.reasoningEffort`
  (`claude` medium, `minimax` high, `antigravity` high by default) so a
  downgraded run still reasons at the intended depth.
- Usage telemetry keeps orchestrator fallback traffic under the `orchestrator`
  origin even when it lands on a non-Codex provider, rather than
  reclassifying it as `direct`.
- A direct concrete `gpt-5.6-luna` request is still never rerouted. Only the
  `autodev/orchestrator` alias degrades across providers.
- The root-delegation `UserPromptSubmit` hook matches `autodev/orchestrator`
  before its leaf-alias glob, so the parent still receives the delegation
  policy while `autodev/<role>` leaves do not.
- Every outbound provider request carries an `x-autodev-agent-role` header the
  router generates from its own alias dispatch (`orchestrator` for the
  orchestrator alias, the role name for an `autodev/<role>` alias). Provider
  bridges select their role instructions from it, so an orchestrator turn that
  degrades onto a bridge-backed provider receives the orchestrator policy
  rather than the leaf policy. See "Agent role across the bridge boundary".
- Every provider in `providerGroups.orchestrator` must declare
  `capabilities.subagentSpawn: true`, and the router refuses to start
  otherwise. The orchestrator's entire job is delegating, so a provider with no
  delegation path would silently turn the root agent into a single-threaded
  chat model -- a failure that looks identical to a slow turn. There are two
  delegation paths and both satisfy the requirement:
  - **Native Codex spawn** (`codex`, `minimax`): the parent drives Codex's own
    `multi_agent_v1` spawn tool, which creates a child thread that asks this
    router for an `autodev/<role>` alias.

    Note how that call actually reaches Codex, because it is not what the model
    catalog suggests. These models run in **code mode**: the request carries no
    `tools` array at all, and the entire tool surface arrives as a single `exec`
    tool -- declared `"type": "custom"` inside an `additional_tools` input item
    -- whose payload is raw JavaScript evaluated in a V8 isolate. The spawn
    function is reached from inside that script as
    `tools.multi_agent_v1__spawn_agent({ agent_type, message })` and is never
    named in the request. Two consequences worth knowing before changing
    anything here:
      - The role must travel as `agent_type`. `agent` is accepted and silently
        ignored, and the child comes back as a generic agent rather than the
        role that was asked for.
      - Fan-out happens inside one script (`await Promise.all(tasks.map(...))`),
        which is why Codex sending `parallel_tool_calls: false` does not cap it.
    `scripts/codex/prompts/orchestrator.md` states this to the model, and
    `scripts/codex/lib/codex-spawn-tools.mjs` builds the call for any component
    that needs to emit one.
  - **Bridge-native spawn** (`claude`, `antigravity`): the CLI behind the bridge
    delegates inside its own runtime -- Claude's `Agent` tool, Antigravity's
    `invoke_subagent` -- and no router request is made for
    the child. Those providers additionally declare
    `capabilities.subagentSpawnTools`, the tool names that mean "a subagent was
    spawned"; see "Counting subagents across providers".

    Browser-capable bridge roles are configured independently of native Codex
    role TOML. The Claude bridge injects the pinned `playwright-mcp` command
    through an inline `--mcp-config` only for `browser-tester` and `smart`, and
    denies the unneeded browser tools. Antigravity has one global MCP registry,
    so the installer owns its `playwright` entry and pins it to the active
    repository's `pnpm exec playwright-mcp` instead of `npx @latest`.

  Copilot's CLI has no subagent tool, so it stays out of the orchestrator tier.
- MiniMax is restored in the orchestrator fallback chain. Codex CLI defines
  subagent tools in a proprietary `type: "namespace"` structure (`multi_agent_v1`),
  which generic Responses endpoints drop or reject. The MiniMax Responses
  proxy (`scripts/codex-minimax-responses-proxy.mjs`) implements outbound
  request rewriting to flatten namespaced tools into standard `type: "function"`
  definitions (e.g., `multi_agent_v1__spawn_agent`) and re-expands them in
  downstream SSE responses. This allows MiniMax to properly receive and invoke
  `spawn_agent` during orchestrator turns rather than emitting plain text.

  That proxy also coerces **freeform tool calls**. MiniMax has no notion of a
  `"type": "custom"` tool, so it answers Codex's code-mode `exec` with an
  ordinary `function_call` carrying JSON arguments -- typically the
  `{cmd, workdir}` shape of `exec_command`. Codex rejects that outright with
  `tool exec invoked with incompatible payload`, which meant a MiniMax-served
  turn could reason but never actually run anything, and every such turn logged
  a burst of those errors. The proxy now rewrites those calls into a
  `custom_tool_call` whose script performs the same work, keeping the `event:`
  header and the terminal `response.completed` snapshot in step with the
  rewritten payload. Freeform tool names are learned from the request's own
  `"type": "custom"` declarations rather than hard-coded, and an argument shape
  the proxy does not recognise is passed through untouched rather than guessed
  at -- a wrong guess would replace a visible failure with a script that runs
  and does the wrong thing.

### Item ids are corrected at the router, not in the adapters

Every item in a Responses request carries an `id` whose prefix encodes its type
-- `rs_` for `reasoning`, `ctc_` for `custom_tool_call`, `msg_` for `message`
-- and the OpenAI backend rejects the whole request when a prefix and a type
disagree:

```
Invalid 'input[18].id': '06ef3bc08924acade1facee14da0af2e_fc_0'.
Expected an ID that begins with 'ctc'.
```

Not every provider honours that contract. MiniMax mints ids shaped
`<32 hex>_rs` and `<32 hex>_fc_<n>`, and the freeform coercion above retypes a
`function_call` as a `custom_tool_call` while keeping the id it arrived with.
Codex stores whatever a provider hands back and replays it on every later turn,
so a single turn served by a lax provider poisons the session for good: the
next turn that lands on a provider which validates fails, and so does every
turn after it, because the history only grows. Because the orchestrator tier is
pinned to `codex` with `minimax` in its fallback group, and a fresh turn is not
a continuation and so is not pinned to the provider that served the last one,
one failover is enough to end a session.

`upstreamPayload` in `scripts/codex-model-router.mjs` therefore rewrites any
non-conforming id, using `scripts/codex/lib/responses-item-ids.mjs`. The router
is the right place for it rather than each adapter: it is the one point every
upstream call passes through, and since stored history is re-sent rather than
re-read, correcting outbound also repairs sessions that are already carrying
bad ids -- no rollout file is touched. The MiniMax proxy's id passthrough is
left deliberately alone; one normalisation layer is easier to reason about than
two that can disagree.

Three properties the rewrite has to keep:

- The replacement is `<prefix><sha256(original)>`, not a random value. The same
  item is re-sent every turn, and an id that moved between turns would change
  the serialised request prefix each time and defeat upstream prompt caching.
- `call_id` is never touched. A tool call and its output are paired by that
  field alone, so rewriting one side would strand the other.
- An item with no `id` does not acquire one. Codex legitimately omits it on
  some tool outputs, and an invented id would name an item the upstream never
  issued.

Normalisation runs on every route for self-contained items (messages, tool calls, and tool outputs). A provider that turns out to pair items by
the ids it minted can opt out with `capabilities.normalizeItemIds: false` in
`scripts/codex/model-routing.json`; absent means enabled. Requests that needed a
correction emit an `item_ids_normalized` router event carrying the count, so a
provider drifting from the contract is visible immediately rather than as a
dead session weeks later.

### Reasoning items are dropped when unresolvable, not rewritten

Reasoning items are fundamentally different from tool calls. While a tool call
carries its own name, input, and `call_id`, a reasoning item without
`encrypted_content` is only a *reference* to an item the backend stored. Because
Codex requests operate with `store: false`, the OpenAI backend persists nothing;
an unencrypted reasoning item minted by a foreign provider (such as MiniMax's
`<32 hex>_rs` or bridge-minted activity summaries) has nothing to resolve to.
Rewriting its id to a conforming `rs_<32 hex>` simply converts a 400 format
validation error into a 404 (`Item with id 'rs_...' not found. Items are not persisted
when store is set to false`).

Therefore, reasoning items are excluded from id rewriting. Instead:

- On Codex routes (`route.provider === "codex"`), `dropUnresolvableReasoning`
  drops foreign reasoning items lacking `encrypted_content`. Genuine OpenAI
  reasoning items carrying `encrypted_content` are preserved. When foreign
  reasoning items are removed, the router emits a `foreign_reasoning_dropped`
  event with `droppedReasoningItems: <count>`.
- On non-Codex routes, reasoning items are passed through untouched so the
  provider that minted them retains its own reasoning continuity on subsequent
  turns.

When the orchestrator tier is genuinely exhausted, the router returns
`503 router_provider_exhausted` exactly as it does for an exhausted role tier --
but only after the last-resort pass and the bounded wait below have both failed.
That distinction matters for the orchestrator specifically: its 503 ends the root
turn and every child with it, so exhausting the tier is the most expensive
failure in the system and worth the extra attempts to avoid.

A subagent that comes back with `status: "incomplete"` is a normal, actionable
outcome rather than a lost turn: the child hit a limit partway through, and the
work it finished is in the response. An orchestrator reading one should use that
work and decide whether to re-delegate, not treat the turn as having produced
nothing. See "Partial results on provider exhaustion".

Provider availability is checked through local health endpoints and credential
checks. HTTP 429/5xx, quota, session-limit, high-demand, timeout, and
unavailable responses cause the router to try the next provider. A malformed
request is returned immediately rather than hidden by fallback. Streaming
fallback happens before response headers are sent; a provider that fails after
streaming has begun cannot be safely replayed. Claude's `rate_limit_event` is
informational when `rate_limit_info.status` is `allowed`; only a non-allowed
status is treated as a Claude limit.

### Cooldowns and provider selection

A cooldown is load-shedding advice, not proof a provider is dead. There are four
kinds, and which one applies decides both how long it lasts and whether the
provider can still be attempted when nothing else is left. `GET /status` reports
the kind as `cooldownKind`, with `cooldownFailureClass`, `cooldownResetsAt` and
`lastResortEligible` alongside it.

| Kind | Applies to | Duration | Last resort? | Survives a restart? |
| --- | --- | --- | --- | --- |
| `transient` | any fallbackable failure, and any limit the router only inferred from prose | 30s doubling to 10min | yes | no |
| `hard` | `quota_exhausted` / `session_limit` that the **provider itself declared** | until the declared reset, else a 15min floor, capped at 6h | only while no reset time is known | yes |
| `probe` | a local bridge that did not answer its health check | 5s doubling to 30s | yes | no |
| `config` | `authentication`, `invalid_model` | fixed 30s, never escalates | no | no |

Three rules are load-bearing:

- **A hard cooldown needs corroboration.** `classifyProviderFailure` matches
  keywords, and bridges put CLI stderr tails into error messages, so one stray
  "quota" in an unrelated crash could otherwise take a provider out for fifteen
  minutes. Only a provider *reporting* a limit -- `x-autodev-limit-source:
  reported`, from a Claude `rate_limit_event` or an upstream that sent the limit
  headers -- produces a hard cooldown. An inferred limit stays on the transient
  ladder.
- **Probe failures ride their own ladder.** A local bridge restarting says
  nothing about the provider behind it, and escalating the provider's own backoff
  for it was how a one-minute outage became a ten-minute one.
- **A cooldown only ever moves later.** A short probe cooldown landing on top of
  a long declared limit must not shorten it.

Selection then runs in up to three passes, and only reaches a 503 if all three
come up empty:

1. **Primary.** Every candidate that is not cooling, in tier order.
2. **Last resort.** The candidates pass 1 skipped, soonest-to-lapse first, capped
   at `CODEX_ROUTER_LAST_RESORT_MAX_ATTEMPTS` (default 2). Excluded: anything
   already attempted, a `config` cooldown, a provider already serving another
   request (so concurrent exhausted requests do not pile onto the same one), and
   a `hard` cooldown with a declared reset still in the future -- that provider
   has stated it will not serve yet, and attempting it anyway is exactly the
   hammering cooldowns exist to prevent. A success clears the cooldown, so the
   chain heals itself.
3. **Bounded wait.** If a cooldown lapses within
   `CODEX_ROUTER_EXHAUSTION_WAIT_MS` (default 20s), the router waits for it and
   makes one more attempt rather than ending the caller's turn. It happens before
   response headers, so the client sees a slow request rather than a stalled
   stream, and it is cut short if the client disconnects. Keep it small: a role
   request holds its subagent slot throughout, and the per-session limit is
   typically 2. Set it to `0` to disable waiting entirely.

`CODEX_ROUTER_CHAIN_SELECTION_DEADLINE_MS` (default 120s) bounds how long the
router may spend *looking* for a provider. It is checked only before starting a
candidate and never during one, so a long turn that lands on the last candidate
still gets the full `CODEX_ROUTER_UPSTREAM_TIMEOUT_MS`. Without it, a tier of
five hanging providers could hold a subagent slot for over an hour.

All of these are positive-millisecond environment variables:
`CODEX_ROUTER_PROVIDER_COOLDOWN_MS` (30_000),
`CODEX_ROUTER_PROVIDER_COOLDOWN_MAX_MS` (600_000),
`CODEX_ROUTER_HARD_COOLDOWN_MS` (900_000),
`CODEX_ROUTER_HARD_COOLDOWN_MAX_MS` (21_600_000),
`CODEX_ROUTER_PROBE_COOLDOWN_MS` (5_000),
`CODEX_ROUTER_PROBE_COOLDOWN_MAX_MS` (30_000),
`CODEX_ROUTER_PROBE_TIMEOUT_MS` (700),
`CODEX_ROUTER_LAST_RESORT_MAX_ATTEMPTS` (2),
`CODEX_ROUTER_EXHAUSTION_WAIT_MS` (20_000, `0` disables) and
`CODEX_ROUTER_CHAIN_SELECTION_DEADLINE_MS` (120_000).

### Declared limits

A provider bridge that knows it hit a usage limit says so structurally rather
than only in prose, on both the streamed and non-streamed paths:

| Header | Value |
| --- | --- |
| `x-autodev-limit-class` | `quota_exhausted`, `session_limit`, `throttled`, `capacity` |
| `x-autodev-limit-type` | the provider's own window name, e.g. `weekly`, `five_hour`, `session` |
| `x-autodev-limit-resets-at` | ISO-8601 UTC |
| `x-autodev-limit-source` | `reported` (the provider said so) or `inferred` (a bridge matched free text) |

The same shape appears as `error.limit` in a non-streamed failure body and as
`response.incomplete_details.provider_limit` on a streamed one, so the router
reads one shape wherever it finds it. `scripts/codex/lib/provider-limits.mjs` is
the single implementation; the Claude bridge is Python and restates the same
literals, with `tests/provider-limits.test.mjs` guarding against drift.

Only `reported` corroborates a hard cooldown. A bridge classifying its CLI's
error text always reports `inferred`, which is enough to pick a better HTTP
status and a `Retry-After` but never enough to strand a provider for the hard
window.

### Partial results on provider exhaustion

A turn cut short after streaming has begun cannot be replayed on another
provider, so whatever the model already produced is all the caller will ever get
for that turn. It used to be discarded: the bridges emitted a bare
`response.failed` and threw away every token they had already sent, leaving the
parent with an error string in place of a partial result it could have acted on.

All three CLI bridges now close such a turn as an *incomplete* response instead,
in this order:

```
response.output_text.delta          (a truncation notice, appended to what the client already saw)
response.reasoning_summary_text.done / _part.done / output_item.done   (reasoning, status "incomplete")
response.output_text.done / content_part.done / output_item.done       (message,   status "incomplete")
response.completed { status: "incomplete", incomplete_details: { reason, provider_limit } }
data: [DONE]
```

`incomplete_details.reason` is `provider_limit`, `provider_timeout` or
`provider_interrupted`. The truncation notice is deliberately in the text a model
will read, not only in metadata: a partial answer mistaken for a complete one is
worse than a failure.

This is not a way of reporting success. `responseWasNotCompleted` treats any
status other than `completed` as a provider failure, so the turn still counts as
a failure, still cools the provider, and now cools it on the class the provider
reported rather than a generic `upstream_error`.

The router applies the same contract as a backstop for what the bridges cannot
cover -- the bridge process being killed, or the socket dropping under it. A
stream that ends without a terminal event is closed by the router itself,
carrying the text it had already forwarded. The invariant: **the router never
ends a started stream without a terminal event.**

## Observability

The router makes its effective choice visible in two ways:

- Every response includes `x-autodev-provider`, `x-autodev-model`, and
  `x-autodev-request-id`. For a role request such as `autodev/explorer`, these
  identify the concrete provider/model selected after shuffling, load balancing,
  health checks, and fallback.
- An exhaustion response additionally carries `x-autodev-limit-class` and
  `x-autodev-limit-resets-at` for the soonest-resetting candidate, alongside
  `retry-after`.
- Router events carry a `selection` field naming the pass that chose a provider:
  `primary`, `last_resort`, or `exhaustion_wait`. The `phase` is unchanged, so
  every existing counter keeps working; `selection` only says how hard the router
  had to look. A waiting request also emits its own `exhaustion_wait` event.
- Per-provider `/status` entries report `cooldownKind`, `cooldownFailureClass`,
  `cooldownResetsAt`, `lastResortEligible`, and `probeFailureStreak` alongside
  the existing cooldown countdown and failure streak.
- The status payload and dashboard report the effective Codex per-session
  concurrency limit, the number of active session buckets, active role-based
  subagent slots, and denials caused by that limit. An active session is a
  session currently holding at least one role-based subagent slot; it is not a
  count of every Codex task or process connected to the router. The default
  local configuration permits one active subagent per session; callers must
  serialize additional work or deliberately raise the
  configured limit after checking provider capacity. The deprecated `max_threads`
  alias is not surfaced. Role requests are gated before provider selection;
  direct concrete model requests
  are not counted as subagent slots. If a session ID is not supplied by the
  client, the router uses a process-wide fallback scope and reports that scope.
  That fallback is a single shared bucket: unrelated sessions that omit an
  identifier can deny one another. The router cannot infer a logical session
  from an anonymous HTTP request, so callers must propagate
  `x-codex-session-id` (or an equivalent supported field) for true independent
  per-session capacity. `/status` exposes `processFallbackEnforcement` and
  `processFallbackActiveThreads` to make this unsafe fallback visible.
- They also aggregate usage by origin (`orchestrator`,
  `subagent`, or `direct`), role, and resolved provider/model. Each bucket
  includes attempts, outcomes, average/max turn duration, and tool-call counts
  inferred from Responses output items. A `role` request is classified as a
  subagent; a direct Codex model request is classified as orchestrator-originated.
  This is an operational inference: the router sees HTTP turns, not the full
  lifetime of a Codex session, and tool-call counts cover calls represented in
  Responses events only. The JSON `/status` payload keeps `usage.byOrigin` and
  `usage.byRole` as separate, unmodified buckets.
- Usage is also aggregated under `status.usage.byWorkspace`. Each workspace
  bucket contains a privacy-safe repository label (remote `owner/repository`
  when available, otherwise the cwd basename), the cwd basename, totals, and
  nested `byRole`, `byModel`, and `byProvider` dimensions. Full absolute paths,
  prompts, credentials, and remote URLs are not stored. The dashboard renders
  this as **Usage by workspace**; missing workspace metadata is attributed to
  `unknown` rather than guessed from the router daemon's cwd.
- The dashboard's usage table collapses this into exactly two top-level rows,
  Orchestrator and Subagents, because roleless requests only carry an origin
  and role-attributed requests only carry a role: origin and role are not two
  independent dimensions to cross-tabulate. The Subagents row is the only one
  with a caret; expanding it reveals one child row per explicit role bucket
  (`usage.byRole`, excluding `unattributed`), and those child rows always sum
  to the Subagents parent totals because every subagent request is
  role-attributed. The Orchestrator row is `usage.byRole.unattributed`, which
  folds together *both* roleless origins (`orchestrator` and `direct`) so that
  no traffic is dropped from the table; it is not a strict proxy for
  Codex-origin traffic, since roleless non-Codex ("direct") requests land in
  the same bucket.
- `status.subagents` counts every subagent spawned behind the router,
  regardless of which provider spawned it and by which mechanism. This is
  distinct from `usage.byRole`, which counts *router requests* made by
  subagents: a bridge-native child makes no router request at all, so it
  appears in `status.subagents` and nowhere else. The dashboard renders it as
  **Subagents spawned** and `codex-model-router-status.mjs` prints it under
  `Subagents spawned:`. See "Counting subagents across providers".
- Open `http://127.0.0.1:4100/dashboard` in a browser for the live HTML
  dashboard; it polls the JSON status every 3 seconds. `GET /status` always
  returns raw JSON regardless of the `Accept` header, including the current
  router instance, active requests, configured models, cooldown countdowns,
  per-provider attempt and success/failure counters, the last classified
  failure, and recent routing events. The status payload includes `spawnFailures` for failures visible at the router
boundary: concurrency denials and role requests exhausted by provider failures.
These records include counts by reason, recent request IDs, and the last reason.
The dashboard renders the spawn-failure counts by reason/type in a table with
last-observed timestamps rather than only a combined text summary.
Failures raised by the Codex app-server before a role request reaches the router
are not inferable from router traffic alone.

The status payload carries no view of the Codex app-server's own threads. A
`codexTasks` snapshot from `thread/list` was surfaced here for a while and has
been removed (see "What the router deliberately does not do" below);
`scripts/codex-model-router.test.mjs` asserts the field stays absent. The local
CLI view is:

  ```sh
  node /Users/henrykirk/AutoDev/scripts/codex-model-router-status.mjs
  # Add --json for machine-readable output.
  ```

To verify the live router is receiving caller identities, inspect
`.concurrency.lastDenial.sessionScope` in `/status`; `identified` means the
per-session key was supplied, while `process-fallback` means anonymous callers
are sharing one bucket.

The router accepts the session/conversation identity from the explicit session
headers and body metadata, and also from `session_id` or `conversation_id` in
the structured `x-codex-turn-metadata` JSON. It never derives a session key
from a workspace path or task text.

The same status payload's `codexTelemetry` includes Codex OTEL lifecycle and
skill-injection telemetry (`codex.skill.injected` and
`codex.thread.skills.*`); see
[docs/metrics-dashboard.md](metrics-dashboard.md) for the receiver and
aggregation details.

Read-only roles (`explorer`, `docs-researcher`, `validator`, and
`browser-tester`) run with filesystem access broad enough to inspect approved
runtime state such as `$CODEX_HOME`/`~/.codex` and localhost diagnostics. Their
role instructions remain read-only: they must not edit, stage, commit, or push
those paths. The broader sandbox is intentional because Codex's `read-only`
policy restricts reads outside the active workspace; the parent must explicitly
scope any external inspection.

Router stderr is structured JSON (`autodev-router-event-v1`) and is retained by
launchd in `$CODEX_HOME/run/codex-model-router.launchd.err.log` (stdout uses
the sibling `*.out.log` so structured events are never interleaved with
incidental output). The direct ensure fallback writes its own log at
`$CODEX_HOME/run/codex-model-router.fallback.log` and records its tracked
PID at `$CODEX_HOME/run/codex-model-router.fallback.pid`; both files are
created with mode 0600 inside a mode 0700 directory so the local user keeps
sole read/write access. Override the fallback paths with
`CODEX_MODEL_ROUTER_FALLBACK_LOG` / `CODEX_MODEL_ROUTER_FALLBACK_PID_FILE`
when sandboxing requires a different writable location. The legacy world-
writable `/tmp/codex-model-router.log` path is gone.

`$CODEX_HOME/run/` is the canonical home for router run-time state. The
installer creates it with mode 0700 on every run, and the launchd plist writes
its logs there too, so all router
operational data survives reboot, tmpfs clears, and `/tmp` rotation.

Provider counters, recent events, and the
versioned privacy-safe OTEL aggregate section are also persisted atomically in
`$CODEX_HOME/codex-router-state.json`, so they survive router restarts. Active
requests and in-flight sessions reset, and so do `transient`, `probe` and
`config` cooldowns -- those are the router's own guesses about a moment that has
passed, and a restart is a legitimate reason to go and look again. A `hard`
cooldown survives: a provider that declared it is out of usage until Tuesday is
still out of usage on Tuesday, and the router restarts often enough under launchd
that dropping it would put it straight back to re-probing an exhausted account.
Restored cooldowns are dropped if already past and re-clamped to
`CODEX_ROUTER_HARD_COOLDOWN_MAX_MS` on the way back in.
Failure classes include `session_limit`,
`throttled`, `quota_exhausted`, `capacity`, `timeout`, `unavailable`,
`authentication`, `invalid_model`, and `probe_unavailable` (a local bridge that
did not answer its health check). Of these, only `session_limit` and
`quota_exhausted` are *hard*, and only when the provider declared them. These are observations from upstream
responses and local health checks, not a provider's authoritative quota API;
the persisted counters remain available after the router process restarts. Use
the router instance ID and request ID to correlate a turn with its fallback
history. Rotate logs by restarting the router: launchd closes and reopens the
log file handles, and the ensure hook reuses the same fallback PID file
without leaking a stale tracker.


## Supervision, liveness, and graceful drain

The router is supervised by a `KeepAlive` launchd job
(`com.codex.model-router`) so it survives app restarts, crashes, and sleep. The launchd plist lives at
`scripts/codex/launchagents/com.codex.model-router.plist` and is materialized
under `~/Library/LaunchAgents/` by the installer. Three contracts separate
"the process is alive" from "the process can serve":

- **Liveness** — `GET /health/liveliness` (or `/health`) returns
  `{"status":"ok","router":"codex-model-router"}` with HTTP 200 whenever the
  router's HTTP server is bound to `127.0.0.1:4100`. It does *not* reflect
  upstream provider health; it only certifies that the router itself is
  alive enough to answer HTTP. Use it for `launchctl`-style "did the bind
  succeed" checks and for the ensure hook's readiness probe.
- **Readiness** — `GET /health/readiness` returns HTTP 200 while the router
  accepts work and HTTP 503 with `router_draining` while it is shutting down.
  It describes router lifecycle readiness, not the health of every upstream.
  Use `GET /status` for the detailed per-provider health, cooldown countdowns,
  active request counts, and `usage`/`codexTasks` snapshots needed to decide
  whether an upstream is usable.
- **In-flight drain** — on `SIGTERM`/`SIGINT` the router stops accepting new
  `/v1/responses` work and gives in-flight requests up to
  `CODEX_ROUTER_SHUTDOWN_DRAIN_MS` (30s by default) to finish before
  forcefully aborting them and exiting. The plist sets `ExitTimeOut` to 45s
  so launchd's SIGKILL lands after the drain window completes, not in the
  middle of it. `ProcessType=Background` keeps the job out of the Dock so
  the desktop session is never disturbed by a router lifecycle event.

The `scripts/ensure-codex-model-router.sh` hook prefers the installed launchd
job and falls back to a direct `nohup` process only when launchd is genuinely
unavailable (for example, from inside the Codex sandbox where `gui/$UID` is
not reachable). It acquires an atomic private lock directory at
`$CODEX_HOME/run/codex-model-router.ensure.lock.d` so concurrent invocations
cannot race the bootstrap/nohup path. When launchd owns the job, the hook
`launchctl kickstart -k`s it on cold start and leaves a healthy process
alone; the direct fallback is never allowed to start a duplicate `nohup`
next to a launchd job that is bound to the port. When launchd is the
supervisor but the router never becomes ready, the hook fails loudly
instead of masking the failure with a duplicate unmanaged process.

The fallback path records its PID in `codex-model-router.fallback.pid`
(mode 0600). A later ensure call reuses the recorded PID when it is still
alive and healthy, recycles it via `SIGTERM` (so the router can drain)
when it is alive but the port is unhealthy, and clears a stale PID file
before starting a new one when the previous process is gone. When an
untracked process already owns the port, the hook refuses to start a
duplicate and surfaces the conflict in the log; an operator must stop
the foreign owner (or hand the job to launchd) before the ensure hook
will bind. Readiness polling is bounded (default 5s total budget,
exponential backoff capped at 1s) so a slow bind surfaces quickly and the
hook never burns CPU waiting.

The installer respects the same preference: it links every launchd plist, then
`bootout`/`bootstrap`/`kickstart` cycles each label on the `gui/$UID` domain.
It does this on every run, not behind a flag -- installing new code and leaving
the old code running is not an install, and it fails silently, because the ports
stay healthy and the files on disk look correct either way. The router drains
in-flight requests on the `SIGTERM` that `bootout` sends, so a turn in progress
finishes rather than being cut off. The readiness probe loop in
the installer waits for the router (and each provider bridge) to bind
before the ensure hooks run, so the hooks observe healthy ports and
no-op instead of racing the agents.

## Retry and error correlation

Every proxied router response carries correlation headers:

- `x-autodev-provider` — the concrete provider selected after shuffling,
  load balancing, health checks, and fallback.
- `x-autodev-model` — the concrete model dispatched to that provider.
- `x-autodev-request-id` — the per-router-request UUID. It remains stable
  across provider fallback within one request; caller-side retries may have
  a new ID. Pair it with `x-autodev-router-instance-id` and
  `routerInstanceId` from `/status` to correlate a turn across restarts and
  the structured stderr event stream.
- `x-autodev-router-instance-id` — the router process instance that handled
  the request, useful for detecting a restart during an incident.

chatgpt.com's Codex backend has been observed recycling a pooled keep-alive
connection without warning, including immediately after a prior request on
that connection completed, which surfaces as an
ECONNRESET/EPIPE/UND_ERR_SOCKET write failure while the router tries to reuse
it for the next request. Rather than only retrying around this, every `codex`
route request sets `Connection: close` on the outbound request so it always
opens a fresh connection and is never drawn from Node's pooled keep-alive
connections -- removing the race at its source instead of catching it
downstream. Other routes run on the local loopback, are unaffected by this
failure mode, and keep reusing pooled connections.

Transient direct concrete provider failures also receive a bounded
pre-response retry before the router returns a structured HTTP 502/503/504
error, as defense in depth for transport failures unrelated to connection
reuse. A completed HTTP 502/503/504 response from the provider is real
signal, so it gets exactly one retry. A connection reset, broken pipe, or
other pre-response transport failure carries no usable response signal; the
provider may still have received the request before the connection failed, so
the router uses only one extra bounded attempt (3 total, tunable with
`CODEX_ROUTER_CONCRETE_TRANSPORT_RETRY_LIMIT`). Retries use a jittered
200–400ms delay by default and can be tuned with
`CODEX_ROUTER_CONCRETE_RETRY_MS` and `CODEX_ROUTER_CONCRETE_RETRY_MAX_MS`; the
router never retries after response headers or client cancellation. The
response includes
`router_provider_unavailable`, the provider/model/request and router-instance
correlation fields, and a `retry-after` header after the provider is cooled
down. Concrete model requests are never silently rerouted.
Router-generated provider errors include stable `code`, `retryable`,
`failureClass`, `provider`, `model`, `requestId`, and `routerInstanceId`
fields in the JSON error object. Transport failures are logged as structured
`transport_error` events with only sanitized error name/code/syscall fields;
raw exception text, credentials, prompts, and upstream bodies are not exposed.
When no provider can complete a role request -- after the primary, last-resort
and bounded-wait passes have all failed -- the router returns HTTP 503 with a
`router_provider_exhausted` error code, the same `x-autodev-request-id` header,
and a `retry-after` header sized to the provider cooldown window.

The consumer of that error is a model deciding what to do next, so it carries
enough to act on rather than four repetitions of "cooldown active". `error.details`
holds `retryAfterMs`, `resetsAt`, `lastResortAttempts`, `selectionDeadlineReached`,
the per-candidate `providers[]` summary (`state`, `failureClass`, `resetsAt`,
`retryAfterMs`), and a `recommendedAction`:

- `summarize_and_yield` when every candidate is hard-limited. There is nothing to
  retry into; the right move is to return a summary of the work completed so far.
- `retry_after` otherwise, with the wait in `retryAfterMs`.

The message text says the same thing in prose, naming each provider and its reset
time, because that is what a model actually reads. Concurrency denials return HTTP
429 with `retry-after: 1` and the same `x-autodev-request-id`.

A started stream never ends without a terminal event on any of these paths: an
exhausted chain, a concrete-request failure, or an internal router error will
close the stream rather than leaving the caller with a truncated body that is
indistinguishable from a hung provider. The dashboard's
`Spawn failures` table renders the recent request IDs by reason so the
same header can be traced from the API call through the router's event log.
Its reasons are `provider_exhausted`, `selection_deadline` (the router spent its
provider-selection budget without finding one),
`max_concurrent_threads_per_session`, and `spawn_tool_unavailable`.

### Streaming resilience and keep-alives

Streaming responses (`stream: true`) to clients such as Codex Desktop are protected against idle disconnects and client disconnect cascades:

- **Downstream SSE Keep-Alives**: The router automatically transmits periodic `: codex-router keep-alive\n\n` SSE comments every 2 seconds while streaming. This prevents the downstream HTTP client (e.g. Codex Desktop's reqwest transport) from triggering an `idle timeout waiting for SSE` during quiet intervals when an upstream model or bridge is busy running tools, spawning subagents, or reasoning.
- **Client Disconnect Resilience**: When a downstream client disconnects or cancels mid-stream, write calls are guarded (`safeWrite`) against closed/destroyed response sockets, and the response stream absorbs socket errors (`EPIPE`, `ECONNRESET`, `ERR_STREAM_DESTROYED`, `ERR_STREAM_WRITE_AFTER_END`). Normal client socket drops are recorded as ignored transport events rather than escalating to fatal uncaught exceptions that would crash the router process.


## External-provider execution

The normal CLI path for an external role remains the repository launcher. It
starts the selected provider hook and local CLI profile:

```sh
/Users/henrykirk/AutoDev/scripts/codex/run-provider-agent.sh \
  --role explorer --prompt 'Bounded task; report evidence.'
```

The caller specifies only the role. Direct terminal sessions use the tracked
`autodev/<role>` aliases through `local_model_router`; provider selection and
fallback remain inside the router. The launcher also applies the selected role's
reasoning effort, summary mode, and sandbox settings so a global parent config
cannot accidentally send a read-only role at the wrong provider effort.
The native app-server path is also configured and verified, but the desktop
high-level fanout service does not currently delegate through it.

The router can reroute a role request only after the Codex process has reached
the configured `local_model_router` and sent a request for an `autodev/<role>`
alias. It can retry another provider when that provider returns a fallbackable
response or becomes unavailable. A failure in the app-server before its model
request is emitted (for example, failure to create the child thread or resolve
its environment) never reaches AutoDev and cannot be redirected by this
router. Concrete provider model requests are intentionally not rerouted because
they represent an explicit provider choice; use a role alias for fallback.

All spawned roles are leaf agents. Native role aliases (`autodev/<role>`) and
external-provider model aliases are therefore excluded from the root
delegation hook; only the configured parent model receives that instruction.
For a delegated Claude turn the bridge is a leaf-provider gateway: it launches
the real Claude Code CLI with `--disallowed-tools Agent,Task`. `Agent` is
the current Claude Code subagent tool and `Task` is the legacy name. That CLI
flag is the enforcement: this repository carries no `.claude/settings.json`, so
a direct Claude Code session opened here is not bounded by it.
The root-delegation hook also exempts Claude model aliases,
while native `autodev/*` roles are excluded by their role alias, so leaf
providers do not receive the parent-only instruction to spawn more agents.
Keep these restrictions at the CLI/gateway boundary rather than
relying only on role prompt text. Provider bridges must treat the active
working directory as transport metadata and must never infer it from arbitrary
task prose. If no valid structured workspace is present, the bridge fails
closed with a diagnostic instead of silently selecting AutoDev; an explicit
`CODEX_PROJECT_ROOT` remains available only as an operator-controlled fallback
for intentionally pinned, single-repository service deployments.

### Agent role across the bridge boundary

The orchestrator tier can land the root turn on Claude, MiniMax, or
Antigravity. A bridge that assumes every request is a delegated leaf then tells
the parent it is a bounded leaf agent that must not spawn child agents, which
suppresses exactly the delegation the root turn exists to perform: the parent
announces a delegation and then silently does the work itself.

The router therefore names the role of every outbound request in the
router-generated `x-autodev-agent-role` header. The value comes from the
router's own alias dispatch, never from the inbound request: `downstreamHeaders`
builds its header set from scratch, so a client claiming
`x-autodev-agent-role: orchestrator` on a leaf request cannot escape the leaf
policy. Every bridge receives it as an ordinary request header; Antigravity
once also received it in the Responses `extra_headers` body field because the
LiteLLM hop that used to sit in front of that adapter dropped raw headers.

Bridges resolve the header and pick one of two shared prompts:

| Role | Prompt | Claude CLI subagent tools |
| --- | --- | --- |
| `orchestrator` | `scripts/codex/prompts/orchestrator.md` | available |
| anything else (including absent) | `scripts/codex/prompts/leaf.md` | `--disallowed-tools Agent,Task` |

The Antigravity bridge has no equivalent CLI flag: `agy` exposes its subagent
tools unconditionally, so a leaf turn there is bounded by `leaf.md` prompt
policy alone rather than at the CLI boundary. `agy`'s own subagent definitions
do carry an `EnableSubagentTools` field ("Grant tools to define and invoke its
own subagents"), but the model sets it when it spawns a child, so it bounds
depth below the orchestrator rather than bounding the turn the bridge starts;
`orchestrator.md` asks for it to be withheld by default.

#### Isolation between concurrently running orchestrators

Several orchestrators can run on this machine at once, each with its own agent
tree. An agent's reach is meant to stop at that tree, in both directions.

- **Claude.** `CROSS_SESSION_CLAUDE_TOOLS` (`SendMessage`, `ListAgents`) is
  denied to *every* role, orchestrator included, since reaching another
  orchestrator is out of bounds regardless of who does it. Measured on Claude
  Code 2.1.260, a `-p` print-mode process does not join the peer socket bus
  under `/tmp/cc-socks/` at all, so this denies nothing that is currently
  reachable. It is pinned precisely because the isolation otherwise rests on an
  undocumented property of print mode. Peer messaging between the user's own
  *interactive* sessions is a separate, deliberate Claude Code feature that
  AutoDev neither creates nor can disable.
- **Antigravity.** `manage_subagents` is already scoped by `agy`: `list`
  reports "active **direct** subagents", and `kill` refuses an id that "is not a
  known active subagent". `send_message` takes an arbitrary "Conversation ID of
  the agent to message" and resolves it at run time (`recipient %q not found`);
  its documented use is parent/child within one run. No cross-run delivery has
  been demonstrated, but `~/.gemini/antigravity-cli/presence/` is a
  machine-wide registry of live conversation ids that an agent with shell
  access could read, so `leaf.md` and `orchestrator.md` both forbid acting on
  any agent id that did not come from spawning it or from the runtime-supplied
  parent id.

### The Claude bridge owns the whole system prompt

The Claude bridge passes `--system-prompt`, which *replaces* the Claude CLI's
default prompt, rather than `--append-system-prompt`, which leaves it in force
underneath. Appending puts AutoDev role policy in competition with Claude Code's
own harness guidance — which includes a standing instruction not to spawn agents
unless asked, directly at odds with `orchestrator.md`. Replacement makes the
role prompts the only policy in the turn.

`scripts/codex/prompts/base.md` holds what the default prompt otherwise supplied
and the role prompts do not: tool-selection guidance, the destructive-action
limits that matter because the bridge runs under `bypassPermissions`, and
reporting-honesty rules. `system_prompt()` composes it as
base + workspace + role policy, role last.

Two consequences of replacement are load-bearing:

- **The per-machine sections are gone.** A default-prompt session is told its
  working directory, platform, and git status; a replaced prompt is told
  nothing (`--exclude-dynamic-system-prompt-sections` is ignored with
  `--system-prompt`). The bridge therefore states the workspace it resolved from
  structured request metadata in the prompt itself. Without that block the agent
  begins the turn not knowing which repository it is in, which is why the prompt
  is built per request rather than read from one static file.
- **`AGENTS.md` is not injected either way.** Claude Code auto-loads `CLAUDE.md`
  (this survives prompt replacement) but not `AGENTS.md`, so a repository whose
  guidance lives only in `AGENTS.md` — AutoDev included — never had it in
  context. `base.md` tells the agent to read both from the workspace root.
  Symlinking `CLAUDE.md` to `AGENTS.md` in a target repository restores
  automatic injection.

The bridge also exports `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`. Claude Code's
bundled skill catalogue is a second, unversioned source of instructions that no
role prompt accounts for; a bridge turn is governed by the role prompts and the
target repository's own skills.

Anything that is not exactly `orchestrator` is treated as a leaf, so a missing
or unrecognized header fails closed to the bounded policy. The same
`orchestrator.md` is what the `enforce-root-delegation.sh` `UserPromptSubmit`
hook injects, so the root agent gets one delegation policy no matter which
provider serves it. The JavaScript bridges share
`scripts/codex/lib/bridge-role.mjs`; the Claude bridge reads the same prompt
files from Python. The installer deploys both the shared module and the prompt
files into the hooks directory at their repo path minus the leading `scripts/`,
so a bridge sits at the same depth above them there as it does in a checkout
and one relative lookup -- `./codex/lib/…`, `./codex/prompts/…` -- resolves in
both. That is what makes the bridges runnable and importable straight from a
checkout, so their pure request-shaping helpers can be unit-tested rather than
asserted against source text.

This role-aware boundary is the *only* place the recursion limit belongs. A
target repository must not also list `Agent` (or `Task`) under
`permissions.deny` in its `.claude/settings.json`: Claude Code resolves project
settings from the bridge-selected workspace `cwd`, deny rules outrank both
`--allowed-tools` and `--permission-mode bypassPermissions`, and no CLI flag can
re-grant a denied tool. Such a rule is role-blind, so it silently strips `Agent`
from the root turn as well, and the orchestrator then truthfully reports that it
has no subagent tool and does the work itself — the exact failure the role header
exists to prevent. Leaf turns stay bounded without it, because the bridge already
passes `--disallowed-tools Agent,Task` for every non-orchestrator role. Denying
the background-task tools (`TaskCreate`, `TaskOutput`, `TaskList`, `TaskUpdate`,
`TaskGet`) is unrelated and safe; those are not the subagent tool.

Excluding project settings from the bridge instead (`--setting-sources user`)
does restore `Agent`, but it discards the target repository's whole deny list —
including its `Bash(git push *)`, `Bash(rm -rf *)`, and `Read(./.env)` rules,
which under `bypassPermissions` are the only remaining guardrail on an
autonomous turn. Fix the deny list, not the setting sources.

MiniMax is the exception, and it needs no role prompt: its proxy
(`scripts/codex-minimax-responses-proxy.mjs`) is a transparent pass-through to
`https://api.minimax.io` rather than a local CLI gateway. It forwards the
parent's own Responses payload, so the root turn arrives with the real Codex
context and the delegation policy the `UserPromptSubmit` hook already injected;
there is no bridge-authored prompt that could override it. That proxy therefore
strips `x-autodev-agent-role` and `x-codex-turn-metadata` instead of honouring
them: both are local routing metadata (the latter carries absolute workspace
paths and git remote URLs) with no meaning to a remote API.

### Counting subagents across providers

A native Codex spawn is visible to the router for free: the child thread's
`autodev/<role>` request *is* the spawn. A bridge-native spawn is not visible at
all -- the CLI runs the child in-process and no request is ever made -- so an
orchestrator turn served by Claude or Antigravity reported zero subagents,
which is indistinguishable from a provider that refused to delegate.

The router therefore hands every spawn-capable bridge three generated headers
per request:

| Header | Value |
| --- | --- |
| `x-autodev-request-id` | the router's own request UUID |
| `x-autodev-subagent-spawn-tools` | comma-separated tool names to watch, from `capabilities.subagentSpawnTools` |
| `x-autodev-agent-events-url` | `http://127.0.0.1:4100/v1/agent-events` |

A bridge matches the tool names its CLI reports against the watchlist and
`POST`s `{ requestId, events: [ { type: "subagent_spawn", tool, role, status, count, children } ] }`,
where `children` is one `{ id, model }` per subagent the call created.
The bridge therefore needs no routing config, no provider identity, and no
router address of its own; and because the request id is an unguessable UUID a
bridge only learns by serving the request, presenting it is also what
authorizes the report. A report naming an unknown request id is rejected with
`404 router_unknown_request` and counted nowhere. Reporting is best effort in
the bridge: a transport failure costs a count, never the model turn.

Codex and MiniMax receive none of these headers -- the router already observes
their children as role requests, so reporting them again would double-count.

The watchlist names only tools that actually start a child. Antigravity's
`manage_subagents` lists and stops existing children and `define_subagent`
declares a type for later use; neither spawns, and `manage_subagents` in
particular is called far more often than any delegation happens -- in one
sampled proxy log, 104 `manage_subagents` calls against 4 `invoke_subagent`
calls. Adding it to the watchlist would turn every status poll into a spawn.

One `invoke_subagent` call dispatches a *batch*: agy is instructed to send
"subagents in batches of at most 16 per `invoke_subagent` call", and the tool
arguments are `{"Subagents":[{"TypeName":...,"Model":...,"Prompt":...}, ...]}`.
The bridge therefore reports one count per entry in that batch and takes each
child's role from its `TypeName` (falling back to the `name` a
`define_subagent` archetype registers), rather than reporting one roleless
spawn per call. A model id is never used as a role: it is the model, not the
role, and would fill `byRole` with model names.

Where those arguments sit inside the CLI's stream-json step update is agy's
business and has moved between versions, so the bridge finds the `Subagents`
array by shape anywhere in the update instead of pinning one path. A step that
exports no arguments still reports one roleless spawn -- the pre-batch
behaviour -- so a CLI change costs role detail and batch width, never the
spawn itself. Set `AGY_LOG_SPAWN_STEPS=1` on the Antigravity proxy to print the
structure of each spawn step (keys kept, string values truncated, so delegation
prompts stay out of the log) when confirming the shape against a new agy build.

Claude's `Agent` tool is one call per child, and the Claude bridge reads the
child's role from the call's `subagent_type`.

#### When the workspace removes the delegation tool

The bridge keeps `Agent`/`Task` for the orchestrator and denies them to every
leaf, but that is not the last word on which tools a turn gets. A project
`.claude/settings.json` in the *target* workspace that lists `Agent` under
`permissions.deny` strips it from the orchestrator too, and
`--permission-mode bypassPermissions` does not override a deny. The turn then
does all the work itself and reports zero subagents -- the exact reading as a
provider that chose not to delegate.

The CLI's `system` init event is the only place that absence is observable: a
denied tool is simply missing from its `tools` list and nothing later mentions
it. On an orchestrator turn the bridge compares that list against the router's
watchlist and, when none of the spawn tools are present, logs the workspace and
posts `{ type: "subagent_tools_unavailable", expected, available }`. The router
records it as a `spawn_tool_unavailable` spawn failure -- with the model that
was left unable to delegate -- so it appears in **Subagent spawn failure
telemetry** rather than vanishing into a zero. It is not a spawn, so it moves no
spawn counter.

Only the tool names are sent, capped at 100: a full tool inventory fingerprints
the workspace, and the router needs only enough to name the gap. The check runs
for the orchestrator alone, since a leaf having no delegation tool is the
policy working.

Both mechanisms land in one `status.subagents` aggregate: `total`,
`byMechanism` (`router_alias` / `bridge_native`), `byProvider`, `byRole`,
`byStatus`, and the 50 most recent spawns. `router_alias` spawns are attributed
to the provider that served the `autodev/orchestrator` turn for the same
session, which is the only join available: a child thread's request carries no
trace of which provider ran its parent. The join is skipped for callers that
supply no session id, because they all share one fallback bucket and would
otherwise be credited to an unrelated caller's parent turn. A role request with
no joinable parent turn is attributed to `unattributed` rather than guessed. `codexNativeSpawns` reports Codex's own OTLP
`codex.multi_agent.spawn` counter beside the router's count rather than merged
into it, because it covers only Codex-exported threads and adding the two would
double-count every `router_alias` spawn.

#### CLI-delegated children as measured turns

A spawn count says a child existed; it does not say the provider did the work.
Counting only spawns left the provider that actually ran a twelve-way fan-out
showing exactly one turn in **Provider health and usage**, and no subagent row
at all in **Usage by orchestrator and subagents** -- both tables are built from
router requests, and a CLI child never makes one.

The bridge's report is the only evidence those turns happened, so it is also
what opens a usage bucket for each child. A `subagent_spawn` opens one turn per
child, attributed to the provider, workspace, and model of the request the
bridge was serving; the matching `subagent_result`
(`{ type: "subagent_result", tool, role, outcome, durationMs, children }`)
closes it with the duration the CLI actually spent. The `id` on each child is
what pairs the close with its open, and is unique within the request.

Closing is an accuracy improvement, not a requirement. A CLI child cannot
outlive the parent turn that spawned it, so the router closes any child still
open when the parent request finishes, measured against the time elapsed since
its spawn. A bridge that never reports a close -- or dies mid-turn -- therefore
still has its children counted; only the per-child duration is lost. A report
that lands after the parent turn already ended is opened and settled at once
rather than dropped, because bridges post without awaiting.

##### What a spawn tool's completion does and does not mean

For Antigravity, closing on the dispatch step is *wrong*, and the parent-turn
bound above is the accurate path rather than the fallback. Captured directly
from `agy -p ... --output-format stream-json`, one `invoke_subagent` dispatch
emits exactly two updates:

```jsonc
{ "step_index": 2, "state": "ACTIVE", "step_type": "subagent", "tool_name": "invoke_subagent",
  "subagent_info": { "subagents": [ { "type_name": "research", "role": "Line Counter",
                                      "conversation_id": "b1655ed9-…", "log_uri": "file:///…" } ] } }
{ "step_index": 2, "state": "DONE",   "duration_seconds": 0.043191, … }
```

The turn containing that dispatch ran 45.2 seconds and the child genuinely did
the work. `invoke_subagent` is fire-and-forget: `DONE` reports that the
*hand-off* finished in 43ms, and agy emits no later step when a child completes
-- the child's result reaches the parent as context, invisibly. The child's true
runtime is therefore not observable from this stream at all, and
`manage_subagents` is how agy tends children afterwards rather than a completion
signal.

So a bridge must not treat a spawn tool's `DONE` as its children finishing. Doing
so reported ~40ms for children that ran for minutes, which is worse than
reporting nothing: it fills the usage tables with a number that looks like a
measurement. Antigravity children stay open and close with the parent turn,
which bounds them honestly -- the child ran somewhere inside that window. A
terminal state other than `DONE` does close immediately, because that means the
hand-off itself failed and there was never a child to wait for.

Read a bridge-native child's duration as an upper bound, not a measurement.

These turns are deliberately *not* fed through the router's event path.
Provider health, cooldown, and the fallback chain describe routing decisions
this router made, and a child it never routed must not move them. Only the
usage buckets -- which measure work done behind the router, not routing --
count them, tagged with the `subagent` origin.

Two details follow from that:

- `status.subagents.byStatus` is the breakdown of how spawns *ended*: a close
  moves a child from `started` to `success` or `failure`, and each row in
  `recent` carries its own `settled` tally so a batch shows how its children
  finished rather than only how many it began. It previously reported
  `{ started: N }` forever, which read as "none of these ever finished" about
  children that had all completed.
- A child whose spawn step exported no role is counted under
  `unattributed-subagent`, never the bare `unattributed` role. That key is
  roleless *orchestrator* traffic, which the dashboard renders as the
  Orchestrator row, so folding children into it would credit a delegation to
  its parent. `status.subagents.byRole` still says `unattributed` for the same
  children; each key is unambiguous within its own table.
- A child's model is its own only when the batch entry names a concrete one.
  agy writes `inherit` when the child runs on whatever the parent was routed
  to, which is not a model id, so the router resolves it to the parent's model.
  A concrete child model that no tier configures still reaches the provider's
  row: the dashboard sums every model observed for a provider, not only the
  configured ones.

The shared reporter is `scripts/codex/lib/agent-events.mjs`; the Claude bridge
mirrors it in Python. The installer ships the module beside the bridges that
import it. The Claude bridge reports spawns but not closes, so its children are
measured against the parent turn until it adopts `reportResults`.

### Reasoning effort on the Antigravity bridge

`agy` encodes reasoning depth in the model id itself (`gemini-3.8-flash-high`)
and rejects the whole invocation when a separate `--effort` disagrees:

```
Error: invalid model selection (--model "gemini-3.8-flash-high" --effort "medium"):
--model gemini-3.8-flash-high conflicts with --effort=medium
```

The router picks the model per tier and the caller's reasoning effort is an
independent value, so the two routinely disagree and the turn fails before the
CLI starts. The model id is the more specific choice, so it wins: the bridge
omits `--effort` entirely for any model whose id already carries a
`-low`/`-medium`/`-high` suffix, and passes it only for models that do not
(`claude-sonnet-4-6`, for example). `orchestrator.reasoningEffort.antigravity`
therefore has effect only through the model the orchestrator tier selects.

### Streaming provider progress back to the parent

A bridge that reports only the final assistant message leaves the parent (and
the operator watching it) with a silent gap for the whole turn. Every bridge
therefore streams the provider's intermediate output as Responses reasoning
summary events (`response.reasoning_summary_text.delta` on a `reasoning` item
at output index 0) alongside the answer text at output index 1:

- Claude: reasoning (`thinking_delta`), each tool it starts, and the CLI's own
  `task_summary` details.
- Antigravity: `step_update` tool and step activity.
- Copilot: `commentary`-phase message deltas, `report_intent` narration, and
  each `tool.execution_start`, parsed from the CLI's `--output-format json`
  JSONL stream.

Each bridge holds its SSE headers back until the provider produces real output
(reasoning, a tool call, or answer text). Until that point a provider failure
is still reported as an HTTP status the router can fall back on; after it, the
turn is genuinely under way and the parent watches it live. Synthetic
pre-run activity is buffered and flushed when the stream opens, so it never
commits the response on its own.

### Canonical turn metadata and `workspaces` map contract

Codex's canonical transport carries turn metadata as the
`x-codex-turn-metadata` request header (the local model router forwards this
verbatim to the chosen provider bridge). The metadata contains a
`workspaces` map whose key is the absolute repo/workspace path (the
Codex source inserts `repo_root` as the map key); each value carries
only git metadata. Provider bridges therefore consult each `workspaces`
map key as an absolute-path candidate first, and only fall back to the
legacy structured `cwd`/`project_root`/`working_directory`/`path` fields
inside each value when no key is a directory that exists on this host.
This matches the upstream Codex contract: values do not carry the path.

Callers that cannot set custom headers may instead embed the same JSON
under `client_metadata["x-codex-turn-metadata"]` in the request body;
the local router normalizes that back into the canonical header shape
so provider bridges only ever have to parse one form. A caller-supplied
`extra_headers` field is discarded outright rather than forwarded: it is an
SDK escape hatch that would bypass the router's credential and header
allowlist. The resolution
order inside `resolve_cwd` / `resolveCwd` is therefore:

1. Top-level `cwd`, `project_root`, or `working_directory` on the request.
2. The same fields inside `metadata`.
3. The canonical `workspaces` map keys (absolute paths).
4. The structured path fields inside each `workspaces` value.
5. The explicit `CODEX_PROJECT_ROOT` operator override.
6. Fail closed with a `400 invalid_request_error` (and a `WorkspaceResolutionError`
   in the bridge) listing the fields the request did carry, instead of
   silently defaulting to an unrelated parent in this repository.

Steps 3 and 4 refuse an ambiguity rather than resolving one. If more than one
listed workspace exists on this host and the request does not say which is
active, the bridge raises `AmbiguousWorkspaceError` (a `WorkspaceResolutionError`,
so it still surfaces as the same `400`). Taking the first would let JSON key
order -- which carries no meaning and which the caller does not control --
decide which repository a coding agent edits, so a turn rooted in one repo
could land in another with nothing but a changed working tree to show for it.
`CODEX_PROJECT_ROOT` is the documented tiebreak and settles the ambiguity when
a multi-root turn is legitimate.

The router's telemetry label reads the same map from the other end, and the two
must agree: a label naming a different repository than the one the agent edited
is worse than no label. The router therefore imports `WORKSPACE_KEYS` and
`isDirectory` from the shared resolver rather than reimplementing them -- it
previously took the first non-empty key while the bridges took the first key
that is a directory here, so a stale first entry made telemetry and execution
disagree silently. Where the bridge refuses an ambiguity, the router records no
workspace instead of inventing one. `tests/workspace-resolution.test.mjs` and
`test_all_provider_bridges_resolve_a_workspace_identically` pin both halves,
the latter by running the Python and JavaScript resolvers over the same inputs
and asserting identical answers.

The JavaScript CLI adapters share this resolver in
`scripts/codex/lib/resolve-workspace.mjs`; the installer deploys that module
alongside the runtime adapter copies, at `codex/lib/` beneath the hooks
directory so the same `./codex/lib/…` specifier resolves in a checkout too. The Claude bridge remains a separate
Python implementation, but it follows the same contract and is covered by the
same workspace-resolution tests. Provider-specific code should pass its
operator override into the shared resolver rather than reimplementing request
metadata parsing or workspace selection.

Provider bridges also forward only delegated user-task content and add their
role boundary as provider-controlled instructions. Parent system/developer
messages are not serialized as fake `[system]` or `[developer]` turns, which
prevents a leaf model from mistaking orchestration context for a user prompt
injection. Agent creation failures that occur in the Codex app-server before a
request reaches the local router cannot be repaired or intercepted by AutoDev;
use an explicit `autodev/<role>` model, keep the parent task rooted in the
intended repository, and inspect the app task/log event for those failures.

## Provider paths and constraints

| Provider    | Local path                                                           | Important constraint                                                                                                                                 |
| ----------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude      | Codex -> Claude Responses bridge on `127.0.0.1:4000` -> Claude CLI   | Uses `CLAUDE_CODE_OAUTH_TOKEN`; the selected role model and reasoning effort are forwarded.                                                          |
| MiniMax     | Codex -> MiniMax Responses proxy on `127.0.0.1:18765`                | Transparent pass-through to the remote API, not a CLI gateway; local routing headers are stripped. Provider quota/rate limits are upstream conditions; inspect the proxy log when diagnosing them.                                                      |
| Antigravity | Codex -> Antigravity adapter `:4002` -> `agy` CLI | `useAiCredits=false` and `useG1Credits=false` keep AI-credit overages disabled. Headless runs require the configured noninteractive permission mode. |
| GitHub Copilot | Codex -> local Copilot Responses adapter `:4003` -> `copilot` CLI | Requires an authenticated local Copilot CLI; unavailable adapters are skipped by fallback. |
| Local router | Codex Responses -> `127.0.0.1:4100` -> model-based provider dispatch | GPT/Codex models use the stored Codex OAuth; external model names use the existing local bridges. |

The Claude Responses adapter is not the GPT passthrough: it launches the
OAuth-authenticated Claude CLI and translates Claude's stream into Responses events. The
`LITELLM_API_KEY` used between the local router and local bridge is only a
localhost gateway credential; it is removed, along with Anthropic API-key
variables, before the Claude CLI subprocess starts.
When Claude emits both `stream_event` text deltas and full `assistant` message
snapshots, the bridge forwards only the canonical deltas so subagent
commentary is not rendered twice; assistant-only streams remain supported.
The bridge also passes the approved runtime directories in
`CLAUDE_CODE_ADDITIONAL_DIRS` to Claude Code via `--add-dir`; it defaults to
`~/.codex`. This lets read-only roles inspect materialized role/config and
telemetry state outside the repository while their role instructions continue
to forbid edits outside the active workspace. The bridge uses Claude Code's
`bypassPermissions` mode by default so approved runtime reads and localhost
diagnostics are not blocked by an interactive approval gate; override
`CLAUDE_CODE_PERMISSION_MODE` when a stricter provider policy is required.
The local router owns the GPT branch separately and forwards it to
`https://chatgpt.com/backend-api/codex/responses` with the existing Codex OAuth
token and account ID from `auth.json`.

The four LaunchAgents under `scripts/codex/launchagents/` are the supported
persistence path for this Desktop host. The installer loads them with `KeepAlive`
and also retains idempotent direct-start hooks as a fallback when `launchctl` is
inaccessible.

The router applies a 900-second total upstream response timeout by default,
including streaming response bodies; override it with the positive
`CODEX_ROUTER_UPSTREAM_TIMEOUT_MS` environment variable when the provider's
turn budget is intentionally different. Client disconnects abort the
upstream request and release the subagent slot, while an upstream stream that
ends without `response.completed` is surfaced as `response.failed` instead of
being reported as a successful early turn.

## Versioned integration, source of truth, and setup

`scripts/codex/` owns the versioned machine-local Codex integration materialized
into `/Users/henrykirk/.codex` through managed symlinks and runtime copies. Keep provider credentials in
`/Users/henrykirk/.codex/.env` or Keychain; no secret belongs in this
repository.

All non-secret user-level provider configuration, profiles, model catalogs,
provider adapters, startup hooks, shared skill content, and installer logic
are versioned in this repository under `scripts/codex/` and `scripts/`. The
installer is the only supported materialization path into
`/Users/henrykirk/.codex`; materialized runtime copies and symlinks, logs, and
`.env` credentials remain machine-local and are not versioned.

- User-level skills: `scripts/codex/skills/{lsp-mcp-server,orchestration,remove-legacy-shims}`
  are versioned directories owned by AutoDev. The installer creates absolute,
  directory-level symlinks under `$HOME/.agents/skills/`, so Codex reads the
  canonical skill files without a second copied source of truth. Keep each
  source `SKILL.md` as a regular file; `--check` rejects file-level or relative
  skill links because Codex currently skips symlinked `SKILL.md` files.
- Native command rules: `scripts/codex/rules/default.rules` is the versioned
  source for restrictive Codex `prefix_rule` entries. The installer symlinks it
  to `$CODEX_HOME/rules/default.rules`; it replaces the old custom Git hook and
  is testable with `codex execpolicy check` before restart. These prefix rules
  cover direct command tokens and the native engine's supported shell parsing;
  they are not a general-purpose parser for arbitrary environment wrappers or
  global-option placement. Explicit localhost diagnostic URLs are allowed for
  `curl`; remote curl commands remain subject to the normal approval policy.
  Destructive `git clean`, `git rebase`, whole-tree `git restore`, force branch
  deletion, force push, superuser/raw-disk formatting, and root/home wildcard
  deletion commands are forbidden.
- User-level role definitions: `scripts/codex/agents/*.toml`, materialized as
  managed regular-file copies under `$CODEX_HOME/agents/`. The role loader must
  receive regular files rather than symlinks; the installer replaces symlinks and
  verifies exact content matches. Code-oriented roles (`default`, `explorer`,
  `worker`, `validator`, and `smart`) enable the user-level `lsp` MCP server and
  the matching `lsp-mcp-server` skill. `browser-tester` and `smart` explicitly
  enable the user-level `playwright` MCP server with the approved browser tool
  allowlist; the role-local `enabled = true` is intentional because a role block
  otherwise overrides the user-level server entry. `browser-tester` and
  `docs-researcher` explicitly disable `lsp`. There is one flat role registry;
  provider assignment is expressed by each role's `model_provider` and
  `model`, not by a provider-specific directory, launcher-specific role name,
  or duplicated role definition.
- `.codex/config.toml` is project execution configuration only. It does not
  register agents or own provider role definitions.
- User-level provider/role configuration: `scripts/codex/config.toml`, which
  is symlinked to `/Users/henrykirk/.codex/config.toml`. This is required by
  Codex because project-local config cannot override provider/auth keys. The
  user layer registers the same codebase-agnostic roles with paths relative to
  `$CODEX_HOME/agents/` for use from any repository. Every custom provider must set
  `model_provider` at the active user/profile layer, define a matching
  `[model_providers.<id>]` entry with `wire_api = "responses"`, and set
  `requires_openai_auth = false` when it uses its own credential or local
  gateway.
- CLI profiles: `scripts/codex/profiles/*.config.toml`; these remain useful for
  direct turns and provider-specific defaults, while the role registry remains
  shared across profiles. `run-provider-agent.sh` reads roles from
  `$CODEX_HOME/agents/`, just like the normal user-level Codex registry.
- Model catalogs: `scripts/codex/catalogs/*.json`; the per-provider catalogs
  support CLI profiles and `codex-model-catalog.json` is the combined user
  catalog used by native app-server configuration.
- Hooks, adapters, and direct-start scripts: `scripts/ensure-*`,
  `scripts/run-*`, and the corresponding files in `scripts/codex/`; the
  provider shell wrappers and Responses adapters from `scripts/` are
  checksum-checked runtime copies in `/Users/henrykirk/.codex/hooks/`. A
  direct symlink would be denied by macOS Desktop privacy controls when the
  ChatGPT app launches it; the installer rematerializes the copy whenever the
  versioned source changes.

### Operational notes

- `run-provider-agent.sh` prefers the newest executable matching
  `$HOME/.nvm/versions/node/*/bin/codex`; set `CODEX_BIN` to override that
  selection.
- Profile names are configuration files selected with `codex --profile`, not
  `[profiles.*]` tables.
- After changing registry or profile configuration, run `codex doctor --json`
  and restart Codex when applicable so the role registry is reloaded.
- Every execution surface must resolve the same flat role entry. The role file
  is the authority for the provider/model pair; CLI profiles and provider
  startup hooks provide transport only and must not define a second role
  registry.
- The native app-server can select the external provider from the loaded user
  catalog/registry. Fully quit and reopen the Desktop app, then start a new
  thread, after changing this user-level provider configuration; an existing
  process can retain the previous provider registry. A fresh `spawn_agent`
  result is only valid when its effective provider/model metadata or provider
  logs confirm the custom route; a ChatGPT-account model error means that the
  request was rejected before the custom provider was selected.
- The active parent provider is the tracked `local_model_router` at
  `http://127.0.0.1:4100/v1`. It dispatches by `model`: GPT/Codex models go to
  the Codex OAuth Responses endpoint, while `sonnet`, MiniMax, and Gemini
  models go to the existing provider bridges. The parent runs on the
  `autodev/orchestrator` alias (see **Orchestrator routing and fallback**),
  which keeps orchestration on the primary Codex model while allowing the
  router to degrade to another provider when Codex is out of usage.
  `default_subagent_model = "autodev/default"` likewise ensures native default
  child work enters the multi-provider priority groups instead of bypassing
  them with a concrete Codex model.
- `[agents].max_depth = 1` in the Codex config limits native Codex child
  creation; it does not remove tools from the separate Claude Code process
  launched by the Claude bridge. `--disallowed-tools Agent,Task` and the
  Claude settings deny list are the authoritative no-descendant controls for
  that process.
- All five services -- the router and the four provider bridges -- are launchd
  agents with `RunAtLoad` and `KeepAlive`, managed by the installer.
  `launchctl bootout`/`bootstrap`/`kickstart` refresh every one of them on each
  install, while direct-start hooks remain an idempotent fallback for a
  sandboxed run where `launchctl` is unreachable. Those hooks adopt the agent
  when one is loaded rather than backgrounding a rival copy beside it: a process
  launchd does not own is one nothing restarts, so it survives installs still
  running the code it loaded days earlier.

Install or repair the managed machine integration with:

```sh
bash /Users/henrykirk/AutoDev/scripts/codex/install-codex-integration.sh
bash /Users/henrykirk/AutoDev/scripts/codex/install-codex-integration.sh --check
```

## Build vs. delegate

This integration sits next to two off-the-shelf components that advertise
overlapping capabilities -- LiteLLM (native Anthropic/OpenAI/Gemini providers,
routing, fallbacks, cooldowns) and the Codex app-server. What is custom here is
custom deliberately. This section records why, so the question does not have to
be re-derived.

### The provider bridges are not model gateways

Three of the four bridges spawn a subscription-authenticated coding-agent CLI
and return a *completed agent turn* -- file edits, tool calls, and for Claude
and Antigravity their own subagents -- not a model completion:

| Bridge | Authenticates as |
| --- | --- |
| `codex-claude-cli-responses-proxy.py` | the `claude` CLI's Claude Code OAuth subscription. `claude_environment()` **removes** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child environment so the CLI cannot silently fall back to metered API billing. |
| `codex-antigravity-cli-responses-proxy.mjs` | the `agy` CLI's Antigravity subscription. `ensure-codex-antigravity-proxy.sh` refuses to start unless `useAiCredits=false` and `useG1Credits=false`. |
| `codex-copilot-cli-responses-proxy.mjs` | the `copilot` CLI's own login. |
| `codex-minimax-responses-proxy.mjs` | a plain `MINIMAX_API_KEY`; no subprocess. |

LiteLLM's `anthropic/*` and `gemini/*` providers speak HTTPS with an API key:
a different account, a different meter, and per-token billing where these have
a flat subscription. They would also return a completion where these return an
agent turn, so `capabilities.subagentSpawn: true` -- which the router enforces
at config load for every orchestrator-tier provider -- could not hold. MiniMax
is the one bridge whose *auth* would suit a LiteLLM deployment, but most of it
is the `multi_agent_v1` namespace flatten/re-expand round-trip that LiteLLM has
no equivalent for; without that the orchestrator emits plain text instead of
delegating.

### The router owns routing, not LiteLLM

LiteLLM genuinely implements fallbacks, cooldowns, retries, load balancing, and
model aliases, so that part of the router overlaps it on paper. The router keeps
the job because its fallback is entangled with semantics LiteLLM cannot express:

- per-provider orchestrator `reasoningEffort`, applied per fallback candidate;
- the spawn-capability validation that fails the process at config load;
- the session-to-provider join that attributes `router_alias` subagents to the
  provider that ran the parent turn;
- namespaced-tool flattening for every non-Codex provider;
- the declared-limit contract: cooldowns keyed to a provider's own stated reset
  time rather than a generic backoff curve, and a last-resort pass that treats a
  cooldown as advice rather than a bar so an orchestrator turn survives a tier
  that is briefly all cooling at once;
- the `x-autodev-*` headers, which the router **generates** per request from its
  own alias dispatch. LiteLLM can forward allowlisted client headers; it cannot
  mint them, and a forwarded client value would be exactly the spoofable input
  `downstreamHeaders` refuses to trust.

LiteLLM was previously deployed in front of the Antigravity adapter. It routed
nothing -- one upstream, an identity model map, `num_retries: 0`, no callbacks,
budgets, caching, or provider translation -- and it cost a config-drift
self-healer (LiteLLM reads its YAML once at start), a header workaround (it
dropped raw headers, so the router smuggled its own through the Responses body),
and a correctness bug (it mistranslated `response.failed`, so the adapter faked
a *completed* response carrying the error as assistant text). The router calls
the adapter directly now and all three are gone.

### What the Codex app-server does and does not offer

The app-server exposes thread, turn, `command/exec`, `model/list`, filesystem,
and approval methods over JSON-RPC. It has no provider selection, fallback,
retry, model aliasing, usage telemetry, OTLP export, or concurrency limiting;
`thread/start` accepts a `model` but no provider orchestration. It therefore
does not overlap the router's job. A `thread/list` snapshot was surfaced in
`/status` for a while; nothing in routing, concurrency, or fallback ever read
it, and it cold-spawned a `codex app-server` process on every refresh, so it
was removed rather than reworked.

### Why the OTLP receiver lives in the router

Codex's exporter posts logs, traces, and metrics to one endpoint, and the
router is the only always-on local service on the request path, so it receives
them. Co-location also lets `/status` present router-owned request telemetry
and Codex-native metrics together while keeping them separately sourced --
`codexNativeSpawns` sits *beside* the router's subagent count rather than being
summed into it, because adding the two would double-count every `router_alias`
spawn. The router owns provider selection, fallback, cooldown, concurrency, and
origin telemetry because Codex emits none of those semantics.

## Distribution and validation strategy

Split a task into independent items and distribute those items across providers
when useful. Select a primary implementer per item based on the task, while
using the overall provider mix to distribute load. Assign disjoint files,
cross-check important work with a different provider, and finish with an
independent validator. Keep prompts bounded and report skipped, stalled, rate-
limited, or quota-exhausted providers as missing evidence rather than success.
Always close completed child handles so the agent pool is released.

Target state and current verification:

| Requirement | State |
| --- | --- |
| OpenAI/Codex orchestrator and tracked user-level cross-provider TOMLs | Configured under `scripts/codex/agents/` and materialized as verified regular-file copies under `~/.codex/agents/`. The orchestrator runs on the `autodev/orchestrator` alias so it degrades to Claude Opus, MiniMax, then Gemini when Codex is out of usage. |
| Shared user-level skills | Configured under `scripts/codex/skills/` as AutoDev-owned versioned directories and materialized under `~/.agents/skills/`; `install-codex-integration.sh --check` verifies all three links. |
| Versioned scripts/hooks/config installed into `~/.codex` | Configured; profiles/catalogs/config are symlinked and app-executed hooks are checksum-checked runtime copies; `install-codex-integration.sh --check` passes. |
| Native app-server custom-provider routing | Verified: `thread/start` selects the custom provider; Claude reached its upstream session-limit response. |
| Direct CLI provider turns | Transport paths verified; Claude was session-limited, MiniMax was upstream high-demand limited, and Antigravity was quota-limited. |
| Desktop high-level native fanout across external models | Tracked model-router and user-level role/config wiring is installed; requires a fully restarted Desktop app and a new thread for fresh `spawn_agent` verification through `127.0.0.1:4100`. |

The remaining verification is specifically a fresh Desktop `spawn_agent` turn
after the user-level provider configuration reload. The repository’s roles,
user-level provider registry, explicit non-OpenAI auth boundaries, combined
model catalog, hooks, gateways, and direct CLI/app-server transports are
configured and validated.

### Cross-provider execution contract

`/Users/henrykirk/AutoDev/scripts/codex/execution-contract.json` is the shared
contract for role kind, read-only intent, expected MCP capabilities, and provider
spawn capabilities. The Claude, Antigravity, and Copilot bridge prompt paths
append the role-specific contract instead of treating every non-orchestrator as
an identical generic leaf. The installer deploys the contract beside the bridge
runtime modules. Native TOML role files remain the Codex configuration surface;
contract changes must be validated with the bridge-role matrix tests.
