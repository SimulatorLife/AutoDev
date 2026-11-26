# Prompt ownership

The canonical AutoDev Console/configuration target is [`docs/autodev-console-target-state.md`](autodev-console-target-state.md).

## AutoDev-owned prompts

AutoDev's generic prompt/command catalog under `.rulesync/commands/*.md` is the canonical tracked source for AutoDev-owned prompts. Provider-specific prompt files and OpenLIT Prompt views are projections/read models, not independent editable sources.

The **Prompts** Console resource is read-only: browse, inspect rendered Markdown and actual source/frontmatter, compare committed revisions and link usage/evaluation history. Changes to AutoDev-owned prompts are made in the canonical repository and applied through the existing RuleSync generation/installation workflow. There is no Console editor, unsaved preview or Control API write. See [read-only RuleSync configuration views](autodev-console-target-state.md#read-only-rulesync-configuration-views).

## Repository-owned prompts

AutoDev has one prompt-agnostic execution path: `.github/workflows/run-prompt.yml`. It accepts a target repository and reads one Markdown prompt from either:

- `prompt_repository: SimulatorLife/AutoDev`: the AutoDev-owned generic catalog under `.rulesync/commands/*.md`.
- `prompt_repository: <target repository>`: that repository's domain-specific `.agents/prompts/*.md` catalog.

Target repositories own their domain context. For example, RacingGame may keep gameplay/UI/browser prompts that do not belong in AutoDev's generic catalog. Those repository-owned prompts are not silently copied into AutoDev or OpenLIT as a second source of truth; the console may surface them as repository-owned/read-only context including when that repository adopts RuleSync as its canonical source.

Prompt paths are restricted to the supported catalog prefixes; arbitrary file reads are rejected. The runner validates that the selected prompt exists and is non-empty before creating a target PR.

## Ownership rule

> **One repository-owned source per prompt.** AutoDev-owned prompts live in RuleSync; target-specific prompts live with the target repository. Console views, generated provider files and observability/read-model records are never authoritative.
