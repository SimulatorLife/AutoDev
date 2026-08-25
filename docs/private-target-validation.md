# Private target validation

Private SimulatorLife repositories must not rely on their own GitHub Actions
billing quota for AutoDev-managed validation. AutoDev's
`target-validation.yml` runs on the public AutoDev runner and checks out the
exact target commit with the `GH_USER_TOKEN` secret.

The current RacingGame profile runs:

1. dependency installation from the target lockfile;
2. lint and dead-code/dependency checks;
3. production build;
4. unit tests; and
5. optional browser validation (`run_browser: true`).

The workflow publishes `autodev/racinggame-validate` back to the target commit
and updates the target PR with the AutoDev run URL. A failed baseline check is
reported as failure rather than hidden; focused PR validation can still be
performed separately when unrelated repository failures are present.

The target checkout never writes credentials into the target repository. The
PAT is supplied only to checkout and GitHub API steps and is masked by GitHub
Actions.

For private RacingGame, the repository-local validation workflows are no longer
used as the merge gate. The AutoDev target-auto-merge workflow trusts only the
`autodev/racinggame-validate` status for RacingGame, so a historical or
billing-blocked local Actions check cannot override the centralized result.
