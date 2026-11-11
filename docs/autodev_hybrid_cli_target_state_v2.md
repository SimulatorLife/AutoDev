# AutoDev — Hybrid CLI Agent Target State (Revised)

*Design proposal based on `SimulatorLife/AutoDev`'s `main` branch, inspected November 10, 2026. This describes a migration target, not completed implementation.*

## Problem

Evolve AutoDev's existing TypeScript control plane into a fast, provider-independent orchestrator that selects roles independently of models/providers; invokes subscription-authenticated coding agents (`codex`, `claude`, `agy`) and model/browser CLIs (`mmx`, `opencli`); respects configured priorities, health, quotas, cooldowns, capacity, sessions, and safe fallback; and manages common skills, MCPs, hooks, agent definitions, and permissions through Rulesync where supported. Reuse maintained dependencies rather than maintaining custom protocol/process infrastructure unnecessarily, without replacing AutoDev's functioning router, memory, observability, security boundaries, or Console.

## Target Architecture

```text
Rulesync + AutoDev canonical config
  ├─ skills / MCP / hooks / agents / portable permissions (where lossless)
  └─ provider-native generated configs + AutoDev execution contract
                         │
Task → AutoDev orchestrator → role / capability requirements
                         │
           Existing RoutingPolicy / Control API
  priorities → eligibility → quota/cooldown → capacity → session affinity
                         │
             Agent/model execution boundary
      ┌──────────────────┴──────────────────┐
      │                                     │
 Existing Responses bridges           Optional ACP client
 Codex model/tool loop                 acpx/runtime → ACP agent
 Claude / agy / MiniMax /              Codex / Claude / agy, etc.
 Copilot / OpenCLI                     (pilot only, parity gated)
      └──────────────────┬──────────────────┘
                         │
          normalized outcome + execution provenance
               ├─ Runtime state / Control API → Console (live control)
               ├─ OTel → OpenLIT OTLP → ClickHouse → Console Usage
               └─ memory/trajectory → PostgreSQL + pgvector
```

**Key separation:** ACP is an **agent-control protocol** (client ↔ self-contained agent), MCP is a **tool protocol** (agent ↔ tools), and OpenAI Responses is AutoDev's existing **model/tool-loop wire interface**. They are complementary, not interchangeable.

## Preserve Existing Investments

| Existing system | Current ownership | Target action |
|---|---|---|
| `runtime/src/router/{routing,proxy,cooldown,concurrency,persistence,subagents}` | Role/tier selection, priority overrides, fallback, provider/model/quota-pool cooldowns, retry safety, session/child tracking, persisted state | **Retain** business logic; do not substitute generic breakers or ACP routing. |
| `runtime/src/providers/*` | Direct CLI/API → Codex Responses adapters, tool translation, capability handling, failure normalization | **Keep** by default; replace an adapter only after measured full parity. |
| `runtime/src/providers/opencli*.ts` | Browser-backed ChatGPT/Gemini, per-site queues, conversation ledger, tool-call parsing | **Optimize in place**, keep serialized browser-site access. |
| `.rulesync/*`, `rulesync.jsonc`, `config/execution-contract.json`, role TOMLs | Shared skill/hook/MCP sources, provider projections, role-scoped capabilities | **Converge** on Rulesync when lossless; retain explicit AutoDev-only policy. |
| `@modelcontextprotocol/sdk`, `runtime/src/mcp/` | MCP servers, role tool filtering, Codex-visible child delegation | **Keep**; ACP does not replace MCP or the spawn shim automatically. |
| `@opentelemetry/*`, `runtime/src/router/telemetry.ts` | Traces/metrics, one logical routed request and separate physical provider attempts | **Keep** instrumentation and correlation; extend to ACP attempts. |
| Patched OpenLIT 2.1.0 + OTLP receiver + ClickHouse | Telemetry ingestion, historical usage/cost/trace queries | **Keep** as sole historical telemetry path; no second Collector/dashboard. |
| `runtime/src/memory/`, `data/src/memory/`, `@letta-ai/trajectory` | Memory retrieval/injection, PostgreSQL/pgvector, native transcript normalization/provenance | **Reuse** for ACP/direct attempts; don't create new memory stores. |
| AutoDev `console/`, Control API, GitHub workflows, Playwright/playtesting | Operator control, convergence, GitHub scheduling, isolated testing | **Preserve** interfaces and operator behaviors. |

## Permissions: Rulesync Owns Policy, Runtime Enforces It

**Correction:** Pi does not need to be AutoDev's permission-policy owner. Pi and acpx have *runtime mechanisms* to ask for/handle permissions, but that is different from defining the canonical rules.

