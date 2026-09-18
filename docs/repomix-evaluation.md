# Repomix Evaluation for AutoDev

> Evaluation against the current `SimulatorLife/AutoDev` architecture and Repomix `1.18.0` as of 2026-09-13

## Decision

**Adopt Repomix only as a scoped context-packaging capability, not as a replacement for CocoIndex or LSP**

AutoDev already has a useful division of responsibility:

| Need | Current owner | Decision |
|---|---|---|
| Broad semantic discovery | CocoIndex / `ccc` | Keep |
| Definitions, references, types, call relationships, diagnostics, refactors | `lsp-mcp-server` | Keep |
| Coherent multi-file context snapshot with tree, token count, filtering, and optional structural compression | No dedicated owner | Add Repomix |

The target model should be:

```text
CocoIndex  -> discover relevant code
Repomix    -> package a coherent relevant scope when useful
LSP        -> verify exact code semantics and relationships
```

Repomix fills the gap between finding relevant code and reasoning over a bounded, repeatable context set. It should not become another general-purpose search surface

## Why it fits AutoDev

AutoDev's shared code-search guidance already distinguishes semantic discovery from precise semantic navigation:

- CocoIndex finds relevant code, related implementations, similar patterns, and conceptually connected areas
- LSP resolves symbols, definitions, references, types, diagnostics, and call relationships

Sources:

- [`agents/prompts/code-search.md`](../agents/prompts/code-search.md)
- [`.rulesync/skills/ccc/SKILL.md`](../.rulesync/skills/ccc/SKILL.md)
- [`.rulesync/skills/lsp-mcp-server/SKILL.md`](../.rulesync/skills/lsp-mcp-server/SKILL.md)

Repomix solves a different problem: it turns a selected repository scope into a structured AI-oriented artifact with a directory tree, file contents, token counts, include/ignore filtering, output formats, and optional Tree-sitter compression

Relevant upstream sources:

