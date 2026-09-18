# AutoDev TypeScript Target State

## Migration progress — 2026-09-17

The migration remains intentionally behavior-preserving. The shared-runtime spawn/state/MCP pass, router HTTP/proxy decomposition, all four provider bridge conversions, cross-provider orchestrator delegation, provider lifecycle ownership, and typed installer boundary are now landed; final test-stack migration continues.

### Completed

- Node 24.12+ is pinned in `.nvmrc`; strict native-TypeScript checking is configured in `tsconfig.json`.
- `smol-toml` and Node typings are installed; `typecheck`, native TypeScript tests, CLI checks, and inventory validation commands exist.
- Provider-limit, workspace, execution-contract, response-item, role, activity, and spawn-session primitives now have typed modules under `src/`.
- AutoDev-owned TOML/config/rendering paths are ported to `src/config` with deterministic output, atomic writes, local-state preservation, and drift checks.
- Typed CLI, MCP launcher, and macOS launchd lifecycle boundaries exist; `run-autodev-mcp.sh` is now only a process-dispatch shim.
- Agent-event telemetry and skill-read telemetry now run from typed modules under `src/telemetry` and `src/hooks`; bridge/router consumers use the shared telemetry module.
- Shared spawn generation/SSE/recovery helpers now live in `src/agents/spawn-tools.ts`; the read-only Codex state collector now lives in `src/router/state-collector.ts` with typed SQLite and snapshot contracts; and the stdio spawn MCP server now lives in `src/mcp/spawn-shim.ts`.
- All current consumers and installer/runtime projections use the typed paths. The old `scripts/codex/lib/*.mjs` modules are deleted, and installers reject/remove stale copies under `$CODEX_HOME/hooks/codex/lib/`.
- Dedicated spawn/state tests are native TypeScript, and the typed spawn MCP server has protocol tests covering initialization, tool gating, valid forwarding, malformed calls, and model-readable failures.
- Typed routing and cooldown owners now live in `src/router/routing.ts` and `src/router/cooldown.ts`; the legacy router imports them directly for model selection, fallback ordering, cooldown ladders, status, and persistence without compatibility re-exports.
- Routing/cooldown contract tests and new focused TypeScript tests cover validation, seeded ordering, disabled providers, orchestrator preference, cooldown ladders, last-resort policy, summaries, and hard-cooldown restoration.
- Typed Responses/SSE transformation, tool flattening, namespace rewriting, model replacement, tool-call counting, and upstream payload normalization now live in `src/router/responses.ts` and are deployed by the installer runtime manifest.
- Typed concurrency tracking and slot admission now live in `src/router/concurrency.ts` with TOML config parsing (`max_concurrent_threads_per_session`), process-fallback scoping, denial recording, and telemetry restoration; router lifecycle state management and graceful shutdown coordination live in `src/router/lifecycle.ts`.
- Typed router authentication boundary (`src/router/auth.ts`), failure classification and ring-buffer event recording (`src/router/events.ts`), subagent/bridge orchestration registry (`src/router/subagents.ts`), and state persistence subsystem (`src/router/persistence.ts`) are decomposed from the legacy router into dedicated TypeScript modules deployed by the installer runtime manifest.
- Orchestrator capability is now explicit in the execution contract: Codex, Claude, Antigravity, and Copilot have native or Codex-shim delegation paths; MiniMax is excluded from the orchestrator fallback tier instead of being advertised as spawn-capable. Copilot's bridge receives a session-scoped `autodev_spawn` MCP shim and emits the same Codex `exec` delegation item used by the other CLI bridges.
- Delegation capability resolution now fails closed to the execution contract rather than inferring capability from a routed provider name or a stale `spawnTools` list. Bridge-native parent activity remains open until the parent outcome is known, preserving failure semantics when child results arrive first; focused TypeScript coverage freezes both behaviors.

