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
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { staleUserSkillLinks } from "@simulatorlife/autodev-runtime/platform/install-materializer";
import { userLevelSkills } from "@simulatorlife/autodev-runtime/platform/user-level-skills";

type JsonObject = Record<string, unknown>;
type RunResult = ReturnType<typeof spawnSync>;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(repositoryRoot, ".rulesync", "skills");
const curatedRoot = join(sourceRoot, ".curated");
const installerPath = join(repositoryRoot, "scripts", "install.sh");
const rulesyncConfigPath = join(repositoryRoot, "rulesync.jsonc");
const rulesyncLockPath = join(repositoryRoot, "rulesync.lock");
const rulesyncNpmLockPath = join(repositoryRoot, "rulesync-npm.lock.json");
const pnpmWorkspacePath = join(repositoryRoot, "pnpm-workspace.yaml");
const driftWorkflowPath = join(
  repositoryRoot,
  ".github",
  "workflows",
  "rulesync-mcp-shadow-drift.yml"
);
const copilotSetupWorkflowPath = join(
  repositoryRoot,
  ".github",
  "workflows",
  "copilot-setup-steps.yml"
);
const targets = [
  "copilot",
  "claudecode",
  "codexcli",
  "antigravity-cli"
] as const;
const canonicalSkills = [
  "autodev-request-capture",
  "autodev-session-diagnostics",
  "ccc",
  "code-simplification",
  "diagnosing-bugs",
  "doubt-driven-development",
  "game-playtesting",
  "improve-codebase-architecture",
  "lsp-mcp-server",
  "opentelemetry",
  "orchestration",
  "playtest-analysis",
  "remove-legacy-shims",
  "resolve-merge-conflicts",
  "source-driven-development",
  "writing-agent-skills"
] as const;
const curatedSkills = [
  "acpx",
  "getting-started",
  "karpathy-guidelines",
  "opencli-autofix",
  "opencli-browser",
  "opencli-usage",
  "quota-axi",
  "react-best-practices",
  "table-state"
] as const;
/**
 * The curated skills that arrive from a GitHub repository, pinned in
 * `rulesync.lock`, and the ones that arrive from a published npm package,
 * pinned in `rulesync-npm.lock.json`. The npm-transport sources exist because
 * the packages ship the skills that document the CLIs this repository runs,
 * so their pinned version must match the installed package version.
 */
const gitCuratedSkills = ["karpathy-guidelines", "react-best-practices"] as const;
const npmCuratedSkills = [
  "acpx",
  "getting-started",
  "opencli-autofix",
  "opencli-browser",
  "opencli-usage",
  "quota-axi",
  "table-state"
] as const;
const npmSourcePackages = [
  { source: "acpx", version: "0.22.0" },
  { source: "quota-axi", version: "0.1.69" },
  { source: "@jackwener/opencli", version: "2.0.3" },
  { source: "@tanstack/react-table", version: "9.3.1" }
] as const;
const repositorySkills: Record<string, readonly string[]> = {
  ".github/skills": [
    "acpx",
    "autodev-request-capture",
    "autodev-session-diagnostics",
    "ccc",
    "getting-started",
    "karpathy-guidelines",
    "lsp-mcp-server",
    "opencli-autofix",
    "opencli-browser",
    "opencli-usage",
    "opentelemetry",
    "orchestration",
    "quota-axi",
    "react-best-practices",
    "table-state"
  ],
  ".claude/skills": [
    "acpx",
    "autodev-request-capture",
    "autodev-session-diagnostics",
    "getting-started",
    "karpathy-guidelines",
    "opencli-autofix",
    "opencli-browser",
    "opencli-usage",
    "opentelemetry",
    "quota-axi",
    "react-best-practices",
    "table-state"
  ],
  ".agents/skills": [
    "acpx",
    "autodev-request-capture",
    "autodev-session-diagnostics",
    "getting-started",
    "karpathy-guidelines",
    "opencli-autofix",
    "opencli-browser",
    "opencli-usage",
    "opentelemetry",
    "quota-axi",
    "react-best-practices",
    "table-state"
  ]
};

