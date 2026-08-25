# Prompt ownership

AutoDev has one prompt-agnostic execution path: `.github/workflows/run-prompt.yml`.
It accepts a target repository and reads one Markdown prompt from either:

- `prompt_repository: SimulatorLife/AutoDev`: the repository-agnostic catalog under
  `.agents/prompts/*.md` in AutoDev.
- `prompt_repository: <target repository>`: the selected repository's
  `.agents/prompts/*.md` directory.

Target repositories own their domain context. For example, GMLoop keeps its
GameMaker/tooling prompts and RacingGame keeps its gameplay/UI/browser prompts.
AutoDev must not embed those assumptions in a generic prompt or create a
workflow file for each prompt.

Prompt paths are restricted to `.agents/prompts/*.md`; arbitrary file reads are
rejected. The runner validates that the selected prompt exists and is non-empty
before creating a target PR.
