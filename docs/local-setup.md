# Local AI and provider setup

The `scripts/` tree is the tracked home for the local-PC setup previously kept in RacingGame. It includes provider proxies/routers, Codex role and model configuration, launch agents, installation/ensure scripts, and provider health checks.

## Installation

Start with the installer and read the script before running it:

```bash
bash scripts/codex/install-codex-integration.sh
```

Provider-specific `ensure-*` and `run-*` scripts are intentionally separate so a machine can enable only the providers it has credentials for. Use environment variables documented in each script to override local binary paths and project roots; do not add machine secrets or generated logs to this repository.

The tracked Codex role files under `scripts/codex/agents/` contain role-specific
configuration plus shared-prompt composition markers. The installer renders
`base.md` and `leaf.md` into regular files under `$CODEX_HOME/agents/` before
Codex loads them; provider identity remains configured in the provider
profiles/catalogs, while role names stay stable and codebase-agnostic.

The user-level config registers the `lsp` and `playwright` MCP servers through the
installed `run-autodev-mcp.sh` launcher. The launcher resolves binaries from
AutoDev's pinned devDependencies while preserving the active workspace as the
MCP process cwd, so a target repository does not need to duplicate those
packages. Both resolve from pinned AutoDev devDependencies (`lsp-mcp-server` and `@playwright/mcp`) rather
than `pnpm dlx @playwright/mcp@latest`; `dlx @latest` re-resolves the package on
every cold start (network + startup latency), grows the pnpm `dlx` cache, and
drifts the version across hosts and agents, so it is not used. Code-oriented
roles (`default`, `explorer`, `worker`, `validator`, and `smart`) enable the
`lsp` server and the `lsp-mcp-server` skill. The `browser-tester` and `smart`
role files explicitly enable the `playwright` server and pin its tool approval
mode to `approve`; this explicit role-level enablement is required because the
role block overrides the user-level MCP entry. The `browser-tester` and
`docs-researcher` roles explicitly disable `lsp` because their bounded work does
not require code navigation. AutoDev declares the MCP bridge, browser
automation, and TypeScript language-server dependencies so this repository can
launch and use them with `pnpm exec`. Other active repositories need to expose
the same `lsp-mcp-server` and `playwright-mcp` commands through their package
manager for the user-level MCP entries to work there. The `docs-researcher`
role enables the OpenAI Developer Docs MCP and Codex's native `web_search`
tool, which is the appropriate search/open/read path for authoritative websites.
The Playwright MCP remains for browser/UI testing roles and is disabled for
`docs-researcher`. Provider bridges that run Claude Code receive the same pinned
Playwright server through a per-turn inline `--mcp-config` for `browser-tester`
and `smart`; the bridge denies the unneeded evaluate, upload, navigation-back,
and unsafe code-execution tools rather than relying on mutable `~/.claude`
settings. Antigravity has no per-turn MCP flag, so the installer updates its
single global `playwright` entry to `pnpm exec playwright-mcp`.

The installer installs CocoIndex Code once at the user level with
`pipx install 'cocoindex-code[full]==0.2.41'` when `ccc` is not already available. It
registers the stdio MCP once in the user-level Codex config as `ccc mcp` without
a `cwd`; Codex therefore starts it from the active session workspace. CocoIndex
Code keeps each repository's incremental index in that repository's
`.cocoindex_code/` directory. The installer does not run `codex mcp add` on every
invocation because that command is not an idempotent upsert; the versioned config
stanza is the single registration source of truth. Install `pipx` before running
the installer if it is not already present. For a new repository, the installed
`ccc` skill directs the agent to run `ccc index` from that repository root; later
searches refresh changed files incrementally.

CocoIndex Code is enabled in the `default`, `explorer`, `worker`, `validator`,
and `smart` agent profiles. It is explicitly disabled in `docs-researcher` and
`browser-tester`, whose jobs are documentation/web research and UI testing
rather than codebase semantic search. The user-level registration remains in
place so the selected coding profiles can use the same MCP without duplicate
installations.

The installer exposes these AutoDev-owned shared skill directories in
`$HOME/.agents/skills/` through symlinks. The root `orchestration` skill is
also enabled in the parent user config and injected deterministically into root
turns by the delegation hook and provider bridges; leaf role TOMLs keep it
disabled so child agents do not inherit parent orchestration policy.

- `ccc`
- `code-simplification`
- `diagnosing-bugs`
- `improve-codebase-architecture`
- `lsp-mcp-server`
- `orchestration`
- `remove-legacy-shims`
- `resolve-merge-conflicts`

The shared engineering skills are repository-agnostic and intended to apply
across local Codex development. `code-simplification` focuses on DRY, KISS,
cohesion, coupling, ownership, fragmentation, and abstraction cleanup.
`diagnosing-bugs` focuses on reproducible failure signals, root-cause tracing,
falsifiable hypotheses, evidence-safe instrumentation, regression guards, and
verification against the original symptom. `improve-codebase-architecture`
focuses on ownership, module depth, seams, dependency direction, locality, test
surfaces, and structural change amplification. `resolve-merge-conflicts`
provides an intent-preserving conflict-resolution workflow plus a bundled
compact context extractor so agents can inspect unresolved paths and hunks
without loading whole conflicted files by default.

Keep the canonical registered user-level skill content in AutoDev; update the
skill directories there and rerun the installer when changing this setup. The
installer links each complete skill directory with an absolute target; do not
link an individual `SKILL.md` file because Codex currently skips file-level
symlinks. Its `--check` mode rejects missing or relative skill-directory links
and symlinked `SKILL.md` files. Restart Codex or start a new task after
installation so user-level skill discovery refreshes.

