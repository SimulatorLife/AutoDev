# Local AI and provider setup

The `scripts/` tree is the tracked home for the local-PC setup previously kept in RacingGame. It includes provider proxies/routers, Codex role and model configuration, launch agents, installation/ensure scripts, and provider health checks.

## Installation

Start with the installer and read the script before running it:

```bash
bash scripts/codex/install-codex-integration.sh
```

Provider-specific `ensure-*` and `run-*` scripts are intentionally separate so a machine can enable only the providers it has credentials for. Use environment variables documented in each script to override local binary paths and project roots; do not add machine secrets or generated logs to this repository.

The tracked Codex role files under `scripts/codex/agents/` are regular configuration files. Provider identity is configured in the provider profiles/catalogs, while role names remain stable and codebase-agnostic.

The user-level config registers the `lsp` MCP server as `pnpm exec lsp-mcp-server`. Code-oriented roles (`default`, `explorer`, `worker`, `validator`,
and `smart`) enable both that server and the `lsp-mcp-server` skill. The
`browser-tester` and `docs-researcher` roles explicitly disable both because
their bounded work does not require code navigation. AutoDev declares the MCP
bridge and TypeScript language-server dependencies so this repository can launch
and use them with `pnpm exec`. Other active repositories need to expose the same
`lsp-mcp-server` command through their package manager for the user-level MCP
entry to work there.

The installer exposes these four AutoDev-owned shared skill directories in
`$HOME/.agents/skills/` through symlinks:

- `diagnosing-bugs`
- `improve-codebase-architecture`
- `lsp-mcp-server`
- `orchestration`
- `remove-legacy-shims`

`code-simplification` is repository-agnostic and is intended to be available to
local Codex work in any repository. It defines a behavior-preserving workflow
for DRY, KISS, cohesion, coupling, ownership, fragmentation, and abstraction
cleanup while deferring to each target repository's own architecture and
validation rules.

`diagnosing-bugs` and `improve-codebase-architecture` are repository-agnostic
engineering workflows intended to apply across local Codex development. The
architecture skill focuses on ownership, module depth, seams, dependency
direction, locality, test surfaces, and structural change amplification. The
bug-diagnosis skill focuses on reproducible failure signals, root-cause tracing,
falsifiable hypotheses, evidence-safe instrumentation, regression guards, and
verification against the original symptom.

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
  launchd services are the canonical supervisors when loaded; the ensure hook
  refuses to start duplicate unmanaged processes on ports 4001/4002. The
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
  The dashboard also periodically queries the local Codex
  app-server for `thread/list` task status and shows the returned task IDs and
  metadata. Inspect the same state with
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