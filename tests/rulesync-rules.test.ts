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

type JsonObject = Record<string, unknown>;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const ruleSourcePath = join(repositoryRoot, ".rulesync/rules/overview.md");
const rootInstructionsPath = join(repositoryRoot, "AGENTS.md");
const configPath = join(repositoryRoot, "rulesync.jsonc");
const generatedPreamble =
  "# Additional Conventions Beyond the Built-in Functions\n\n" +
  "As this project's AI coding tool, you must follow the additional conventions below, in addition to the built-in functions.\n\n";
const temporaryRoot = mkdtempSync(join(tmpdir(), "autodev-rulesync-rules-"));
const outputRoot = join(temporaryRoot, "rules-only");
const projectOutputRoot = join(temporaryRoot, "project");
mkdirSync(outputRoot, { recursive: true });
mkdirSync(projectOutputRoot, { recursive: true });

test.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files.push(relative(root, path).split("\\").join("/"));
    }
  };
  visit(root);
  return files.sort();
}

test("RuleSync owns root instructions and targets only the shared AGENTS.md output", () => {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as JsonObject;
  assert.ok((config.targets as string[]).includes("agentsmd"));
  assert.ok((config.features as string[]).includes("rules"));

  const source = readFileSync(ruleSourcePath, "utf8");
  assert.match(source, /^---\nroot: true\ntargets:\n  - agentsmd\n---\n/u);
  const frontmatterEnd = source.indexOf("\n---\n", 4);
  assert.notEqual(frontmatterEnd, -1, "rule source has closing frontmatter");
  const sourceBody = source.slice(frontmatterEnd + 5);
  assert.ok(sourceBody.trim(), "canonical instruction body is present");

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

  const generated = readFileSync(join(outputRoot, "AGENTS.md"), "utf8");
  assert.equal(generated, readFileSync(rootInstructionsPath, "utf8"));
  assert.ok(generated.startsWith(generatedPreamble));
  assert.equal(
    generated.slice(generatedPreamble.length).trim(),
    sourceBody.trim()
  );

  const workflow = readFileSync(
    join(repositoryRoot, ".github/workflows/rulesync-mcp-shadow-drift.yml"),
    "utf8"
  );
  const pushPathFilter = /^  push:\n([\s\S]*?)(?=^  pull_request:)/mu.exec(
    workflow
  )?.[1];
  const pullRequestPathFilter =
    /^  pull_request:\n([\s\S]*?)(?=^permissions:)/mu.exec(workflow)?.[1];
  assert.ok(pushPathFilter?.includes('      - "AGENTS.md"'));
  assert.ok(pullRequestPathFilter?.includes('      - "AGENTS.md"'));
});

test("full project generation materializes the shared root instructions", () => {
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
    { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 }
  );
  assert.equal(
    result.status,
    0,
    `RuleSync project generation failed:\n${result.stderr}`
  );

  const files = filesUnder(projectOutputRoot);
  assert.ok(files.includes("AGENTS.md"));
  assert.deepEqual(
    files.filter((file) =>
      [
        "AGENTS.md",
        "CLAUDE.md",
        "GEMINI.md",
        "copilot-instructions.md"
      ].includes(file.split("/").at(-1) ?? "")
    ),
    ["AGENTS.md"]
  );
  assert.equal(
    readFileSync(join(projectOutputRoot, "AGENTS.md"), "utf8"),
    readFileSync(rootInstructionsPath, "utf8")
  );
});
