# The Dark Arts of Skill Engineering

Creating an agent skill is easy; making it reliable across projects, prompts, models, harnesses, and operating systems is not. A short `SKILL.md` may work in personal tests but fail under unfamiliar conditions.

Treat a skill as a **harness extension**, not a saved prompt. Its instructions, scripts, tools, state, hooks, and checks should close a real capability gap: gathering context before acting, challenging default choices, preserving findings, or verifying edits. The objective is to make behavior the model might skip **repeatable, observable, and enforceable**.

## Nine techniques

1. **Make them argue:** Separate reviewers and synthesize independent findings.
2. **Force divergence:** Explore beyond the model's predictable defaults.
3. **Route like a frontier model:** Load only relevant instructions.
4. **Give them memory:** Persist actionable state between sessions.
5. **Scripts that talk back:** Compute next steps from the environment.
6. **Hooks that fight back:** Validate work without requiring skill invocation.
7. **Live-wire the browser:** Turn visual interaction into agent input.
8. **Compile to every harness:** Adapt one source to multiple runtimes and models.
9. **Design for the weakest model:** Enforce critical workflow gates.

## 1. Make them argue

*Useful for: code review, security audits, architecture reviews, design critique, and ranking.*

Agents tend to favor their own output. Asking the same agent to produce and judge work in one context invites shallow reviews; stronger instructions to “be objective” rarely solve this.

Use **independent, complementary reviewers**. For example, a qualitative reviewer assesses architecture, clarity, usability, or design without seeing static-analysis results. A deterministic reviewer independently runs tests, linters, accessibility checks, or other reproducible checks and gathers evidence.

Showing detector output to the qualitative reviewer first creates two biases:

- **Noisy detection:** Minor or false-positive findings overshadow sound work.
- **Silent detection:** An empty report encourages approval of work with qualitative flaws.

A coordinating agent should **reconcile and prioritize** the two assessments, not concatenate them. Address overlaps, contradictions, and differing severity.

**Portability:** Sub-agent delegation and permissions vary by harness. Check capability and authorization; request permission or use a defined fallback rather than silently skipping independent review.

## 2. Force divergence

*Useful for: naming, branding, design exploration, ideation, and breaking boilerplate.*

Banning a frequent model choice often produces its next-most-frequent choice, not an original one. Denylists shift defaults rather than escape them.

Three increasingly involved methods:

1. **Discard obvious choices:** Generate the top three predictable options, reject them, and explore alternatives.
2. **Generate, then judge independently:** Produce a broad pool (e.g., 50 candidates), then let a blind reviewer select the five most distinctive and appropriate.
3. **Inject external seeds:** Use a dataset, reproducible random seed, or domain-specific generator to reach options the model would not initiate. For example, `palette.mjs --seed 8f2a` can supply reproducible starting colors.

Combine these when needed: seed, generate, discard defaults, independently rank. **Divergence is a means, not a quality metric**; choices must still fit the requirements.

## 3. Route like a frontier model

*Useful for: multi-command skills, conditional workflows, and model-specific guidance.*

A monolithic `SKILL.md` containing every procedure and exception wastes context and increases conflicting instructions. Separate skills work when capabilities are independent; for a cohesive toolkit, use **internal routing**.

Keep a `SKILL.md` as a lightweight entrypoint that selects task-specific references. The example below is illustrative: it names a hypothetical skill, so those files are not part of this one.

<!-- skill-example -->
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
<!-- /skill-example -->

Each reference owns its inputs, tools, steps, and acceptance criteria. Load the **smallest sufficient set** rather than every command's documentation. Avoid needless fragmentation, too.

## 4. Give them memory

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

## 5. Scripts that talk back

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

## 6. Hooks that fight back

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

## 7. Live-wire the browser

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

## 8. Compile to every harness

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

## 9. Design for the weakest model

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

## Building effective skills

Prompt wording still matters and should be evaluated, but most reliability gains come from the surrounding workflow: independent judgment, deliberate exploration, selective context, persistent state, environment-driven instructions, automatic validation, interactive feedback, runtime adaptation, and verifiable checkpoints.

A strong skill does more than describe desirable behavior. **It provides mechanisms that make that behavior difficult to omit and easy to verify.**