- [Repomix repository](https://github.com/yamadashy/repomix)
- [Repomix MCP server](https://github.com/yamadashy/repomix/blob/main/src/mcp/mcpServer.ts)
- [`pack_codebase`](https://github.com/yamadashy/repomix/blob/main/src/mcp/tools/packCodebaseTool.ts)

This is especially useful for AutoDev because multiple providers and subagents may otherwise rediscover and reread the same files independently

## Recommended scope

### Add

Use Repomix for:

- Packaging a known subsystem or selected file set into one coherent context artifact
- Measuring total context size before dispatch or handoff
- Producing deterministic context packets for review, architecture analysis, documentation, or subagent delegation
- Searching within an already captured context artifact
- Optionally compressing wider architectural context while keeping correctness-sensitive files uncompressed

A useful context pattern is:

```text
Files being edited or reviewed  -> full content
Direct collaborators            -> full content
Wider subsystem                 -> compressed when appropriate
Unrelated repository areas      -> omitted or structure only
```

### Do not replace

Do not use Repomix instead of:

- CocoIndex for conceptual or semantic discovery
- LSP for symbol-aware navigation or correctness-sensitive code relationships
- Native or existing file tools for simple direct reads

Repomix grep is lexical search over a captured artifact, not semantic code search or symbol resolution

## MCP integration

AutoDev already centralizes MCP process startup in [`scripts/run-autodev-mcp.sh`](../scripts/run-autodev-mcp.sh), resolving pinned AutoDev dependencies while preserving the active target repository as the MCP process working directory

Repomix fits that model directly:

```text
AutoDev dependency
      |
      v
run-autodev-mcp.sh repomix
      |
      v
Repomix MCP --sandbox
      |
      v
active target repository
```

The canonical MCP declaration should continue to live in [`.rulesync/mcp.jsonc`](../.rulesync/mcp.jsonc), with AutoDev retaining role/capability semantics and runtime security behavior

This matches the broader platform rule in [`AUTODEV_PLATFORM_MIGRATION.md`](AUTODEV_PLATFORM_MIGRATION.md): use upstream dependencies for portable tooling and generic plumbing while keeping AutoDev-specific orchestration, policy, and capability semantics inside AutoDev

## Security and tool exposure

Use Repomix MCP in **sandbox mode only** for AutoDev-managed code work

Sandbox mode confines paths to the active workspace and disables the broader operations that would otherwise overlap or conflict with AutoDev ownership

Expose only the Repomix capabilities needed for context packaging:

- `pack_codebase`
- `read_repomix_output`
- `grep_repomix_output`

Do not expose by default:

- `pack_remote_repository`
- `generate_skill`
- `attach_packed_output`
- Generic Repomix filesystem read/directory tools unless a specific gap is demonstrated

Reasons:

- Remote repository access should remain owned by AutoDev/GitHub workflows and the checked-out workspace
- Skill generation overlaps with AutoDev's Agent Skill and Rulesync ownership
- Arbitrary attachment or path access is unnecessary for the intended use
- Generic file reads duplicate existing capabilities and increase tool-choice ambiguity

`pack_codebase` is semantically read-only with respect to the target repository, but Repomix does create temporary packed-output files outside the workspace. AutoDev should explicitly verify that behavior under Codex read-only roles before enabling it broadly

## Role exposure

Start narrowly

| Role | Repomix | Rationale |
|---|---:|---|
| `explorer` | Yes | Best fit for repository surveys, architecture analysis, and bounded context assembly |
| `smart` | Yes | Broad analysis role that can benefit from cross-cutting context packets |
| `worker` | No initially | Avoid giving implementation agents three competing code-inspection surfaces before usage proves valuable |
| Validator or specialized roles | Evaluate case-by-case | Enable only where coherent snapshot context is materially useful |

The existing `explorer` and `smart` roles already receive both CocoIndex and LSP, so Repomix should be described explicitly as the context-assembly step rather than another search mechanism

## Compression guidance

Repomix Tree-sitter compression is useful for reducing token usage while preserving signatures and high-level structure, but it removes implementation detail

Use compression for:

- Architecture surveys
- Wider subsystem context
- Dependency and API-shape understanding
- Large background context where implementation bodies are not yet required

Do not rely on compressed output alone for:

- Bug fixes
- Concurrency or lifecycle analysis
- Dead-code proof
- Behavioral correctness
- Security-sensitive review
- Refactors where implementation details determine safety

For those tasks, use full source for the affected files and LSP to verify exact relationships

## Library integration opportunity

Repomix is also published as a Node package, so the MCP server should not be the only integration considered

A potentially stronger long-term use is for AutoDev itself to generate context packets before model or subagent dispatch:

- Package the exact file scope chosen by an explorer or orchestrator
- Record file count and token count before dispatch
- Hand the same deterministic context set to different providers
- Include context-package metadata in AutoDev telemetry
- Reuse the package for reviewer or validator handoffs

This would reduce provider-specific rediscovery and make subagent context more reproducible without changing CocoIndex or LSP ownership

## Risks

| Risk | Mitigation |
|---|---|
| Agents use Repomix as a replacement for semantic search | Define explicit CocoIndex -> Repomix -> LSP guidance |
| Large packs waste context | Require targeted include patterns and use token counts before reading full outputs |
| Compression hides implementation behavior | Restrict compression to wider/background context |
| Tool proliferation increases ambiguity | Enable only on selected roles and expose only three Repomix tools |
| New dependency duplicates existing features | Treat context packaging as Repomix's sole architectural responsibility |
| Temporary output behavior conflicts with read-only policy | Validate filesystem behavior under AutoDev's sandbox model before rollout |

## Recommended rollout

1. Add Repomix as a pinned AutoDev dependency
2. Add a `repomix` branch to `run-autodev-mcp.sh` that starts the MCP server in sandbox mode
3. Add the canonical Repomix MCP declaration to Rulesync
4. Expose only `pack_codebase`, `read_repomix_output`, and `grep_repomix_output`
5. Enable Repomix for `explorer` and `smart` only
6. Add short shared guidance defining the CocoIndex -> Repomix -> LSP workflow
7. Add tests for sandbox startup, workspace confinement, role exposure, and generated Rulesync shadows
8. Measure actual use, token savings, redundant tool calls, and failure modes before enabling additional roles
9. Separately evaluate direct Node-library use for orchestrator/subagent context handoffs

## Final recommendation

**Adopt Repomix, but give it one narrow architectural responsibility: deterministic, token-aware context packaging**

Keep the existing ownership boundaries:

```text
CocoIndex = semantic discovery
Repomix   = context packaging
LSP       = exact code semantics
```

That adds a capability AutoDev does not currently have while avoiding duplication of the two code-navigation systems already in place
