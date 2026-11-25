/**
The shared root instructions.

`.rulesync/rules/overview.md` is the canonical source; RuleSync's
`agentsmd` target projects it into the tracked `AGENTS.md`. The
expectations here are derived from that canonical source, so an ordinary
edit to the instructions is a change to the source and to the projection,
not to this file. Whether the tracked projection is current is RuleSync's
own drift gate, owned by tests/rulesync-config.test.ts.
*/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compareText } from "./support/ordering.ts";
import {
  readRulesyncConfig,
  targetsOwningFeature
} from "./support/rulesync-config.ts";
import { splitFrontmatter } from "./support/skill-document.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const ruleSourcePath = join(repositoryRoot, ".rulesync/rules/overview.md");
const driftWorkflowPath = join(
  repositoryRoot,
  ".github/workflows/rulesync-mcp-shadow-drift.yml"
);
const temporaryRoot = mkdtempSync(join(tmpdir(), "autodev-rulesync-rules-"));
const outputRoot = join(temporaryRoot, "rules-only");
const projectOutputRoot = join(temporaryRoot, "project");
mkdirSync(outputRoot, { recursive: true });
mkdirSync(projectOutputRoot, { recursive: true });

test.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return files.sort(compareText);
}

interface RuleFrontmatter {
  readonly root: boolean;
  readonly targets: readonly string[];
  readonly body: string;
}

const ROOT_PATTERN = /^root:[ \t]*true$/mu;
const TARGETS_PATTERN = /^targets:[ \t]*$/mu;
const TARGET_ITEM_PATTERN = /^ {2}-[ \t]*(?<value>\S.*)$/u;

/**
The canonical rule source's frontmatter and body.
*/
function readCanonicalRule(): RuleFrontmatter {
  const { front, body } = splitFrontmatter(
    readFileSync(ruleSourcePath, "utf8")
  );
  const targets: string[] = [];
  let isInsideTargets = false;
  for (const line of front.split("\n")) {
    if (TARGETS_PATTERN.test(line)) {
      isInsideTargets = true;
      continue;
    }
    if (!isInsideTargets) continue;
    const item = TARGET_ITEM_PATTERN.exec(line);
    if (!item?.groups?.value) {
      isInsideTargets = false;
      continue;
    }
    targets.push(item.groups.value.trim());
  }
  return {
    root: ROOT_PATTERN.test(front),
    targets,
    body: body.trim()
  };
}

/**
The paths a workflow trigger watches.

The workflow is read as text rather than as YAML, because the assertion is
about which paths the drift gate reacts to, not about the document's
formatting.
*/
function workflowPaths(
  workflow: string,
  trigger: "push" | "pull_request"
): string[] {
  const section = new RegExp(
    String.raw`^  ${trigger}:\n([\s\S]*?)(?=^  [a-z_]+:|^permissions:)`,
    "mu"
  ).exec(workflow)?.[1];
  assert.ok(section, `the drift workflow declares a ${trigger} trigger`);
  const matches = section.matchAll(/^ {6}- "(?<path>[^"]+)"$/gmu);
  return Array.from(matches, (match) => match.groups?.path ?? "");
}

test("RuleSync owns root instructions and targets only the shared AGENTS.md output", () => {
  const config = readRulesyncConfig(repositoryRoot);
  const ruleOwners = targetsOwningFeature(config, "rules");
  assert.ok(ruleOwners.includes("agentsmd"));

  const canonical = readCanonicalRule();
  assert.equal(canonical.root, true);
  assert.deepEqual(canonical.targets, ["agentsmd"]);
  assert.ok(canonical.body, "the canonical instruction body is present");

  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "rulesync",
      "generate",
      "--config",
      "rulesync.jsonc",
      "--features",
      "rules",
      // A run that names its features replaces the configuration's per-target
      // map with a flat selection, so the targets that own the rules feature
      // are named explicitly.
      "--targets",
      ruleOwners.join(","),
      "--output-roots",
      outputRoot,
      "--delete",
      "--silent"
    ],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 }
  );
  assert.equal(
    result.status,
    0,
    `RuleSync root-instruction generation failed:\n${result.stderr}`
  );
  assert.deepEqual(filesUnder(outputRoot), ["AGENTS.md"]);

  // RuleSync prepends a preamble of its own and projects the canonical body
  // verbatim, so the body has to be the tail of the generated instructions.
  const generated = readFileSync(join(outputRoot, "AGENTS.md"), "utf8");
  assert.match(generated, /^# /u);
  assert.ok(
    generated.trimEnd().endsWith(canonical.body),
    "the generated instructions do not end with the canonical rule body"
  );

  const workflow = readFileSync(driftWorkflowPath, "utf8");
  for (const trigger of ["push", "pull_request"] as const) {
    assert.ok(
      workflowPaths(workflow, trigger).includes("AGENTS.md"),
      `the ${trigger} trigger does not watch the tracked root instructions`
    );
  }
});

test("full project generation materializes the shared root instructions", () => {
  const canonical = readCanonicalRule();
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "rulesync",
      "generate",
      "--config",
      "rulesync.jsonc",
      "--output-roots",
      projectOutputRoot,
      "--delete",
      "--silent"
    ],
    // A full generation walks every skill, command, rule, and hook the
    // repository projects, and the RuleSync suites run side by side, so this
    // subprocess needs more room than a single projection does.
    { cwd: repositoryRoot, encoding: "utf8", timeout: 180_000 }
  );
  assert.equal(
    result.status,
    0,
    `RuleSync project generation failed:\n${result.stderr}`
  );

  assert.ok(filesUnder(projectOutputRoot).includes("AGENTS.md"));
  const generated = readFileSync(join(projectOutputRoot, "AGENTS.md"), "utf8");
  assert.ok(
    generated.trimEnd().endsWith(canonical.body),
    "the generated instructions do not end with the canonical rule body"
  );
});
