# Remove one obsolete compatibility shim

Locate exactly one instance of legacy-support code and remove it with a forward-looking fix. Eligible targets include: backwards-compatibility wrappers, deprecated compatibility branches, pass-through re-export shims, transitional alias APIs, or adapter layers that only preserve old behavior.
Requirements: - Pick one concrete instance and complete the full migration in the same PR. - Replace compatibility paths with the canonical long-term implementation; do not add new shims. - If the target is a re-export shim, remove the shim and update callers to import from the true owner directly. - Keep the change architecture-aligned with AGENTS.md workspace boundaries and target-state direction. - Update/add tests to protect the forward path and verify behavior remains correct. - Keep scope tight and avoid unrelated cleanup.
In the PR/commit message, identify the removed legacy pattern, explain why it was backwards-compatibility debt, and show validation results (tests/lint/typecheck).

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
