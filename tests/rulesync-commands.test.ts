import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RuleSyncRepository } from "@simulatorlife/autodev-data";
import {
  loadCodexCommands,
  materializeCommands
} from "@simulatorlife/autodev-runtime/platform/install-materializer";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const catalogRoot = join(repositoryRoot, ".rulesync", "commands");
const rulesyncConfigPath = join(repositoryRoot, "rulesync.jsonc");
const rulesyncBin = join(repositoryRoot, "node_modules", ".bin", "rulesync");
const driftWorkflowPath = join(
  repositoryRoot,
  ".github",
  "workflows",
  "rulesync-mcp-shadow-drift.yml"
);
const installerPath = join(repositoryRoot, "scripts", "install.sh");
const checkModulePath = join(
  repositoryRoot,
  "runtime",
  "src",
  "platform",
  "install-check.ts"
);
const materializerPath = join(
  repositoryRoot,
  "runtime",
  "src",
  "platform",
  "install-materializer.ts"
);
const codexCommandNames = loadCodexCommands(repositoryRoot)
  .map((command) => command.name)
  .sort();

function splitFrontmatter(text: string): { front: string; body: string } {
  const match = /^---\n(?<front>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u.exec(text);
  assert.ok(
    match?.groups?.front !== undefined && match.groups.body !== undefined,
    "missing YAML frontmatter"
  );
  const targets = /^targets:[ \t]*(?<value>\[[^\]]*\])[ \t]*$/mu.exec(
    match.groups.front
  );
  assert.ok(
    targets?.groups?.value !== undefined,
    "frontmatter must declare `targets: [...]`"
  );
  const targetsList = JSON.parse(targets.groups.value) as unknown;
  assert.ok(
    Array.isArray(targetsList) &&
      targetsList.every((value) => typeof value === "string"),
    "frontmatter `targets` must be a list of strings"
  );
  const description = /^description:[ \t]*(?<value>\S.*)$/mu.exec(
    match.groups.front
  );
  assert.ok(
    description?.groups?.value !== undefined,
    "frontmatter must declare a non-empty `description:`"
  );
  return { front: match.groups.front, body: match.groups.body };
}

function readConfig(): {
  targets: string[];
  features: string[];
  outputRoots: string[];
  delete: boolean;
  global: boolean;
} {
  return JSON.parse(readFileSync(rulesyncConfigPath, "utf8")) as {
    targets: string[];
    features: string[];
    outputRoots: string[];
    delete: boolean;
    global: boolean;
  };
}

function generateGlobal(outputHome: string): void {
  const result = spawnSync(
    rulesyncBin,
    [
      "generate",
      "--global",
      "--input-roots",
      join(repositoryRoot, ".rulesync"),
      "--targets",
      "codexcli",
      "--features",
      "commands",
      "--silent"
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, HOME: outputHome },
      encoding: "utf8",
      timeout: 60_000
    }
  );
  assert.equal(
    result.status,
    0,
    `Rulesync commands generation failed:\nSTDOUT=${result.stdout}\nSTDERR=${result.stderr}`
  );
}

test("every canonical RuleSync command has valid targets, description, and body", () => {
  const files = readdirSync(catalogRoot).filter((file) => file.endsWith(".md"));
  for (const file of files) {
    const text = readFileSync(join(catalogRoot, file), "utf8");
    const { front, body } = splitFrontmatter(text);
    assert.match(
      front,
      /^description:[ \t]*\S/mu,
      `${file} description must be a non-empty single-line scalar`
    );
    assert.match(
      front,
      /^targets:[ \t]*\[[^\]]*\]/mu,
      `${file} targets must be present`
    );
    assert.ok(body.length > 0, `${file} body must not be empty`);
  }
});

test("Data exposes the canonical RuleSync command catalog without a Runtime inventory", () => {
  const state = new RuleSyncRepository(repositoryRoot).loadCommands();
  assert.equal(state.valid, true);
  assert.equal(state.source, ".rulesync/commands");

  const onDisk = readdirSync(catalogRoot)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.replace(/\.md$/u, ""))
    .sort();
  assert.deepEqual(
    state.commands.map((command) => command.name),
    onDisk,
    "Data's validated catalog must cover every canonical command file"
  );
});

