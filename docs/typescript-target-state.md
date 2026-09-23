# AutoDev TypeScript Target State

## Migration progress — Complete (2026-09-17)

The TypeScript target state migration is fully completed across all twelve phases. AutoDev has converged on TypeScript as its sole first-party implementation and test language, running on Node 24+ LTS via native TypeScript execution.

### Completed

- Node 24.12+ is pinned in `.nvmrc`; strict native-TypeScript checking is configured in `tsconfig.json`.
- `smol-toml` and Node typings are installed; `typecheck`, native TypeScript tests, CLI checks, and strict inventory validation commands exist.
- Provider-limit, workspace, execution-contract, response-item, role, activity, and spawn-session primitives have typed modules under `src/`.
- AutoDev-owned TOML/config/rendering paths are ported to `src/config` with deterministic output, atomic writes, local-state preservation, and drift checks.
- Typed CLI, MCP launcher, and macOS launchd lifecycle boundaries exist; `run-autodev-mcp.sh` is now only a process-dispatch shim.
- Agent-event telemetry and skill-read telemetry run from typed modules under `src/telemetry` and `src/hooks`; bridge/router consumers use the shared telemetry module.
- GitHub metrics dashboard automation is migrated to typed native ESM in `src/telemetry/github-metrics.ts` with comprehensive unit tests in `tests/metrics.test.ts`. Obsolete `scripts/autodev-metrics.cjs` and `tests/metrics.test.mjs` are deleted.
- Shared spawn generation/SSE/recovery helpers live in `src/agents/spawn-tools.ts`; the read-only Codex state collector lives in `src/router/state-collector.ts` with typed SQLite and snapshot contracts; and the stdio spawn MCP server lives in `src/mcp/spawn-shim.ts`.
- All consumers and installer/runtime projections use the typed paths. The old `scripts/codex/lib/*.mjs` modules are deleted, and installers reject/remove stale copies under `$CODEX_HOME/hooks/codex/lib/`.
- Subagent telemetry test suite is native TypeScript in `tests/subagent-telemetry.test.ts`; `tests/subagent-telemetry.test.mjs` is deleted.
- Typed routing and cooldown owners live in `src/router/routing.ts` and `src/router/cooldown.ts`.
- Routing/cooldown contract tests and focused TypeScript tests cover validation, seeded ordering, disabled providers, orchestrator preference, cooldown ladders, last-resort policy, summaries, and hard-cooldown restoration.
- Typed Responses/SSE transformation, tool flattening, namespace rewriting, model replacement, tool-call counting, and upstream payload normalization live in `src/router/responses.ts` and are deployed by the installer runtime manifest.
- Typed concurrency tracking and slot admission live in `src/router/concurrency.ts` with TOML config parsing (`max_concurrent_threads_per_session`), process-fallback scoping, denial recording, and telemetry restoration; router lifecycle state management and graceful shutdown coordination live in `src/router/lifecycle.ts`.
- Typed router authentication boundary (`src/router/auth.ts`), failure classification and ring-buffer event recording (`src/router/events.ts`), subagent/bridge orchestration registry (`src/router/subagents.ts`), and state persistence subsystem (`src/router/persistence.ts`) are decomposed from the legacy router into dedicated TypeScript modules deployed by the installer runtime manifest.
- Standalone router server execution is decomposed into `src/router/server.ts`, wiring directly to `src/cli/router.ts`, `scripts/run-codex-model-router.sh`, `src/platform/service-restart.ts`, and `src/platform/install-materializer.ts`. Legacy `scripts/codex-model-router.mjs` is deleted, and its comprehensive 183-test suite is migrated to `tests/router/model-router.test.ts` with 0 type errors.
- Orchestrator capability is explicit in the execution contract: Codex, Claude, Antigravity, and Copilot have native or Codex-shim delegation paths; MiniMax is excluded from the orchestrator fallback tier. Copilot's bridge receives a session-scoped `autodev_spawn` MCP shim and emits the same Codex `exec` delegation item used by the other CLI bridges.
- Delegation capability resolution fails closed to the execution contract.
- Dedicated native TypeScript test suites cover concurrency (`tests/router/concurrency.test.ts`), router lifecycle (`tests/router/lifecycle.test.ts`), authentication (`tests/router/auth.test.ts`), event recording (`tests/router/events.test.ts`), subagent registry (`tests/router/subagents.test.ts`), and state persistence (`tests/router/persistence.test.ts`).
- Router HTTP routing, workspace/session resolution, status aggregation, agent-event ingestion, upstream proxying, retry/fallback, and exhaustion diagnostics live in `src/router/http.ts` and `src/router/proxy.ts`.
- The MiniMax boundary adapter lives in `src/providers/minimax.ts` with strict native-TypeScript checking. Workstation installation, launchd service ownership, and CI deploy/execute the typed module directly.
- The Copilot Responses bridge lives in `src/providers/copilot.ts` under strict native-TypeScript checking.
- The Antigravity Responses bridge lives in `src/providers/antigravity.ts` under strict native-TypeScript checking.
- The Claude Code Responses bridge lives in `src/providers/claude.ts` under strict native-TypeScript checking.
- The provider-limit, MiniMax Responses boundary, and workspace-resolution contract suites run as native TypeScript `node:test` files.
- The skill-read hook validates its JSON payload and persisted deduplication state through explicit `JsonValue`, `JsonObject`, and `SeenState` boundaries.
- The workflow-weight validation suite runs as native TypeScript (`tests/weights.test.ts`).
- Claude and MiniMax launch/ensure decisions live in `src/platform/claude-ensure.ts` and `src/platform/minimax-ensure.ts`.
- Antigravity permission and global skill-registry reconciliation live in `src/platform/antigravity-settings.ts` with typed JSON validation.
- Runtime file targeting, atomic materialization, symlink replacement/linking, skill-source validation, mode assignment, and drift comparison live in `src/platform/runtime-files.ts`.
- Obsolete launch-agent, runtime-file, hook, and directory cleanup lives in `src/platform/runtime-reconciliation.ts`.
- Launchd service ownership, foreign-runtime protection, stale-process reaping, readiness probes, service restart ordering, and direct fallback dispatch live in `src/platform/service-restart.ts`. Each label is booted out (waiting for launchd to unload it), cleared of stray listeners, and bootstrapped; `RunAtLoad` starts it, so there is no `kickstart`. A supervised restart then verifies every service in parallel (ready, served by the launchd job's own process, not crash-looping) instead of re-running the ensure hooks. A label launchd refuses to load and a missing `launchctl` are reported as distinct conditions; both fall back to the direct ensure-hook path.
- `LaunchdClient.bootout` blocks until launchd has finished unloading the job. `launchctl bootout` returns before the teardown completes, so an immediate re-`bootstrap` of the same label fails with `Bootstrap failed: 5: Input/output error`.
- Collector foreground validation, exact version/config checks, duplicate-listener protection, readiness, and ensure fallback live in `src/platform/otel-collector.ts`.
- Pinned Collector artifact manifest validation, platform/architecture selection, download, SHA-256 verification, archive extraction, and private installation live in `src/platform/otel-provision.ts`.
- LaunchAgent placeholder rendering and drift validation live in `src/platform/macos/launchagent.ts`.
- Collector mode persistence and router-auth token creation/publication live in `src/platform/install-state.ts`.
- External dependency availability, pipx provisioning, pinned CocoIndex/Python-LSP installation, macOS SDK/compiler environment preparation, and executable checks live in `src/platform/dependencies.ts`.
- The AutoDev request-capture recorder and its contract suite run as native TypeScript (`.rulesync/skills/autodev-codex-request-capture/scripts/responses-recorder.ts` and `tests/codex-request-capture-skill.test.ts`).
- The AutoDev session-diagnostics trace script and its suite run as native TypeScript (`.rulesync/skills/autodev-session-diagnostics/scripts/session-trace.ts` and `tests/session-diagnostics-skill.test.ts`).
- The install materialization sequence lives in `src/platform/install-materializer.ts`. Its `RUNTIME_MODULES` manifest is verified to be closed under relative imports by `tests/platform/runtime-manifest.test.ts`, so `$CODEX_HOME` never receives a module whose own imports were left behind.
- The concrete `autodev install` command runs through `src/platform/install-command.ts`. Installation drift diagnostics live in `src/platform/install-check.ts`.
- The legacy Python test suite `tests/test_local_setup.py` is eliminated; its concerns are 100% covered by native TypeScript suites (`tests/platform/*.test.ts`, `tests/config/*.test.ts`, `tests/cli/*.test.ts`).
- `package.json` test scripts are unified: `"test": "node --test tests/*.test.ts tests/**/*.test.ts"`.
- Strict inventory validation (`pnpm run validate:inventory` with `AUTODEV_ENFORCE_INVENTORY=1`) passes with zero unapproved legacy files.
- Declarative assets are migrated out of `scripts/codex/` into top-level `agents/` (`roles/`, `prompts/`, `rules/`) and `config/` (`catalogs/`, `profiles/`, `launchagents/`, `config.autodev.toml`, `model-routing.json`, `execution-contract.json`).
- `scripts/install.sh` provides the canonical shell entrypoint (executable via `pnpm run install:codex` or `bash scripts/install.sh`) delegating directly to `autodev install`.
- Legacy `scripts/codex/` directory is completely eliminated with zero legacy compatibility shims.
- The entire test suite (854 tests, 24 suites) passes with 0 failures under `node:test` on Node 24+ LTS.

### Current state and verification

- Zero first-party `.cjs`, `.mjs`, or `.py` files remain in `src/`, `scripts/`, or `tests/`.
- Shell scripts are strictly restricted to thin OS/process execution boundaries registered in `approvedLegacyFiles`.
- Legacy directory `scripts/codex/` is completely deleted.
- `pnpm run typecheck` (`tsc --noEmit`) passes with 0 errors.
- `pnpm test` passes 100% across all 854 tests.
- `pnpm run validate:actionlint` and `pnpm run validate:shell` pass with 0 warnings.
- `pnpm run validate:inventory` passes with 0 violations.

## Decision

AutoDev should converge on **TypeScript as its sole first-party implementation language**

Keep declarative formats in their native form (`YAML`, `TOML`, `JSON`, `JSONC`, plist, Markdown), and retain shell only for tiny OS/process launch shims where it materially simplifies an external boundary. Do not preserve Python or Bash application logic merely because those implementations already exist

Target ownership:

| Concern | Target |
|---|---|
| Router, provider bridges, orchestration | TypeScript |
| Config composition and rendering | TypeScript |
| Hooks and telemetry | TypeScript |
| Installer, reconciliation, lifecycle logic | TypeScript |
| Tests | TypeScript with `node:test` |
| Thin `exec`/platform launch shims | Shell only when justified |
| Agent/provider configuration | Existing declarative formats |
| Prompts and skills | Markdown |
| Vendored third-party helpers | Preserve upstream language unless replaced upstream |

The objective is not language purity by file extension. It is to eliminate duplicated runtime contracts, multiple test stacks, and cross-language maintenance for AutoDev-owned behavior

## Why TypeScript

AutoDev is already Node-centric:

- The model router and most provider bridges are JavaScript
- Shared runtime libraries and most tests are JavaScript
- The repository already uses ESM, pnpm, TypeScript, and `node:test`
- Existing Python code primarily performs TOML/JSON parsing, validation, file I/O, subprocess management, HTTP/SSE adaptation, and rendering rather than Python-specific computation
- Existing large Bash files contain application logic such as installation, reconciliation, health checks, locking, launchd management, and policy enforcement that is easier to type, compose, and test in TypeScript

Moving these implementations onto one runtime allows router, providers, hooks, telemetry, configuration, and installation to share actual types and modules instead of mirroring behavioral contracts across languages

## Node target

Upgrade from Node 22 to **Node 24 LTS**, with **Node 24.12+** as the preferred minimum when native TypeScript execution is adopted

Use Node's native TypeScript type stripping for runtime execution where practical rather than introducing a separate runtime transpiler or checked-in build output

Target development model:

```text
node src/cli/autodev.ts ...
tsc --noEmit
node --test tests/**/*.test.ts
```

Use TypeScript that is directly erasable at runtime. Avoid constructs that require TypeScript code generation or runtime transforms

Recommended compiler posture:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "strict": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "rewriteRelativeImportExtensions": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

`tsc` remains the static checker even when Node executes `.ts` directly

## Shell policy

Shell should be an **OS boundary, not an implementation language**

A shell file may reasonably locate an installation or `exec` another process. It should not own JSON parsing, configuration merging, retry policy, locking, health checks, process supervision, provider selection, filesystem reconciliation, telemetry semantics, or other application behavior

Agent hooks do not inherently need shell. Prefer direct Node/TypeScript hook entry points where the host supports command execution

The existing `scripts/run-autodev-mcp.sh` is a reasonable candidate to remain a small shim if its final responsibility is only process dispatch. Large installer and `ensure-*` scripts should move behind typed commands

## Target repository organization

Treat AutoDev as one application/control plane rather than a directory of unrelated scripts

```text
src/
  cli/
  router/
  providers/
    claude/
    minimax/
    antigravity/
    copilot/
  agents/
  config/
  hooks/
  mcp/
  telemetry/
  platform/
    macos/
  shared/

agents/
  roles/
  prompts/

config/
  providers/
  otel/

tests/
  unit/
  contract/
  integration/

vendor/
docs/
```

Do not introduce multiple pnpm workspace packages unless independently versioned/deployed package boundaries later justify them. Internal TypeScript modules are sufficient for the current control-plane architecture.

Declarative assets reside in top-level `agents/` (`roles/`, `prompts/`, `rules/`) and `config/` (`catalogs/`, `profiles/`, `launchagents/`, `config.autodev.toml`, `model-routing.json`, `execution-contract.json`), while `scripts/` contains only runtime launch shims (`scripts/run-*.sh` and `scripts/otel/`) and the repository-level installer (`scripts/install.sh`, invokable via `pnpm run install:codex`). The installer delegates directly to `autodev install`. Legacy `scripts/codex/` is eliminated completely.

## Single CLI boundary

Converge executable behavior behind one `autodev` CLI with typed internal modules

Example command surface:

```text
autodev install
autodev check

autodev router run
autodev router ensure
autodev router status

autodev provider claude
autodev provider minimax
autodev provider copilot
autodev provider antigravity

autodev hook session-start
autodev hook subagent-start
autodev hook root-delegation
autodev hook skill-read

autodev render agents
autodev render contract
autodev render skills

autodev mcp lsp
autodev mcp cocoindex-code
autodev mcp playwright
```

This should replace independent executable scripts where those scripts are only separate because the implementation evolved incrementally

## High-value consolidation targets

### Shared provider contracts

Provider-limit classes, incomplete-response reasons, workspace metadata, Responses/SSE structures, role capabilities, tool metadata, and telemetry event shapes should become shared TypeScript types/modules

The Claude bridge is an important early migration because it currently mirrors concepts maintained by the JavaScript router/provider code. After conversion, it should import shared definitions rather than duplicating them across Python and JavaScript

### Config and role generation

Port the AutoDev-owned Python renderers/composers to TypeScript and use one maintained TOML parser. Preserve their current semantic guarantees, including deterministic output, validation, atomic replacement, preservation of machine-local state, and drift checks

Rulesync remains responsible for portable provider-format translation. AutoDev remains responsible for its role/capability semantics and any generated execution contract that Rulesync cannot represent losslessly

### Installation and lifecycle

Replace the large Bash installer and behavioral `ensure-*` scripts with typed platform modules behind `autodev install`, `autodev check`, and lifecycle commands

Keep macOS-specific launchd behavior isolated under a platform boundary rather than spreading launchctl/plist assumptions throughout core modules

### Tests

Consolidate first-party tests on TypeScript + `node:test`

Split oversized tests by subsystem rather than recreating monolithic test files during conversion. Keep contract fixtures where they provide useful provider-independent compatibility coverage

## Canonical versus generated content

Every duplicated configuration/skill/runtime view must have one explicit canonical source and one generated direction

Prefer:

```text
canonical source -> generator -> generated/install view
```

Generated files should be clearly marked and protected by drift validation. Avoid parallel locations that both appear hand-editable

## Migration order

1. Add strict `tsconfig.json` and repository TypeScript conventions
2. Upgrade Node to 24 LTS and establish the native-TypeScript runtime constraints
3. Convert shared `.mjs` libraries to `.ts` so later migrations reuse typed primitives
4. Split and convert the model router into cohesive TypeScript modules:
   - `src/router/auth.ts`: Bearer token authentication & authorization validation.
   - `src/router/lifecycle.ts`: Router lifecycle management, graceful draining & shutdown.
   - `src/router/cooldown.ts`: Provider cooldown management, probe failure classification, and retry ladders.
   - `src/router/concurrency.ts`: Subagent concurrency slots, session key tracking, and reservation limits.
   - `src/router/events.ts`: Router event recording, recent event ring buffer, and persistence serialization.
   - `src/router/subagents.ts`: Subagent registry, capability resolution, role contracts, bridge telemetry headers, and child normalization.
   - `src/router/persistence.ts`: Router state persistence envelope (`autodev-router-persisted-state-v3`), atomic writes (`0o600`), debounced scheduling, and section restore dispatch.
   - `src/router/usage.ts`: Usage telemetry buckets, workspace attribution, privacy-safe hashing, live agent projection, attribution diagnostics, and snapshot restoration.
   - `src/router/otel.ts`: OpenTelemetry ingestion (logs, traces, metrics), delta/cumulative series calculation, deduplication windows, MCP health & lifecycle tracking, bridge observation events, additive `AUTODEV_OTEL_ATTRIBUTES=v1` payload enrichment, and persistence snapshot/restore (`schemaVersion: 6`).
   - `src/router/proxy.ts`: upstream headers/authentication, payload transformation, streaming/JSON response handling, retries, cooldown-aware fallback chains, and structured exhaustion diagnostics.
   - `src/router/http.ts`: HTTP endpoint routing, workspace/session resolution, status aggregation, agent-event ingestion, and router request lifecycle/error handling.
5. Convert the Claude bridge and unify provider contracts — complete; the implementation is `src/providers/claude.ts` and Claude Code CLI/OAuth remains the supported transport
6. Convert AutoDev-owned config/render Python scripts
7. Replace large Bash installer/reconciliation logic with typed CLI/platform modules
8. Convert behavioral hooks and `ensure-*` scripts to CLI subcommands
9. Retain only genuinely trivial shell shims where they improve an external OS/process boundary
10. Convert first-party Python tests and remaining JavaScript tests to TypeScript
11. Remove Python as an AutoDev development/runtime requirement except where an external dependency independently requires it
12. Add repository-inventory enforcement preventing new first-party Python, JavaScript, or non-approved shell implementation files

## Non-goals

- Do not rewrite upstream/vendored utilities solely to satisfy the language target
- Do not replace declarative configuration formats with TypeScript
- Do not create a build pipeline or checked-in JavaScript output unless runtime requirements prove native TypeScript insufficient
- Do not split AutoDev into packages merely to create artificial module boundaries
- Do not combine this migration with unrelated provider-routing or platform-behavior changes

## Target end state

**TypeScript is AutoDev's only first-party programming language**

Shell, if retained, is limited to small launch/`exec` shims. Python is not required by AutoDev-owned runtime, configuration, tests, or installation logic. All core domains share one type system, one package/runtime ecosystem, one test stack, and reusable contracts across router, providers, agents, hooks, telemetry, configuration, and platform integration
