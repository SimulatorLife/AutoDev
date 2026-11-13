---
targets: ["*"]
description: Upgrade all dependencies in this project to their latest available versions.
---

Upgrade all dependencies in this project (including devDependencies and lockfiles) to their latest available versions.

After upgrading:
1. Run the build, typechecker, linter, and test suite to identify any breaking changes or deprecations.
2. Fix all resulting issues properly at the source by migrating to the updated APIs—do not suppress errors, lower test/lint thresholds, or add compatibility shims.
3. Update any affected tests or documentation to reflect the new versions.
4. Provide a brief summary of the major version bumps and key code changes made.