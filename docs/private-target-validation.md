# Private target validation

Private SimulatorLife repositories must not rely on their own GitHub Actions
billing quota for AutoDev-managed validation. AutoDev's
`target-validation.yml` runs on public AutoDev runners and checks out the exact
target commit with the `GH_USER_TOKEN` secret.

Validation behavior is defined in the centrally owned
`.github/ci/validation-profiles.json` file. Profiles select the target's
package manager, dependency installation command, required validation commands,
and optional slower commands such as browser suites. The workflow itself is
repository-agnostic and supports every repository in `weights.json`; a target
without a required validation profile fails safely instead of being merged.

The workflow publishes the single authoritative `autodev/validation` status
back to the target commit and updates the target PR with the AutoDev run URL.
The target auto-merge workflow trusts that status for every configured private
repository and does not use historical local Actions checks as a substitute.

The target checkout never writes credentials into the target repository. The
PAT is supplied only to checkout and GitHub API steps and is masked by GitHub
Actions.
