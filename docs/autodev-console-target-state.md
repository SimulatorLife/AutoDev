# AutoDev Console Target State

> **Authority:** This is the single living source of truth for AutoDev's OpenLIT fork, observability architecture, control-plane/UI ownership, RuleSync configuration ownership, migration state, acceptance evidence, and future console work.
>
> **Last reviewed:** 2026-09-30.
>
> **Runtime status:** The original observability migration is complete: the local router dashboard, in-process history aggregation, and pass-through AutoDev Collector are decommissioned. OpenLIT and the AutoDev Control API are the active observability/control foundation. The next target is to evolve the maintained OpenLIT distribution into the AutoDev Console described here.

## 1. Canonical-document contract

Every change touching telemetry, OpenLIT, RuleSync projections, agent/provider/MCP/skill configuration, dashboard/UI behavior, or the AutoDev Control API must:

1. Read this document before work and update it in the same PR when target decisions, verified facts, gaps, implementation status, or acceptance evidence change.
2. Update decisions in place. Do not preserve competing active plans in other docs.
3. Distinguish **target**, **verified current state**, and **open migration work**.
4. Keep implementation references repo-relative and keep secrets/machine-local values out of the repository.
5. Keep secondary docs and reusable skills concise and link here rather than copying this target state.

If another AutoDev document conflicts with this one on console, observability, OpenLIT, RuleSync ownership, or control-plane architecture, this document is authoritative.

## 2. Product goal

Build an **AutoDev-centric control and observability console** as a maintained OpenLIT distribution.

OpenLIT remains the standards-based telemetry foundation; AutoDev replaces OpenLIT's generic multi-tenant product shell with AutoDev's actual operating model. The product should make these resources first-class:

```text
AutoDev Console
├── Overview
├── Usage
├── Agents
├── Providers
├── Models
├── MCP Servers
├── Skills
├── Workspaces
├── Routing
├── Telemetry
│   ├── Traces
│   ├── Metrics
│   └── Logs
└── Settings
```

Configuration, desired state, observed runtime state, health, activity, and historical telemetry should appear together on the same resource surfaces while remaining separate architectural data/control paths underneath.

This is a **product/UX fork, not a destructive observability/storage fork**.

## 3. Core architecture

### Observability plane

```text
AutoDev producers
    │ standard OTLP
    ▼
OpenLIT first-party OTLP receiver
    │
    ▼
OpenLIT storage/query layer
    │
    ├── traces
    ├── metrics
    ├── logs
    ├── Usage dashboards
    └── resource-level historical analysis
```

Use standard OpenTelemetry traces, metrics, and logs as the telemetry contract. Prefer official GenAI and MCP semantic conventions and add a minimal `autodev.*` namespace only for concepts with no suitable standard.

Do not restore an AutoDev-owned historical aggregation database, general-purpose query service, compatibility dashboard, or pass-through Collector. Add a separate Collector only for a concrete documented policy need such as pre-export redaction, routing, or fan-out.

### Control plane

```text
AutoDev Console
    │ authenticated same-origin server path
    ▼
AutoDev Control API
    │
    ├── canonical configuration mutation
    ├── validation/generation/apply
    ├── desired-state reconciliation
    └── runtime/status reads
```

OTLP, telemetry queries, and dashboards are observation-only. **Never use telemetry as a command/configuration channel.**

For mutable resources, expose desired and actual state explicitly:

```text
canonical desired configuration
          ↓
validated apply / queued action
          ↓
runtime/controller
          ↓
observed actual state
          ↓
converged | pending | error
```

Borrow OpenLIT Controller/Argo CD semantics for desired state, actions, convergence, and actual-state reporting. Do not force AutoDev configuration through OpenLIT's eBPF/workload-management mechanisms when a direct AutoDev runtime/configuration owner exists.

## 4. RuleSync is the canonical agent-configuration source

Use the pinned RuleSync tool **as the single source of truth for every agent-facing configuration surface it natively represents**. Do not create an AutoDev-specific replacement schema or a second authoritative copy in OpenLIT/ClickHouse.

Canonical RuleSync-owned concerns include:

- rules/instructions;
- commands and prompt assets;
- subagent/agent-role definitions;
- Agent Skills and their supporting files;
- MCP server declarations and target-specific overrides;
- hooks;
- permissions and tool/capability policy where RuleSync can represent them.

The target canonical tree is RuleSync-native, including `.rulesync/commands/`, `.rulesync/subagents/`, `.rulesync/skills/`, `.rulesync/mcp.jsonc`, `.rulesync/hooks.jsonc`, and `.rulesync/permissions.jsonc` as applicable, with `rulesync.jsonc` selecting the supported features/targets.

### Ownership rules

- **RuleSync source files are authoritative.** Provider-specific Codex/Claude/Copilot/Antigravity files are generated projections, not editable truth.
- Existing native AutoDev agent-role files and prompt-composition paths are migration inputs only where RuleSync has not yet become authoritative; remove the duplicate authority once their semantics are represented losslessly in RuleSync.
