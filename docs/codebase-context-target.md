# Codebase Context Target State

## Goal

Reduce repeated repository exploration and **time-to-first-edit** by giving agents persistent, queryable codebase context instead of rebuilding the same understanding on every task.

The target state is:

> **Persistent repository understanding + targeted investigation, not exhaustive rediscovery on every task.**

Prefer indexed/deterministic tooling for mechanical discovery and graph traversal. The agent should reason over that context rather than reconstructing repository structure through dozens of searches, file reads, and navigation calls.

## Tool Responsibilities

Use each tool for a distinct information class.

### CodeGraphContext (CGC) — structural repository understanding

Use **CGC as the default structural map** for:

- callers/callees and transitive call relationships
- call chains
- imports/module dependencies
- dependency neighborhoods and likely blast radius
- inheritance/override architecture
- repository-wide structural relationships

Prefer CGC graph traversal over repeated step-by-step LSP/file traversal when the question is architectural or relational.

### CocoIndex Code (CCC) — semantic discovery

Use **CCC when the relevant code is not yet known by name/location**.

Examples:

- “Where is neutralization/overtaking behavior implemented?”
- “What controls cars bunching under braking?”
- “Where does intervention-phase dimming happen?”

Use semantic search to identify likely anchors, then switch to CGC/LSP rather than repeatedly searching.

### LSP MCP — precise language semantics

Use **LSP as the authority for compiler/language-server semantics**, including:

- exact definitions and references
- inferred types, hover information, and signatures
- implementations and precise type hierarchy
- diagnostics
- code actions, rename, and refactoring

LSP is a **precision tool**, not the default mechanism for manually exploring the whole repository.

### Repomix — optional repository briefing

Use **Repomix only as a complementary high-level briefing layer**, not as AutoDev's code graph, default code-search tool, or a duplicate of CGC.

A Repomix briefing is useful when a task needs high-level project context that is not already obvious from repository instructions or existing docs. Keep it focused on:

- `AGENTS.md` and other repository instructions
- skills/rules and development guidance
- architecture/design docs, TODOs, and project state
- manifests and important configuration
- high-level directory structure

Prefer full content for important docs/config, but omit source-code bodies or include only source directory structure where CGC already represents implementation relationships. Do **not** use Repomix for symbol, caller, dependency, or implementation-location questions, and do not query Repomix and CGC for the same fact.

Repomix is currently **not installed, registered as an AutoDev MCP server, or run automatically for tasks**. If a repository owner supplies a briefing, treat it as orientation rather than authoritative evidence about current source; confirm task-relevant implementation details with CGC and targeted source inspection.

A bounded Repomix integration may be evaluated later if measurements show repeated rediscovery of high-level repository rules/docs. Any integration should remain optional, have explicit generation/freshness ownership, exclude implementation source already covered by CGC, and avoid assuming unverified performance/compression benefits.

Conceptually:

```text
Repomix  → "What is this project, and what rules should I follow?"
CCC      → "Where is this concept implemented?"
CGC      → "How is the implementation connected?"
LSP      → "What exactly does the language/compiler know here?"
```

## Expected Task Flow

```text
Task
  ↓
Relevant code already known?
  ├─ No → CCC semantic search → establish likely anchor(s)
  └─ Yes
       ↓
CGC structural context
  dependency/call relationships
  ownership/blast radius
       ↓
Targeted source inspection
       ↓
Need exact compiler/language semantics?
  ├─ Yes → LSP
  └─ No
       ↓
Implement
       ↓
LSP diagnostics / focused validation
```

Do **not** query CCC, CGC, LSP, grep, and file search for the same fact merely to increase confidence.

## Suspected Tool Overlap — Cross-Validate Before Restricting

Inspect the **actual installed/current versions and exposed MCP schemas** before disabling or hiding anything. The ownership below is the target hypothesis and must be verified against the real tools.

| Capability | Preferred owner | Suspected overlap |
|---|---|---|
| Natural-language/concept discovery | **CCC** | CGC `find_code`, LSP workspace/symbol search |
| Known-symbol lookup | **LSP** | CGC `find_code` |
| Exact definitions | **LSP** | CGC/source search |
| Exact references | **LSP** | CGC callers/importers are related but not equivalent |
| Callers/callees | **CGC** | LSP call hierarchy |
| Transitive callers/callees | **CGC** | repeated LSP call-hierarchy traversal |
| A→B call chains | **CGC** | manual/repeated LSP traversal |
| Module/dependency graph | **CGC** | LSP imports/related-files |
| Importers | **CGC** | LSP reference/import tooling |
| Exact type/signature/hover | **LSP** | limited CGC metadata |
| Implementations/type semantics | **LSP** | CGC inheritance graph |
| Broad inheritance architecture | **CGC** | LSP type hierarchy |
| Diagnostics/refactoring | **LSP** | no meaningful equivalent |
| Semantic similarity search | **CCC** | no true equivalent |

Important distinctions:

- **References are not callers.** Keep LSP references authoritative.
- **Semantic similarity is not structural dependency.** CCC and CGC are complementary.
- **Graph relationships are not compiler semantics.** CGC should not replace LSP where exact language resolution matters.

## Reduce Agent Choice

Do not expose multiple interchangeable tools just because they exist.

Prefer:

> **One authoritative default per information class; alternatives are fallbacks, not competing defaults.**

After cross-validation, likely candidates to hide or demote from normal agents include:

- CGC generic code search when CCC/LSP already cover discovery better
- LSP call-hierarchy traversal when CGC can answer the architectural question transitively
- LSP file-import/dependency exploration when CGC already owns repository dependency analysis
- low-level LSP workspace-symbol tools when a higher-level bundled symbol tool provides the needed information