- Dedicated native TypeScript test suites cover concurrency (`tests/router/concurrency.test.ts`), router lifecycle (`tests/router/lifecycle.test.ts`), authentication (`tests/router/auth.test.ts`), event recording (`tests/router/events.test.ts`), subagent registry (`tests/router/subagents.test.ts`), and state persistence (`tests/router/persistence.test.ts`), while all router integration and frozen contract tests remain 100% green.
- Existing provider/router contract tests remain green while imports move to typed shared modules.
- Router HTTP routing, workspace/session resolution, status aggregation, agent-event ingestion, upstream proxying, retry/fallback, and exhaustion diagnostics now live in `src/router/http.ts` and `src/router/proxy.ts`; `scripts/codex-model-router.mjs` is a concise executable/re-export entrypoint. Dedicated native TypeScript proxy and HTTP tests cover the extracted contracts.
- The MiniMax boundary adapter now lives in `src/providers/minimax.ts` with strict native-TypeScript checking. Its header allowlist, `client_metadata` privacy boundary, freeform `exec` coercion, streaming rewrite, and tool/activity/MCP telemetry are unchanged; workstation installation, launchd service ownership, and CI now deploy/execute the typed module directly, and the obsolete `.mjs` entrypoint is deleted.
- The Copilot Responses bridge now lives in `src/providers/copilot.ts` under strict native-TypeScript checking. Its CLI-backed Responses, MCP, skill-read, tool-outcome, provider-limit, and activity telemetry boundaries are behavior-preserving; the installer deploys the typed module directly, stale `.mjs` copies are removed, and the obsolete `.mjs` entrypoint is deleted.
- The Antigravity Responses bridge now lives in `src/providers/antigravity.ts` under strict native-TypeScript checking. Its CLI-backed Responses, workspace/permission handling, role-specific MCP and skill exposure, tool outcomes, provider limits, activity, and bridge-native spawn accounting are preserved; installer/runtime projections deploy the typed module directly, stale `.mjs` copies are removed, and the obsolete `.mjs` entrypoint is deleted.
- The Claude Code Responses bridge now lives in `src/providers/claude.ts` under strict native-TypeScript checking. Its Claude Code OAuth-only environment, workspace and role permissions, MCP/skill views, stream-json continuation and item IDs, provider-limit handling, activity/tool/skill/MCP telemetry, and Codex-owned spawn-session boundary are preserved. The installer deploys the typed module directly, stale Python copies are removed, and the obsolete Python implementation is deleted; Claude Code CLI/OAuth remains the supported transport by policy.
- The provider-limit, MiniMax Responses boundary, and workspace-resolution contract suites now run as native TypeScript `node:test` files, preserving cross-language vocabulary, adapter assertions, and router/bridge workspace parity without duplicate JavaScript test entrypoints.
- The skill-read hook now validates its JSON payload and persisted deduplication state through explicit `JsonValue`, `JsonObject`, and `SeenState` boundaries rather than an `any` escape hatch; malformed state still fails closed without changing telemetry behavior.
- The workflow-weight validation suite now runs as native TypeScript (`tests/weights.test.ts`), and `validate:weights` executes that single source without a duplicate JavaScript entrypoint.
- Claude and MiniMax launch/ensure decisions now live in `src/platform/claude-ensure.ts` and `src/platform/minimax-ensure.ts`; Copilot's existing typed owner is the executable boundary as well. The corresponding `ensure-*` files are process-dispatch shims, while MiniMax's launchd daemon path directly execs the typed provider. `src/hooks/subagent-start.ts` invokes the typed owners directly in a model-gated, fail-closed sequence, with native TypeScript contract tests for each lifecycle boundary.
- Antigravity permission and global skill-registry reconciliation now live in `src/platform/antigravity-settings.ts` with typed JSON validation, deterministic deduplication, atomic private writes, and native TypeScript contract tests. The installer retains only optional CLI detection, root collection, and process dispatch; its embedded Python configuration logic is removed.
- Runtime file targeting, atomic materialization, symlink replacement/linking, skill-source validation, mode assignment, and drift comparison now live in `src/platform/runtime-files.ts`. Installer runtime-module, prompt, role, config, catalog, rules, and skill link/check paths use that typed owner; native TypeScript tests freeze checkout-to-`CODEX_HOME` mapping and link/replacement behavior.
- Obsolete launch-agent, runtime-file, hook, and directory cleanup now lives in `src/platform/runtime-reconciliation.ts`; the installer retains only launchctl bootout and argument collection. Native TypeScript tests cover lstat-based detection, symlink-safe removal, and recursive directory cleanup.
- Launchd service ownership, foreign-runtime protection, stale-process reaping, readiness probes, service restart ordering, and direct fallback dispatch now live in `src/platform/service-restart.ts`. The installer invokes this typed owner; only Collector/provider process execution remains an external boundary. Native TypeScript tests cover managed ownership, foreign services, alternate `CODEX_HOME`, Collector environment forwarding, and hook-matched reaping.
- Collector foreground validation, exact version/config checks, duplicate-listener protection, readiness, and ensure fallback now live in `src/platform/otel-collector.ts`; the `ensure-*` and `run-*` Collector scripts are process-dispatch shims. Native TypeScript tests cover option boundaries and exact binary validation.
- Pinned Collector artifact manifest validation, platform/architecture selection, download, SHA-256 verification, archive extraction, and private installation now live in `src/platform/otel-provision.ts`; the provisioning script is a process-dispatch shim. Native TypeScript tests cover explicit-binary, invalid-binary, and manifest-drift fail-closed paths.
- LaunchAgent placeholder rendering and drift validation now live in `src/platform/macos/launchagent.ts` with atomic writes and literal-safe path substitution; the installer delegates plist rendering/checks to the typed macOS owner.
- Collector mode persistence and router-auth token creation/publication now live in `src/platform/install-state.ts` with private atomic mode writes, preserved environment content, idempotent token reuse, and native TypeScript tests; the installer retains only option parsing and dispatch.
- External dependency availability, pipx provisioning, pinned CocoIndex/Python-LSP installation, macOS SDK/compiler environment preparation, and executable checks now live in `src/platform/dependencies.ts`; installer dependency functions are dispatch-only and native TypeScript tests cover skip, Homebrew, Python fallback, and missing-tool paths.
- The AutoDev request-capture recorder and its contract suite now run as native TypeScript (`.rulesync/skills/autodev-codex-request-capture/scripts/responses-recorder.ts` and `tests/codex-request-capture-skill.test.ts`); the previous first-party `.mjs` test/recorder pair is removed.
- The install materialization sequence now lives in `src/platform/install-materializer.ts`: typed runtime/role/link deployment, stale cleanup, Rulesync projections, composed config, provider skill/MCP views, Antigravity settings, and LaunchAgent rendering are coordinated there. The shell installer now dispatches the materializer before typed service restart.
- The concrete `autodev install` command now runs through `src/platform/install-command.ts`, coordinating typed state, dependency, materialization, Collector, and service owners. Installation drift diagnostics now live in `src/platform/install-check.ts`; the shell installer is only a process-dispatch shim.

