# Organization routing

## `weights.json`

The policy file has four routing concerns:

- `agents`: scheduled agent eligibility, cadence, and weight.
- `agentPools.followUps`: weighted fallback routing for PR follow-up work.
- `workflows`: scheduled workflow weights and task metadata.
- `repositories`: target repositories in `owner/name` form and their scheduled-PR weights.

Repository names must be unique and must not contain whitespace. Repository weights, like workflow and agent weights, are finite numbers; values less than or equal to zero disable selection. The scheduler rejects malformed names, duplicate records, invalid categories, invalid complexity, and non-finite weights before dispatching anything.

A scheduled candidate has effective weight:

```text
repository.weight × workflow.weight × agent.weight
```

Agent cadence and category/complexity eligibility are applied before the weighted cycle is built. Selection is deterministic for a given scheduler run number, which makes routing auditable and testable.

## PAT boundary

The workflow repository is the policy/control plane, not the code being changed. Every target-aware workflow receives `target_repository`, validates that the PAT can push there, and checks out that repository with the PAT. The scheduler itself dispatches workflow runs in AutoDev and passes the selected target explicitly.

The provider workflows are also dispatchable from AutoDev. A new PR's provider request includes the target repository and PR number, so the agent invocation does not depend on workflows being installed in the target repository.

## Adding a repository

1. Add `{ "name": "SimulatorLife/Example", "weight": 1 }` to `repositories`.
2. Grant the AutoDev `GH_USER_TOKEN` write access to that repository.
3. Confirm the target's default branch and set a workflow's `base_branch` only when it is not `main`.
4. Run `npm test` and manually dispatch one small workflow with the target repository before enabling a larger weight.
