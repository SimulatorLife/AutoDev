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
Claude's smart model to `claude-opus-4-8` or Codex's to `gpt-5.6-sol` there; providers like MiniMax or Copilot that use the same model across tiers only need to define `default`. The installer materializes this file as
`$CODEX_HOME/codex-model-routing.json`.
For the `default` capability tier, the router randomizes Claude, Gemini/Antigravity, and MiniMax, then falls back to Copilot and OpenAI/Codex. For `smart`, it randomizes Claude and Gemini/Antigravity, then falls back directly to OpenAI/Codex Sol. Providers that are unavailable or return fallbackable limit errors are skipped and the next provider in the current group is tried before progressing to the next group:

1. `default`: Claude, Gemini/Antigravity, MiniMax (randomized), then Copilot, then OpenAI/Codex Luna
2. `smart`: Claude, Gemini/Antigravity (randomized), then OpenAI/Codex Sol

Provider availability is checked through local health endpoints and credential
checks. HTTP 429/5xx, quota, session-limit, high-demand, timeout, and
unavailable responses cause the router to try the next provider. A malformed
request is returned immediately rather than hidden by fallback. Streaming
fallback happens before response headers are sent; a provider that fails after
streaming has begun cannot be safely replayed. Claude's `rate_limit_event` is
informational when `rate_limit_info.status` is `allowed`; only a non-allowed
status is treated as a Claude limit.

## Observability

The router makes its effective choice visible in two ways:

- Every response includes `x-autodev-provider`, `x-autodev-model`, and
  `x-autodev-request-id`. For a role request such as `autodev/explorer`, these
  identify the concrete provider/model selected after shuffling, load balancing,
  health checks, and fallback.
- The status payload and dashboard report the active Codex concurrency limits
  (`max_concurrent_threads_per_session` and the legacy `max_threads` alias),
  effective limit, active role-based subagent slots, and denials caused by
  those limits. Configure the canonical setting rather than treating
  `max_threads` as a separate global cap. Role
  requests are gated before provider selection; direct concrete model requests
  are not counted as subagent slots. If a session ID is not supplied by the
  client, the router uses a process-wide fallback scope and reports that scope.
- They also aggregate usage by origin (`orchestrator`,
  `subagent`, or `direct`), role, and resolved provider/model. Each bucket
  includes attempts, outcomes, average/max turn duration, and tool-call counts
  inferred from Responses output items. A `role` request is classified as a
  subagent; a direct Codex model request is classified as orchestrator-originated.
  This is an operational inference: the router sees HTTP turns, not the full
  lifetime of a Codex session, and tool-call counts cover calls represented in
  Responses events only.
- Open `http://127.0.0.1:4100/status` in a browser for the bare-bones dashboard;
  it polls the JSON status every 3 seconds. `/dashboard` is an explicit HTML
  alias. API clients that send `Accept: application/json` to `/status` receive
  the current router instance, active requests, configured models, cooldown
  countdowns, per-provider attempt and success/failure counters, the last
  classified failure, and recent routing events. The status payload includes `spawnFailures` for failures visible at the router
boundary: concurrency denials and role requests exhausted by provider failures.
These records include counts by reason, recent request IDs, and the last reason.
Failures raised by the Codex app-server before a role request reaches the router
are not inferable from router traffic alone.

The status payload also includes a `codexTasks` snapshot from the local Codex
app-server `thread/list` method. It reports counts and raw task metadata for
statuses such as `active`, `idle`, and `notLoaded` (up to the configured page
window); it is deliberately not interpreted as an orphan detector. The router
refreshes it periodically and retains the last snapshot if the app-server is
unavailable. The local CLI view is:

  ```sh
  node /Users/henrykirk/AutoDev/scripts/codex-model-router-status.mjs
  # Add --json for machine-readable output.
  ```

Router stderr is structured JSON (`autodev-router-event-v1`) and is retained by
launchd in `~/.codex/hooks/model-router.launchd.log` (the direct ensure path
uses `/tmp/codex-model-router.log`). Provider counters and recent events are
also persisted atomically in `$CODEX_HOME/codex-router-state.json`, so they
survive router restarts. Only active requests and short cooldown timers reset.
Failure classes include `session_limit`,
`throttled`, `quota_exhausted`, `capacity`, `timeout`, `unavailable`,
`authentication`, and `invalid_model`. These are observations from upstream
responses and local health checks, not a provider's authoritative quota API;
the persisted counters remain available after the router process restarts. Use
the router instance ID and request ID to correlate a turn with its fallback
history.

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