### Current findings and constraints

- All provider bridges now live under `src/providers/` as typed modules. The router entrypoint remains a compatibility-preserving `.mjs` executable while its retained implementation is typed.
- The installer shell file is now a process-dispatch shim. Check-only validation, temporary MCP projection, final status gating, normal install orchestration, materialization, stale-path reconciliation, Antigravity settings, service restart, Collector lifecycle/provisioning, install-state, and dependency policy are typed owners reached through the concrete CLI coordinator; provider and Collector scripts are dispatch-only.
- First-party tests are still split between JavaScript, Python, and TypeScript. The inventory gate is present but intentionally reports the remaining legacy files until their replacements and equivalent tests land. The root-delegation, bridge-role, portable-config, Copilot MCP, workflow, workspace-attribution, native-vs-bridge, agent-instructions, Rulesync-permissions/MCP/hooks, and Collector config/runtime contract slices now run as native TypeScript.
- Canonical declarative content remains under `scripts/codex/`; moving it to the target `agents/` and `config/` layout must be coordinated with installer/runtime path changes.
- The typed state collector keeps its dynamic SQLite schema inspection behind an explicit row/binding boundary and continues to strip raw paths before snapshots are exposed; its output and privacy contracts were not changed.
- Routing owns provider/config policy; typed router modules now own HTTP, upstream proxy execution, Responses/SSE compatibility, OTEL telemetry, persistence, lifecycle, and bridge orchestration. The legacy `.mjs` router is retained only as the executable/public re-export entrypoint. The execution contract records a provider delegation mode so status and routing cannot claim that a provider with no spawn path can orchestrate.
- Claude's supported subscription path remains the unmodified Claude Code CLI, but AutoDev-owned bridge logic is now typed and imports shared workspace, role, limit, telemetry, and spawn contracts rather than maintaining a Python copy.
- `src/cli/autodev.ts` now has typed dispatch boundaries for `router`, `provider`, `hook`, and `install`; normal install, check, and render behavior has explicit typed ownership.
- The router status CLI now lives in `src/cli/router-status.ts` and consumes the typed `src/router/status.ts` boundary; the obsolete `scripts/codex-model-router-status.mjs` entrypoint is deleted and stale installed copies are removed.
- Router ensure/lifecycle decisions now live in `src/platform/router-ensure.ts` with injectable filesystem/process/launchd dependencies; `src/hooks/session-start.ts` invokes the typed owner directly, and the installed shell ensure entrypoint is only a process-dispatch shim. The typed owner preserves the best-effort optional Copilot ensure side effect through `src/platform/copilot-ensure.ts`.
- Session-start, subagent-start, and root-delegation command handlers own the
  hook entry points under `src/hooks`; Rulesync invokes those typed handlers
  directly. Session-start and subagent-start now call typed platform owners
  for router, Claude, MiniMax, Copilot, and Antigravity lifecycle decisions.
  The migrated local runtime's remaining shell ownership is limited to process