function skillSourceDir(skill: string): string {
  const canonical = join(sourceRoot, skill);
  return existsSync(canonical) ? canonical : join(curatedRoot, skill);
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}
function _asObject(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}
function runRulesync(outputRoot: string, ...mode: string[]): RunResult {
  return spawnSync(
    "pnpm",
    [
      "exec",
      "rulesync",
      "generate",
      "--config",
      "rulesync.jsonc",
      "--output-roots",
      outputRoot,
      // Commands also land in `.agents/skills/` (Antigravity CLI's command
      // surface); tests/rulesync-commands.test.ts owns that projection.
      "--features",
      "skills",
      ...mode,
      "--silent"
    ],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 }
  );
}
function splitFrontmatter(text: string): [string, string] {
  const match = /^---\n(?<front>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u.exec(text);
  assert.ok(
    match?.groups?.front !== undefined && match.groups.body !== undefined,
    "missing skill frontmatter"
  );
  return [match.groups.front, match.groups.body.replaceAll(/^\n+|\n+$/gu, "")];
}
function description(frontmatter: string): string {
  const foldedMatch = /^description:[ \t]*>-[ \t]*\n/mu.exec(frontmatter);
  let value: string | undefined;
  if (foldedMatch) {
    const bodyLines: string[] = [];
    const remainder = frontmatter.slice(
      foldedMatch.index + foldedMatch[0].length
    );
    for (const line of remainder.split("\n")) {
      if (/^[ \t]/.test(line)) {
        bodyLines.push(line);
      } else {
        break;
      }
    }
    value = bodyLines.join("\n");
  } else {
    const single = /^description:[ \t]*(?<value>\S.*)$/mu.exec(frontmatter);
    value = single?.groups?.value;
  }
  assert.ok(value !== undefined, "missing skill description");
  return value
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/^['"]|['"]$/gu, "");
}
function files(directory: string): string[] {
  const output: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) output.push(relative(directory, path));
    }
  };
  visit(directory);
  return output.sort();
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "autodev-rulesync-skills-"));
const generated = join(temporaryRoot, "generated");
const installResult = spawnSync(
  "pnpm",
  ["exec", "rulesync", "install", "--frozen", "--silent"],
  { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 }
);
assert.equal(
  installResult.status,
  0,
  `Rulesync frozen install failed: ${installResult.stdout}\n${installResult.stderr}`
);
const result = runRulesync(generated);
assert.equal(
  result.status,
  0,
  `Rulesync skills generation failed: ${result.stdout}\n${result.stderr}`
);
test.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function generatedSkillPath(folder: string, skill: string): string {
  return join(generated, folder, skill, "SKILL.md");
}

test("canonical source holds every skill", () => {
  const names = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".curated")
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(names, [...canonicalSkills].sort());
  for (const skill of canonicalSkills) {
    const document = join(sourceRoot, skill, "SKILL.md");
    assert.equal(lstatSync(document).isSymbolicLink(), false, skill);
    const [front] = splitFrontmatter(readFileSync(document, "utf8"));
    assert.match(front, new RegExp(`^name: ${skill}$`, "mu"));
    assert.doesNotMatch(front, /^description:\s*>/mu);
  }
  const curatedNames = readdirSync(curatedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(curatedNames, [...curatedSkills].sort());
  for (const skill of curatedSkills) {
    const document = join(curatedRoot, skill, "SKILL.md");
    assert.equal(lstatSync(document).isSymbolicLink(), false, skill);
    const [front] = splitFrontmatter(readFileSync(document, "utf8"));
    assert.match(front, /^name:\s*\S+/mu, skill);
    description(front);
  }
  const lockfile = _asObject(readJson(rulesyncLockPath));
  const lockedSources = _asObject(lockfile.sources);
  const lockedSkills = Object.values(lockedSources)
    .flatMap((entry) => Object.keys(_asObject(_asObject(entry).skills)))
    .sort();
  assert.deepEqual(lockedSkills, [...gitCuratedSkills].sort());
  const npmLockfile = _asObject(readJson(rulesyncNpmLockPath));
  const npmLockedSources = _asObject(npmLockfile.sources);
  const npmLockedSkills = Object.values(npmLockedSources)
    .flatMap((entry) => Object.keys(_asObject(_asObject(entry).skills)))
    .sort();
  assert.deepEqual(npmLockedSkills, [...npmCuratedSkills].sort());
  assert.deepEqual(
    [...lockedSkills, ...npmLockedSkills].sort(),
    [...curatedSkills].sort()
  );
  assert.equal(
    existsSync(join(sourceRoot, "orchestration", "agents", "openai.yaml")),
    true
  );
});

