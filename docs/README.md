# AutoDev documentation map

AutoDev keeps **one broad target-state authority** and a small set of focused operational/design documents. Do not add another repository-wide migration plan or console/platform target document when the canonical target can be updated instead.

## Canonical target

- [`autodev-console-target-state.md`](autodev-console-target-state.md) — sole authority for the AutoDev Console product model, dark-only UI/design contract, OpenLIT fork boundary, RuleSync configuration ownership, observability/control-plane architecture, resource semantics, and acceptance criteria.

## Focused operational/design docs

- [`autodev-console-migration.md`](autodev-console-migration.md) — current Console/OpenLIT migration state, current gaps, cutover dependencies, and current acceptance evidence. It must not redefine target requirements.
- [`local-setup.md`](local-setup.md) — current installation/materialization/runtime setup plus Console/OpenLIT commands, ports, service credentials, and local operational entry points. It may describe transitional native projections but does not override canonical ownership.
- [`provider-routing.md`](provider-routing.md) — current provider/router execution, retry, fallback, limits, and bridge contract. Current native role projections are transitional where the canonical target moves them to RuleSync.
- [`antigravity-codex-tool-loop.md`](antigravity-codex-tool-loop.md) — focused Antigravity provider/tool-loop design and migration gates; subordinate to the canonical target for configuration ownership.
- [`prompt-ownership.md`](prompt-ownership.md) — editable ownership of AutoDev RuleSync prompts versus target-repository prompts.
- [`organization-routing.md`](organization-routing.md) — GitHub organization scheduler/repository routing. “Organization” here refers to SimulatorLife GitHub automation, not the removed OpenLIT organization concept.
- [`private-target-validation.md`](private-target-validation.md) — centralized validation for private target repositories.
- [`codebase-context-target.md`](codebase-context-target.md) — code-search/context tool responsibilities and target workflow.
- [`memory-target-state.md`](memory-target-state.md) — focused memory architecture: raw experience, episodic/semantic/procedural memory, scoped multi-agent sharing, JIT retrieval/reconstruction, provenance, supersession, promotion, evaluation, and the Memory feature's domain contract. Its operator UI is the unified AutoDev Console, using adapted OpenLIT components rather than a second application.
- [`memory-injection-outcome-evaluation.md`](memory-injection-outcome-evaluation.md) — append-only request-level packet exposure and operator-reported outcome correlation, including scope and attribution limits.
- [`../config/memory/README.md`](../config/memory/README.md) — local PostgreSQL/pgvector startup and migration command for the memory foundation.

## Documentation rules

1. Update `autodev-console-target-state.md` in place when shared product/ownership/UI architecture changes.
2. Update `autodev-console-migration.md` for current migration state/evidence; do not accumulate patch-by-patch history in the target spec.
3. Keep operational commands/secrets/ports in `local-setup.md` and focused subsystem details in their owning docs.
4. Keep focused docs explicitly subordinate to the canonical target when scopes overlap.
5. Delete completed ledgers and superseded target-state docs instead of retaining contradictory historical instructions in the active docs tree.
6. Use repo-relative paths and avoid machine-specific absolute paths in normative documentation.
7. Generated provider configuration, OpenLIT read models, and telemetry records are never competing configuration sources of truth.

Removed/superseded documents must not be recreated as active guidance: the old platform-migration ledger, TypeScript migration target, UI control-plane target, observability target/runbook, metrics-dashboard runbook, and prompt-catalog migration ledger have all been folded into current authorities or completed.