- **Desired authority:** Rulesync owns portable permissions/tool exposure **where it can express them losslessly**; provider-specific overrides and AutoDev-only semantics remain explicit, not duplicated in another framework.
- **Observed current state:** `rulesync.jsonc` currently lists only `skills` and `hooks` as generated features. Canonical Codex approval/sandbox/network settings currently live in `config/config.autodev.toml`; role sandbox settings live in `agents/roles/*.toml`; `config/execution-contract.json` describes role-scoped MCP tools/skills. The repository's target document calls for further RuleSync ownership, with lossless parity as a migration gate.
- **Enforcement:** AutoDev validates role admission, restricts tool lists (`runtime/src/mcp/tool-filter.ts`), maps permissions to each CLI/ACP adapter, and applies actual CLI-native sandbox/approval mechanisms **or OS/container isolation**. Rulesync-generated instructions or prompt text are not a security boundary. The existing read-only prompt injection for some bridges must not be mistaken for strong filesystem isolation.
- **ACP requests:** Map agent permission requests to the **same** AutoDev policy and approval reviewer; fail closed when an adapter cannot express a restriction. Never allow an ACP agent, Pi, or another wrapper to silently widen granted permissions.

## ACP Status and Migration Decision

**Current:** The inspected AutoDev repository does **not** show `acpx`, `@agentclientprotocol/sdk`, or ACP integration. It already runs provider CLIs directly, exposes MCP tools/delegation, and adapts providers to **Codex Responses**. MCP support is not ACP support.

