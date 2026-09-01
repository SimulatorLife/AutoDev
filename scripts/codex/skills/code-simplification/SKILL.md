---
name: code-simplification
description: Simplify working code without changing supported behavior by reducing unnecessary concepts, duplication, indirection, coupling, fragmentation, and special cases. Use for focused refactors, cleanup passes, architectural simplification, or when code is harder to understand, maintain, or extend than it should be.
---

# Code Simplification

## Purpose

Simplify code while preserving supported behavior

The goal is not fewer lines or fewer files by themselves. The goal is fewer concepts, ownership locations, dependencies, branches, abstractions, and special cases required to understand or change a behavior

A simplification is successful when the resulting system is easier to reason about, has clearer ownership, and requires less coordination to modify safely

## Use This Skill When

- Working code is harder to understand, maintain, test, or extend than necessary
- Logic is duplicated or represented by parallel implementations
- Related behavior is scattered across files or modules without a clear owner
- One file or function owns multiple unrelated responsibilities
- Many tiny files or helpers fragment one cohesive concept
- Wrappers, adapters, factories, configuration layers, or abstractions add little value
- Control flow contains excessive nesting, branching, temporary state, or repeated conditions
- Feature-specific logic has leaked into shared or generic modules
- A refactor should improve DRY, KISS, cohesion, coupling, organization, or ownership
- A task explicitly asks for a proactive code-quality or simplification pass

## Do Not Use This Skill To

- Change product behavior under the label of cleanup
- Add speculative infrastructure or abstractions for hypothetical future needs
- Rewrite code you do not yet understand
- Optimize for line count, file count, novelty, or personal style
- Perform unrelated drive-by cleanup during a focused feature or bug-fix task
- Remove required compatibility guarantees that the repository explicitly treats as supported behavior

## Core Definition

Prefer the design that minimizes the total concepts a maintainer must hold in mind while preserving the repository's intended behavior and boundaries

Evaluate simplification across these dimensions:

- **DRY**: one authoritative implementation for the same rule, calculation, constant, type, state, or behavior
- **KISS**: direct solutions over unnecessary indirection, configuration, generalization, or framework-like machinery
- **High cohesion**: behavior lives with the concept or subsystem that owns it
- **Loose coupling**: modules depend on narrow, intentional contracts rather than each other's internals
- **Clear ownership**: every behavior has an obvious authoritative home
- **Low fragmentation**: closely related logic is not scattered across needless files, helpers, or layers
- **Low incidental complexity**: temporary state, branching, wrappers, conversions, and special cases are kept only when they serve real behavior

## Operating Modes

### Focused Mode

Use during or after a specific implementation when the changed area contains avoidable complexity

Stay close to the task and changed code. Small directly related cleanup is appropriate when it reduces the complexity of the implementation being delivered

Do not broaden a feature or bug-fix task into a repository-wide refactor unless the task explicitly allows it

### Proactive Audit Mode

Use when the task explicitly asks to find and perform code-quality, cleanup, architectural, DRY, KISS, cohesion, or simplification work

Survey the repository before selecting a target, then choose one bounded, high-confidence hotspot where simplification produces a clear structural improvement

Prefer candidates that are:

- High leverage for future maintenance or changes
- Clearly supported by repository evidence
- Behavior-preserving
- Small enough to verify thoroughly
- Stronger than cosmetic renaming or formatting churn

Do not manufacture a refactor merely to produce a diff. If no safe improvement exists in the inspected area, inspect another plausible hotspot rather than forcing a questionable change

## Repository Authority Comes First

Before simplifying, discover and follow the current repository's authoritative guidance

Inspect as applicable:

- `AGENTS.md`, `CLAUDE.md`, or equivalent agent guidance
- Architecture and ownership documentation
- Repository-local skills
- Package or workspace boundaries
- Existing tests and fixtures
- Validation, formatting, linting, typechecking, and build commands
- Similar nearby implementations
- Recent history when it explains an otherwise surprising design

Project-specific rules override generic preferences in this skill

Do not assume a language, framework, package manager, file layout, test runner, or architecture

## Simplification Workflow

### 1. Understand Before Changing

For the candidate area, determine:

