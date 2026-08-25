# Improve control-flow clarity

Locate a bite-sized logic path (function, reducer, effect handler, or small module) where the control flow is harder to read than it needs to be, and streamline it without changing behaviour. Favour guard clauses, early returns, or extracted helpers to flatten nesting, eliminate duplicated branches, and make intent immediately obvious. Keep naming/formatting tweaks to the style workflow; here the mission is to untangle logic so future contributors can follow it at a glance. Ship one concrete improvement, keep the diff minimal and well-tested, and note the before/after reasoning in the commit message so reviewers see the clarity win.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
