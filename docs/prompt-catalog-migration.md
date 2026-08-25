# Generic prompt catalog migration

AutoDev is the organization-wide prompt control plane. The former GMLoop
workflow catalog was audited from the historical parent of commit
`1aa70503a` (the commit that moved automation ownership to AutoDev). The
current GMLoop checkout intentionally has no `.github` control-plane tree.

## Result

- `weights.json` now registers **51** AutoDev-owned generic prompts.
- Four existing prompts were retained and recorded with their former workflow
  provenance: DRY, KISS, organization, and bug fixing.
- **47** additional generic prompts were converted from numbered GMLoop
  workflows into `.agents/prompts/*.md`.
- Each registered prompt has a `sourceWorkflow` field so the migration remains
  auditable without restoring one workflow file per prompt.
- The scheduler still has one prompt-agnostic entry point: `run-prompt.yml`.

The migrated prompts describe bounded engineering work without assuming a
language, framework, package manager, repository layout, or fixture format.
Prompts that originally contained tool-specific instructions were rewritten to
use the target repository's documented commands and ownership boundaries.

## Migrated generic workflow families

The following historical workflows are represented as prompts in AutoDev:

- `agent-03-dry` (normalized into `dry.md`)
- `agent-04-style`, `agent-05-consolidate-files`, `agent-06-decouple`
- `agent-09-dependencies`, `agent-10-documentation`, `agent-15-parameters`
- `agent-16-dead-code`, `agent-17-error-handling`, `agent-18-clarity`
- `agent-20-micro-optimization`, `agent-21-extensibility`, `agent-22-bugfix`
- `agent-23-lint`, `agent-25-duplicates`, `agent-30-organization`
- `agent-36-docstrings`, `agent-37-helper-substitution`,
  `agent-38-logic-deduplicate`
- `agent-40-memory-footprint`, `agent-41-test-failure`,
  `agent-42-todo-implementation`
- `agent-70-null-undefined-guardrails` through `agent-82-demeter`
- `agent-84-document-intent`, `agent-85-isp`, `agent-86-kiss-sweeper`,
  `agent-87-coupling`, `agent-88-lsp`, `agent-89-pola`
- `agent-90-policy-mechanism`, `agent-91-sla`, `agent-92-srp`
- `agent-99-test-duration` through `agent-104-test-deduplication`, plus
  `agent-106-bad-test-remediation`

## Intentionally not migrated

- Runner, scheduler, provider, validation, auto-merge, janitor, and setup
  workflows are control-plane mechanisms, not prompt catalog entries. They
  remain centralized in AutoDev's generic workflows.
- `agent-01-custom-prompt` is already represented by the generic custom-prompt
  runner, and `agent-02-resolve-merge-conflicts` is a merge workflow rather
  than a scheduled engineering prompt.
- GMLoop-specific workflows are not copied into AutoDev. This includes the
  target-state/formatter contract, refactor performance, hot-reload, semantic
  graph, UI workspace, autonomous GameMaker creation, and semantic/LSP/graph
  workflows (`agent-19`, `agent-24`, `agent-39`, `agent-93`–`agent-98`,
  `agent-105`, `agent-107`, `agent-108`, and `agent-109`).
- Repository-specific prompts remain in the target repository's
  `.agents/prompts/` directory and are selected through the same generic
  runner using that repository as `prompt_repository`.

This keeps AutoDev's catalog generic while retaining the full set of useful
organization-wide engineering workflows that used to be hidden inside the
GMLoop repository.
