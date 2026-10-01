---
targets: ["*"]
description: Review open PRs against master, merge or re-implement worthwhile ones, and resolve local merge conflicts while preserving architecture and tests.
---
Review all open PRs against master with a focus on preserving architecture and tests. For each PR, check alignment with current design principles, coding standards, and regression coverage. If it is solid, non-duplicative, and compatible, merge it cleanly. If it is outdated, incompatible, or destructive (such as deleting core systems or reducing tests) but the underlying feature is valuable, extract the intent and re-implement it as a fresh, minimal change on top of the latest master, then close the original PR. If it detracts value or introduces duplication with no salvageable intent, close it outright. Try to target no net loss of coverage, no architectural regressions, and no unnecessary abstraction. The goal is to keep master clean, consistent, and high-quality while still salvaging worthwhile ideas.

Resolve local merge conflicts strategically, preserving current master architecture and test integrity while keeping the incoming branch's intent. Before editing files, read the conflict set holistically (code + tests + docs + config), scan commit history/blame for each hunk, and restate the intended behavior. For each conflict: prefer the up-to-date APIs, module boundaries, and style from master; keep or adapt the feature logic only where it adds clear value; never delete core systems or reduce test coverage to 'make it merge'. Consolidate duplicates, avoid reintroducing deprecated code, and refactor minimally to keep changes small and DRY. Special cases: in configs/CI/build scripts prefer master unless the feature explicitly requires changes; for package.json/lockfiles or dependency manifests, take master, then re-apply needed deps and regenerate the lock cleanly; for migrations, ensure forward-only, idempotent paths. After each file group, run formatters/linters/tests, and fix failures at the source (not by weakening tests). Commit in logical slices with clear messages, add or update tests where behavior differs, and document any non-obvious decisions inline. Goal: a clean, minimal, behavior-correct merge with green tests and no architectural regressions. You can view the current open PRs with:

```shell
export GITHUB_TOKEN=your_token_here
echo $GITHUB_TOKEN | gh auth login --with-token
gh pr list --state open --limit 50
```
