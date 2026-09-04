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
For the `default` capability tier, the router randomizes Claude, Gemini/Antigravity, and MiniMax, then falls back to Copilot and OpenAI/Codex. For `smart`, it randomizes Claude and Gemini/Antigravity, then falls back directly to OpenAI/Codex Sol. Providers that are unavailable or return fallbackable limit errors are skipped and the next provider in the current group is tried before progressing to the next group:

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
- MiniMax is restored in the orchestrator fallback chain. Codex CLI defines
  subagent tools in a proprietary `type: "namespace"` structure (`multi_agent_v1`),
  which generic Responses endpoints drop or reject. The MiniMax Responses
  proxy (`scripts/codex-minimax-responses-proxy.mjs`) implements outbound
  request rewriting to flatten namespaced tools into standard `type: "function"`
  definitions (e.g., `multi_agent_v1__spawn_agent`) and re-expands them in
  downstream SSE responses. This allows MiniMax to properly receive and invoke
  `spawn_agent` during orchestrator turns rather than emitting plain text.

When every orchestrator candidate is unavailable or cooling down, the router
returns `503 router_provider_exhausted` with a `Retry-After` header, exactly as
it does for an exhausted role tier.

Provider availability is checked through local health endpoints and credential
checks. HTTP 429/5xx, quota, session-limit, high-demand, timeout, and
unavailable responses cause the router to try the next provider. A malformed
request is returned immediately rather than hidden by fallback. Streaming
fallback happens before response headers are sent; a provider that fails after
streaming has begun cannot be safely replayed. Claude's `rate_limit_event` is
informational when `rate_limit_info.status` is `allowed`; only a non-allowed
status is treated as a Claude limit.

Provider failures use exponential backoff: the default cooldown is 30 seconds,
then 60 seconds, 120 seconds, and so on up to 10 minutes for repeated failures.
The cooldown and failure streak are provider-wide, so a failing provider moves
behind healthy peers for later role requests. When every candidate is cooling
down, the router returns `503 router_provider_exhausted` with a `Retry-After`
header indicating the earliest retry time rather than immediately hammering the
same provider. Override the defaults with the positive millisecond environment
variables `CODEX_ROUTER_PROVIDER_COOLDOWN_MS` and
`CODEX_ROUTER_PROVIDER_COOLDOWN_MAX_MS` when operating a deliberately different
retry policy.

## Observability

The router makes its effective choice visible in two ways:

- Every response includes `x-autodev-provider`, `x-autodev-model`, and
  `x-autodev-request-id`. For a role request such as `autodev/explorer`, these
  identify the concrete provider/model selected after shuffling, load balancing,
  health checks, and fallback.
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

The status payload also includes a `codexTasks` snapshot from the local Codex
app-server `thread/list` method. It reports counts and task metadata for
statuses such as `active`, `idle`, and `notLoaded` (up to the configured page
window); it is deliberately not interpreted as an orphan detector. Codex
returns task timestamps as Unix seconds, so the router normalizes `createdAt`
and `updatedAt` to ISO 8601 strings before exposing them to API and dashboard
consumers. The router refreshes the snapshot periodically and retains the last
snapshot if the app-server is unavailable. The local CLI view is:

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
installer creates it with mode 0700 during both baseline install and
`--restart`, and the launchd plist writes its logs there too, so all router
operational data survives reboot, tmpfs clears, and `/tmp` rotation.

Provider counters, recent events, and the
versioned privacy-safe OTEL aggregate section are also persisted atomically in
`$CODEX_HOME/codex-router-state.json`, so they survive router restarts. Only
active requests, in-flight sessions, and short cooldown timers reset.
Failure classes include `session_limit`,
`throttled`, `quota_exhausted`, `capacity`, `timeout`, `unavailable`,
`authentication`, and `invalid_model`. These are observations from upstream
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