| Direct CLI / existing Responses bridge | ACP via [`acpx/runtime`](https://github.com/openclaw/acpx) |
|---|---|
| Already supports Codex's model/tool loop, native subagent visibility, provider-specific functionality, and established telemetry. | Standardizes launching and communicating with complete ACP agents, structured updates, sessions, cancellation, and permissions. |
| Custom provider parsing/stream handling must be maintained. | Relies on an ACP-capable agent/adapter; adds a process/protocol boundary and version compatibility risk (`acpx` is pre-1.0). |
| Best for **inference providers** (MiniMax, OpenCLI) and bridges dependent on Codex-specific tool semantics. | Best for **independent leaf coding-agent tasks** where a full agent owns its tool loop. |
| Existing Codex sessions and tool-call attribution remain first-class. | May lose Codex-native child/session visibility and provider-specific metadata unless explicitly bridged. |

**Decision: add ACP as an optional *parallel executor*, not a replacement router or universal provider transport.** Start with a bounded read-only leaf (`explorer` / `docs-researcher`) on one ACP-compatible CLI. Keep the existing path available under a flag. Use the official [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) only if an adapter is missing. Do **not** move the root Codex orchestrator to ACP as part of the pilot; that would change the owning tool loop.

**Migrate a direct adapter only if** ACP has demonstrated: role/Rulesync parity, enforced sandbox and MCP scope, comparable startup/turn latency, persistent/resumable sessions, deterministic cancellation, correct native child visibility or explicit replacement semantics, quota/error classification, usage attribution, and safe handling of partial side effects. ACP does **not** provide provider selection, subscription quota discovery, cooldown policy, or guaranteed token accounting.

## Dependency Decisions

| Dependency | Decision | Reason |
|---|---|---|
| [Rulesync](https://github.com/dyoshikawa/rulesync) | **Keep** | Canonical agent-facing configuration when lossless; do not make it a live router. |
| [acpx](https://github.com/openclaw/acpx) (`acpx/runtime`) | **Pilot** | Independently installable TypeScript ACP client/session/process layer; version-pin and verify API stability. |
| [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) | **If needed** | Implement an ACP adapter rather than hand-writing the protocol. |
| [cockatiel](https://github.com/connor4312/cockatiel) | **Optional, localized** | Can replace generic timeout/retry mechanics; **not** AutoDev-specific quota or cooldown policy. |
| `p-queue` | **Defer** | AutoDev already has concurrency and browser/site queues. |
| [Pi](https://github.com/earendil-works/pi) | **Do not adopt as core** | Optional self-contained agent wrapper for a model-only provider; no independent permission authority. |
| [OpenClaw](https://github.com/openclaw/openclaw), OpenCode | **Do not adopt as core** | Duplicate existing routing, agent/runtime, policy, UI, and telemetry infrastructure. |

## Observability and Memory Contract

Keep the established pipeline: **AutoDev/OpenTelemetry producers → OpenLIT's authenticated, loopback OTLP receiver → ClickHouse → AutoDev Console Usage**. Control changes flow **Console → Control API → canonical config/runtime**, never via telemetry. Preserve existing OpenLIT patches, OTel export behavior, and read-model separation.

For each direct or ACP task, correlate `taskId`, role, workspace, route decision, provider/model, attempt, session, and child-agent IDs through safe internal references. Reuse the existing `autodev.routed_request` parent and `gen_ai.client_operation` attempt span design; add ACP session/tool lifecycle events **inside** the appropriate attempt without generating duplicate parent usage or counting parent/child tokens twice. Record unavailable costs/tokens as **unknown**, not zero. Attribute queue, CLI startup, browser wait, model time, tool time, retry/fallback, and completion separately. Continue existing privacy rules (no prompt text, credentials, raw paths, or tool arguments in metric dimensions).

Continue PostgreSQL/pgvector task-scoped memory and `@letta-ai/trajectory` provenance. ACP event streams can supply observations, but must not establish a second memory authority; store only approved metadata/references, subject to existing privacy and retention rules.

## OpenCLI Performance

1. Instrument each phase in the **existing** bridge: queue wait, process/daemon startup, browser submission/polling, generation, tool turns, retries and recovery.
2. Keep its per-site serialization and conversation ledger; avoid ambiguous retransmission after the browser has accepted a prompt.
3. Prefer deterministic, permission-checked local macros and bounded multi-step plans to minimize expensive browser turns; retain Codex's tool execution authority and current skill/memory injection.
4. Test a local function-calling model **only if** it beats deterministic delegation on end-to-end completion time **and** success rate.

## Migration Plan

1. **Characterize current behavior:** Inventory provider bridges and permissions; benchmark direct CLIs versus equivalent ACP sessions; capture existing role/latency/usage/child-state baselines.
2. **Set the policy boundary:** Reconcile Rulesync-supported permissions/agent declarations with Codex/CLI-specific settings, prove lossless generation, and enforce identical restrictions on all transports.
3. **Introduce a narrow `AgentExecutor` port:** Preserve router APIs and attempt/result semantics; add an optional acpx adapter for a single read-only leaf, with version pinning and feature flag.
4. **Instrument the pilot:** Reuse OTel/OpenLIT, Control API, and memory/trajectory; add span and session correlation, unknown-value treatment, and comparison dashboards/queries in existing Usage.
5. **Run parity and fault tests:** Authentication, quotas, cooldown reset, concurrent sessions, session resume, cancellation, MCP tool filtering, child attribution, read-only enforcement, partial writes, and unavailable provider fallback.
6. **Keep or cut over selectively:** Retire a custom CLI adapter only when ACP is materially simpler and at least as correct. Otherwise keep direct CLI. Optimize OpenCLI separately based on measurements.
7. **Update canonical docs:** Apply shared ownership decisions in [`docs/autodev-console-target-state.md`](https://github.com/SimulatorLife/AutoDev/blob/main/docs/autodev-console-target-state.md); operational details in `docs/provider-routing.md` and `docs/local-setup.md`; update or supersede `docs/plan/opencli-hybrid-concept.md` rather than maintaining competing active plans.

## Acceptance Criteria

- Roles remain provider-independent; user priority, availability, capacity, quota pools, cooldowns, persisted overrides and session affinity work unchanged.
- One canonical permission policy is **enforced**, not merely included in prompts. No ACP/Pi-specific shadow policy.
- Both direct and ACP leaf execution (if adopted) produce correct live state, OTel/OpenLIT history, memory provenance and operator visibility.
- No second agent control plane, queue scheduler, memory store, Collector, telemetry dashboard, or provider-specific copied codebase.
- ACP is optional and justified by **less maintained code at equal/better task quality, latency, and safety**; OpenCLI optimization is separately measured.

## Primary Repository References

- [AutoDev provider routing and cooldowns](https://github.com/SimulatorLife/AutoDev/blob/main/docs/provider-routing.md)
- [Canonical Console architecture, Rulesync and OpenLIT ownership](https://github.com/SimulatorLife/AutoDev/blob/main/docs/autodev-console-target-state.md)
- [Current execution contract](https://github.com/SimulatorLife/AutoDev/blob/main/config/execution-contract.json)
- [Current Rulesync generation configuration](https://github.com/SimulatorLife/AutoDev/blob/main/rulesync.jsonc)
- [Current Codex permission source](https://github.com/SimulatorLife/AutoDev/blob/main/config/config.autodev.toml)
- [OpenLIT OTLP endpoints](https://github.com/SimulatorLife/AutoDev/blob/main/config/openlit/otlp-endpoints.md)
- [Existing router telemetry](https://github.com/SimulatorLife/AutoDev/blob/main/runtime/src/router/telemetry.ts)
- [Current OpenCLI bridge](https://github.com/SimulatorLife/AutoDev/blob/main/runtime/src/providers/opencli.ts)
