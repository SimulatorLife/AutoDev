# Prompt ownership

The canonical AutoDev Console/configuration target is [`docs/autodev-console-target-state.md`](autodev-console-target-state.md).

## AutoDev-owned prompts

AutoDev's generic prompt/command catalog under `.rulesync/commands/*.md` is the canonical tracked source for AutoDev-owned prompts. Provider-specific prompt files and OpenLIT Prompt views are projections/read models, not independent editable sources.

The future **Prompts** console surface may browse, edit, preview, diff, and link usage/evaluation history, but a mutation of an AutoDev-owned prompt must update the canonical RuleSync source through the typed Control API and then validate/regenerate the relevant projections.

## Repository-owned prompts

AutoDev has one prompt-agnostic execution path: `.github/workflows/run-prompt.yml`. It accepts a target repository and reads one Markdown prompt from either:

- `prompt_repository: SimulatorLife/AutoDev`: the AutoDev-owned generic catalog under `.rulesync/commands/*.md`.
- `prompt_repository: <target repository>`: that repository's domain-specific `.agents/prompts/*.md` catalog.

Target repositories own their domain context. For example, RacingGame may keep gameplay/UI/browser prompts that do not belong in AutoDev's generic catalog. Those repository-owned prompts are not silently copied into AutoDev or OpenLIT as a second source of truth; the console may surface them as repository-owned/read-only context unless that repository itself adopts RuleSync as its canonical source.

Prompt paths are restricted to the supported catalog prefixes; arbitrary file reads are rejected. The runner validates that the selected prompt exists and is non-empty before creating a target PR.

## Ownership rule

> **One editable owner per prompt.** AutoDev-owned prompts live in RuleSync; target-specific prompts live with the target repository. Generated provider files and observability/read-model records are never authoritative.
