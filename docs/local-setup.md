# Local AI and provider setup

The `scripts/` tree is the tracked home for the local-PC setup previously kept in RacingGame. It includes provider proxies/routers, Codex role and model configuration, launch agents, installation/ensure scripts, and provider health checks.

## Installation

Start with the installer and read the script before running it:

```bash
bash scripts/codex/install-codex-integration.sh
```

Provider-specific `ensure-*` and `run-*` scripts are intentionally separate so a machine can enable only the providers it has credentials for. Use environment variables documented in each script to override local binary paths and project roots; do not add machine secrets or generated logs to this repository.

The tracked Codex role files under `scripts/codex/agents/` are regular configuration files. Provider identity is configured in the provider profiles/catalogs, while role names remain stable and codebase-agnostic.

## Safety

- Inspect launch-agent plists before loading them with `launchctl`.
- Keep OAuth/PAT/API credentials outside the repository. Background services
  load provider credentials from `~/.codex/.env`; for MiniMax this means a
  private `MINIMAX_API_KEY=...` entry with restrictive file permissions.
- Treat proxy and router logs as local-only operational data.
- Prefer `ensure-*` scripts for idempotent setup and the `diagnose-*` scripts for evidence before changing provider routing.
- Open `http://127.0.0.1:4100/status` in a browser for the lightweight live
  dashboard, or inspect the same state with
  `node scripts/codex-model-router-status.mjs` (use `--json` for automation).
  It reports observed session-limit, throttling, quota, capacity, timeout, and
  availability failures; it cannot query an upstream provider's private quota
  dashboard. Response headers and structured router events provide per-request
  correlation without logging prompts or credentials.
