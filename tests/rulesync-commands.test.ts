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

import { compareText } from "./support/ordering.ts";
import {
  readRulesyncConfig,
  targetsOwningFeature
} from "./support/rulesync-config.ts";
import { readCommand } from "./support/skill-document.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const catalogRoot = join(repositoryRoot, ".rulesync", "commands");
const rulesyncConfigPath = join(repositoryRoot, "rulesync.jsonc");
// The CLI entry run with this test's own Node, as the installer runs rulesync
// in-process: the `.bin` shim finds `node` on PATH, and a pnpm-managed Node
// there cannot locate its store once HOME is isolated.
const rulesyncCli = join(
  repositoryRoot,
  "node_modules",
  "rulesync",
  "dist",
  "cli",
  "index.js"
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
  .sort(compareText);

/**
The targets that own a feature, read from the configuration.

A run that names its targets replaces the configuration's per-target map
with a flat selection, so the owners are named explicitly.
*/
function commandFeatureOwners(): string[] {
  return targetsOwningFeature(readRulesyncConfig(repositoryRoot), "commands");
}

function generateGlobal(outputHome: string): void {
  const result = spawnSync(
    process.execPath,
    [
      rulesyncCli,
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
    const { front, body } = readCommand(
      repositoryRoot,
      file.replace(/\.md$/u, "")
    );
    const targets = /^targets:[ \t]*(?<value>\[[^\]]*\])[ \t]*$/mu.exec(front);
    assert.ok(
      targets?.groups?.value !== undefined,
      `${file} frontmatter must declare \`targets: [...]\``
    );
    const targetsList = JSON.parse(targets.groups.value) as unknown;
    assert.ok(
      Array.isArray(targetsList) &&
        targetsList.every((value) => typeof value === "string"),
      `${file} frontmatter \`targets\` must be a list of strings`
    );
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
    .sort(compareText);
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
    const promptsDirectory = join(outputHome, ".codex", "prompts");
    const projected = readdirSync(promptsDirectory)
      .filter((file) => file.endsWith(".md"))
      .sort(compareText);
    assert.deepEqual(
      projected,
      codexCommandNames.map((name) => `${name}.md`),
      "Rulesync must project only canonical commands targeted at codexcli or *"
    );
    for (const name of codexCommandNames) {
      const text = readFileSync(join(promptsDirectory, `${name}.md`), "utf8");
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

test("RuleSync's project projection installs every command for Claude Code, Copilot, and Antigravity CLI", () => {
  const outputRoot = mkdtempSync(
    join(tmpdir(), "autodev-rulesync-project-commands-")
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        rulesyncCli,
        "generate",
        "--config",
        rulesyncConfigPath,
        "--input-roots",
        join(repositoryRoot, ".rulesync"),
        "--output-roots",
        outputRoot,
        "--features",
        "commands",
        "--targets",
        commandFeatureOwners().join(","),
        "--silent"
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 }
    );
    assert.equal(
      result.status,
      0,
      `Rulesync project commands generation failed:\nSTDOUT=${result.stdout}\nSTDERR=${result.stderr}`
    );
    const listed = (directory: string, suffix: string) =>
      readdirSync(join(outputRoot, directory))
        .filter((entry) => entry.endsWith(suffix))
        .map((entry) => entry.slice(0, -suffix.length))
        .sort(compareText);
    // Every canonical command targets `*`, so each project target receives
    // the whole catalog in its native command surface. Antigravity CLI has no
    // command format, so Rulesync projects commands as skills.
    assert.deepEqual(listed(".claude/commands", ".md"), codexCommandNames);
    assert.deepEqual(
      listed(".github/prompts", ".prompt.md"),
      codexCommandNames
    );
    assert.deepEqual(
      readdirSync(join(outputRoot, ".agents", "skills")).sort(compareText),
      codexCommandNames
    );
    for (const name of codexCommandNames)
      assert.ok(
        readFileSync(
          join(outputRoot, ".agents", "skills", name, "SKILL.md"),
          "utf8"
        ).startsWith(`---\nname: ${name}\ndescription:`),
        `${name} must project as a named Antigravity skill`
      );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("materializeCommands applies, reconciles, and reports real Codex prompt changes", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "autodev-commands-codex-"));
  const promptsDirectory = join(codexHome, "prompts");
  const canonicalCommands = new Map(
    new RuleSyncRepository(repositoryRoot)
      .loadCommands()
      .commands.map((command) => [command.name, command])
  );
  try {
    assert.deepEqual(
      materializeCommands({ repositoryRoot }, promptsDirectory),
      codexCommandNames,
      "a first install reports each projected Codex prompt"
    );
    assert.deepEqual(
      readdirSync(promptsDirectory).sort(compareText),
      codexCommandNames.map((name) => `${name}.md`),
      "only Codex-targeted commands are installed"
    );
    for (const name of codexCommandNames) {
      const target = join(promptsDirectory, `${name}.md`);
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
      materializeCommands({ repositoryRoot }, promptsDirectory),
      [],
      "an unchanged install reports no prompt changes"
    );

    writeFileSync(join(promptsDirectory, "bug-fix.md"), "old wording\n");
    writeFileSync(join(promptsDirectory, "retired.md"), "# retired\n");
    assert.deepEqual(
      materializeCommands({ repositoryRoot }, promptsDirectory),
      ["bug-fix", "retired"],
      "a rewritten prompt and removed stale prompt are both reported"
    );
    assert.notEqual(
      readFileSync(join(promptsDirectory, "bug-fix.md"), "utf8"),
      "old wording\n"
    );
    assert.equal(existsSync(join(promptsDirectory, "retired.md")), false);
    assert.deepEqual(
      readdirSync(promptsDirectory).sort(compareText),
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
  assert.match(
    materializer,
    /export function materializeCurrentCommandProjections\(/mu
  );
  const check = readFileSync(checkModulePath, "utf8");
  assert.match(check, /loadCodexCommands\(paths\.repositoryRoot\)/mu);
  assert.match(check, /function checkCommands\(/mu);
  assert.match(check, /checkCommands\(paths, failures\)/mu);

  // Project-mode commands reach Claude Code, Copilot, and Antigravity CLI.
  // Rulesync skips codexcli (its commands are global-only), so the installer
  // projects Codex prompts into $CODEX_HOME/prompts separately.
  const config = readRulesyncConfig(repositoryRoot);
  assert.ok(
    commandFeatureOwners().includes("copilot"),
    "Copilot is a project-mode command surface"
  );
  assert.equal(
    config.features.length,
    0,
    "the configuration must not narrow the per-target feature map"
  );
  assert.equal(config.global, false);
  assert.equal(config.delete, true);
  const installer = readFileSync(installerPath, "utf8");
  assert.match(installer, /src\/cli\/install\.ts/);
});
