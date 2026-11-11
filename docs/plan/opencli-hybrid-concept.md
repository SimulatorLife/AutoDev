# OpenCLI Hybrid Agent Harness — Design Plan

## Problem

Using a browser-backed chat model through OpenCLI as an agent's model provider is slow: every reasoning/tool-selection turn incurs browser and model latency. The goal is to **retain OpenCLI for high-quality reasoning** while avoiding remote round trips for routine work.

## Proposed Architecture

```text
User / Agent Harness
        |
Local orchestrator ── skill + memory retrieval
        |
        +── DIRECT: deterministic tools/macros (no model)
        +── LOCAL: small model maps bounded steps to tool calls
        +── PLAN / ESCALATE: OpenCLI → powerful chat model
        |
Tool execution → validation → compact observations → shared state
```

## Responsibilities

- **OpenCLI-backed smart model:** Plan goals, decide high-level steps, resolve ambiguity, and handle unexpected failures. Return *structured plans*, not individual shell commands or free-form internal thoughts.
- **Local executor:** Carry out several approved steps before returning results. Prefer deterministic mappings (`inspect_workspace` → `pwd`, file listing) over model inference; use a small function-calling model only when interpretation is necessary.
- **Tool routing:** Classify into `DIRECT`, `LOCAL`, `PLAN`, or `ESCALATE` with confidence thresholds. A compact local classifier may suffice; three separate LLMs are not required.
- **Skill selection:** Index skill metadata and retrieve relevant skills when the task changes, not on every tool call.
- **Memory:** Use local keyword/vector retrieval for project facts, task state, and prior observations. Cache active context and inject only relevant snippets into remote prompts.

## Example Flow

1. **Smart model (OpenCLI):** "Inspect the repository, identify its build system, run appropriate tests, and report failures." Sends a structured plan with allowed actions and escalation conditions.
2. **Local executor:** Runs `pwd`, identifies files, selects approved test commands, and captures concise outputs—without a browser call for each step.
3. **Smart model (OpenCLI):** Receives a compact result summary only if review or replanning is needed.

## Optimization Priorities

1. **Reduce remote calls:** Batch routine steps into locally executable plans; escalate only for ambiguity, unexpected results, or material decisions.
2. **Reduce bridge overhead:** Reuse the browser session, avoid repeated setup, and overlap independent local work with remote responses where possible.
3. **Reduce prompt overhead:** Cache schemas/skills/memory; send concise state deltas and tool summaries rather than full logs.
4. **Reduce local latency:** Keep the small model loaded, use structured outputs, and replace frequently repeated model decisions with deterministic code.
5. **Preserve safety and correctness:** Enforce tool allowlists, permissions, timeouts, sandboxing, output validation, and explicit replan conditions. Do not let a local model silently expand privileges or scope.

## Implementation Plan

1. **Baseline:** Measure per-call browser/model latency, tool latency, token/context size, and failure rates.
2. **MVP:** Implement structured OpenCLI planning, deterministic local macros, shared state, and escalation.
3. **Retrieval:** Add skill indexing and memory retrieval with cache invalidation.
4. **Local model:** Test a compact function-calling model (e.g., FunctionGemma) only where macros cannot cover decisions; compare against deterministic routing.
5. **Evaluate:** Replay representative tasks, measuring total completion time, browser-call count, successful completion, incorrect tool calls, and recovery rate.

## Success Criterion

**Primary metric:** end-to-end task completion time at equal task quality and safety—not raw local-model speed. The largest expected gain comes from replacing many browser-backed micro-turns with a few planning/review calls plus local execution.