- What behavior or concept is owned here
- Who calls it and what it calls
- What inputs, outputs, side effects, ordering, and error behavior are observable
- Which tests or fixtures define the supported behavior
- Which repository boundary should own the behavior
- Why the current structure may exist

Do not remove or relocate a structure until you understand what responsibility it serves

### 2. Identify Concrete Complexity

Look for evidence such as:

- Duplicate functions, calculations, constants, types, state, tests, or content
- Near-duplicate implementations that differ only parametrically
- Multiple sources of truth for one concept
- Deep or repetitive control flow
- Repeated conditionals on the same state or shape
- Functions with multiple unrelated responsibilities
- Large modules containing unrelated domains
- Tiny modules or helpers that split one cohesive concept without creating a meaningful boundary
- Pass-through wrappers or forwarding layers that add no policy, validation, translation, or ownership value
- Abstractions with only one real use case and no current need for generalization
- Configuration replacing a simpler convention
- Stored state that can be safely derived
- Feature-specific logic in generic/shared modules
- Circular, bidirectional, or overly broad dependencies
- Dead or superseded code
- Comments required only because the code structure obscures intent

Treat size thresholds only as investigation signals. A small file can have excellent cohesion and a large file can represent one clear concept

### 3. Define the Better Ownership Model

Before editing, state the intended simplification in structural terms

Examples:

- Replace two calculations with one authoritative calculation and migrate all callers
- Move feature-specific policy from a shared utility into the feature that owns it
- Merge fragmented helpers into the module that owns their shared concept
- Split unrelated responsibilities into separate owners
- Remove a pass-through abstraction and call the authoritative implementation directly
- Collapse duplicated branches into one explicit flow
- Replace stored synchronization state with a derived value
- Delete a superseded implementation after migrating every caller

Prefer removing moving pieces over redistributing the same complexity

### 4. Choose the Simplest Complete Change

Ask:

- Can the problem be solved by improving an existing owner rather than adding a new layer
- Can a branch, wrapper, state variable, adapter, or configuration option disappear entirely
- Can callers use the authoritative API directly
- Can two concepts become one without hiding meaningful differences
- Can a dependency direction become simpler
- Can related behavior be colocated without creating a kitchen-sink module

Do not generalize merely to consolidate code. Three obvious lines can be better than one configurable abstraction that introduces a new concept

### 5. Apply the Refactor Directly

Make the target structure the real structure

- Update all affected callers, imports, exports, references, and tests
- Remove superseded implementations when repository policy allows it
- Avoid leaving parallel old/new paths merely to reduce migration churn
- Do not add compatibility shims unless backwards compatibility is an explicit supported requirement
- Keep abstractions only when they provide a real boundary, policy, translation, validation, reuse, or test seam
- Preserve unrelated concurrent work

When compatibility is explicitly required, preserve the supported contract using the least complex mechanism that satisfies the repository's policy

### 6. Preserve Behavior

For a simplification-only task, preserve:

- Inputs and outputs
- User-visible behavior
- Side effects and their required ordering
- Error behavior
- Persistence and serialization contracts
- Public interfaces that are explicitly supported
- Performance characteristics where they are part of the contract

Structural tests may need import or ownership updates after a move, but do not weaken behavioral assertions to make the refactor pass

If behavior must change, treat that as separate feature or bug-fix work unless the task explicitly includes it

### 7. Verify the Result

Run the repository's actual documented checks relevant to the change

Use targeted validation while iterating, then broader required validation before completion

Evidence may include:

- Focused unit or integration tests
- Typechecking, linting, formatting, or static analysis
- Build validation
- Runtime or end-to-end verification
- Dependency or boundary checks
- Before/after call-site or ownership comparison
- Dead-code checks after consolidation or deletion
- Performance tests when the affected path is performance-sensitive

Never weaken tests, thresholds, lint rules, architecture rules, or validation merely to make a simplification pass

## Before/After Test

A refactor is not complete until the resulting structure is demonstrably simpler

Compare before and after:

- How many authoritative places define the behavior
- How many concepts must be understood to change it
- How many modules must coordinate
- How many branches or special cases exist
- How many layers a caller crosses
- Whether ownership is more obvious
- Whether duplication was actually removed rather than moved
- Whether the new structure matches repository conventions better

