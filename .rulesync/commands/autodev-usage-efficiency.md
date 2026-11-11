---
targets: ["*"]
description: Evaluate AutoDev and recent sessions to improve usage/token/model efficiency.
---

Evaluate recent AutoDev sessions, code, and metrics; how/where were agents/model-usage inefficient? How/where/why did they use too much "usage", too many tokens, overly-verbose/unnecessary/duplicate/repeated context/prompts/steering?

Goal is to cut down extraneous token usage as much / wherever possible *and* improve results.

Report savings at the end.

Test, validate, lock in the fixes/improvements with unit tests to prevent regressions.