# Testing conventions

AutoDev keeps one canonical source for every editable definition: the
`.rulesync/` tree holds the skills, commands, rules, hooks, MCP declarations,
and permissions, and `agents/prompts/`, `agents/roles/`, and `docs/` hold the
role prompts, role configuration, and the human-facing contracts. Everything
else is a projection or a test.

These conventions exist so that an ordinary content edit -- a reworded skill,
one more permission rule, a new target -- does not break a test that was only
restating that content.

## The rule

**A test asserts a contract, not a copy.**

If an assertion would fail because a canonical document was reworded, it is
restating the document rather than checking a contract, and it has to change.

The three kinds of assertion that are worth having:

- **A behavioural contract.** The code does something observable: a rule is
  enforced, a file is written with the right mode, a projection carries the
  canonical content.
- **A structural invariant.** A shape has to hold: one owner per output tree,
  no user-level skill duplicated into a folder that did not ask for it, no
  MCP server selector in a rule format that cannot express one.
- **A security invariant.** A boundary must not be crossed: the profile holds
  no MCP configuration, the permissions file is written `0600`, the helper
  resolves nothing.

## Where the expectation comes from

| The test wants to know | Read the expectation from |
| --- | --- |
| What a projection contains | The canonical `.rulesync/` source |
| Which target owns which feature | `rulesync.jsonc`, read through `tests/support/rulesync-config.ts` |
| Which files a target writes | RuleSync itself, observed by running it |
| Whether a tracked projection is current | RuleSync's own `--check` mode |
| What a helper does | A synthetic fixture the test builds |

`tests/support/rulesync-config.ts` is the one place that reads
`rulesync.jsonc`; `tests/support/skill-document.ts` is the one place that
parses skill and command frontmatter; `tests/support/playtesting-sections.ts`
is the one place that holds the review-section contract;
`tests/support/ordering.ts` is the one place that holds the comparator the
suites sort with, so a suite's expectation orders the way production does. A
suite that needs one of them imports it rather than keeping its own copy.

## Generated artifacts

A generated artifact is an output, not a fixture.

- Do not compare a generated artifact against another generated artifact.
  That proves only that the two were generated the same way; it says nothing
  about the canonical source, and it fails whenever the source moves ahead of
  one projection.
- Do not keep a generated artifact under `tests/fixtures/`. The canonical
  source is the only tracked input.
- Drift between the canonical source and a tracked projection is detected by
  RuleSync's native `--check` mode, not by a hand-written diff. The gate
  lives in `tests/rulesync-config.test.ts`, and the installer runs the same
  primitive through `generateRepositoryRulesync(root, { check: true })`.

## Writing a test against a canonical document

Prefer the structural shape over the wording.

```ts
// Brittle: breaks on a reword.
assert.match(body, /## The 8-step review procedure/);

// Better: the procedure has to exist.
assert.ok(headings(body).some((title) => /8-step review procedure/i.test(title)));
```

```ts
// Brittle: the test now owns the production inventory.
assert.deepEqual(permissions.deny, [
  { tool_name: "bash", matcher: { kind: "command", pattern: "rm -rf *" } }
]);

// Better: the projection carries the canonical deny list.
assert.deepEqual(projected, canonicalDenyPatterns(home));
```

Negative assertions are the most robust kind, because a prohibition stays
true through rewording: assert that a document does **not** name a
provider-specific tool, a parent session's global tool list, or another role's
capabilities.

When a contract is genuinely a list -- the review sections, the tool
vocabulary, the roles a skill routes to -- the list lives in exactly one
shared module and the suites import it.

## Unit tests of a transformation

A translation, a parser, or a renderer is tested with controlled inputs:

```ts
assert.deepEqual(toMcodePermissionEntry("Bash(exit 1)", home), {
  tool_name: "bash",
  matcher: { kind: "command", pattern: "exit 1" }
});
```

The input is a controlled example, not a copy of the production rule. The
test then says what the function does with it.

## What still needs a literal

Some things are contracts with the outside world and are written out on
purpose:

- a provider's file layout (`.agents/skills/`, `.github/hooks/…`);
- a protocol shape (a wire identifier, a schema version, a permission
  document's `version: 2`);
- a documented parity limit (the client that has no session-start event);
- the security rules a document has to state.

Each of these is listed in the test that owns it, with the reason it cannot
be derived.

## Suites

| Suite | Owns |
| --- | --- |
| `tests/rulesync-config.test.ts` | The canonical target state, one owner per output tree, and the tracked-projection drift gate |
| `tests/rulesync-rules.test.ts` | The shared root instructions |
| `tests/rulesync-skills.test.ts` | The canonical skill source and the projections derived from it |
| `tests/rulesync-commands.test.ts` | The canonical command catalog and its projections |
| `tests/rulesync-hooks-shadow.test.ts` | The canonical hook declarations and each client's hook file |
| `tests/rulesync-permissions-inventory.test.ts` | Who owns the permissions, and what the permission documents must contain |
| `tests/rulesync-mcp.test.ts` | The canonical MCP catalogue |
| `tests/agent-instructions.test.ts` | One instruction file, and no copies of it |

## Isolation from the operator's live state

Every Runtime and root test process loads `runtime/tests/support/isolate-autodev-state.ts` first (the `test` scripts pass it with `--import`). It gives the process its own `CODEX_HOME` and router state file, drops the live router bearer token, keeps Keychain access off, and removes every inherited `OTEL_EXPORTER_OTLP_*` variable. The last one matters because an agent session that runs the suite inherits the live OpenLIT receiver's endpoint and credential: a test that drives a real telemetry producer would otherwise export its fixtures into the operator's Usage history, where they read as agent output. A test that exercises export names its own endpoint or installs an in-memory exporter; none removes these variables itself. Run single files through the same preload (`node --import ./runtime/tests/support/isolate-autodev-state.ts --test <file>`).

## Changing the canonical source

1. Edit the source under `.rulesync/`.
2. Regenerate the projections: `node_modules/.bin/rulesync generate --config
   rulesync.jsonc`.
3. Run the RuleSync suites: `node --test tests/rulesync-*.test.ts`.

Step 2 is what keeps the tracked projections current, and step 3 is what
proves it. Neither step involves editing a test.
