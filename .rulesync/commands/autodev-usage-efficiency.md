---
targets: ["*"]
description: Evaluate AutoDev and recent sessions to improve usage/token/model efficiency.
---

# AutoDev Efficiency Audit & Optimization

**Goal:** Analyze recent AutoDev sessions, code, and metrics to minimize token usage, context overhead, latency, and unnecessary work while maintaining or improving results.

## 1. Audit Areas

1. **Token and prompt overhead:** Excessive model usage, verbose or duplicated prompts, instructions, steering, and injected context.
2. **Session and context management:** Long-running sessions, excessive context growth, missed compaction opportunities, and failure to start fresh sessions for new tasks.
3. **Context and memory reuse:** Repeated discovery, investigation, file reads, or failure to reuse existing context, memory, caches, and prior results.
4. **Tools:** Unnecessary or repeated calls, excessive discovery, inefficient sequencing, oversized inputs/outputs, and missing output bounds.
5. **Loops and retries:** Repeated reasoning, failed attempts, excessive polling, ineffective retries, and unproductive steps.
6. **Hooks and automation:** Unnecessary triggers, excessive execution frequency, and redundant context injections.
7. **Skills:** Oversized or verbose skills, unnecessary always-loaded content, redundant skills, and opportunities to split reference files or consolidate skills.
8. **Agent orchestration:** Unnecessary delegation, duplicated agent work, excessive context transfers, and inefficient coordination.
9. **Model routing:** Inefficient model selection, unnecessary escalation/fallback, and avoidable usage or latency.
10. **Workflow and code inefficiencies:** Redundant steps, repeated cross-session patterns, unnecessary custom logic, and underused existing tooling.
11. **Model switching:** Unnecessary model switching, which causes the agent to re-read the whole session on the next message, which uses more usage and invalidates the context cache.

## 2. Procedure

1. **Inspect:** Analyze representative recent sessions, traces, metrics, code, and configurations.
2. **Diagnose:** Identify inefficiencies, root causes, recurring patterns, and measurable overhead.
3. **Prioritize:** Rank opportunities by expected savings, frequency, effort, and risk.
4. **Fix:** Implement simple, maintainable, systemic improvements using existing tooling where practical.
5. **Test:** Add regression tests and validate correctness, reliability, and task quality.
6. **Measure:** Compare before/after token usage, context size, tool calls, retries, latency, and costs.
7. **Report:** Summarize findings, fixes, verified savings, test results, and remaining opportunities.

## Requirements

- Optimize **total end-to-end efficiency**, not individual metrics at the expense of results
- Eliminate unnecessary work rather than simply shortening its output
- Preserve functionality and avoid adding unjustified complexity
- Base findings and savings on evidence; distinguish measurements from estimates
- **Implement, test, and validate fixes**, not just recommend them