Do not permanently remove useful recovery/precision capabilities. Keep them available to expanded/debug/validator roles when justified.

### Current state: LSP on normal implementation roles

Checked against `lsp-mcp-server` 1.1.20's exposed schemas, the normal implementation roles (`default`, `worker`) scope `lsp` with `enabled_tools` in their role TOMLs:

| Status | Tools | Reason |
|---|---|---|
| Kept | `lsp_find_symbol`, `lsp_smart_search`, `lsp_goto_definition`, `lsp_goto_type_definition`, `lsp_find_references`, `lsp_find_implementations`, `lsp_type_hierarchy`, `lsp_hover`, `lsp_signature_help`, `lsp_document_symbols`, `lsp_diagnostics`, `lsp_index_files`, `lsp_workspace_diagnostics`, `lsp_rename`, `lsp_code_actions`, `lsp_format_document` | Exact symbol/type/reference/diagnostic/refactor semantics |
| Hidden: covered by a bundled tool | `lsp_workspace_symbols` | `lsp_find_symbol` does the same fuzzy name search and adds definition, hover, and references; its schema also advertises it as a codebase-exploration entry point, which competes with CCC |
| Hidden: owned by CGC | `lsp_call_hierarchy`, `lsp_file_imports`, `lsp_related_files` | Callers/callees and import/dependency neighbourhoods |
| Hidden: redundant | `lsp_file_exports`, `lsp_document_highlights` | Covered by `lsp_document_symbols` and `lsp_find_references` |
| Hidden: no agent value | `lsp_completions`, `lsp_inlay_hints`, `lsp_folding_ranges`, `lsp_selection_range`, `lsp_server_status`, `lsp_start_server`, `lsp_stop_server` | Editor affordances; servers auto-start |

`lsp_find_symbol` and `lsp_smart_search` can still return `incoming_calls`/`outgoing_calls`, which keeps a precise one-hop fallback. `explorer`, `validator`, `smart`, and `orchestrator` keep the full LSP surface. `tests/config/config-rendering.test.ts` freezes the split, and `tests/copilot-mcp-scope.test.ts` checks that Copilot turns receive the same allowlist.

## Suggested Agent Profiles

### Normal implementation agent

Expose the smallest useful surface:

- CCC semantic search
- CGC core relationship/dependency queries
- LSP exact symbol/type/reference/diagnostic/refactor tools

### Discovery / architecture agent

Bias toward:

- CCC search
- fuller CGC graph traversal
- limited LSP precision/navigation

### Validator / deep-debug agent

May receive broader access, including overlapping tools, when independent verification or ambiguity resolution justifies cross-checking.

## Longer-Term Interface

Prefer eventually hiding backend-specific MCP complexity behind a small user-level interface such as:

```text
code.search      → CCC
code.graph       → CGC
code.precise     → LSP
code.validate    → LSP
repo.brief       → Repomix/docs/config
```

Or a higher-level `get_task_context(task)` that mechanically combines the appropriate indexed information before implementation begins.

The agent should choose among a few **information intents**, not dozens of overlapping MCP operations.

## Repository and Tool Exclusions

Agents should work against arbitrary repositories with **zero manual setup in normal use**. Manage universal exclusions globally once wherever possible.

- **CGC:** ignore Repomix outputs, CGC-generated reports/state, and generated/vendor/build/cache/tool artifacts such as `node_modules`, `dist`, `build`, `target`, `out`, `.codegraphcontext/`, `.cgc/`, repo-local CCC/LSP/agent caches, etc., where not already covered by tool defaults.
- **Repomix:** ignore CGC state/cache, Repomix outputs, CGC-generated reports, repo-local CCC/LSP/agent caches, and generated/vendor/build/test artifacts not already covered by defaults.
- **Global Git excludes:** keep universal local/tool-generated artifacts from appearing as untracked repository changes.
- **Idempotent repo bootstrap:** run automatically on session start to verify global configuration, detect genuinely repo-specific generated/cache paths, and apply only missing non-versioned local exclusions when required.

Prefer global/tool-owned configuration or non-versioned mechanisms such as `.git/info/exclude`. Avoid modifying tracked project files by default; preserve and merge existing configuration instead of overwriting it.

## Investigation Behavior and Metrics

Investigate **proportionally to uncertainty and risk**. Once the responsible subsystem, relevant dependency surface, and regression surface are sufficiently established, begin implementation. Continue exploring only when a concrete unanswered question blocks the change.

Track at minimum:

- tool calls before first meaningful edit
- tokens before first edit
- unique files read before first edit
- repeated reads/searches
- CCC / CGC / LSP call counts
- total tool calls
- rework caused by insufficient investigation

Use these measurements to validate whether reduced tool exposure and clearer ownership actually improve performance.

## Required Validation Before Tool-Surface Changes

Before changing agent tool exposure:

1. inspect the installed/current versions of **CGC, CCC, and `lsp-mcp-server`**;
2. enumerate their actual exposed tools and schemas;
3. cross-validate the overlap assumptions above;
4. distinguish exact duplicates from superficially similar tools with materially different semantics;
5. propose the smallest normal-agent tool surface;
6. identify tools to hide, demote to fallback, or restrict to specialist roles;
7. preserve escape hatches where the preferred tool cannot answer correctly.

The objective is **not fewer tools for its own sake**. The objective is fewer redundant decisions, fewer duplicate queries, less repeated repository discovery, and faster movement from task → understanding → implementation.