The Claude bridge is intentionally a leaf-provider gateway: when it launches
the real Claude Code CLI, it passes `--disallowed-tools Agent,Task`. `Agent` is
the current Claude Code subagent tool and `Task` is the legacy name. The same
boundary is declared in `.claude/settings.json` with both tools in
`permissions.deny`, so a direct Claude Code session from this repository has
the same behavior. The root-delegation hook also exempts Claude model aliases,
so leaf providers do not receive the parent-only instruction to spawn more
agents. Keep these restrictions at the CLI/gateway boundary rather than
relying only on role prompt text.

## Provider paths and constraints

| Provider    | Local path                                                           | Important constraint                                                                                                                                 |
| ----------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude      | Codex -> Claude Responses bridge on `127.0.0.1:4000` -> Claude CLI   | Uses `CLAUDE_CODE_OAUTH_TOKEN`; the selected role model and reasoning effort are forwarded.                                                          |
| MiniMax     | Codex -> MiniMax Responses proxy on `127.0.0.1:18765`                | Provider quota/rate limits are upstream conditions; inspect the proxy log when diagnosing them.                                                      |
| Antigravity | Codex -> LiteLLM `:4001` -> Antigravity adapter `:4002` -> `agy` CLI | `useAiCredits=false` and `useG1Credits=false` keep AI-credit overages disabled. Headless runs require the configured noninteractive permission mode. |
| GitHub Copilot | Codex -> local Copilot Responses adapter `:4003` -> `copilot` CLI | Requires an authenticated local Copilot CLI; unavailable adapters are skipped by fallback. |
| Local router | Codex Responses -> `127.0.0.1:4100` -> model-based provider dispatch | GPT/Codex models use the stored Codex OAuth; external model names use the existing local bridges. |

The Claude Responses adapter is not the GPT passthrough: it launches the
OAuth-authenticated Claude CLI and translates Claude's stream into Responses events. The
`LITELLM_API_KEY` used between the local router and local bridge is only a
localhost gateway credential; it is removed, along with Anthropic API-key
variables, before the Claude CLI subprocess starts.
The local router owns the GPT branch separately and forwards it to
`https://chatgpt.com/backend-api/codex/responses` with the existing Codex OAuth
token and account ID from `auth.json`.

The five LaunchAgents under `scripts/codex/launchagents/` are the supported
persistence path for this Desktop host. The installer loads them with `KeepAlive`
and also retains idempotent direct-start hooks as a fallback when `launchctl` is
inaccessible.

## Versioned integration, source of truth, and setup

`scripts/codex/` owns the versioned machine-local Codex integration materialized
into `/Users/henrykirk/.codex` through managed symlinks and runtime copies. Keep provider credentials in
`/Users/henrykirk/.codex/.env` or Keychain; no secret belongs in this
repository.

All non-secret user-level provider configuration, profiles, model catalogs,
provider adapters, startup hooks, and installer logic are versioned in this
repository under `scripts/codex/` and `scripts/`. The installer is the only
supported materialization path into `/Users/henrykirk/.codex`; runtime copies,
symlinks, logs, and `.env` credentials remain machine-local and are not
versioned.

- User-level role definitions: `scripts/codex/agents/*.toml`, materialized as
  managed regular-file copies under `$CODEX_HOME/agents/`. The role loader must
  receive regular files rather than symlinks; the installer replaces symlinks and
  verifies exact content matches. There is one flat role registry;
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
  models go to the existing provider bridges. The parent remains on its
  configured Codex model, while `default_subagent_model = "autodev/default"`
  ensures native default child work enters the multi-provider priority groups
  instead of bypassing them with a concrete Codex model. This keeps parent
  orchestration on Codex while making child-provider fallback effective.
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
| OpenAI/Codex orchestrator and tracked user-level cross-provider TOMLs | Configured under `scripts/codex/agents/` and materialized as verified regular-file copies under `~/.codex/agents/`. |
| Versioned scripts/hooks/config installed into `~/.codex` | Configured; profiles/catalogs/config are symlinked and app-executed hooks are checksum-checked runtime copies; `install-codex-integration.sh --check` passes. |
| Native app-server custom-provider routing | Verified: `thread/start` selects the custom provider; Claude reached its upstream session-limit response. |
| Direct CLI provider turns | Transport paths verified; Claude was session-limited, MiniMax was upstream high-demand limited, and Antigravity was quota-limited. |
| Desktop high-level native fanout across external models | Tracked model-router and user-level role/config wiring is installed; requires a fully restarted Desktop app and a new thread for fresh `spawn_agent` verification through `127.0.0.1:4100`. |

The remaining verification is specifically a fresh Desktop `spawn_agent` turn
after the user-level provider configuration reload. The repository’s roles,
user-level provider registry, explicit non-OpenAI auth boundaries, combined
model catalog, hooks, gateways, and direct CLI/app-server transports are
configured and validated.