/**
 * The canonical skills source holds real directories only.
 *
 * A package that ships agent skills used to be linked into `.rulesync/skills/`
 * as a symbolic link, and the Runtime's catalog reads that directory as the
 * canonical source: a link there is not a skill, it is an invalid entry that
 * fails the whole catalog. RuleSync owns every skill this repository
 * distributes, so the packages are installed for their CLIs and libraries
 * only, and their skills are fetched and pinned by RuleSync instead.
 */
test("the canonical skills source holds no symbolic link", () => {
  const linked = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name);
  assert.deepEqual(linked, []);
  const curatedLinked = readdirSync(curatedRoot, { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name);
  assert.deepEqual(curatedLinked, []);
});

/**
 * pnpm must not link a dependency's agent skills into the repository.
 *
 * `skills.dirs` is pnpm's own skill distribution, and a non-empty list points
 * it at the canonical source, where its links shadow the RuleSync-managed
 * copies. An empty list turns that distribution off.
 */
test("pnpm does not distribute agent skills into the repository", () => {
  const workspace = readFileSync(pnpmWorkspacePath, "utf8");
  const dirs = /^skills:\s*\n(?:\s+[^\n]*\n)*?\s+dirs:\s*(?<dirs>\[[^\]]*\])\s*$/mu.exec(
    workspace
  )?.groups?.dirs;
  assert.equal(dirs, "[]");
  assert.doesNotMatch(workspace, /^\s*permissions:/mu);
});

test("only the canonical skill source is tracked", () => {
  const tracked = spawnSync(
    "git",
    [
      "ls-files",
      "--",
      ".github/skills",
      ".claude/skills",
      ".agents/skills",
      ".rulesync/skills/.curated"
    ],
    { cwd: repositoryRoot, encoding: "utf8" }
  )
    .stdout.split("\n")
    .filter(Boolean);
  assert.deepEqual(
    tracked.filter((path) => path.includes("/skills/")),
    []
  );
  const lockTracked = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", "rulesync.lock"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  assert.equal(lockTracked.status, 0);
  const npmLockTracked = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", "rulesync-npm.lock.json"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  assert.equal(npmLockTracked.status, 0);
  const ignored = readFileSync(join(repositoryRoot, ".gitignore"), "utf8")
    .split("\n")
    .map((line) => line.trim());
  assert.ok(ignored.includes("/.github/skills/"));
  assert.ok(ignored.includes("/.claude/skills/"));
  assert.ok(ignored.includes("/.rulesync/skills/.curated/"));
  assert.ok(ignored.includes("!/rulesync.lock"));
  assert.ok(ignored.includes("!/rulesync-npm.lock.json"));
  assert.deepEqual(
    ignored.filter(
      (line) => line.includes(".agents/skills") && !line.startsWith("#")
    ),
    []
  );
});

test("each tool folder receives exactly its repository skills with bundled files", () => {
  for (const [folder, skills] of Object.entries(repositorySkills)) {
    const root = join(generated, folder);
    assert.deepEqual(
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
      [...skills].sort(),
      folder
    );
    for (const skill of skills) {
      const origin = skillSourceDir(skill);
      assert.deepEqual(
        files(join(root, skill)),
        files(origin),
        `${folder}/${skill}`
      );
      for (const relativePath of files(origin)) {
        if (relativePath !== "SKILL.md")
          assert.deepEqual(
            readFileSync(join(root, skill, relativePath)),
            readFileSync(join(origin, relativePath)),
            `${folder}/${skill}/${relativePath}`
          );
      }
    }
  }
  assert.deepEqual(
    readdirSync(generated, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory() ? [entry.name] : []))
      .flatMap((tool) =>
        existsSync(join(generated, tool, "skills")) ? [`${tool}/skills`] : []
      )
      .sort(),
    Object.keys(repositorySkills).sort()
  );
});

