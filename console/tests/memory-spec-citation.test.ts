import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import ts from "typescript";

import { MemoryCohortsView } from "../src/features/memory/MemoryCohortsView.ts";
import type { MemoryListScope } from "../src/features/memory/memory-list-url.ts";

/**
 * Operator-visible memory copy must not cite a spec section that does not exist.
 *
 * The cohorts callout read "§10/§14 Non-inferential cohort policy". The document
 * it gestures at, `docs/memory-target-state.md`, ends at §13 — there is no §14 —
 * so the one piece of the sentence meant to establish where the policy comes
 * from pointed nowhere. That is worse than having no citation: an operator who
 * checks finds nothing, and the sentence keeps the borrowed authority of the
 * check they did not make.
 *
 * The sweep below walks string literals rather than raw source text, which is
 * the only way to get this right. A grep for `§N` over the source also matches
 * the comment explaining this defect — and that comment has to quote the bad
 * citation to be worth anything. Scanning the AST keeps the rule about copy an
 * operator reads and leaves prose about the copy alone.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_SRC = path.resolve(HERE, "../src");
const SPEC_PATH = path.resolve(HERE, "../../docs/memory-target-state.md");

/** Section numbers the spec actually defines, from its `## N. Title` headings. */
function specSections(): Set<string> {
  const headings = readFileSync(SPEC_PATH, "utf8").matchAll(/^## (\d+)\./gmu);
  return new Set(Array.from(headings, (match) => match[1] as string));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return /\.tsx?$/u.test(entry) ? [full] : [];
  });
}

/**
 * Every string an operator could be shown, and nothing else.
 *
 * Comments are not visited at all, and neither are identifiers, numbers or
 * operators — a § in a comment is a note to the next reader, a § in a literal
 * is a promise to the current one.
 */
function copiedStrings(file: string): string[] {
  const parsed = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      // Only the literal spans: a `${…}` interpolation's expression is code, and
      // its own nested literals are picked up by the walk on its own terms.
      found.push(node.head.text);
      for (const span of node.templateSpans) {
        found.push(span.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);

  return found;
}

function listScope(): MemoryListScope {
  return {
    tab: "cohorts",
    workspaceId: "SimulatorLife/AutoDev",
    offset: 0,
    limit: 25
  } as MemoryListScope;
}

function renderCohorts(): string {
  return renderToStaticMarkup(
    React.createElement(MemoryCohortsView, {
      sessionCohorts: {
        schema: "autodev-memory-session-outcome-cohorts-v1",
        cells: [
          { memoryMode: "jit", outcomeKind: "success", sessionCount: 3 },
          { memoryMode: "jit", outcomeKind: null, sessionCount: 2 }
        ],
        sessionCount: 5,
        reportedSessionCount: 3,
        unreportedSessionCount: 2,
        conflictingOutcomeSessionCount: 0,
        mixedModeSessionCount: 0,
        workspaceId: "SimulatorLife/AutoDev",
        repositoryId: "simulatorlife/autodev",
        occurredFrom: "2026-10-01T00:00:00.000Z",
        occurredUntil: "2026-10-08T00:00:00.000Z"
      },
      useCohorts: null,
      currentWorkspaceId: "SimulatorLife/AutoDev",
      repositoryId: "simulatorlife/autodev",
      occurredFrom: "2026-10-01T00:00:00.000Z",
      occurredUntil: "2026-10-08T00:00:00.000Z",
      listScope: listScope()
    })
  );
}

test("every spec section cited by Console copy exists", () => {
  const defined = specSections();
  const dangling: string[] = [];

  for (const file of sourceFiles(CONSOLE_SRC)) {
    const relative = path.relative(path.resolve(HERE, ".."), file);
    for (const literal of copiedStrings(file)) {
      for (const match of literal.matchAll(/§(\d+)/gu)) {
        const cited = match[1] as string;
        if (!defined.has(cited)) {
          dangling.push(`${relative} cites §${cited}`);
        }
      }
    }
  }

  assert.deepEqual(
    dangling,
    [],
    `Console copy cites spec sections that docs/memory-target-state.md does not ` +
      `define (it has ${[...defined].join(", ")}). A citation an operator ` +
      `cannot follow lends the sentence authority it never earned.`
  );
});

test("the cohort callout cites the spec, and the section it names is real", () => {
  // Non-vacuity for the sweep above, which is otherwise satisfiable by deleting
  // every citation. The callout is supposed to say where the policy comes from.
  const markup = renderCohorts();
  const cited = Array.from(
    markup.matchAll(/§(\d+)/gu),
    (match) => match[1] as string
  );

  assert.ok(
    cited.length > 0,
    "the cohort callout must cite the spec section that states the policy"
  );
  const defined = specSections();
  for (const section of cited) {
    assert.ok(
      defined.has(section),
      `the cohort callout cites §${section}, which docs/memory-target-state.md ` +
        `does not define`
    );
  }
});

test("the cohort callout states each retained non-goal the spec keeps separate", () => {
  // The citation was only half the defect. The clause beside it said outcomes
  // are "never inferred from output text", which is the separate rule about
  // model-output scanners — and it dropped the rule that actually governs this
  // table: §11 requires reporter-supplied outcomes not be inferred from
  // injection/provider telemetry, and the companion's cohort rules 3 and 8
  // withhold verified task success and causal effectiveness.
  const markup = renderCohorts();

  assert.match(
    markup,
    /single canonical reporter-supplied report/u,
    "the outcome must be described as the one canonical report for the session"
  );
  assert.match(
    markup,
    /unreported cell/u,
    "a session with no report must stay an explicit unreported cell"
  );
  assert.match(
    markup,
    /never inferred from injection or provider telemetry/u,
    "the non-inference rule must name the provenance the spec actually names"
  );
  assert.match(
    markup,
    /verified task success nor causal effectiveness/u,
    "the counts must not claim verified task success or causal effectiveness"
  );
});