test("Codex materialization selects only codexcli and wildcard RuleSync targets", () => {
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), "autodev-rulesync-command-targets-")
  );
  const commandsRoot = join(temporaryRoot, ".rulesync", "commands");
  mkdirSync(commandsRoot, { recursive: true });
  const writeCommand = (name: string, targets?: readonly string[]) => {
    const targetLine =
      targets === undefined
        ? ""
        : `targets: [${targets.map((target) => JSON.stringify(target)).join(", ")}]\n`;
    writeFileSync(
      join(commandsRoot, `${name}.md`),
      `---\ndescription: ${name}\n${targetLine}---\nPrompt body for ${name}.\n`
    );
  };

  try {
    writeCommand("codex-only", ["codexcli"]);
    writeCommand("shared", ["*"]);
    writeCommand("other-provider", ["claudecode"]);
    writeCommand("default-target");

    assert.deepEqual(
      new RuleSyncRepository(temporaryRoot)
        .loadCommands()
        .commands.map((command) => command.name),
      ["codex-only", "default-target", "other-provider", "shared"]
    );
    assert.deepEqual(
      loadCodexCommands(temporaryRoot).map((command) => command.name),
      ["codex-only", "default-target", "shared"]
    );
    assert.throws(
      () => loadCodexCommands(join(temporaryRoot, "missing")),
      /load an absent or invalid RuleSync command catalog/u
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("RuleSync's codexcli projection contains exactly the canonical Codex commands", () => {
  const outputHome = mkdtempSync(join(tmpdir(), "autodev-rulesync-commands-"));
  try {
    generateGlobal(outputHome);
    const promptsDir = join(outputHome, ".codex", "prompts");
    const projected = readdirSync(promptsDir)
      .filter((file) => file.endsWith(".md"))
      .sort();
    assert.deepEqual(
      projected,
      codexCommandNames.map((name) => `${name}.md`),
      "Rulesync must project only canonical commands targeted at codexcli or *"
    );
    for (const name of codexCommandNames) {
      const text = readFileSync(join(promptsDir, `${name}.md`), "utf8");
      assert.match(
        text,
        /^---\ndescription:/mu,
        `${name} must keep its description in projected frontmatter`
      );
      assert.doesNotMatch(
        text,
        /^targets:/mu,
        `${name} projected frontmatter must not leak RuleSync's internal ` +
          "`targets` key into Codex output"
      );
    }
  } finally {
    rmSync(outputHome, { recursive: true, force: true });
  }
});

test("materializeCommands applies, reconciles, and reports real Codex prompt changes", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "autodev-commands-codex-"));
  const promptsDir = join(codexHome, "prompts");
  const canonicalCommands = new Map(
    new RuleSyncRepository(repositoryRoot)
      .loadCommands()
      .commands.map((command) => [command.name, command])
  );
  try {
    assert.deepEqual(
      materializeCommands({ repositoryRoot }, promptsDir),
      codexCommandNames,
      "a first install reports each projected Codex prompt"
    );
    assert.deepEqual(
      readdirSync(promptsDir).sort(),
      codexCommandNames.map((name) => `${name}.md`),
      "only Codex-targeted commands are installed"
    );
    for (const name of codexCommandNames) {
      const target = join(promptsDir, `${name}.md`);
      const stat = lstatSync(target);
      assert.equal(stat.isFile(), true, `${name} must be a regular file`);
      assert.equal(
        stat.isSymbolicLink(),
        false,
        `${name} must not be a symlink`
      );
      assert.equal(stat.mode & 0o777, 0o644, `${name} must be mode 0o644`);

      const source = canonicalCommands.get(name);
      assert.ok(source, `missing canonical source for ${name}`);
      const sourceBody = source.content.replace(/^---\n[\s\S]*?\n---\n/u, "");
      const installedBody = readFileSync(target, "utf8").replace(
        /^---\n[\s\S]*?\n---\n/u,
        ""
      );
      assert.equal(
        installedBody.replace(/^\n/u, "").replace(/\n?$/u, ""),
        sourceBody.replace(/^\n/u, "").replace(/\n?$/u, ""),
        `${name} body must survive the canonical Rulesync projection`
      );
    }
    assert.deepEqual(
      materializeCommands({ repositoryRoot }, promptsDir),
      [],
      "an unchanged install reports no prompt changes"
    );

    writeFileSync(join(promptsDir, "bug-fix.md"), "old wording\n");
    writeFileSync(join(promptsDir, "retired.md"), "# retired\n");
    assert.deepEqual(
      materializeCommands({ repositoryRoot }, promptsDir),
      ["bug-fix", "retired"],
      "a rewritten prompt and removed stale prompt are both reported"
    );
    assert.notEqual(
      readFileSync(join(promptsDir, "bug-fix.md"), "utf8"),
      "old wording\n"
    );
    assert.equal(existsSync(join(promptsDir, "retired.md")), false);
    assert.deepEqual(
      readdirSync(promptsDir).sort(),
      codexCommandNames.map((name) => `${name}.md`)
    );
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("installer and install-check both use the Data-owned RuleSync catalog", () => {
  const materializer = readFileSync(materializerPath, "utf8");
  assert.match(materializer, /export function loadCodexCommands\(/mu);
  assert.match(materializer, /export function materializeCommands\(/mu);
  assert.match(materializer, /materializeCommands\(options, prompts\)/mu);
  const check = readFileSync(checkModulePath, "utf8");
  assert.match(check, /loadCodexCommands\(paths\.repositoryRoot\)/mu);
  assert.match(check, /function checkCommands\(/mu);
  assert.match(check, /checkCommands\(paths, failures\)/mu);

  // The commands feature stays out of rulesync.jsonc's project-mode features:
  // codexcli commands is global-only and would throw if used in project mode
  // alongside the other targets.
  const config = readConfig();
  assert.deepEqual(config.targets, [
    "copilot",
    "claudecode",
    "codexcli",
    "antigravity-cli"
  ]);
  assert.deepEqual(config.features, ["skills", "hooks"]);
  assert.equal(config.global, false);
  assert.equal(config.delete, true);
  assert.deepEqual(config.outputRoots, ["."]);
  const installer = readFileSync(installerPath, "utf8");
  assert.match(installer, /src\/cli\/install\.ts/);
});

test("drift workflow runs the commands suite alongside the other RuleSync suites", () => {
  const workflow = readFileSync(driftWorkflowPath, "utf8");
  assert.match(
    workflow,
    /node --test tests\/rulesync-mcp\.test\.ts tests\/rulesync-hooks-shadow\.test\.ts tests\/rulesync-skills\.test\.ts tests\/rulesync-permissions-inventory\.test\.ts tests\/rulesync-commands\.test\.ts/
  );
  assert.match(workflow, /- "tests\/rulesync-\*\.test\.ts"/);
});