test("repository folders never duplicate user-level skills", () => {
  const userLevel = new Set(userLevelSkills(sourceRoot));
  for (const folder of [".claude/skills", ".agents/skills"]) {
    const projected = new Set(
      readdirSync(join(generated, folder), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    );
    assert.deepEqual(
      [...projected].filter((skill) => userLevel.has(skill)),
      [],
      folder
    );
  }
});

test("generated documents preserve name, description, and body without targets", () => {
  const canonicalSet = new Set<string>(canonicalSkills);
  for (const [folder, skills] of Object.entries(repositorySkills))
    for (const skill of skills) {
      const [sourceFront, sourceBody] = splitFrontmatter(
        readFileSync(join(skillSourceDir(skill), "SKILL.md"), "utf8")
      );
      const [front, body] = splitFrontmatter(
        readFileSync(generatedSkillPath(folder, skill), "utf8")
      );
      const declaredName = /^name:[ \t]*(?<value>\S.*)$/mu.exec(sourceFront)
        ?.groups?.value;
      assert.ok(declaredName, `${folder}/${skill} source missing name`);
      if (canonicalSet.has(skill)) {
        assert.equal(declaredName, skill, `${folder}/${skill}`);
      }
      assert.match(front, new RegExp(`^name:[ \t]*${declaredName}$`, "mu"));
      assert.equal(description(front), description(sourceFront));
      assert.doesNotMatch(front, /^targets:/mu);
      assert.equal(body, sourceBody);
    }
});

test("Rulesync check detects edited, stale, and missing generated skills", () => {
  assert.equal(runRulesync(generated, "--check").status, 0);
  for (const [label, damage] of [
    [
      "edited",
      (root: string) =>
        writeFileSync(join(root, ".github/skills/ccc/SKILL.md"), "drift\n")
    ],
    [
      "stale",
      (root: string) => {
        const path = join(root, ".github/skills/stale");
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "SKILL.md"), "x\n");
      }
    ],
    [
      "missing",
      (root: string) =>
        rmSync(join(root, ".claude/skills/autodev-request-capture/SKILL.md"))
    ]
  ] as const) {
    const root = join(temporaryRoot, label);
    mkdirSync(root, { recursive: true });
    assert.equal(runRulesync(root).status, 0, label);
    damage(root);
    assert.notEqual(runRulesync(root, "--check").status, 0, label);
  }
});

