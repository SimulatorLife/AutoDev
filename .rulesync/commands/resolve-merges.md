---
targets: ["*"]
description: Resolve all local merge conflicts safely while preserving repository conventions and maintaining a clean commit history.
---
Resolve all local merge merge conflicts in the codebase safely while preserving repository conventions, minimizing accidental churn, and maintaining a clean commit history.

## Core Principles

1. Never blindly accept "ours" or "theirs" for large conflicts.
2. Avoid introducing unrelated formatting or refactors during conflict resolution.
3. Resolve semantic conflicts first, formatting second.
4. Generated files should usually be regenerated, not hand-edited.
5. Keep merge commits mechanically clean and easy to review.
6. Minimize touched lines outside true conflict regions.
7. Preserve repository conventions, tooling versions.
8. Never manually edit lockfiles unless absolutely necessary.

## Understand:

* Why the conflict happened
* Which side contains newer architectural intent
* Whether tooling drift is involved
* Whether generated artifacts are stale

## For each file:

1. Understand BOTH sides
2. Preserve *intended*, target-state behavior
3. Avoid accidental deletions
4. Avoid whitespace churn
5. Keep surrounding code untouched
