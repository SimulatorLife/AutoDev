---
name: resolve-merge-conflicts
description: Resolve in-progress Git merge, rebase, cherry-pick, or stash conflicts by reconstructing both sides' intent, preserving the intended target behavior, minimizing unrelated churn, and validating the completed integration
---

# Resolve Merge Conflicts

Resolve conflicts as an integration problem, not a text-selection problem. Understand why both changes exist, determine the intended combined behavior, then produce the smallest correct resolution

## Core Principles

1. Understand both sides before editing
2. Resolve intent and behavior first, syntax and formatting second
3. Preserve both changes when they are compatible
4. Never blindly choose `ours` or `theirs` for a semantic conflict
5. Do not invent new behavior merely to make two changes coexist
6. Minimize edits outside the actual integration required by the conflict
7. Preserve repository conventions, invariants, APIs, and pinned tooling unless the intended change explicitly supersedes them
8. Resolve source-of-truth files first and regenerate generated artifacts
9. Do not mix unrelated refactors, cleanup, or formatting into the resolution
10. Finish and validate the entire Git operation, not just the first conflicted hunk

## Understand the Conflict

Before resolving, determine:

* What Git operation is in progress: merge, rebase, cherry-pick, or stash application
* Which files and index entries are unresolved
* What the common/base version contained
* What each side changed and why
* Whether either change supersedes, relocates, or depends on the other
* What the intended target-state behavior should be
* Whether the conflict involves generated output, tooling drift, dependency changes, renames, or deletions

Use repository evidence rather than guessing from the conflict markers alone. Inspect relevant commit messages, history, PR or issue context, documentation, tests, and nearby code when available

For difficult conflicts, compare Git's three versions directly:

```bash
git show :1:path/to/file  # base
git show :2:path/to/file  # ours
git show :3:path/to/file  # theirs
```

Remember that `ours` and `theirs` depend on the Git operation and can be especially unintuitive during a rebase. Reason from the underlying commits and intent, not the labels alone.

## Resolve Each Conflict

For each conflicted file:

1. Identify what each side was trying to accomplish
2. Determine the intended final behavior before writing the resolution
3. Preserve both changes when they are independent or complementary
4. If one change supersedes the other, preserve the superseding behavior without retaining obsolete implementation
5. If structural changes moved or renamed code, apply the other side's behavioral change to the new structure rather than restoring the old structure
6. Keep distinct tests from both sides when they represent distinct required behavior
7. Avoid unrelated formatting, cleanup, renaming, or refactoring
8. Inspect related definitions or callers when the conflicted hunk alone is insufficient to determine correctness
9. Stage the file only after its resolution is complete

Do not assume that the correct resolution must resemble either original side. The correct result may combine both intents while matching neither textually

If the required behavior is genuinely ambiguous after examining available repository evidence, do not guess. Leave that decision unresolved and clearly identify the conflicting intents and the specific decision required

## Conflict Types

For imports and declarations, preserve required additions from both sides, deduplicate them, then let the repository's formatter, compiler, or linter determine what is unnecessary

For tests, preserve distinct coverage from both sides. Consolidate only genuinely duplicate tests and update fixtures or setup as needed for the integrated behavior

For configuration, preserve independent keys from both sides. Resolve conflicting values from repository requirements and intended behavior rather than simply choosing the newer value

For rename or modify/delete conflicts, determine whether the deletion represents intentional removal, relocation, or replacement. Apply still-valid changes to the surviving target instead of resurrecting obsolete files

For add/add conflicts, determine whether both files implement the same responsibility. Integrate them when appropriate or keep both under distinct names when they serve distinct purposes

For binaries, submodules, or other non-textual conflicts, determine the intended artifact or referenced revision from repository context rather than attempting a textual merge

## Generated Files and Lockfiles

Do not manually reconcile generated output when it can be reproduced reliably

Resolve the source-of-truth inputs first, then regenerate the artifact using the repository's documented and pinned tooling

This includes:

* Dependency lockfiles
* Generated source code
* Schemas
* Build artifacts
* Generated documentation
* Generated snapshots or metadata

For lockfiles, reconcile the dependency manifests first and regenerate the lockfile with the repository's expected package-manager version and command

Hand-edit generated files only when regeneration is genuinely unavailable and repository guidance requires it

## Validate

After resolving the conflicts:

1. Confirm Git reports no unresolved paths
2. Confirm no conflict markers remain in resolved files
3. Review the final diff for accidental deletions, duplicated logic, stale code, and unrelated churn
4. Run the repository's relevant formatter, typecheck, build, lint, and tests according to repository guidance
5. Prefer targeted validation first, then broader validation when warranted by the scope
6. Fix integration failures caused by the resolution without expanding into unrelated work
7. Re-check the final staged diff after automated tools modify files

A syntactically resolved conflict is not necessarily a semantically correct integration

## Finish the Operation

Complete the Git operation that was already in progress

For a merge, stage the resolved files and complete the merge

For a rebase, continue until every remaining commit has been successfully rebased, resolving subsequent conflicts with the same process

For a cherry-pick, continue the cherry-pick after validation

Do not abort, reset, force-push, rewrite unrelated history, or discard work merely to escape a difficult conflict unless the user explicitly requests it or repository guidance requires it

Finish with a clean, reviewable working state and summarize any non-obvious resolution decisions or remaining validation limitations