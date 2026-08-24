# AutoDev

AutoDev is the SimulatorLife organization control plane for autonomous GitHub development. It owns the reusable GitHub Actions workflows, routing policy, and local AI/provider setup used to open and process focused pull requests in SimulatorLife repositories.

## How it works

1. `.github/workflows/_scheduler.yml` reads `weights.json` on its 15-minute schedule.
2. It selects a workflow, an eligible agent, and a target repository using the configured weights.
3. The selected workflow runs in AutoDev, then `_agent-open-pr-and-ping.yml` checks out the target repository with `GH_USER_TOKEN`, creates a branch and PR, and dispatches the centralized provider workflow when needed.
4. Provider workflows call `agent-invoke.yml`, which continues working against the target repository and pushes through the PAT.

## Required GitHub configuration

Configure these organization/repository secrets and variables on AutoDev:

- `GH_USER_TOKEN`: PAT with write access to every configured target repository and permission to dispatch AutoDev workflows.
- Provider credentials used by the provider workflows (`CLAUDE_CODE_OAUTH_TOKEN`, `GEMINI_API_KEY`, `MINIMAX_API_KEY`, and any provider-specific values you enable).
- `GH_USER_NAME` and `GH_USER_EMAIL` variables for commit identity.

Keep tokens in GitHub Secrets or the local credential store. Never commit them to this repository.

## Configure target repositories

Edit `.github/workflows/weights.json` and add one `repositories` record per target in `owner/name` form. A non-positive weight disables a repository without invalidating the configuration. The scheduler combines repository, workflow, and agent weights, so repository weights directly control the share of scheduled PRs.

The migrated policy keeps the source repository's agent weights unchanged; a zero agent weight is an intentional disable switch. Set a positive weight for at least one configured provider before enabling the scheduler.

Run the focused policy and local setup tests locally with:

```bash
npm test
npm run test:python
```

AutoDev owns the organization workflows and local AI/provider setup. RacingGame intentionally retains only product-specific tooling such as build, performance, CSS-token, and source-boundary scripts; those are not organization automation and are not duplicated here.

See [`docs/organization-routing.md`](docs/organization-routing.md) for the schema and operational details, and [`docs/provider-routing.md`](docs/provider-routing.md) plus [`docs/local-setup.md`](docs/local-setup.md) for the migrated local AI/provider setup.
