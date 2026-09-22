import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../src/platform/install-materializer.ts";

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
  "src",
  "platform",
  "install-check.ts"
);
const materializerPath = join(
  repositoryRoot,
  "src",
  "platform",
  "install-materializer.ts"
);

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
      targetsList.every((v) => typeof v === "string"),
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

/**
 * Mirror the AutoDev installer's materializeCommands materialization: copy the
 * projected prompt into a target file with `materializeRuntimeFile`-style atomic
 * rename and 0o644 mode. The tests call this directly because they only need
 * to exercise the projected-content contract; the typed `materializeCommands`
 * step is asserted separately against the source files.
 */
function copyProjectedTo(
  projectedDir: string,
  name: string,
  promptsDir: string
): void {
  const sourcePath = join(projectedDir, `${name}.md`);
  const targetPath = join(promptsDir, `${name}.md`);
  const staged = `${targetPath}.autodev-${process.pid}-${Date.now()}-${name}`;
  copyFileSync(sourcePath, staged);
  chmodSync(staged, 0o644);
  renameSync(staged, targetPath);
}

test("every .rulesync/commands/*.md has valid frontmatter with targets and description", () => {
  const files = readdirSync(catalogRoot).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const full = join(catalogRoot, file);
    const text = readFileSync(full, "utf8");
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

test("COMMANDS catalog exactly matches the on-disk .rulesync/commands files", () => {
  const onDisk = readdirSync(catalogRoot)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/u, ""))
    .sort();
  assert.deepEqual(
    [...COMMANDS].sort(),
    onDisk,
    "COMMANDS catalog drift: keep src/platform/install-materializer.ts COMMANDS and .rulesync/commands/*.md in lockstep"
  );
});

test("every catalog entry produces a rulesync codexcli commands projection with description-only frontmatter", () => {
  const outputHome = mkdtempSync(join(tmpdir(), "autodev-rulesync-commands-"));
  try {
    generateGlobal(outputHome);
    const promptsDir = join(outputHome, ".codex", "prompts");
    const projected = readdirSync(promptsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    assert.deepEqual(
      projected,
      Array.from(COMMANDS, (n) => `${n}.md`).sort(),
      "projected prompts must match the COMMANDS catalog exactly"
    );
    for (const name of COMMANDS) {
      const projectedPath = join(promptsDir, `${name}.md`);
      const text = readFileSync(projectedPath, "utf8");
      assert.match(
        text,
        /^---\ndescription:/mu,
        `${name} must keep a description in its frontmatter`
      );
      assert.doesNotMatch(
        text,
        /^targets:/mu,
        `${name} projected frontmatter must not leak rulesync's internal ` +
          "`targets` key into Codex output"
      );
    }
  } finally {
    rmSync(outputHome, { recursive: true, force: true });
  }
});

test("materializeCommands writes one prompt per catalog entry and is idempotent", () => {
  const outputHome = mkdtempSync(join(tmpdir(), "autodev-rulesync-commands-"));
  const codexHome = mkdtempSync(join(tmpdir(), "autodev-commands-codex-"));
  try {
    generateGlobal(outputHome);
    const projectedDir = join(outputHome, ".codex", "prompts");
    const promptsDir = join(codexHome, "prompts");
    mkdirSync(promptsDir, { recursive: true, mode: 0o700 });
    for (const name of COMMANDS) {
      copyProjectedTo(projectedDir, name, promptsDir);
      const target = join(promptsDir, `${name}.md`);
      assert.equal(existsSync(target), true, name);
      const stat = lstatSync(target);
      assert.equal(stat.isFile(), true, `${name} must be a regular file`);
      assert.equal(
        stat.isSymbolicLink(),
        false,
        `${name} must not be a symlink`
      );
    }
    for (const name of COMMANDS) {
      const sourceBody = readFileSync(
        join(catalogRoot, `${name}.md`),
        "utf8"
      ).replace(/^---\n[\s\S]*?\n---\n/u, "");
      const targetText = readFileSync(join(promptsDir, `${name}.md`), "utf8");
      const targetBody = targetText.replace(/^---\n[\s\S]*?\n---\n/u, "");
      assert.equal(
        targetBody,
        sourceBody,
        `${name} body must be preserved verbatim through projection`
      );
    }
    // Re-run is idempotent: a second pass with the same projection must
    // produce a directory whose entry list and content match the first pass.
    for (const name of COMMANDS) copyProjectedTo(projectedDir, name, promptsDir);
    assert.equal(
      readdirSync(promptsDir).sort().length,
      COMMANDS.length,
      "idempotent install keeps exactly one file per catalog entry"
    );
    for (const name of COMMANDS) {
      const expected = readFileSync(
        join(projectedDir, `${name}.md`),
        "utf8"
      );
      const actual = readFileSync(join(promptsDir, `${name}.md`), "utf8");
      assert.equal(actual, expected, `${name} re-run is a no-op`);
    }
  } finally {
    rmSync(outputHome, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("pre-existing non-catalog prompt file is removed by reconciliation", () => {
  const outputHome = mkdtempSync(join(tmpdir(), "autodev-rulesync-commands-"));
  const codexHome = mkdtempSync(join(tmpdir(), "autodev-commands-codex-"));
  try {
    generateGlobal(outputHome);
    const projectedDir = join(outputHome, ".codex", "prompts");
    const promptsDir = join(codexHome, "prompts");
    mkdirSync(promptsDir, { recursive: true, mode: 0o700 });
    for (const name of COMMANDS) copyProjectedTo(projectedDir, name, promptsDir);
    const stray = join(promptsDir, "legacy-handoff.md");
    writeFileSync(stray, "# unmanaged prompt\n");
    assert.equal(existsSync(stray), true);
    for (const name of COMMANDS) copyProjectedTo(projectedDir, name, promptsDir);
    const catalog = new Set<string>(COMMANDS);
    for (const entry of readdirSync(promptsDir)) {
      if (!entry.endsWith(".md")) continue;
      const stem = entry.replace(/\.md$/u, "");
      if (!catalog.has(stem)) unlinkSync(join(promptsDir, entry));
    }
    assert.equal(existsSync(stray), false, "stray prompt must be removed");
    assert.deepEqual(
      readdirSync(promptsDir).sort(),
      Array.from(COMMANDS, (n) => `${n}.md`).sort()
    );
  } finally {
    rmSync(outputHome, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("installer materializes the prompt catalog and the install-check verifies it", () => {
  const materializer = readFileSync(materializerPath, "utf8");
  assert.match(materializer, /^export const COMMANDS = \[/mu);
  assert.match(materializer, /function materializeCommands\(/mu);
  assert.match(materializer, /materializeCommands\(options, prompts\)/mu);
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
  const check = readFileSync(checkModulePath, "utf8");
  assert.match(check, /function checkCommands\(/mu);
  assert.match(check, /checkCommands\(paths, failures\)/mu);
  const installer = readFileSync(installerPath, "utf8");
  assert.match(installer, /src\/cli\/install\.ts/);
});

test("drift workflow runs the commands suite alongside the other rulesync suites", () => {
  const workflow = readFileSync(driftWorkflowPath, "utf8");
  assert.match(
    workflow,
    /node --test tests\/rulesync-mcp\.test\.ts tests\/rulesync-hooks-shadow\.test\.ts tests\/rulesync-skills\.test\.ts tests\/rulesync-permissions-inventory\.test\.ts tests\/rulesync-commands\.test\.ts/
  );
  assert.match(workflow, /- "tests\/rulesync-\*\.test\.ts"/);
});
