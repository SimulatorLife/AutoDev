# AutoDev TypeScript Target State

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

Do not introduce multiple pnpm workspace packages unless independently versioned/deployed package boundaries later justify them. Internal TypeScript modules are sufficient for the current control-plane architecture

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
4. Split and convert the model router into cohesive TypeScript modules
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
