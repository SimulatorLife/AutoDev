/**
The canonical skill source and the projections RuleSync derives from it.

`.rulesync/skills/` is the only tracked skill source, and `.rulesync/skills/
.curated/` holds the externally pinned skills RuleSync materializes from the
lockfiles. The expectations here are derived from those sources and from
the configuration that names the projections, so adding a skill, retiring
one or changing a target is a change to the canonical source and not to
this file.
*/

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

import { parseJsoncObject } from "@simulatorlife/autodev-data/files";
import { staleUserSkillLinks } from "@simulatorlife/autodev-runtime/platform/install-materializer";
import { userLevelSkills } from "@simulatorlife/autodev-runtime/platform/user-level-skills";

import { compareText } from "./support/ordering.ts";
import {
  readRulesyncConfig,
  rulesyncBinary,
  skillTreesWrittenBy,
  targetsOwningFeature
} from "./support/rulesync-config.ts";
import {
  declaredTargets,
  frontmatterDescription,
  readSkill,
  splitFrontmatter
} from "./support/skill-document.ts";

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
const copilotSetupWorkflowPath = join(
  repositoryRoot,
  ".github",
  "workflows",
  "copilot-setup-steps.yml"
);
const workspaceProjects = ["console", "runtime", "core", "data"];

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}
function asObject(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function skillSourceDirectory(skill: string): string {
  const canonical = join(sourceRoot, skill);
  return existsSync(canonical) ? canonical : join(curatedRoot, skill);
}

/**
The skills the canonical source declares, excluding the curated ones.
*/
function canonicalSkillNames(): string[] {
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".curated")
    .map((entry) => entry.name)
    .sort(compareText);
}

/**
The skills the curated sources declare.
*/
function curatedSkillNames(): string[] {
  return readdirSync(curatedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareText);
}

/**
The targets that own the `skills` feature, read from the configuration.

A run that names its targets replaces the configuration's per-target map
with a flat selection, so the owners are named explicitly.
*/
function skillOwners(): string[] {
  return targetsOwningFeature(readRulesyncConfig(repositoryRoot), "skills");
}

/**
The skill tree each owner writes, observed from RuleSync.

The tree a target owns is RuleSync's business, so the mapping is observed
rather than restated.
*/
function skillTreeOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const owner of skillOwners()) {
    for (const tree of skillTreesWrittenBy(repositoryRoot, owner)) {
      assert.equal(
        owners.has(tree),
        false,
        `the skill tree ${tree} has more than one owner`
      );
      owners.set(tree, owner);
    }
  }
  return owners;
}

/**
The skills a projection receives for one target.

A skill reaches a target when it keeps RuleSync's default targets, or when
it names that target explicitly. The curated skills keep the default.
*/
function expectedSkillsForTarget(target: string): string[] {
  const canonical = canonicalSkillNames().filter((skill) => {
    const { front } = readSkill(repositoryRoot, skill);
    const targets = declaredTargets(front);
    return targets === null || targets.includes(target);
  });
  return [...curatedSkillNames(), ...canonical].sort(compareText);
}

function runRulesync(outputRoot: string, ...mode: string[]): RunResult {
  return spawnSync(
    rulesyncBinary(repositoryRoot),
    [
      "generate",
      "--config",
      "rulesync.jsonc",
      "--output-roots",
      outputRoot,
      // Commands also land in `.agents/skills/` (Antigravity CLI's command
      // surface); tests/rulesync-commands.test.ts owns that projection.
      "--features",
      "skills",
      "--targets",
      skillOwners().join(","),
      ...mode,
      "--silent"
    ],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 300_000 }
  );
}
function files(directory: string): string[] {
  const output: string[] = [];
  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) output.push(relative(directory, path));
    }
  };
  visit(directory);
  return output.sort(compareText);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "autodev-rulesync-skills-"));
