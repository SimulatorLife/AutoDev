# AutoDev

AutoDev is the SimulatorLife organization control plane for autonomous GitHub development. It owns the reusable GitHub Actions workflows, routing policy, and local AI/provider setup used to open and process focused pull requests in SimulatorLife repositories.

## How it works

1. `.github/workflows/_scheduler.yml` reads `weights.json` on its 15-minute schedule.
2. It selects a generic prompt, eligible agent, and target repository using the configured weights.
3. `run-prompt.yml` reads either an AutoDev generic prompt or the target repository's `.agents/prompts/*.md`, then `_agent-open-pr-and-ping.yml` creates the target PR with `GH_USER_TOKEN`.
4. Provider workflows call `agent-invoke.yml`, which continues working against the target repository and pushes through the PAT.

## Required GitHub configuration

Configure these organization/repository secrets and variables on AutoDev:

- `GH_USER_TOKEN`: PAT with write access to every configured target repository and permission to dispatch AutoDev workflows.
- Provider credentials used by the provider workflows (`CLAUDE_CODE_OAUTH_TOKEN`, `GEMINI_API_KEY`, `MINIMAX_API_KEY`, and any provider-specific values you enable).
- `GH_USER_NAME` and `GH_USER_EMAIL` variables for commit identity.

Keep tokens in GitHub Secrets or the local credential store. Never commit them to this repository.

## Local validation toolchain

AutoDev itself is managed with pnpm `10.32.1`, declared by `packageManager` in
`package.json` and locked in `pnpm-lock.yaml`. Use `pnpm install --frozen-lockfile`
before running the checks. The target-aware runner intentionally retains an npm
compatibility branch for organization repositories that have not migrated their
own package manager; that branch is not used to validate AutoDev.

## Configure target repositories

Edit `.github/workflows/weights.json` and add one `repositories` record per target in `owner/name` form. A non-positive weight disables a repository without invalidating the configuration. The scheduler combines repository, generic-prompt, and agent weights, so repository weights directly control the share of scheduled PRs.

The migrated policy keeps the source repository's agent weights unchanged; a zero agent weight is an intentional disable switch. Set a positive weight for at least one configured provider before enabling the scheduler.

Run the focused policy and local setup tests locally with:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run test:python
```

AutoDev owns the organization workflows and local AI/provider setup. RacingGame intentionally retains only product-specific tooling such as build, performance, CSS-token, and source-boundary scripts; those are not organization automation and are not duplicated here.

See the [live metrics dashboard](https://github.com/SimulatorLife/AutoDev/issues/2), [`docs/organization-routing.md`](docs/organization-routing.md) for routing, and [`docs/merge-conflict-handling.md`](docs/merge-conflict-handling.md) for conflict recovery, [`docs/private-target-validation.md`](docs/private-target-validation.md) for private-repository validation, and [`docs/provider-routing.md`](docs/provider-routing.md) plus [`docs/local-setup.md`](docs/local-setup.md) for local AI/provider setup.
