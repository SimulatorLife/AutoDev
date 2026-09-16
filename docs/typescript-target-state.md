# AutoDev TypeScript Target State

## Migration progress — 2026-09-16

The migration remains intentionally behavior-preserving. The shared-runtime spawn/state/MCP pass is now landed; router, provider, installer, and test-stack migrations remain.

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
- Dedicated native TypeScript test suites cover concurrency (`tests/router/concurrency.test.ts`), router lifecycle (`tests/router/lifecycle.test.ts`), authentication (`tests/router/auth.test.ts`), event recording (`tests/router/events.test.ts`), subagent registry (`tests/router/subagents.test.ts`), and state persistence (`tests/router/persistence.test.ts`), while all router integration and frozen contract tests remain 100% green.
- Existing provider/router contract tests remain green while imports move to typed shared modules.

### Current findings and constraints

- The router and provider bridges are still primarily legacy `.mjs`/Python implementations; router decomposition and Claude bridge conversion are not complete.
- Installer, reconciliation, hook, telemetry, and `ensure-*` behavior still has substantial shell/legacy runtime ownership.
- First-party tests are still split between JavaScript, Python, and TypeScript. The inventory gate is present but intentionally reports the remaining legacy files until their replacements and equivalent tests land.
- Canonical declarative content remains under `scripts/codex/`; moving it to the target `agents/` and `config/` layout must be coordinated with installer/runtime path changes.
- The typed state collector keeps its dynamic SQLite schema inspection behind an explicit row/binding boundary and continues to strip raw paths before snapshots are exposed; its output and privacy contracts were not changed.
- Routing owns provider/config policy while the legacy router retains HTTP, Responses/SSE, OTEL telemetry, persistence, lifecycle, and bridge orchestration; typed modules receive narrow runtime callbacks for live-load and provider-state inputs rather than importing those concerns.
- The Claude bridge still contains a provider-local Python copy of spawn-script/SSE logic until the provider bridge conversion pass; its MCP delegation path now launches the shared typed shim.
- The typed skill-read hook still has a dynamic JSON boundary that uses an explicit `any`; tighten that boundary when the hook tests are converted to TypeScript.
- `src/cli/autodev.ts` now has typed dispatch boundaries for `router`, `provider`, `hook`, and `install`; only `check` and render commands have concrete repository backends, while the remaining default backends fail closed until their runtime migrations land.
- The router status CLI now crosses a typed boundary in `src/router/status.ts`; the legacy router backend remains explicit and unchanged.
- Session-start, subagent-start, and root-delegation command handlers now own the
  hook entry points under `src/hooks`; Rulesync invokes those typed handlers
  directly while the existing ensure scripts remain unchanged runtime helpers.
  Their current implementation still delegates service startup to those legacy
  ensure scripts, so the platform/lifecycle migration is not complete.
- The vendored `.rulesync/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py` helper remains an allowed upstream-language exception.

### Next implementation order

1. Continue router decomposition with typed Responses/SSE, telemetry, persistence, lifecycle, and HTTP modules without changing its contracts.
2. Convert provider bridges, then the Claude bridge, so all providers use the shared contracts.
3. Move installer, reconciliation, hook, and `ensure-*` behavior behind the typed CLI/platform modules.
4. Convert remaining JavaScript/Python tests to `node:test`, remove obsolete entrypoints, and enable the inventory gate as a required check.

The current validation baseline is: `pnpm typecheck` passes; the expanded test commands include root-level TypeScript tests and currently report `pnpm test` at 658 passed and 1 skipped and `pnpm run test:ts` at 85 passed and 1 skipped. The Python compatibility suite reports 280 tests passing with 1 skipped; actionlint and ShellCheck also pass. `pnpm run validate:inventory` is expected to fail until the remaining migration order above is completed.

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

Directory [scripts/](scripts) and [scripts/codex/](scripts/codex/) are legacy and should be removed/migrated to `src/` or `agents/` as appropriate. The install script, [scripts/codex/install-codex-integration.sh](scripts/codex/install-codex-integration.sh) should be moved to the repo root or `src/`, renamed to `install.sh`, and/or replaced with a typed CLI command(s).

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
5. Convert the Claude Python bridge and unify provider contracts
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
