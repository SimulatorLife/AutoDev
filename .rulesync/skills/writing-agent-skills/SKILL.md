---
name: writing-agent-skills
description: Design, write, revise, and validate reusable AI agent skills. Use when creating a new SKILL.md, improving an existing skill, deciding whether guidance belongs in a skill, or testing whether a skill triggers correctly and changes agent behavior as intended.
targets: []
---

# Writing Agent Skills

Create the smallest reusable skill that reliably produces the intended agent behavior.

## Principles

- Start from desired behavior, not prose
- Prefer observed failures over speculative rules
- Keep instructions proportional to task complexity and risk
- Separate reusable judgment from deterministic mechanics
- Keep core instructions concise; load details, tools, and assets only when relevant
- Test both behavior and triggering
- Optimize for portability; do not assume a specific agent, CLI, subagent system, or test harness unless the target environment requires it
- Add constraints only when they prevent a real failure or encode a real requirement

## 1. Decide whether this should be a skill

Use a skill when the guidance is:

- Reusable across multiple tasks
- Procedural or judgment-heavy
- Important enough that relying on the model's default behavior is unreliable
- Better expressed as contextual instructions than as deterministic tooling

Prefer another mechanism when:

- A linter, formatter, schema, type system, test, or script can enforce the rule deterministically
- The rule is repository-wide context that should always be present rather than conditionally loaded
- The content is merely reference documentation with no meaningful procedure or decision-making
- The behavior already works reliably without extra guidance

If a deterministic check can replace an instruction, prefer the check.

## 2. Define the target before writing

Write down:

1. **Trigger** - when the skill should be used
2. **Outcome** - what successful use produces
3. **Critical behavior** - decisions or steps the agent must perform
4. **Failure modes** - ways an unassisted agent is likely to fail
5. **Non-goals** - nearby tasks the skill should not absorb

Use concrete examples wherever possible.

For factual or domain-specific skills, identify authoritative sources and confirm that guidance is current before encoding it.

## 3. Baseline first when behavior matters

For simple formatting or reference skills, a baseline test may be unnecessary.

For procedural, safety-sensitive, high-impact, or frequently misapplied skills:

1. Run one or more representative tasks **without** the skill
2. Record the actual mistakes, omissions, or rationalizations
3. Write guidance that addresses those observed failures
4. Avoid adding rules for failures that have not occurred and are not clearly required

The goal is not maximal instruction. The goal is the minimum instruction that changes behavior reliably.

## 4. Write the skill

### Frontmatter

At minimum include:

```yaml
---
name: concise-skill-name
description: What the skill does and when the agent should use it.
---
```

The description is part of the routing mechanism. Make it specific enough to distinguish both:

- Positive triggers that should load the skill
- Near-miss tasks that should not

Include likely user terminology when it improves discovery.

Target a description length of 150–400 characters.

### Body

Prefer this order when applicable:

1. Goal or governing principle
2. Decision criteria
3. Step-by-step workflow
4. Important constraints and gotchas
5. Validation or completion criteria

Write instructions as actions and decisions, not essays.

Prefer:

- Short ordered workflows
- Explicit decision rules
- Concrete correct/incorrect examples where ambiguity is likely
- Defaults that cover the common case
- Small gotcha sections based on observed mistakes
- Lists over paragraphs

Avoid:

- Explaining concepts the model already knows
- Repeating the same rule in multiple sections
- Long motivational prose
- Large option matrices without a recommended default
- Rigid procedures when judgment is actually required
- Environment-specific commands unless the skill is environment-specific

## 5. Engineer reliable behavior beyond prose

Treat complex skills as harness extensions, not saved prompts. Use mechanisms that make critical behavior repeatable, observable, and enforceable rather than relying on prose the model may ignore.

Keep core instructions focused. Put optional detail in `references/`, deterministic or repeated work in `scripts/`, and templates in `assets/`. Create auxiliary files only when they improve clarity, and keep references shallow and discoverable. For cohesive multi-command skills, route selectively rather than loading everything.

