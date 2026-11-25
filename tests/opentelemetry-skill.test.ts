import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userLevelSkills } from "@simulatorlife/autodev-runtime/platform/user-level-skills";

const repositoryRoot = new URL("../", import.meta.url);
const skillPath = new URL(
  ".rulesync/skills/opentelemetry/SKILL.md",
  repositoryRoot
);
const targetStatePath = new URL(
  "docs/autodev-console-target-state.md",
  repositoryRoot
);

function splitFrontmatter(text: string): [string, string] {
  const match = /^---\n(?<front>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u.exec(text);
  assert.ok(
    match?.groups?.front !== undefined && match.groups.body !== undefined,
    "missing skill frontmatter"
  );
  return [match.groups.front, match.groups.body.replaceAll(/^\n+|\n+$/gu, "")];
}

test("opentelemetry skill is project-independent and retains its current repository projection", () => {
  assert.equal(lstatSync(skillPath).isSymbolicLink(), false);
  const content = readFileSync(skillPath, "utf8");
  const [front, body] = splitFrontmatter(content);

  assert.match(front, /^name: opentelemetry$/mu);
  assert.match(
    front,
    /^description: .*OpenTelemetry.*instrumentation.*OTLP.*telemetry quality.*$/mu
  );
  assert.doesNotMatch(front, /^targets:/mu);

  // Content portability is independent of the current repository-only projection.
  assert.ok(
    !userLevelSkills(
      fileURLToPath(new URL(".rulesync/skills", repositoryRoot))
    ).includes("opentelemetry")
  );

  // Required reusable OTel sections and project-specific source-of-truth pointer.
  assert.match(body, /^# OpenTelemetry$/mu);
  assert.match(body, /^## Project architecture and authority$/mu);
  assert.match(body, /^## Ownership boundaries$/mu);
  assert.match(body, /^## Semantic conventions$/mu);
  assert.match(body, /^## Attribute placement$/mu);
  assert.match(body, /^## Instrumentation$/mu);
  assert.match(body, /^## Telemetry quality$/mu);
  assert.match(body, /^## Collector rules$/mu);
  assert.match(body, /^## Review checklist$/mu);
  assert.match(body, /^## Architectural preference$/mu);
  assert.match(
    body,
    /canonical observability or architecture target-state document, if one exists/
  );
  assert.match(body, /If no canonical document exists/);
  assert.doesNotMatch(content, /AutoDev|OpenLIT/i);

  assert.match(body, /configured receiver/);
  assert.match(body, /authorized control plane|authorized owner/);
  assert.match(
    body,
    /Prefer established OpenTelemetry semantic conventions, including `gen_ai\.\*`/
  );
  assert.match(
    body,
    /Never fabricate an attribute because a schema has a field/
  );
});

test("AutoDev's target-state document owns its concrete observability architecture", () => {
  const targetState = readFileSync(targetStatePath, "utf8");
  const authorityLine = targetState
    .split("\n")
    .find((line) => line.startsWith("> **Authority:**"));
  assert.ok(authorityLine, "target doc must declare its authority");
  assert.match(authorityLine, /single living source of truth/i);
  assert.match(authorityLine, /OpenLIT.*fork/i);
  assert.match(authorityLine, /observability/i);
  const canonicalContract = targetState
    .split(/^## 1\. Canonical-document contract\s*$/mu)[1]
    ?.split(/^##\s/mu)[0];
  assert.ok(canonicalContract, "target doc must define its canonical contract");
  assert.match(canonicalContract, /must update this document/i);
  assert.match(canonicalContract, /same PR/i);
  const openLitStrategy = targetState
    .split(/^## 12\. OpenLIT maintenance strategy\s*$/mu)[1]
    ?.split(/^##\s/mu)[0];
  assert.ok(
    openLitStrategy,
    "target doc must define OpenLIT maintenance policy"
  );
  assert.match(openLitStrategy, /upstream/i);
  assert.match(openLitStrategy, /must\s+(?:not|never)\s+block AutoDev/i);

  // Project-specific architecture must not regress to the old local aggregator target.
  assert.match(targetState, /OpenLIT first-party OTLP receiver/);
  assert.match(targetState, /authenticated Control API/);
});