dispatch. CI provider invocation and the generic role runner still contain
behavior and remain pending migration; the next slice is consolidating the
remaining first-party legacy test stack and those two runtime entrypoints.
- The vendored `.rulesync/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py` helper remains an allowed upstream-language exception.

### Next implementation order

Step 1 — router HTTP and upstream proxy decomposition — is complete.

2. Convert all provider bridges to typed shared-contract implementations — complete for MiniMax, Copilot, Antigravity, and Claude.
3. Move installer option/check orchestration and temporary MCP projection behind typed CLI/platform modules — complete; the installer is now dispatch-only.
4. Convert the remaining JavaScript/Python tests to `node:test`, remove obsolete entrypoints, and enable the inventory gate as a required check — in progress; the request-capture test/recorder slice is complete.
5. Preserve the provider delegation matrix while moving the remaining bridge/telemetry contract tests to native TypeScript; Rulesync subagent generation remains deferred until it can project the AutoDev role/capability contract without weakening Codex ownership. The current slice hardens the contract and parent-outcome telemetry boundary first.

For the current provider, lifecycle, installer, and test-stack slices, `pnpm typecheck` and the remaining Python compatibility suite pass; the full JavaScript/TypeScript suite reports 848 tests with 846 passing and 2 skips. The focused Claude, provider, lifecycle, MCP, role, telemetry, workspace, root-delegation, and boundary suites pass, including the native TypeScript Claude Responses, portable-config, Copilot MCP, workflow, workspace-attribution, native-vs-bridge, agent-instructions, Rulesync-permissions/MCP/hooks, and Collector config/runtime contract tests. The inventory gate intentionally still reports the remaining legacy runtime entrypoints and test files; remaining migration work is concentrated in the final first-party test conversions and removal of obsolete executable entrypoints.

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

The existing `scripts/codex/run-autodev-mcp.sh` is a reasonable candidate to remain a small shim if its final responsibility is only process dispatch. Large installer and `ensure-*` scripts should move behind typed commands

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

Directory [scripts/](scripts) and [scripts/codex/](scripts/codex/) remain declarative/configuration and external process-boundary locations where required. The install script is now only a process-dispatch shim to the typed `autodev install` command and should be removed once downstream callers migrate.

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