Apply the following nine patterns where observed failures or meaningful compatibility requirements justify them.

### 1. Make them argue

*Useful for: code review, security audits, architecture reviews, design critique, and ranking.*

Agents tend to favor their own output. Asking the same agent to produce and judge work in one context invites shallow reviews; stronger instructions to “be objective” rarely solve this.

Use **independent, complementary reviewers**. For example, a qualitative reviewer assesses architecture, clarity, usability, or design without seeing static-analysis results. A deterministic reviewer independently runs tests, linters, accessibility checks, or other reproducible checks and gathers evidence.

Showing detector output to the qualitative reviewer first creates two biases:

- **Noisy detection:** Minor or false-positive findings overshadow sound work.
- **Silent detection:** An empty report encourages approval of work with qualitative flaws.

A coordinating agent should **reconcile and prioritize** the two assessments, not concatenate them. Address overlaps, contradictions, and differing severity.

**Portability:** Sub-agent delegation and permissions vary by harness. Check capability and authorization; request permission or use a defined fallback rather than silently skipping independent review.

### 2. Force divergence

*Useful for: naming, branding, design exploration, ideation, and breaking boilerplate.*

Banning a frequent model choice often produces its next-most-frequent choice, not an original one. Denylists shift defaults rather than escape them.

Three increasingly involved methods:

1. **Discard obvious choices:** Generate the top three predictable options, reject them, and explore alternatives.
2. **Generate, then judge independently:** Produce a broad pool (e.g., 50 candidates), then let a blind reviewer select the five most distinctive and appropriate.
3. **Inject external seeds:** Use a dataset, reproducible random seed, or domain-specific generator to reach options the model would not initiate. For example, `palette.mjs --seed 8f2a` can supply reproducible starting colors.

Combine these when needed: seed, generate, discard defaults, independently rank. **Divergence is a means, not a quality metric**; choices must still fit the requirements.

### 3. Route like a frontier model

*Useful for: multi-command skills, conditional workflows, and model-specific guidance.*

A monolithic `SKILL.md` containing every procedure and exception wastes context and increases conflicting instructions. Separate skills work when capabilities are independent; for a cohesive toolkit, use **internal routing**.

Keep `SKILL.md` as a lightweight entrypoint that selects task-specific references:

- “Polish this interface” → `references/polish.md`
- “Review this component” → `references/review.md`
- “Migrate this project” → `references/migration.md`
- Platform-specific behavior → load the appropriate adapter only when applicable

```text
skill/
├── SKILL.md
├── references/
│   ├── polish.md
│   ├── review.md
│   └── migration.md
└── scripts/
    ├── inspect-context.mjs
    └── validate.mjs
```

Each reference owns its inputs, tools, steps, and acceptance criteria. Load the **smallest sufficient set** rather than every command's documentation. Avoid needless fragmentation, too.

### 4. Give them memory

*Useful for: resumable workflows, audits, migrations, and find-then-fix tasks.*

A review that ends with its conversation loses its findings. Persist **structured, target-specific snapshots** so later commands or sessions can continue the work:

- `/review` writes findings, severity, evidence, score, and timestamp.
- `/fix` reads the latest applicable snapshot as its prioritized backlog.

Example Markdown with frontmatter:

```markdown
---
target: src/components/Checkout.tsx
score: 72
created_at: 2026-01-15T14:30:00Z
---

## P1
- Submission can occur before validation finishes.

## P2
- Error text is not associated with its input.
```

Use a **stable target key** derived from the normalized file path or another canonical identifier, not the user's wording. This lets teammates and new sessions find the same record and track progress (e.g., scores 64 → 72 → 85).

Specify how snapshots are updated, shared, and invalidated. Findings based on outdated source files must not silently remain authoritative.

### 5. Scripts that talk back

*Useful for: dynamic onboarding, dependency checks, environment setup, and repository-state gates.*

Models may skim or compress long instructions, especially conditional branches. At consequential decision points, **run a script that inspects the environment and prints the next action**.

