# Local AI and provider setup

The `scripts/` tree is the tracked home for the local-PC setup previously kept in RacingGame. It includes provider proxies/routers, Codex role and model configuration, launch agents, installation/ensure scripts, and provider health checks.

## Installation

Start with the installer and read the script before running it:

```bash
bash scripts/codex/install-codex-integration.sh
```

Provider-specific `ensure-*` and `run-*` scripts are intentionally separate so a machine can enable only the providers it has credentials for. Use environment variables documented in each script to override local binary paths and project roots; do not add machine secrets or generated logs to this repository.

The tracked Codex role files under `scripts/codex/agents/` are regular configuration files. Provider identity is configured in the provider profiles/catalogs, while role names remain stable and codebase-agnostic.

The three shared skills under `scripts/codex/skills/` are tracked AutoDev-owned
skill directories. The installer exposes those versioned directories in
`$HOME/.agents/skills/` through symlinks:

- `lsp-mcp-server`
- `orchestration`
- `remove-legacy-shims`

Keep the canonical skill content in AutoDev; update the directories there and
rerun the installer when changing this user-level skill setup. Restart Codex or
start a new task after installation so user-level skill discovery refreshes.

Destructive Git commands are enforced by Codex's native rules engine. The
tracked rules live in `scripts/codex/rules/default.rules` and are symlinked by
the installer to `$CODEX_HOME/rules/default.rules`. Validate a rule without
running the command:

```bash
codex execpolicy check --pretty \
  --rules /Users/henrykirk/AutoDev/scripts/codex/rules/default.rules \
  -- git reset --hard HEAD
```

## Safety

- Inspect launch-agent plists before loading them with `launchctl`.
- Keep OAuth/PAT/API credentials outside the repository. Background services
  load provider credentials from `~/.codex/.env`; for MiniMax this means a
  private `MINIMAX_API_KEY=...` entry with restrictive file permissions.
- Treat proxy and router logs as local-only operational data. Antigravity's
  launchd services are the canonical supervisors when loaded; the ensure hook
  refuses to start duplicate unmanaged processes on ports 4001/4002.
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
