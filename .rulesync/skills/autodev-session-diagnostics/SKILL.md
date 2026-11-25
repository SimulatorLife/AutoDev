---
name: autodev-session-diagnostics
description: AutoDev-only. Diagnose session, delegation, routing, tool exposure, permission, telemetry, and runtime failures from authoritative live or recorded evidence. Use when an AutoDev session or subagent stalls, misbehaves, or has missing or inconsistent capabilities.
---

# AutoDev session diagnostics (AutoDev development only)

Diagnose what the system actually recorded, not what code or documentation says should happen. Establish the relevant execution architecture, trace the defect to its owner, fix it there, and prove the correction.

Use `autodev-request-capture` for offline wire-request reproduction. For current architecture, consult `docs/autodev-console-target-state.md` and `docs/xacpx-subagent-delegation.md`. For Codex-specific probes and historical rollout/bridge evidence, consult [references/codex-and-legacy-diagnostics.md](references/codex-and-legacy-diagnostics.md) only when applicable.

## 1. Obtain authoritative evidence

Prefer the configured diagnostics surfaces: the read-only Control API, Runtime diagnostics CLI, or Console session-scoped diagnostics. These should use the single diagnostics engine, not independent ad hoc parsers. Check the deployed version and actual coverage; distinguish historical Codex records from current pinned ACP sessions and xacpx task lifecycle. Do not assume every provider produces the same records.

Where authorized and available, start with the summary rather than a raw event dump:

```bash
pnpm autodev -- diagnostics <id> --efficiency --failures
pnpm autodev -- diagnostics --recent 10
```

The bundled `scripts/session-trace.ts` wrapper uses the same diagnostics engine; see the historical reference for its supported arguments and existing report fields. If the available engine does not cover the active execution path, name the gap and obtain evidence from the owning runtime or authorized telemetry surface instead of inventing a result.

## 2. Evidence map

| Question | Authoritative evidence to seek |
| --- | --- |
| What happened, and when? | Session and turn lifecycle records; stable session/task identity |
| Which provider/model served the work? | Pinned session allocation and recorded provider attribution |
| Was delegation admitted and completed? | Coordinator-owned xacpx task lifecycle, admission, progress, and terminal result |
| Were expected tools, skills, prompts, and permissions exposed? | Actual role-scoped inventory, execution contract, permission decisions, and observed calls |
| Why did a tool or action fail? | Owning tool/server error, policy decision, and transport diagnostics |
| Was telemetry emitted, captured, and attributed? | Producer events, traces, logs, metrics, and documented correlation |
| Is the running system healthy and current? | Runtime health, service/process identity, deployed version, and drift |
| Is the issue isolated or systemic? | Comparable session/fleet evidence with coverage and missingness |

Discover available evidence through the active authorized interface. A root tool inventory does not prove a child's exposure; an installed MCP binary does not prove authorization or successful invocation through the actual role and gateway. Never use global inventory as child-ownership proof.

## 3. Investigate proportionately

- Pin the session, workspace, role, provider/model, deployment version, and relevant time range.
- Compare actual behavior with the canonical execution and permission contract. Verify both expected access and prohibited access, including provider parity.
- Trace failures across the owning boundaries: allocation, session lifecycle, delegation, tool discovery, permissions, execution, telemetry, and presentation.
- Check deployment drift before attributing behavior to checkout changes; prefer focused, bounded evidence and avoid repeated reads.
- Compare investigation costs by information capability (semantic discovery, structural analysis, language-aware analysis, source inspection) when observed. Retain originating tool identity. Existing diagnostic fields are implementation-specific; do not invent generic fields or claim unobserved counts. Missing observations are not zero.
- A timeout, absent telemetry, or empty transcript is not proof that a task failed or did not execute.

## 4. Reproduce, fix, verify

Use hermetic reproductions first; isolate provider/session/workspace state and fake external services where feasible. Use an authorized live probe only when necessary, without interrupting unrelated work. Verify the regression test fails before the fix and passes afterward; run proportionate validation against an identified repository state.

Record observed evidence, owning cause, change, validation, deployment requirements, and unresolved gaps. Never print credentials or raw prompts, restart shared services without authorization, bypass permissions, or claim successful provider parity based only on configuration.
