# Improve dependency hygiene

Audit the target repository's documented dependency manifests and lockfiles for one safe, evidence-backed hygiene improvement: an unused dependency, redundant entry, deprecated API use, or inconsistent version constraint. Do not assume a language, package manager, or manifest filename. Remove or update only what you can prove is safe, preserve lockfile integrity, and run the repository's documented install/build/test checks. Avoid adding heavy dependencies or unrelated tooling changes.