Destructive Git commands are enforced by Codex's native rules engine. The
tracked rules live in `scripts/codex/rules/default.rules` and are symlinked by
the installer to `$CODEX_HOME/rules/default.rules`. Validate a rule without
running the command:

```bash
codex execpolicy check --pretty \
  --rules /Users/henrykirk/AutoDev/scripts/codex/rules/default.rules \
  -- git reset --hard HEAD
```

The same rules allow explicit localhost diagnostics such as
`curl http://127.0.0.1:4100/status`, while remote curl commands remain gated.
They also deny destructive Git history/worktree operations, force pushes and
branch deletion, superuser/raw-disk commands, and catastrophic root/home
recursive deletion.

## Safety

- Inspect launch-agent plists before loading them with `launchctl`. The model
  router plist keeps `KeepAlive` and `RunAtLoad`, separates stdout/stderr
  under `$CODEX_HOME/run/`, uses `ProcessType=Background`, and sets an
  `ExitTimeOut` large enough for the router's drain timeout before launchd
  SIGKILLs it. Inspect the other provider plists independently; they may have
  different lifecycle and log-path contracts.
- Keep OAuth/PAT/API credentials outside the repository. Background services
  load provider credentials from `~/.codex/.env`; for MiniMax this means a
  private `MINIMAX_API_KEY=...` entry with restrictive file permissions.
- Treat proxy and router logs as local-only operational data. Antigravity's
  launchd service is the canonical supervisor when loaded; the ensure hook
  refuses to start a duplicate unmanaged process on port 4002. The
  router ensure hook owns the same property for port 4100 and additionally
  serializes concurrent invocations through an atomic private lock directory
  at `$CODEX_HOME/run/codex-model-router.ensure.lock.d`.
- All router operational state (launchd stdout/stderr logs, the fallback
  pid/log files, the ensure lock) lives under `$CODEX_HOME/run/` which the
  installer creates with mode 0700. Override individual paths with
  `CODEX_MODEL_ROUTER_FALLBACK_LOG`,
  `CODEX_MODEL_ROUTER_FALLBACK_PID_FILE`, and
  `CODEX_MODEL_ROUTER_ENSURE_LOCK` when sandboxing requires a different
  writable location.
- Liveness vs readiness: `GET /health/liveliness` (or `/health`) returns
  HTTP 200 when the router's HTTP server is bound; use it only as a liveness
  probe. `GET /health/readiness` returns HTTP 200 while the router accepts
  work and HTTP 503 while it is draining. `GET /status` remains the detailed
  diagnostic surface for per-provider health, cooldown countdowns, active
  request counts, and the router instance ID — use it to decide whether an
  upstream is usable and to correlate a turn's request header across
  restarts.
- Prefer `ensure-*` scripts for idempotent setup and the `diagnose-*` scripts for evidence before changing provider routing.
- Open `http://127.0.0.1:4100/dashboard` in a browser for the lightweight live
  dashboard. Raw JSON status is available at `http://127.0.0.1:4100/status`.
  The dashboard shows only the router's own state; it does not query the Codex
  app-server. A `thread/list` snapshot was surfaced here once and was removed
  because nothing in routing, concurrency, or fallback read it and it cold-spawned
  an app-server process on every refresh. Inspect the same state with
  `node scripts/codex-model-router-status.mjs` (use `--json` for automation).
  It reports observed session-limit, throttling, quota, capacity, timeout, and
  availability failures; it cannot query an upstream provider's private quota
  dashboard. Antigravity CLI turns allow up to 15 minutes by default (override
  with `AGY_PRINT_TIMEOUT` when needed). Router counters and recent events are
  persisted in `$CODEX_HOME/codex-router-state.json`; response headers and
  structured router events provide per-request
  correlation without logging prompts or credentials.

The tracked configuration enables network access for workspace-write sessions
so agents can query approved localhost diagnostics such as the model router.
Read-only roles use a broader filesystem policy only to inspect runtime state
such as `~/.codex`; their role instructions still prohibit edits outside the
active repository.

### Execution contract

The versioned execution contract is `scripts/codex/execution-contract.json`. It
is installed beside the bridge modules and is consumed by provider bridges for
role kind, read-only intent, expected MCP capabilities, and provider spawn
capabilities. Canonical role prose lives in
`scripts/codex/prompts/roles/*.md`; bridges and the native-role renderer share
those fragments instead of duplicating them. A bridge must report missing
capabilities rather than silently substituting a different workflow. Native role
TOMLs remain the Codex-native configuration surface; changes to role capability
policy must update the contract and its matrix tests together.

Workspace-local `.codex/agents/*.toml` roles are allowed when they use names
outside AutoDev's managed flat roles. A project-local role that reuses a managed
name is rejected as an explicit conflict rather than silently choosing precedence;
this keeps user-level provider routing deterministic while allowing repository-
specific agents, MCPs, and skills to coexist under distinct names.

To enable the router authentication boundary during a planned restart, run:

```bash
bash scripts/codex/install-codex-integration.sh --enable-router-auth --materialize-only
```

This creates/reuses a private `CODEX_ROUTER_AUTH_TOKEN` in
`$CODEX_HOME/.env`, exports it to launchd, and synchronizes the configured
`local_model_router` provider without restarting the current services. Run the
normal installer later, when no active task depends on the local router, to
restart the supervisors and enforce the token on live requests. It is
intentionally an explicit migration flag rather than an implicit install-time
change so an existing Desktop session is not disconnected unexpectedly.

For a live Desktop session, use `--materialize-only` to synchronize hooks,
role files, MCP launchers, and rendered LaunchAgents without cycling any running
service:

```bash
bash scripts/codex/install-codex-integration.sh --materialize-only
```

Run the normal installer later, when no active task depends on the local router,
to restart the supervisors and load the new runtime code.