const generated = join(temporaryRoot, "generated");
const installResult = spawnSync(
  rulesyncBinary(repositoryRoot),
  ["install", "--frozen", "--silent"],
  { cwd: repositoryRoot, encoding: "utf8", timeout: 300_000 }
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

test("the canonical skill source holds only well-formed skills", () => {
  assert.ok(canonicalSkillNames().length > 0);
  for (const skill of canonicalSkillNames()) {
    const document = join(sourceRoot, skill, "SKILL.md");
    assert.equal(lstatSync(document).isSymbolicLink(), false, skill);
    const { front } = splitFrontmatter(readFileSync(document, "utf8"));
    assert.match(front, new RegExp(`^name: ${skill}$`, "mu"));
    assert.doesNotMatch(front, /^description:\s*>/mu);
    frontmatterDescription(front);
  }
  assert.ok(curatedSkillNames().length > 0);
  for (const skill of curatedSkillNames()) {
    const document = join(curatedRoot, skill, "SKILL.md");
    assert.equal(lstatSync(document).isSymbolicLink(), false, skill);
    const { front } = splitFrontmatter(readFileSync(document, "utf8"));
    assert.match(front, /^name:\s*\S+/mu, skill);
    frontmatterDescription(front);
  }
});

/**
The curated skills are pinned by exactly one lockfile.

The GitHub sources are pinned in `rulesync.lock` and the npm sources in
`rulesync-npm.lock.json`, so the two lockfiles together cover the curated
directory exactly once.
*/
test("the curated skills are pinned by exactly one lockfile", () => {
  const lockedSkills = (lockfilePath: string): string[] => {
    const sources = asObject(asObject(readJson(lockfilePath)).sources);
    return Object.values(sources)
      .flatMap((entry) => Object.keys(asObject(asObject(entry).skills)))
      .sort(compareText);
  };
  const gitLocked = lockedSkills(rulesyncLockPath);
  const npmLocked = lockedSkills(rulesyncNpmLockPath);
  assert.deepEqual(
    [...gitLocked].filter((skill) => npmLocked.includes(skill)),
    [],
    "a curated skill is pinned by both lockfiles"
  );
  assert.deepEqual(
    [...gitLocked, ...npmLocked].sort(compareText),
    curatedSkillNames(),
    "the lockfiles do not cover the curated skills exactly"
  );
});

/**
The canonical skills source holds real directories only.

A package that ships agent skills used to be linked into `.rulesync/skills/`
as a symbolic link, and the Runtime's catalog reads that directory as the
canonical source: a link there is not a skill, it is an invalid entry that
fails the whole catalog. RuleSync owns every skill this repository
distributes, so the packages are installed for their CLIs and libraries
only, and their skills are fetched and pinned by RuleSync instead.
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
pnpm must not link a dependency's agent skills into the repository.

`skills.dirs` is pnpm's own skill distribution, and a non-empty list points
it at the canonical source, where its links shadow the RuleSync-managed
copies. An empty list turns that distribution off.
*/
test("pnpm does not distribute agent skills into the repository", () => {
  const workspace = readFileSync(pnpmWorkspacePath, "utf8");
  const lines = workspace.split("\n").map((line) => line.trim());
  const directoriesIndex = lines.indexOf("skills:");
  assert.notEqual(
    directoriesIndex,
    -1,
    "pnpm-workspace.yaml declares no skills block"
  );
  const emptyDirectoriesIndex = lines.indexOf("dirs: []", directoriesIndex);
  assert.notEqual(
    emptyDirectoriesIndex,
    -1,
    "pnpm still links agent skills somewhere"
  );
  assert.ok(
    lines.every((line) => !line.startsWith("permissions:")),
    "pnpm still grants a dependency a skill permission"
  );
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
  const treeOwners = skillTreeOwners();
  assert.ok(treeOwners.size > 0);
  for (const [tree, owner] of treeOwners) {
    const root = join(generated, tree);
    const expected = expectedSkillsForTarget(owner);
    assert.deepEqual(
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareText),
      expected,
      tree
    );
    for (const skill of expected) {
      const origin = skillSourceDirectory(skill);
      assert.deepEqual(
        files(join(root, skill)),
        files(origin),
        `${tree}/${skill}`
      );
      for (const relativePath of files(origin)) {
        if (relativePath !== "SKILL.md")
          assert.deepEqual(
            readFileSync(join(root, skill, relativePath)),
            readFileSync(join(origin, relativePath)),
            `${tree}/${skill}/${relativePath}`
          );
      }
    }
  }
});

