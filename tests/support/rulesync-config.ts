/**
The canonical RuleSync configuration and the projections it owns.

`rulesync.jsonc` is the single source of truth for which provider
projection owns which feature. The suites that need that ownership read it
here instead of keeping a copy of the map, so adding a target is a
configuration change and not a test change.
*/

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseJsoncObject } from "@simulatorlife/autodev-data/files";

import { compareText } from "./ordering.ts";

export interface RulesyncConfig {
  readonly targets: Readonly<Record<string, readonly string[]>>;
  readonly outputRoots: Readonly<Record<string, readonly string[]>>;
  readonly features: readonly string[];
  readonly global: boolean;
  readonly delete: boolean;
  readonly gitignoreDestination: string;
}

/**
Read `rulesync.jsonc`, the repository's canonical target state.
*/
export function readRulesyncConfig(repositoryRoot: string): RulesyncConfig {
  const source = parseJsoncObject(
    readFileSync(path.join(repositoryRoot, "rulesync.jsonc"), "utf8"),
    "rulesync.jsonc"
  );
  const targets = source.targets;
  const outputRoots = source.outputRoots;
  assertRecord(targets, "rulesync.jsonc targets");
  assertRecord(outputRoots, "rulesync.jsonc outputRoots");
  return {
    targets: targets as Record<string, readonly string[]>,
    outputRoots: outputRoots as Record<string, readonly string[]>,
    features: Array.isArray(source.features)
      ? (source.features as readonly string[])
      : [],
    global: source.global === true,
    delete: source.delete === true,
    gitignoreDestination:
      typeof source.gitignoreDestination === "string"
        ? source.gitignoreDestination
        : ""
  };
}

function assertRecord(
  value: unknown,
  label: string
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

/**
The targets that own a feature, in the order the configuration lists them.
*/
export function targetsOwningFeature(
  config: RulesyncConfig,
  feature: string
): string[] {
  return Object.entries(config.targets)
    .filter(([, features]) => features.includes(feature))
    .map(([target]) => target);
}

/**
Every feature the configuration enables, across every target.
*/
export function configuredFeatures(config: RulesyncConfig): Set<string> {
  return new Set(Object.values(config.targets).flat());
}

/**
The RuleSync executable this repository installs.
*/
export function rulesyncBinary(repositoryRoot: string): string {
  const binary = path.join(repositoryRoot, "node_modules", ".bin", "rulesync");
  if (!existsSync(binary)) {
    throw new Error(
      `missing-rulesync ${binary}; run pnpm install --frozen-lockfile`
    );
  }
  return binary;
}

const WOULD_WRITE_PATTERN =
  /^\[DRY RUN\] Would (?:write|create directory|delete file): "?(?<path>[^"]+?)"?$/gmu;

/**
The paths RuleSync's own drift check reports as out of date.

RuleSync's `--check` mode is the native drift gate: it reports every file
it would rewrite, relative to the repository root. The repository's
generated trees are not tracked, so a drifted path only matters when the
repository tracks it.
*/
function rulesyncDriftedPaths(repositoryRoot: string): string[] {
  const result = spawnSync(
    rulesyncBinary(repositoryRoot),
    ["generate", "--check"],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 300_000 }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const root = path.resolve(repositoryRoot);
  const paths = new Set<string>();
  for (const match of output.matchAll(WOULD_WRITE_PATTERN)) {
    const drifted = match.groups?.path;
    if (!drifted) continue;
    const relative = path.relative(root, path.resolve(drifted));
    if (!relative.startsWith(".."))
      paths.add(relative.split(path.sep).join("/"));
  }
  return [...paths].sort((left, right) => compareText(left, right));
}

/**
The tracked files RuleSync's drift check reports as out of date.
*/
export function driftedTrackedProjections(repositoryRoot: string): string[] {
  const tracked = new Set(
    spawnSync("git", ["ls-files"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    })
      .stdout.split("\n")
      .filter(Boolean)
  );
  return rulesyncDriftedPaths(repositoryRoot).filter((drifted) =>
    tracked.has(drifted)
  );
}

/**
The skill trees a target writes, observed from the tool.

Which tree a target owns is RuleSync's business, not this repository's, so
the mapping is observed rather than restated: the target is run on its own
and the trees it produced are read back.
*/
export function skillTreesWrittenBy(
  repositoryRoot: string,
  target: string
): string[] {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "autodev-rulesync-tree-"));
  try {
    const result = spawnSync(
      rulesyncBinary(repositoryRoot),
      [
        "generate",
        "--config",
        "rulesync.jsonc",
        "--input-roots",
        ".rulesync",
        "--output-roots",
        outputRoot,
        "--features",
        "skills",
        "--targets",
        target,
        "--silent"
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 300_000 }
    );
    if (result.status !== 0) {
      throw new Error(
        `RuleSync generation for ${target} failed:\n${result.stderr ?? ""}`
      );
    }
    return skillTrees(outputRoot);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
}

/**
The skill trees below `root`, as relative paths such as `.agents/skills`.
*/
function skillTrees(root: string): string[] {
  const trees = new Set<string>();
  const visit = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === "skills") {
        trees.add(relative);
        continue;
      }
      visit(path.join(directory, entry.name), relative);
    }
  };
  visit(root, "");
  return [...trees].sort((left, right) => compareText(left, right));
}