The router's `--restart` installer flow respects the same preference: the
installer links every launchd plist, then `bootout`/`bootstrap`/`kickstart`
cycles each label on the `gui/$UID` domain. The readiness probe loop in
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
When no provider can complete a role request, the router returns HTTP 503
with a `router_provider_exhausted` error code, the same
`x-autodev-request-id` header, and a `retry-after` header sized to the
provider cooldown window. Concurrency denials return HTTP 429 with
`retry-after: 1` and the same `x-autodev-request-id`. The dashboard's
`Spawn failures` table renders the recent request IDs by reason so the
same header can be traced from the API call through the router's event log.

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
policy. Antigravity additionally receives the header through the Responses
`extra_headers` field, because LiteLLM can drop raw request headers.

Bridges resolve the header and pick one of two shared prompts:

| Role | Prompt | Claude CLI subagent tools |
| --- | --- | --- |
| `orchestrator` | `scripts/codex/prompts/orchestrator.md` | available |
| anything else (including absent) | `scripts/codex/prompts/leaf.md` | `--disallowed-tools Agent,Task` |

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
files beneath the hooks directory, keeping their `scripts/` path so the same
relative lookups work in a checkout and in the installed copy.

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
so provider bridges only ever have to parse one form. For Antigravity, the
router also puts this same allowlisted header in the Responses
`extra_headers` field: LiteLLM's Responses transformation can discard the
raw request header and unknown top-level workspace fields before calling the
local adapter. No caller-supplied credential or other arbitrary header is
copied into that field. The resolution
order inside `resolve_cwd` / `resolveCwd` is therefore:

1. Top-level `cwd`, `project_root`, or `working_directory` on the request.
2. The same fields inside `metadata`.
3. The canonical `workspaces` map keys (absolute paths).
4. The structured path fields inside each `workspaces` value.
5. The explicit `CODEX_PROJECT_ROOT` operator override.
6. Fail closed with a `400 invalid_request_error` (and a `WorkspaceResolutionError`
   in the bridge) listing the fields the request did carry, instead of
   silently defaulting to an unrelated parent in this repository.

The JavaScript CLI adapters share this resolver in
`scripts/codex/lib/resolve-workspace.mjs`; the installer deploys that module
alongside the runtime adapter copies. The Claude bridge remains a separate
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
| Antigravity | Codex -> LiteLLM `:4001` -> Antigravity adapter `:4002` -> `agy` CLI | `forward_client_headers_to_llm_api: true` must remain enabled so the structured workspace metadata reaches the adapter; `useAiCredits=false` and `useG1Credits=false` keep AI-credit overages disabled. Headless runs require the configured noninteractive permission mode. |
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

The five LaunchAgents under `scripts/codex/launchagents/` are the supported
persistence path for this Desktop host. The installer loads them with `KeepAlive`
and also retains idempotent direct-start hooks as a fallback when `launchctl` is
inaccessible.

`scripts/ensure-codex-antigravity-proxy.sh` also self-heals config drift for the
Antigravity LiteLLM process: LiteLLM only reads `antigravity.yaml` at process
start, so a healthy, already-running process can keep serving a stale config
after that file changes. The script fingerprints the resolved config content
against a stamp recorded on the last successful start and restarts LiteLLM
(via `launchctl kickstart`, or by recycling the locally tracked `nohup` PID
when running outside launchd) only when the fingerprint has changed; a missing
stamp (first run) or an unreadable config is never treated as drift, so
healthy, up-to-date processes are never restarted unnecessarily.

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
  the matching `lsp-mcp-server` skill; `browser-tester` and `docs-researcher`
  explicitly disable both. There is one flat role registry; provider assignment
  is expressed by each role's `model_provider` and
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
- LiteLLM model mapping: `scripts/codex/litellm/antigravity.yaml`.

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
- The five launchd plist sources are active and managed by the installer.
  `launchctl bootout`/`bootstrap`/`kickstart` refresh them during `--restart`,
  while direct-start hooks remain an idempotent fallback.

Install or repair the managed machine integration with:

```sh
bash /Users/henrykirk/AutoDev/scripts/codex/install-codex-integration.sh --restart
bash /Users/henrykirk/AutoDev/scripts/codex/install-codex-integration.sh --check
```

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
