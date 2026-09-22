# Prompt ownership

AutoDev has one prompt-agnostic execution path: `.github/workflows/run-prompt.yml`.
It accepts a target repository and reads one Markdown prompt from either:

- `prompt_repository: SimulatorLife/AutoDev`: the AutoDev-owned generic
  catalog under `.rulesync/commands/*.md` in AutoDev.
- `prompt_repository: <target repository>`: the selected repository's
  `.agents/prompts/*.md` directory.

Target repositories own their domain context. For example, GMLoop keeps its
GameMaker/tooling prompts and RacingGame keeps its gameplay/UI/browser prompts.
AutoDev must not embed those assumptions in a generic prompt or create a
workflow file for each prompt.

Prompt paths are restricted to `.rulesync/commands/*.md` (AutoDev-owned) and
`.agents/prompts/*.md` (target repository); arbitrary file reads are
rejected. `run-prompt.yml` accepts either prefix and `_agent-open-pr-and-ping.yml`
routes by `prompt_repository`: `SimulatorLife/AutoDev` resolves to the
AutoDev-owned catalog, the target repository resolves to a path under that
repository, and any other repository is fetched as an external prompt. The
runner validates that the selected prompt exists and is non-empty before
creating a target PR.
