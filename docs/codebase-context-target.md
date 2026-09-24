# Codebase Context Target State

## Goal

Reduce repeated repository exploration and time-to-first-edit by giving agents a persistent, queryable understanding of the codebase instead of rebuilding that understanding on every task.

## CodeGraphContext — Primary Code Understanding

Use **CodeGraphContext (CGC)** as the default structural codebase map.

CGC should provide agents with pre-indexed relationships such as:

* files, modules, symbols, classes, and functions
* callers/callees and call chains
* imports and module dependencies
* inheritance and overrides
* transitive relationships and likely change impact

Agents should consult CGC **before exploratory file reads, broad grep/search, or repeated LSP navigation**. Prefer graph traversal performed by CGC over having the agent manually reconstruct dependency chains.

Use existing tools as focused fallbacks:

* **CocoIndex:** semantic/conceptual discovery when the relevant code or identifier is unknown.
* **LSP:** exact compiler/language semantics such as definitions, inferred types, references, diagnostics, and precise navigation.
* **Direct file reads:** inspect only the implementations relevant to the identified change.

Target flow:

```text
Task
  ↓
CodeGraphContext
  ↓
Relevant subsystem / symbols / dependency surface
  ↓
CocoIndex only if location is unclear
LSP only if exact language semantics are needed
  ↓
Targeted source reads
  ↓
Implement
```

## Repomix — Optional Repository Briefing

Use **Repomix only as a complementary high-level briefing layer**, not as a second source-code graph duplicating CGC.

A Repomix-generated briefing may contain:

* `AGENTS.md` / repository instructions
* agent skills and development rules
* architecture/design documentation
* TODOs and project state
* manifests and important configuration
* high-level directory structure

Prefer full content for important documentation/configuration and directory-only or excluded source-code content where CGC already provides structural understanding.

Conceptually:

```text
Repomix → "What is this project, and what rules should I follow?"
CGC     → "How is the implementation actually connected?"
CocoIndex → "Where is this concept implemented?"
LSP     → "What exactly does the language/compiler know here?"
```

## Operating Principle

Do not query multiple systems for the same fact merely to increase confidence. Each tool should have a distinct responsibility, and agents should continue exploration only when a concrete unanswered question blocks implementation.

The target is **persistent repository understanding + targeted investigation**, rather than exhaustive rediscovery on every task.