For example:

1. `SKILL.md` directs the agent to run `node scripts/inspect-context.mjs`.
2. The script checks required files, configuration, and tools.
3. If something is missing, it reports `MISSING_PROJECT_CONTEXT` and the initialization step.
4. The agent resolves the prerequisite and reruns the check before proceeding.
5. On success, the script supplies the context needed for the task.

Use machine-readable statuses, meaningful exit codes, and concise instructions. Distinguish recoverable prerequisites from hard failures. The script's output should determine the next step, rather than a generic prompt asking the model to guess.

**Trade-off:** Dynamic output may reduce prompt-cache reuse and add context cost. Reserve it for state-dependent decisions.

### 6. Hooks that fight back

*Useful for: formatting, linting, secret detection, accessibility, and policy checks.*

An agent may make problematic edits without invoking the relevant skill. **Event hooks** can run checks after edits or tool calls whether or not a skill was requested, where the harness supports and the user authorizes them.

A scoped post-edit hook:

1. Receives the file-edit event.
2. Ignores excluded paths and irrelevant file types.
3. Runs deterministic checks on relevant files.
4. Returns actionable findings to the agent.
5. Prompts correction and revalidation before completion.

For example, a frontend edit introduces an inaccessible control; the hook catches it even during an unrelated feature task.

**Risks:** Hooks can create false positives, repeated rewrites, latency, and token costs. Keep them precise, fast, and configurable, with explicit suppression mechanisms. File scans cannot detect every runtime-generated UI issue; inspect the rendered application when needed. Hook events, permission rules, and feedback formats differ across harnesses.

### 7. Live-wire the browser

*Useful for: visual polish, dashboards, 3D scenes, game tuning, and complex interfaces.*

Detailed visual feedback is hard to express in chat. A browser overlay lets the user select an element or annotate a change directly in the running application, then pass that context to the agent.

A typical loop:

1. A local development server injects an element picker or inspection overlay.
2. The agent starts a blocking poll or supported event listener.
3. The user selects an element and submits feedback.
4. The listener returns the target, metadata, and requested change.
5. The agent edits the source; the browser reloads or hot-updates for inspection.

Implementation may use local HTTP endpoints, server-sent events or polling, and browser storage to survive reloads. **Agent lifecycle is the hard part**: some harnesses resume after background jobs; others require blocking commands. Account for permissions, wake-up behavior, and session state.

The pattern also applies to interactive onboarding, diagram critique, visual planning, and data exploration.

### 8. Compile to every harness

*Useful for: multi-IDE skills, shared toolchains, and broad model support.*

Portability fails along two axes:

- **Harness:** Agent spawning and permissions, user-question APIs, background wake-up, built-in tools, hooks, file locations, and command syntax.
- **Model:** Default coding or design habits, response to conflicting rules, tendency to infer requirements or skip steps, and model-specific biases.

Adding every model's workaround to one generic prompt can degrade the others. For complex skills, **treat the skill as source code**:

1. Maintain one canonical definition (e.g., `SKILL.src.md`).
2. Compile abstract actions such as “ask the user” or “spawn a reviewer” into each harness's supported tools.
3. Generate runtime-specific commands, paths, hook configuration, and permission guidance.
4. Apply model-specific corrections only where relevant.
5. Test each generated build independently.

```text
src/
  SKILL.src.md
  references/
  scripts/
adapters/
  harness-a/
  harness-b/
dist/
  harness-a/
  harness-b/
```

A short, self-contained skill may need no compilation. Add this machinery only when real compatibility differences justify it.

### 9. Design for the weakest model

*Useful for: lower-cost models, long workflows, CI gates, and wide compatibility.*

Less capable models more often misread ambiguity, compress long procedures, skip mandatory steps, and ignore relevant context. Stronger models may recover, but that does not make a skill robust.

Design for the **least capable model you intend to support**:

- Define concrete inputs, outputs, and acceptance criteria.
- Separate work into explicit phases with observable results.
- Check prerequisites before dependent steps.
- Validate critical work with commands, tests, or other deterministic checks.
- Specify recovery behavior for missing requirements or failed checks.

For example, an implementation workflow can gate **inspect → confirm approach → implement → test → report**. Merely saying “do not skip tests” is weaker than requiring the test command, checking its exit status, and reporting unresolved failures.

> If a critical gate can be skipped without detection, it eventually will be.

Keep gates proportional to risk; the goal is reliability, not bureaucracy.
## 6. Validate structure

Before behavioral testing, check:

- Frontmatter is valid
- `name` is concise and stable
- `description` says both what the skill does and when to use it
- Referenced files actually exist
- Instructions do not contradict each other
- Required inputs and outputs are clear
- Environment assumptions are explicit
- The skill contains no obsolete facts or unnecessary duplicated guidance

Use an available validator when one exists. Do not make a specific validator a portability requirement.

## 7. Test behavior

Choose effort based on the skill's importance.

### Lightweight

Use for straightforward skills:

- Test 2-3 representative prompts
- Confirm the agent follows the intended workflow
- Confirm outputs satisfy explicit acceptance criteria

### Comparative

Use for important behavioral skills:

- Run the same prompts with and without the skill
- Compare whether the skill fixes the targeted baseline failures
- Prefer observable assertions over subjective impressions

Useful assertions include:

- Required action was performed
- Forbidden action was avoided
- Required artifact or section exists
- Correct source or tool was used
- Output satisfies a schema or test
- Agent made the intended decision at a branch point

Do not add assertions that both versions pass equally; they provide little evidence that the skill helps.

Run repeated trials when model variance could affect the conclusion.

## 8. Test triggering separately

A good skill must both **work when loaded** and **load at the right time**.

Create two small sets:

### Should trigger

Include:

- Direct requests
- Natural paraphrases
- Requests that imply the workflow without naming the skill

### Should not trigger

Include:

- Nearby but distinct tasks
- Ambiguous wording
- Tasks sharing vocabulary but not intent

Revise the description when false positives or false negatives appear.

Do not stuff the description with every conceivable keyword.

## 9. Refine from evidence

When a test fails:

1. Identify the specific decision or behavior that failed
2. Determine whether the cause is missing guidance, ambiguous guidance, bad ordering, or a missing deterministic check
3. Make the smallest change that addresses it
4. Re-run the failing case
5. Re-run nearby passing cases to avoid regressions

When agents invent recurring excuses or shortcuts, add a concise gotcha or explicit decision rule addressing that exact pattern.

Do not accumulate defensive instructions indefinitely. Remove rules that no longer earn their complexity.

## 10. Review for quality

Before finishing, ask:

- Is this actually a skill rather than a rule better enforced elsewhere?
- Does every major instruction affect behavior or encode a real requirement?
- Could any section be shorter without losing reliability?
- Are important decisions explicit?
- Are defaults clear?
- Are examples concrete where ambiguity exists?
- Are factual claims current and sourced appropriately?
- Does the skill avoid unnecessary vendor-specific assumptions?
- Did testing cover behavior as well as triggering?
- Did revisions target observed failures rather than imagined ones?

## Completion criteria

A skill is ready when:

- Its purpose and trigger are unambiguous
- Its workflow is concise enough to use in context
- Structural validation passes
- Representative tasks produce the intended behavior
- Important baseline failures are measurably reduced
- Positive and negative trigger cases behave correctly
- No known instruction is redundant, contradictory, stale, or better enforced deterministically

## Editing an existing skill

When revising an existing skill:

1. Preserve behavior that already works
2. Identify the concrete problem being solved
3. Compare against the previous version, not only against no skill
4. Prefer local edits over wholesale rewrites
5. Re-test previous success cases for regressions
6. Remove superseded guidance instead of layering new instructions on top

The best skill is not the longest or strictest one. It is the smallest set of reusable instructions that reliably changes the agent's behavior in the intended situations.
