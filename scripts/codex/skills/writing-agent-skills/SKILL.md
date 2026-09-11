---
name: writing-agent-skills
description: Design, write, revise, and validate reusable AI agent skills. Use when creating a new SKILL.md, improving an existing skill, deciding whether guidance belongs in a skill, or testing whether a skill triggers correctly and changes agent behavior as intended.
---

# Writing Agent Skills

Create the smallest reusable skill that reliably produces the intended agent behavior.

## Principles

- Start from desired behavior, not prose
- Prefer observed failures over speculative rules
- Keep instructions proportional to task complexity and risk
- Separate reusable judgment from deterministic mechanics
- Keep the core skill concise; move non-essential detail to references, scripts, or assets
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

## 5. Use progressive disclosure

Keep `SKILL.md` focused on the behavior needed most often.

Move content out only when that makes the skill clearer:

- `references/` for detailed documentation, examples, schemas, or domain knowledge
- `scripts/` for deterministic or repeatedly executed mechanics
- `assets/` for templates or files used in outputs

Do not create auxiliary files merely to make the skill look complete.

Keep references shallow and easy to discover from `SKILL.md`.

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