test("installer delegates repository skill generation and checking to typed materialization", () => {
  const installer = readFileSync(installerPath, "utf8");
  const materializer = readFileSync(
    join(repositoryRoot, "runtime/src/platform/install-materializer.ts"),
    "utf8"
  );
  assert.match(installer, /src\/cli\/install\.ts/);
  assert.match(materializer, /rulesync\.jsonc/);
  assert.match(materializer, /rulesync/);
  assert.match(materializer, /ensureExclude/);
  assert.doesNotMatch(materializer, /renderProviderSkillViews/);
  assert.match(materializer, /OBSOLETE_CLAUDE_SKILL_VIEWS/);
  // Skills are read only from their installed link; the runtime tree carries
  // none, and an earlier lone SKILL.md copy there is removed on install.
  assert.doesNotMatch(materializer, /"\.rulesync\/skills\//);
  assert.match(materializer, /path\.join\(codexHome, "\.rulesync"\)/);
});

test("Copilot cloud setup generates repository skills after installing dependencies", () => {
  const workflow = readFileSync(copilotSetupWorkflowPath, "utf8");
  assert.ok(
    workflow.indexOf("pnpm install --frozen-lockfile") <
      workflow.indexOf("pnpm exec rulesync generate --targets copilot --silent")
  );
  assert.match(workflow, /- "\.rulesync\/\*\*"/);
});

test("RuleSync project config and CI cover the repository projections", () => {
  const config = readJson(rulesyncConfigPath);
  assert.deepEqual(config.targets, [...targets, "agentsmd"]);
  assert.deepEqual(config.features, ["skills", "commands", "hooks", "rules"]);
  assert.deepEqual(config.outputRoots, ["."]);
  assert.equal(config.delete, true);
  assert.equal(config.global, false);
  const configuredSources = (config.sources as Array<Record<string, unknown>>)
    .flatMap((entry) => entry.skills as string[])
    .sort();
  assert.deepEqual(configuredSources, [...curatedSkills].sort());
  const workflow = readFileSync(driftWorkflowPath, "utf8");
  assert.match(workflow, /- "rulesync\.lock"/);
  assert.match(workflow, /- "rulesync-npm\.lock\.json"/);
  assert.match(workflow, /pnpm exec rulesync install --frozen --silent/);
  assert.match(
    workflow,
    /run: node --test tests\/rulesync-mcp\.test\.ts tests\/rulesync-hooks-shadow\.test\.ts tests\/rulesync-skills\.test\.ts tests\/rulesync-permissions-inventory\.test\.ts tests\/rulesync-commands\.test\.ts tests\/rulesync-rules\.test\.ts/
  );
  assert.equal(workflow.match(/- "tests\/rulesync-\*\.test\.ts"/g)?.length, 2);
  assert.doesNotMatch(workflow, /rulesync generate/);
  const stray = readdirSync(join(repositoryRoot, "tests", "fixtures"), {
    withFileTypes: true
  })
    .filter((entry) => entry.name.startsWith("rulesync-"))
    .map((entry) => entry.name);
  assert.deepEqual(stray, []);
});

/**
 * A skill that documents a CLI must document the CLI this repository runs.
 *
 * The npm-transport sources fetch the skills a published package ships, so
 * the pin in `rulesync.jsonc` is a package version. When the workspace bumps
 * that package, the fetched skill is the one that describes the new CLI, so
 * the two versions must be the same number; a skill pinned to an older
 * version describes commands the installed CLI does not have.
 */
test("every npm-transport source pins the version the workspace installs", () => {
  const config = readJson(rulesyncConfigPath);
  const sources = config.sources as Array<Record<string, unknown>>;
  const npmSources = new Map(
    sources
      .filter((entry) => entry.transport === "npm")
      .map((entry) => [entry.source as string, entry])
  );
  assert.deepEqual(
    [...npmSources.keys()].sort(),
    npmSourcePackages.map((entry) => entry.source).sort()
  );
  const workspaceProjects = ["runtime", "console", "core", "data"];
  for (const { source, version } of npmSourcePackages) {
    const declared = workspaceProjects.flatMap((project) => {
      const manifest = readJson(
        join(repositoryRoot, project, "package.json")
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return [
        manifest.dependencies?.[source],
        manifest.devDependencies?.[source]
      ].filter((value): value is string => typeof value === "string");
    });
    assert.ok(declared.length > 0, `${source} is not a workspace dependency`);
    assert.deepEqual(
      [...new Set(declared)],
      [version],
      `${source} is installed at a version other than ${version}`
    );
    assert.equal(npmSources.get(source)?.ref, version, source);
  }
  const npmLock = _asObject(readJson(rulesyncNpmLockPath));
  const npmLocked = _asObject(npmLock.sources);
  for (const { source, version } of npmSourcePackages) {
    const entry = _asObject(npmLocked[source]);
    assert.equal(entry.requestedVersion, version, source);
    assert.equal(entry.resolvedVersion, version, source);
  }
});

test("every skill a role enables is installed at user level", () => {
  // Observed 2026-11-12: a hand-kept installer list omitted game-playtesting,
  // playtest-analysis and source-driven-development, so the roles enabling
  // them got no skill. The user-level set now comes from each skill's
  // frontmatter; this pins that every enabled skill is in it.
  const userLevel = new Set(userLevelSkills(sourceRoot));
  const rolesRoot = join(repositoryRoot, "agents", "roles");
  const enabled = new Map<string, string[]>();
  for (const file of readdirSync(rolesRoot).filter((f) => f.endsWith(".toml")))
    for (const match of readFileSync(join(rolesRoot, file), "utf8").matchAll(
      /name = "([^"]+)"\s*\nenabled = true/gu
    ))
      enabled.set(match[1]!, [...(enabled.get(match[1]!) ?? []), file]);
  assert.ok(enabled.size > 0, "roles enable skills");
  for (const [skill, roles] of enabled)
    assert.ok(
      userLevel.has(skill),
      `${skill} (enabled by ${roles.join(", ")}) is not installed at user level`
    );
});

/**
 * A skill may show what another skill could look like. Such an example names
 * files on purpose that the skill does not ship, so the reference check
 * ignores the paths inside a `skill-example` region.
 */
