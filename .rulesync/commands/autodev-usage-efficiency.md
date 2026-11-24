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
8. **Under-delegation:** Missed opportunities to delegate focused tasks to subagents with isolated contexts, enabling parallel execution, reduced context pollution, lower token usage, and more efficient orchestration.
9. **Over-delegation and coordination overhead:** Unnecessary delegation, excessive subagent spawning, duplicated work, oversized context transfers, redundant coordination, lost subagent results, and delegation costs exceeding their benefits.
10. **Model routing:** Inefficient model selection, unnecessary escalation/fallback, and avoidable usage or latency.
11. **Workflow and code inefficiencies:** Redundant steps, repeated cross-session patterns, unnecessary custom logic, and underused existing tooling.
12. **Model switching:** Unnecessary model switching, which causes the agent to re-read the whole session on the next message, which uses more usage and invalidates the context cache.
13. **Multiple system prompts:** Since AutoDev supports dynamic routing and multiple model providers/CLIs, multiple system prompts could end up being injected into a session, which is unnecessary, confusing, wasteful, and can cause the model to behave inconsistently.

## 2. Evidence & Tooling Workflow

Start every efficiency audit with AutoDev's bundled diagnostics before writing ad-hoc log parsers. Every diagnostics answer comes from **one** engine (`@simulatorlife/autodev-data/diagnostics`), reached through the Control API, the `autodev diagnostics` CLI, or the Console -- never through a second parser.

1. **Single-session efficiency trace:**
   ```bash
   pnpm autodev -- diagnostics <session-or-thread-id> --efficiency --failures
   # or, through the skill's wrapper (identical output):
   node .rulesync/skills/autodev-session-diagnostics/scripts/session-trace.ts <session-or-thread-id> --efficiency --failures
   ```
   - `--efficiency` includes per-thread cumulative token usage (input, cached %, output, reasoning %, peak input, >50% cache drops), compaction count & retained image/payload sizes, initial developer-prompt byte size, loaded skills grouped by source root vs `SKILL.md` reads & `$CODEX_HOME/run/skill-read-telemetry`, router `ROUTER SKIPPED` / `ROUTER RETRIES` events, and categorized `TOOL FAILURES` (capped at 2 samples per category by default; add `--all-failures` for full inputs and every occurrence, `--json` for scripting).
2. **Cross-session sizing & hook friction:**
   ```bash
   pnpm autodev -- diagnostics --scan-recent 15
   pnpm autodev -- diagnostics --hooks --since 7
   ```
   - `--scan-recent [N]` aggregates token usage, cache hit rate, cache drops, compactions, skill counts, tool-failure categories, `PreToolUse` blocks, and router skips across the newest `N` active + archived sessions in one pass.
   - `--hooks [--since DAYS]` summarizes structured `PreToolUse` denials logged in `$CODEX_HOME/hooks/hooks.log`.
3. **Live router status:** `pnpm autodev -- router status` (or `curl -s 127.0.0.1:4100/status | jq`). If `session-trace.ts` prints `router /status unreachable` right after a router restart, retry once after a few seconds.
4. **Console view:** `/usage?range=24H&sessionId=<id>` renders the same diagnostics in the browser (`Overview`, `Threads & Turns`, `Failures & Hooks`, `Router Requests`, `OTel Spans`), with unscoped `Recent sessions` and `Hook denials` tabs for fleet sizing.
5. **Handoff for request-shape reproduction:** Use `autodev-session-diagnostics` for deeper provider/MCP/rule probes, and `autodev-request-capture` when inspecting exact provider wire requests offline.

## 3. Procedure

1. **Inspect:** Run the session and fleet commands above, then inspect targeted rollout/config/runtime files only for gaps not already surfaced.
2. **Diagnose:** Identify inefficiencies, root causes, recurring patterns, and measurable overhead.
3. **Prioritize:** Rank opportunities by expected savings, frequency, effort, and risk.
4. **Fix:** Implement simple, maintainable, systemic improvements using existing tooling where practical.
5. **Test:** Add regression tests and validate correctness, reliability, and task quality.
6. **Measure:** Compare before/after token usage, context size, tool calls, retries, latency, and costs. When live launchd services are not reinstalled/restarted yet, validate deltas by running **offline rollout/log replay** against the updated checkout logic (and clearly label offline replay vs live post-reinstall measurements).
7. **Report:** Summarize findings, fixes, verified savings, test results, and remaining opportunities.

## Requirements

- Optimize **total end-to-end efficiency**, not individual metrics at the expense of results
- Eliminate unnecessary work rather than simply shortening its output
- Preserve functionality and avoid adding unjustified complexity
- Base findings and savings on evidence; distinguish measurements from estimates
- **Implement, test, and validate fixes**, not just recommend them
