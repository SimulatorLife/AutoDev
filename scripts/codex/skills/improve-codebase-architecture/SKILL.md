---
name: improve-codebase-architecture
description: Analyze and improve codebase architecture by finding structural friction, unclear ownership, shallow modules, leaky seams, and tightly coupled change paths, then propose or implement bounded refactors that increase locality, testability, leverage, and navigability. Use for architecture audits, module-boundary redesign, structural refactors, or when changing one concept requires coordinating too many files or layers.
---

# Improve Codebase Architecture

Improve the structure that determines where behavior lives, how modules depend on one another, and how much of the codebase must be understood or changed together

The goal is not a novel architecture, more abstractions, smaller files, or fewer lines. The goal is clearer ownership, narrower interfaces, better dependency direction, stronger locality, and less change amplification

## Repository Authority Comes First

Before evaluating architecture, inspect the current repository rather than assuming a preferred design

Use as applicable:

- `AGENTS.md`, `CLAUDE.md`, or equivalent repository guidance
- Architecture, requirements, domain, and ownership documentation
- Repository-local skills and conventions
- Package, workspace, layer, and dependency boundaries
- Existing tests, fixtures, and public interfaces
- Build, lint, typecheck, test, and architecture-validation commands
- Similar nearby implementations
- Relevant recent history when it explains an otherwise surprising structure
- ADRs, domain glossaries, or equivalent records when they exist

Project-specific guidance overrides generic preferences in this skill

Do not require a particular documentation layout, framework, language, package manager, or architecture

## Relationship to Code Simplification

Architecture improvement and code simplification overlap but have different centers of gravity

Use architecture analysis primarily for:

- Ownership and responsibility boundaries
- Module and package structure
- Dependency direction
- Public interfaces and seams
- Cross-module coordination
- Test surfaces
- Structural change amplification

Use code simplification primarily for local duplication, unnecessary indirection, control-flow complexity, fragmentation, and redundant concepts

A structural improvement should usually make later local simplification easier, not merely move the same complexity into differently named files

## Core Concepts

Use these concepts as reasoning tools rather than mandatory project vocabulary

- **Module**: any cohesive unit that exposes behavior to callers, from a function or class to a package or subsystem
- **Interface**: everything callers must know to use a module correctly, including operations, inputs, invariants, ordering, errors, configuration, and relevant performance expectations
- **Depth**: how much useful behavior a module hides behind how little caller-facing complexity
- **Seam**: a deliberate place where behavior can vary or be substituted without spreading that decision through callers
- **Leverage**: how much repeated caller work or knowledge one authoritative module removes
- **Locality**: how strongly related behavior, knowledge, bugs, tests, and changes stay concentrated in the same owner
- **Change amplification**: how many unrelated files, modules, or layers must change to implement one conceptual change

Prefer deep, cohesive modules with small intentional interfaces over chains of shallow wrappers whose callers still need to understand the underlying implementation

## Operating Modes

### Audit Mode

Use when asked to inspect architecture, identify candidates, or recommend improvements without necessarily changing code

Survey enough of the relevant codebase to understand actual ownership and dependency patterns, then return a small ranked set of evidence-backed candidates

Do not manufacture findings merely to produce recommendations

### Focused Improvement Mode

Use when asked to make an architectural improvement or when a broader implementation task clearly requires one

Choose one bounded structural problem, define the intended target state, implement the complete migration, and validate the resulting ownership and behavior

Do not turn a focused task into a repository-wide rewrite unless the task explicitly calls for it

## Scope Before Scanning

If the user names a subsystem, module, pain point, or boundary, start there

Otherwise, prioritize areas where architecture is most likely to matter:

- Frequently changed files or subsystems
- Code touched repeatedly by unrelated features
- Dependency hubs with many callers
- Areas with recurring bugs or regression fixes
- Modules whose tests require unusually broad setup
- Places where one conceptual change routinely spans many files or layers
- Areas with repeated ownership or dependency exceptions

Recent churn is a signal, not proof that the architecture is wrong

## Find Structural Friction

Look for concrete evidence such as:

- Understanding one concept requires bouncing through many small modules with no clear authoritative owner
- A module exposes nearly as much complexity as it hides
- Pass-through wrappers forward calls without owning policy, validation, translation, or a real substitution point
- Callers duplicate orchestration or policy because no module owns the complete behavior
- Internal implementation details leak across module or package boundaries
- Shared utilities contain feature-specific policy
- Dependency direction is circular, bidirectional, or routinely bypassed
- A lower-level module depends on higher-level product policy without a deliberate inversion
- Multiple modules must coordinate shared mutable state to preserve one invariant
- Tests reach through interfaces into internals because the intended behavior cannot be exercised at the real boundary
- Production code has been fragmented mainly to make isolated tests possible while integration behavior remains hard to verify
- One behavior has several partial owners or several sources of truth
- Similar changes require synchronized edits across many callers
- Adapters, factories, interfaces, registries, or configuration layers exist for variation that does not actually occur
- A supposedly generic module knows too much about individual features
- Stable callers repeatedly change because an implementation detail changed behind them