function withoutExampleRegions(text: string, document: string): string {
  const openings = text.match(/<!--\s*skill-example\s*-->/gu)?.length ?? 0;
  const closings = text.match(/<!--\s*\/skill-example\s*-->/gu)?.length ?? 0;
  assert.equal(
    openings,
    closings,
    `${document}: unbalanced skill-example markers`
  );
  return text.replaceAll(
    /<!--\s*skill-example\s*-->[\s\S]*?<!--\s*\/skill-example\s*-->/gu,
    ""
  );
}

test("an example region is exempt from the reference check", () => {
  const document = [
    "Load `references/polish.md` for polishing.",
    "<!-- skill-example -->",
    "Load `references/review.md` for reviews.",
    "<!-- /skill-example -->"
  ].join("\n");
  assert.equal(
    withoutExampleRegions(document, "skill.md"),
    "Load `references/polish.md` for polishing.\n"
  );
  assert.throws(
    () => withoutExampleRegions("<!-- skill-example -->\ntext", "skill.md"),
    /unbalanced skill-example markers/
  );
});

test("every file a skill names exists where an agent resolves it", () => {
  // A skill names its bundled files relative to its own directory and
  // repository files relative to the repository root. Either way the file
  // must exist, or an agent following the skill stops at a missing path.
  // Illustrative examples are exempt: a skill may name files it does not
  // ship, as long as it marks them as an example.
  const bundled = /^(?:references|scripts|assets|templates|examples|agents)\//u;
  const repository =
    /^(?:docs|runtime|core|console|data|config|agents|tests|scripts|\.rulesync)\//u;
  const missing: string[] = [];
  for (const skill of readdirSync(sourceRoot)) {
    if (skill === ".curated") continue;
    const directory = join(sourceRoot, skill);
    const documents = readdirSync(directory, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".md"));
    for (const document of documents) {
      const body = withoutExampleRegions(
        readFileSync(join(directory, document), "utf8"),
        `${skill}/${document}`
      );
      for (const [, named] of body.matchAll(/`([\w.@/-]+\.[a-z]{1,5})`/gu)) {
        const reference = named!;
        if (reference.includes("*") || reference.includes("<")) continue;
        const inSkill = existsSync(join(directory, reference));
        const inRepository = existsSync(join(repositoryRoot, reference));
        if (
          (bundled.test(reference) && !inSkill && !inRepository) ||
          (!bundled.test(reference) &&
            repository.test(reference) &&
            !inRepository)
        )
          missing.push(`${skill}/${document}: ${reference}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("a user skill link into the canonical source is stale once the skill is not user-level", () => {
  const root = mkdtempSync(join(tmpdir(), "autodev-stale-skill-links-"));
  try {
    const skills = join(root, "source");
    const user = join(root, "user");
    const other = join(root, "elsewhere", "mine");
    for (const directory of [
      join(skills, "kept"),
      join(skills, "repo-only"),
      other,
      user
    ])
      mkdirSync(directory, { recursive: true });
    symlinkSync(join(skills, "kept"), join(user, "kept"));
    symlinkSync(join(skills, "repo-only"), join(user, "repo-only"));
    symlinkSync(join(skills, "deleted"), join(user, "deleted"));
    symlinkSync(other, join(user, "mine"));
    assert.deepEqual(staleUserSkillLinks(skills, user, ["kept"]).sort(), [
      join(user, "deleted"),
      join(user, "repo-only")
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the local setup guide lists exactly the user-level skills", () => {
  const guide = readFileSync(
    join(repositoryRoot, "docs", "local-setup.md"),
    "utf8"
  );
  const marker = "today that is:\n\n";
  const markerStart = guide.indexOf(marker);
  assert.notEqual(markerStart, -1, "user-level skill list");
  const afterMarker = guide.slice(markerStart + marker.length);
  const sectionEnd = afterMarker.indexOf("\n\n");
  const section =
    sectionEnd === -1 ? afterMarker : afterMarker.slice(0, sectionEnd);
  assert.deepEqual(
    Array.from(section.matchAll(/`([^`]+)`/gu), (match) => match[1]),
    userLevelSkills(sourceRoot)
  );
});
