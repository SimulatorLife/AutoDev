---
targets: ["*"]
description: Identify code that reimplements behavior already provided by a shared helper or platform API and refactor it to use that helper.
---
Identify code that reimplements behaviour already provided by a shared helper or
well-supported platform API (serialization, cloning, range checks, deep merges,
randomization, etc.). Refactor the chosen spot to use the established helper or a
modern built-in, removing the bespoke implementation while preserving behaviour
and performance expectations. Adjust imports/exports as needed, add concise tests
if the helper path is under-covered, and explain the before/after in the commit
message so the rationale is obvious.