If the same complexity still exists under new names or in different files, the refactor only relocated complexity

## Right-Sized Files and Modules

Do not optimize for file count

Split when a file contains responsibilities with different reasons to change or different ownership

Merge when multiple files only fragment one cohesive concept and the separation adds navigation or indirection without a useful boundary

Keep separate when the boundary improves ownership, testing, dependency direction, reuse, or comprehension

The target is cohesive modules with clear responsibilities, not uniformly small files

## Abstraction Rules

Every abstraction should earn its existence

Keep an abstraction when it clearly provides one or more of:

- A stable ownership boundary
- Meaningful reuse across genuinely distinct consumers
- Policy or invariant enforcement
- Input/output translation
- Isolation from an external dependency
- A useful testing seam that cannot be achieved more simply

Question an abstraction when it primarily provides:

- A different name for the same call
- One implementation behind a factory or strategy
- Configuration for a behavior that does not vary
- A wrapper around one caller and one callee
- A generic framework for a single concrete case
- A future extension point with no current requirement

## Coupling Rules

Prefer dependencies that flow toward authoritative owners

Watch for:

- Shared modules importing feature-specific code
- UI or presentation layers owning domain rules
- Lower-level modules depending on higher-level orchestration
- Cross-workspace access to internal implementation details
- Circular dependencies
- Broad utility modules that become accidental dependency hubs
- Callers that need knowledge of another module's internal state shape

Reduce coupling by clarifying ownership first. Do not automatically add interfaces, facades, event buses, or dependency-injection layers because they can increase conceptual complexity

## Dead Code and Legacy Paths

Delete code only when repository evidence establishes that it is unused, superseded, or no longer supported

When removing a path:

- Find all call sites and references
- Migrate supported callers first
- Remove the old path rather than leaving a pass-through shell when compatibility is not required
- Remove obsolete tests, fixtures, exports, comments, and documentation tied only to the deleted path
- Re-run dead-code and repository validation where available

If support status is genuinely ambiguous, inspect authoritative requirements or history before deleting

## Common Failure Modes

- Fewer lines but denser, harder-to-read logic
- More helper functions without fewer concepts
- Moving duplicated logic into a new layer while preserving the duplicates
- Splitting files until related behavior is harder to navigate
- Merging unrelated responsibilities into a large generic module
- Replacing straightforward code with configuration or metaprogramming
- Introducing an interface solely to claim lower coupling
- Preserving old and new APIs indefinitely after an internal migration
- Changing behavior while calling the work a refactor
- Simplifying only the happy path while making edge cases less explicit
- Adding a generic utility instead of fixing the existing authoritative owner
- Creating a new pattern that conflicts with neighboring code

## Rationalizations to Reject

| Rationalization | Response |
|---|---|
| "Fewer lines means simpler" | Measure comprehension and concept count, not line count |
| "More files means cleaner architecture" | Separate only when the boundary has value |
| "One big file means poor design" | Split by responsibility and ownership, not size alone |
| "This wrapper might be useful later" | Keep abstractions for current value, not hypothetical futures |
| "A shared utility avoids duplication" | Only if the shared location is the correct owner and does not create feature leakage |
| "I'll leave the old path for safety" | Preserve it only when backwards compatibility is actually required |
| "The tests pass, so the refactor is safe" | Tests are evidence, not proof of architecture, ownership, or uncovered behavior |
| "I can clean up nearby code too" | Stay focused unless the task explicitly requests proactive cleanup |

## Completion Checklist

- Supported behavior is preserved
- The authoritative owner is clearer
- Duplicate or parallel implementations in scope are removed
- The result follows DRY and KISS without premature abstraction
- Cohesion is stronger and coupling is no worse
- Complexity was removed rather than relocated
- Files and modules are organized by responsibility rather than arbitrary size targets
- No unnecessary compatibility shim, wrapper, state, configuration, or abstraction was added
- Callers, imports, exports, tests, docs, and references are updated
- Repository-specific validation was discovered and run
- Tests and quality thresholds were not weakened
- The final structure is easier to understand and change than the original

## Attribution

Inspired by the `code-simplification` workflow in Addy Osmani's `agent-skills` project and adapted for repository-agnostic, user-level Codex use across autonomous and interactive coding workflows
