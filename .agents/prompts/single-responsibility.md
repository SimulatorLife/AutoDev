# Improve one single-responsibility boundary

Run a repository-wide guardrail pass to enforce the single-responsibility principle. Identify one function whose body is extremely long (not including comments and blank lines) and whose name clearly strings  together multiple verb stems. Explain why the current implementation violates SRP, then propose and implement/reuse helper extraction(s) so that each resulting function owns a single change-triggering responsibility. Keep public APIs stable, preserve tests, and update documentation if behaviour shifts. If no candidate qualifies, document the audit findings and outline a follow-up plan instead of forcing changes.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
