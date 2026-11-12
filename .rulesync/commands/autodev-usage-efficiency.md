---
targets: ["*"]
description: Evaluate AutoDev and recent sessions to improve usage/token/model efficiency.
---

Evaluate recent AutoDev sessions, code, and metrics; how/where were agents/model-usage inefficient? How/where/why did they use too much "usage", too many tokens, overly-verbose/unnecessary/duplicate/repeated context/prompts/steering?

Where/how did they spend too much time in loops, retries, discovery, tool-discovery, or unnecessary steps? Where/how did they fail to leverage existing context, memory, or tooling? What repeated steps or patterns across different sessions could be optimized, eliminated, or improved?

Goal is to cut down extraneous token/context usage as much / wherever possible *and* improve results.

When do/did sessions run long? Longer sessions are more expensive and less efficient, even with caching. How/when/where could sessions be compacted mid-task so that sessions run less at/over high-context? How/when can new sessions be started when a new task begins, rather than continuing to run a long session with high context?

Report savings/optimizations/efficiencies at the end.

Test, validate, lock in the fixes/improvements with unit tests to prevent regressions.