File size alone is not architectural evidence

## Evaluate Candidates

For each plausible candidate, apply these tests

### Ownership Test

Can you name one authoritative owner for the behavior and its invariants

If ownership is split, determine whether that split represents real domain responsibilities or accidental coordination

### Deletion Test

Imagine removing the suspected abstraction

If its complexity simply disappears, it may be a shallow forwarding layer

If its behavior and knowledge would have to be duplicated across many callers, it is probably earning its place

### Interface Test

Ask what a caller must know to use the module safely

Prefer interfaces that hide implementation choices and keep invariants local. A small type signature is not enough if callers still need to understand hidden ordering, state, or implementation details

### Locality Test

Ask where a future maintainer would need to look to understand, change, debug, and verify one behavior

Prefer designs where those paths converge on the same owner rather than spreading across unrelated layers

### Variation Test

Do not introduce a seam, adapter, plug-in point, or generalized interface merely because variation could exist someday

A seam is strongest when the repository has actual variation, a real external boundary, a test substitution need that cannot be handled more directly, or an explicit architectural requirement

### Dependency-Direction Test

Dependencies should point toward stable, authoritative concepts rather than convenience

Do not solve a dependency problem by moving policy into a generic layer that should not own it

### Change-Amplification Test

Compare how many places must change before and after the proposed design for a representative conceptual change

A useful refactor should reduce coordination or knowledge requirements, not simply rename them

## Design the Target State Before Editing

For a meaningful structural change, state:

- The current authoritative owners and dependency direction
- The specific architectural friction supported by repository evidence
- The intended owner after the change
- The interface callers should depend on
- Which responsibilities move, stay, or disappear
- Which old paths will be removed
- Which observable behavior and compatibility requirements must remain unchanged
- How tests will exercise the resulting design
- The migration and validation scope

For consequential choices with more than one plausible structure, consider at least two materially different designs before committing to one

Compare alternatives by:

- Interface complexity
- Locality
- Dependency direction
- Test surface
- Number of concepts and coordination points
- Migration risk
- Compatibility requirements
- Expected future change amplification

Do not add abstraction merely to make the design look more architectural

## Implement the Complete Structural Change

When making edits:

- Move behavior to its intended authoritative owner
- Migrate every affected caller, import, export, test, fixture, and configuration reference
- Remove superseded implementations and pass-through layers when repository policy allows it
- Do not leave parallel old and new ownership paths merely to reduce short-term migration work
- Do not add compatibility wrappers unless backward compatibility is an explicit supported requirement
- Keep unrelated refactors and formatting out of the change
- Preserve concurrent work from other agents or processes
- Keep abstractions only when they hide meaningful complexity or enforce a real boundary
- Preserve supported behavior unless the task explicitly includes behavior changes

If the new structure requires more concepts, more cross-module knowledge, or more synchronization than the old one, re-evaluate the design

## Validation

Use targeted validation while iterating, then run the repository's required broader checks before completion

Evidence should match the architectural claim and may include:

- Tests through the intended public interface
- Regression or integration tests that prove preserved behavior
- Dependency, layer, import, or source-boundary checks
- Typecheck, lint, formatting, and build validation
- Runtime or end-to-end verification when the changed boundary is exercised there
- A before/after comparison of callers, ownership locations, dependency edges, or change amplification
- Dead-code checks after removing superseded paths

Do not weaken tests, architecture rules, dependency checks, lint rules, or validation to make the new structure pass

Passing tests alone do not prove an architectural improvement. Confirm that the intended ownership and dependency model is actually simpler and more local

## Red Flags

- Creating abstractions for hypothetical future implementations
- Splitting cohesive modules only to reduce file size
- Combining unrelated responsibilities into a large module only to reduce file count
- Moving code without changing ownership or dependency structure
- Adding interfaces, factories, registries, or adapters with one caller and no real variation or policy
- Replacing a direct dependency with several forwarding layers
- Moving feature policy into shared infrastructure to make dependencies easier
- Duplicating behavior to avoid repairing the correct boundary
- Rewriting a stable area without evidence of structural friction
- Treating personal style as architecture
- Assuming the newest structure is necessarily the intended structure
- Preserving obsolete layers as compatibility shims without an explicit compatibility requirement
- Testing internals more heavily because the new public interface became harder to exercise
- Calling complexity reduction successful when the same coordination merely moved elsewhere

## Completion Criteria

Architecture work is complete when:

- The structural problem is supported by repository evidence
- The resulting ownership model is explicit and coherent
- Callers depend on a smaller, more intentional surface where appropriate
- Dependency direction is at least as clear as before
- Change amplification or cross-module coordination is reduced for the targeted behavior
- Superseded ownership paths are removed unless explicitly required
- Supported behavior remains correct
- Relevant tests and repository validation pass
- The final diff is bounded to the architectural goal
- Any remaining trade-offs or risks are stated explicitly

## Attribution

This skill is inspired by the deep-module, interface, locality, leverage, seam, and deletion-test ideas in Matt Pocock's `improve-codebase-architecture` and `codebase-design` skills, substantially adapted for repository-agnostic autonomous and interactive development