test("a user-level skill reaches a repository folder only where it was asked for", () => {
  // A skill that declares `targets` is installed at user level, so a
  // repository copy would list it twice. The exception is a target that
  // asked for it by name, such as the Copilot cloud agent, which has no user
  // level of its own.
  const userLevel = new Set(userLevelSkills(sourceRoot));
  for (const [tree, owner] of skillTreeOwners()) {
    const projected = readdirSync(join(generated, tree), {
      withFileTypes: true
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const projectedUserLevel = projected.filter((name) => userLevel.has(name));
    for (const skill of projectedUserLevel) {
      const { front } = readSkill(repositoryRoot, skill);
      assert.ok(
        declaredTargets(front)?.includes(owner),
        `${tree}/${skill} duplicates a user-level skill in a folder that did not ask for it`
      );
    }
  }
});

test("generated documents preserve name, description, and body without targets", () => {
  const canonicalSet = new Set(canonicalSkillNames());
  for (const [tree] of skillTreeOwners()) {
    const generatedSkills = readdirSync(join(generated, tree), {
      withFileTypes: true
    });
    for (const skill of generatedSkills) {
      if (!skill.isDirectory()) continue;
      const sourceDocument = readFileSync(
        join(skillSourceDirectory(skill.name), "SKILL.md"),
        "utf8"
      );
      const generatedDocument = readFileSync(
        generatedSkillPath(tree, skill.name),
        "utf8"
      );
      const { front: sourceFront, body: sourceBody } =
        splitFrontmatter(sourceDocument);
      const { front, body } = splitFrontmatter(generatedDocument);
      const declaredName = /^name:[ \t]*(?<value>\S.*)$/mu.exec(sourceFront)
        ?.groups?.value;
      assert.ok(declaredName, `${tree}/${skill.name} source missing name`);
      if (canonicalSet.has(skill.name)) {
        assert.equal(declaredName, skill.name, `${tree}/${skill.name}`);
      }
      assert.match(front, new RegExp(`^name:[ \t]*${declaredName}$`, "mu"));
      assert.equal(
        frontmatterDescription(front),
        frontmatterDescription(sourceFront)
      );
      assert.doesNotMatch(front, /^targets:/mu);
      assert.equal(body, sourceBody);
    }
  }
});

test("Rulesync check detects edited, stale, and missing generated skills", () => {
  assert.equal(runRulesync(generated, "--check").status, 0);
  const firstTree = skillTreeOwners().keys().next();
  assert.ok(!firstTree.done, "a skill tree exists");
  const tree = firstTree.value;
  const skill = readdirSync(join(generated, tree), {
    withFileTypes: true
  }).find((entry) => entry.isDirectory());
  assert.ok(skill, "a skill exists");
  for (const [label, damage] of [
    [
      "edited",
      (root: string) =>
        writeFileSync(join(root, tree, skill.name, "SKILL.md"), "drift\n")
    ],
    [
      "stale",
      (root: string) => {
        const path = join(root, tree, "stale");
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "SKILL.md"), "x\n");
      }
    ],
    [
      "missing",
      (root: string) => rmSync(join(root, tree, skill.name, "SKILL.md"))
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
  assert.match(materializer, /runRulesyncGitignore/);
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

test("the canonical source is the only tracked RuleSync input", () => {
  const stray = readdirSync(join(repositoryRoot, "tests", "fixtures"), {
    withFileTypes: true
  })
    .filter((entry) => entry.name.startsWith("rulesync-"))
    .map((entry) => entry.name);
  assert.deepEqual(stray, []);
});

/**
A skill that documents a CLI must document the CLI this repository runs.

The npm-transport sources fetch the skills a published package ships, so
the locked release has to be the one the workspace installs: a skill from an
older release describes commands the installed CLI does not have. The
manifest declares no version, the way the GitHub sources declare no ref:
`rulesync install --frozen` fetches the release the lockfile resolved, and
the lockfile is what pins it.
*/
test("every npm-transport source locks the version the workspace installs", () => {
  const config = parseJsoncObject(
    readFileSync(rulesyncConfigPath, "utf8"),
    "rulesync.jsonc"
  ) as Record<string, unknown>;
  const sources = config.sources as Array<Record<string, unknown>>;
  const npmSources = new Map(
    sources
      .filter((entry) => entry.transport === "npm")
      .map((entry) => [entry.source as string, entry])
  );
  assert.ok(npmSources.size > 0);
  const npmLock = asObject(readJson(rulesyncNpmLockPath));
  const npmLocked = asObject(npmLock.sources);
  for (const [source, entry] of npmSources) {
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
    assert.equal(
      new Set(declared).size,
      1,
      `${source} is installed at more than one version`
    );
    const installed = [...new Set(declared)][0]!;
    const locked = asObject(npmLocked[source]);
    assert.equal(locked.requestedVersion, "latest", source);
    assert.equal(locked.resolvedVersion, installed, source);
    // The manifest names the package, not a version: the lockfile pins it.
    assert.equal(entry.ref, undefined, source);
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
  const roleFiles = readdirSync(rolesRoot).filter((file) =>
    file.endsWith(".toml")
  );
  for (const file of roleFiles) {
    const matches = readFileSync(join(rolesRoot, file), "utf8").matchAll(
      /name = "([^"]+)"\s*\nenabled = true/gu
    );
    for (const match of matches)
      enabled.set(match[1]!, [...(enabled.get(match[1]!) ?? []), file]);
  }
  assert.ok(enabled.size > 0, "roles enable skills");
  for (const [skill, roles] of enabled)
    assert.ok(
      userLevel.has(skill),
      `${skill} (enabled by ${roles.join(", ")}) is not installed at user level`
    );
});

/**
A skill may show what another skill could look like. Such an example names
files on purpose that the skill does not ship, so the reference check
ignores the paths inside a `skill-example` region.
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
        const isBundled = bundled.test(reference);
        const isRepositoryPath = repository.test(reference);
        const isMissingFromSkill = !inRepository && isBundled && !inSkill;
        const isMissingFromRepository =
          !inRepository && !isBundled && isRepositoryPath;
        if (isMissingFromSkill || isMissingFromRepository)
          missing.push(`${skill}/${document}: ${reference}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("user-level skill selection follows YAML target declarations, not formatting", () => {
  const root = mkdtempSync(join(tmpdir(), "autodev-skill-targets-"));
  try {
    const writeSkill = (name: string, metadata: string): void => {
      const directory = join(root, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\n${metadata}\n---\nBody.\n`
      );
    };
    writeSkill("default", "description: Repository only.");
    writeSkill("quoted", 'description: Shared.\n"targets": []');
    writeSkill("block", "description: Shared.\ntargets:\n  - copilot");
    writeSkill("nested", "description: Shared?\nextra:\n  targets: []");
    assert.deepEqual(userLevelSkills(root), ["block", "quoted"]);
    writeSkill("invalid", "description: Invalid.\ntargets: copilot");
    assert.throws(
      () => userLevelSkills(root),
      /targets must be a string array/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    assert.deepEqual(
      staleUserSkillLinks(skills, user, ["kept"]).sort(compareText),
      [join(user, "deleted"), join(user, "repo-only")]
    );
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
