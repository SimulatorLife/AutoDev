import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const skillPath = new URL(
  ".rulesync/skills/opentelemetry/SKILL.md",
  repositoryRoot
);
const targetStatePath = new URL(
  "docs/autodev-console-target-state.md",
  repositoryRoot
);
const materializerPath = new URL(
  "src/platform/install-materializer.ts",
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

test("opentelemetry skill is a repository-only canonical skill", () => {
  assert.equal(lstatSync(skillPath).isSymbolicLink(), false);
  const content = readFileSync(skillPath, "utf8");
  const [front, body] = splitFrontmatter(content);

  assert.match(front, /^name: opentelemetry$/mu);
  assert.match(
    front,
    /^description: Defines OpenTelemetry architecture, ownership, semantic-convention, instrumentation, and telemetry-quality rules for AutoDev\. Use when implementing, modifying, debugging, reviewing, or organizing OTLP ingestion, Collector configuration, telemetry attributes, traces, metrics, logs, agent\/tool\/skill\/MCP observability, telemetry attribution, or related dashboard\/status data$/mu
  );
  assert.doesNotMatch(front, /^targets:/mu);

  // AutoDev-only development skill: must never be in user-level SKILLS.
  const materializerContent = readFileSync(materializerPath, "utf8");
  const skillsMatch = /export const SKILLS = \[(.*?)\]/su.exec(
    materializerContent
  );
  assert.ok(skillsMatch?.[1] !== undefined);
  assert.doesNotMatch(skillsMatch[1], /"opentelemetry"/);

  // Required reusable OTel sections and project-specific source-of-truth pointer.
  assert.match(body, /^# OpenTelemetry$/mu);
  assert.match(body, /^## AutoDev target-state pointer$/mu);
  assert.match(body, /^## Ownership boundaries$/mu);
  assert.match(body, /^## Semantic conventions$/mu);
  assert.match(body, /^## Attribute placement$/mu);
  assert.match(body, /^## Instrumentation$/mu);
  assert.match(body, /^## Telemetry quality$/mu);
  assert.match(body, /^## Collector rules$/mu);
  assert.match(body, /^## Review checklist$/mu);
  assert.match(body, /^## Architectural preference$/mu);
  assert.match(body, /docs\/observability-target-state\.md/);

  // The canonical target document carries the maintenance rule future agents need.
  const targetState = readFileSync(targetStatePath, "utf8");
  assert.match(
    targetState,
    /single living source of truth for AutoDev's OpenLIT fork, observability architecture/
  );
  assert.match(targetState, /update it in the same change\/PR/);
  assert.match(targetState, /upstreaming is optional and never a prerequisite/);

  // Project-specific architecture must not regress to the old local aggregator target.
  assert.match(body, /OpenLIT first-party OTLP receiver/);
  assert.match(body, /authenticated AutoDev Control API/);
  assert.doesNotMatch(
    body,
    /producer → OTel\/OTLP → Collector → AutoDev semantic aggregation/
  );
  assert.doesNotMatch(
    body,
    /Keep \*\*stateful\/domain-specific interpretation\*\* in AutoDev/
  );
  assert.match(
    body,
    /Prefer established OpenTelemetry semantic conventions, including `gen_ai\.\*`/
  );
  assert.match(
    body,
    /Never fabricate an attribute because a schema has a field/
  );
});
