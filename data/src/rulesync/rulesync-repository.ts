import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type HookAction,
  type HookDeclarationOrigin,
  type HookEvent,
  type HookEventDeclaration,
  isHookEvent,
  type McpServerDefinition,
  type McpServerLaunchConfiguration,
  type McpServerTransport,
  type McpTargetOverride,
  type PromptVersion,
  type RuleSyncHooksState,
  type RuleSyncMcpLaunchState,
  type RuleSyncMcpState,
  type RuleSyncValidationIssue,
  type SkillDefinition
} from "@simulatorlife/autodev-core";
import {
  applyEdits,
  type EditResult,
  type FormattingOptions,
  modify,
  parse,
  type ParseError,
  printParseErrorCode
} from "jsonc-parser";
import { parse as parseYaml } from "yaml";

import {
  COMMANDS_SOURCE,
  isRecord,
  parseRuleSyncCommand,
  type RuleSyncCommand,
  RuleSyncCommandValidationError
} from "./command-parser.ts";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COLLATOR = new Intl.Collator();

/**
 * The canonical MCP declaration's path, in the repository.
 *
 * One spelling of it: the declaration is read, written and digested under
 * this name, and a second spelling would be a second file to keep in step.
 */
const MCP_SOURCE = ".rulesync/mcp.jsonc" as const;

/**
 * The canonical hook declaration's path, in the repository.
 *
 * One spelling of it: the declaration is read, written and digested under this
 * name, and a second spelling would be a second file to keep in step.
 */
const HOOKS_SOURCE = ".rulesync/hooks.jsonc" as const;
const MD_EXTENSION_PATTERN = /\.md$/u;
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const COMMAND_CONTENT_MAX_BYTES = 48_000;
const SKILL_SOURCE_MAX_BYTES = 48_000;
const SKILL_SOURCE_UNSAFE_MESSAGE =
  "Canonical RuleSync skill source could not be accessed safely.";
const COMMAND_DIFF_MAX_BYTES = 196_608;
/**
 * How many committed versions one page of a command's history carries when a
 * request names no size, and the largest page a request may ask for. Both are
 * part of the contract the Control API answers with, so they are exported
 * rather than kept private to this file.
 */
export const RULE_SYNC_COMMAND_HISTORY_PAGE_SIZE = 20;
export const RULE_SYNC_COMMAND_HISTORY_MAX_PAGE_SIZE = 100;

/** The page a request that names no page gets: the newest history. */
const FIRST_COMMAND_HISTORY_PAGE: RuleSyncCommandHistoryPage = {
  offset: 0,
  limit: RULE_SYNC_COMMAND_HISTORY_PAGE_SIZE
};
const COMMAND_HISTORY_LINE_SPLIT_PATTERN = /\r?\n/u;
const COMMAND_GIT_TIMEOUT_MS = 3000;
const COMMAND_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SKILLS_SOURCE = ".rulesync/skills" as const;
const SKILL_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/u;
const SKILL_DESCRIPTION_MAX = 512;
const SKILL_CONTENT_MAX = 20_000;
const SOURCE_UPDATE_QUEUES = new Map<string, Promise<void>>();
const COMMAND_PARSED_CACHE = new Map<
  string,
  { content: string; command: RuleSyncCommand }
>();
const SKILL_ENTRY_CACHE = new Map<
  string,
  { text: string; entry: SkillEntry }
>();
const COMMAND_HISTORY_CACHE = new Map<
  string,
  { timestamp: number; history: RuleSyncCommandHistory }
>();
const COMMAND_HISTORY_CACHE_TTL_MS = 5000;

export function clearRuleSyncCachesForTests(): void {
  COMMAND_PARSED_CACHE.clear();
  SKILL_ENTRY_CACHE.clear();
  COMMAND_HISTORY_CACHE.clear();
}

async function withSourceUpdateLock<T>(
  sourcePath: string,
  update: () => Promise<T>
): Promise<T> {
  const previous = SOURCE_UPDATE_QUEUES.get(sourcePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  SOURCE_UPDATE_QUEUES.set(sourcePath, current);
  await previous;
  try {
    return await update();
  } finally {
    release();
    if (SOURCE_UPDATE_QUEUES.get(sourcePath) === current) {
      SOURCE_UPDATE_QUEUES.delete(sourcePath);
    }
  }
}

/**
 * Why one skill's frontmatter cannot be applied, or `null` when it can.
 *
 * Split from the walk so the checks stay a readable list rather than a wall of
 * conditions, and so each one can say what is wrong instead of contributing to a
 * single boolean.
 */
function skillFrontmatterProblem(
  metadata: unknown,
  directoryName: string
): string | null {
  if (!isRecord(metadata)) {
    return "The skill frontmatter must be a mapping of fields.";
  }
  if (metadata.name !== directoryName) {
    return `The skill frontmatter declares ${
      typeof metadata.name === "string" ? `"${metadata.name}"` : "no name"
    }, but the directory is "${directoryName}". A skill must be addressable by the name it declares.`;
  }
  if (typeof metadata.description !== "string") {
    return "The skill frontmatter must declare a description string.";
  }
  if (metadata.description.trim().length === 0) {
    return "The skill frontmatter declares an empty description.";
  }
  return null;
}

function validateSkillSource(name: string, content: string): void {
  const frontmatter = content.match(SKILL_FRONTMATTER_PATTERN);
  if (!frontmatter) {
    throw new RuleSyncSkillValidationError(
      "Skill source must have YAML frontmatter."
    );
  }
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter[1]!);
  } catch {
    throw new RuleSyncSkillValidationError(
      "Skill source frontmatter is not valid YAML."
    );
  }
  const problem = skillFrontmatterProblem(metadata, name);
  if (problem !== null) throw new RuleSyncSkillValidationError(problem);
}

/** One located fault in the skill catalog. */
function invalidSkills(location: string, message: string): RuleSyncSkillsState {
  return {
    source: SKILLS_SOURCE,
    valid: false,
    issues: [{ location, message }],
    skills: []
  };
}

function skillCatalogError(state: RuleSyncSkillsState): Error {
  return state.valid === null
    ? new RuleSyncSkillSourceUnavailableError(
        "Canonical RuleSync skill catalog has not been observed."
      )
    : new RuleSyncSkillValidationError(
        "Canonical RuleSync skill catalog is invalid."
      );
}

function skillDirectoryError(directory: CanonicalRuleSyncDirectory): Error {
  return directory.valid === null
    ? new RuleSyncSkillSourceUnavailableError(
        "Canonical RuleSync skill catalog has not been observed."
      )
    : new Error(SKILL_SOURCE_UNSAFE_MESSAGE);
}

type SkillEntry =
  /** An entry that is not a skill at all, and not a fault. */
  | { readonly kind: "ignored" }
  | { readonly kind: "skill"; readonly skill: SkillDefinition }
  | {
      readonly kind: "invalid";
      readonly issue: readonly [location: string, message: string];
    };

/**
 * One `.rulesync/skills` entry, judged on its own.
 *
 * Split out of the walk so each fault stays a single named reason rather than a
 * branch in a growing loop, and so the rules live in one place instead of being
 * scattered between the walk and its caller. The walk reports the first fault it
 * meets; this says why that one entry is a fault.
 */
function readSkillEntry(skillsDir: string, entry: Dirent): SkillEntry {
  const skillLocation = `.rulesync/skills/${entry.name}/SKILL.md`;
  const unreadable = (error: unknown): SkillEntry => ({
    kind: "invalid",
    issue: [
      skillLocation,
      `"${skillLocation}" could not be read: ${describeFileSystemError(error)}.`
    ]
  });
  if (entry.isSymbolicLink()) {
    return {
      kind: "invalid",
      issue: [
        `.rulesync/skills/${entry.name}`,
        `".rulesync/skills/${entry.name}" is a symbolic link, and canonical skills are read from the repository itself.`
      ]
    };
  }
  if (!entry.isDirectory()) return { kind: "ignored" };
  if (!SKILL_NAME_PATTERN.test(entry.name)) {
    return {
      kind: "invalid",
      issue: [
        `.rulesync/skills/${entry.name}`,
        `"${entry.name}" is not a usable skill directory name: expected lowercase letters, digits, and hyphens.`
      ]
    };
  }
  const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
  let skillStat: ReturnType<typeof lstatSync>;
  try {
    skillStat = lstatSync(skillPath);
  } catch (error) {
    return unreadable(error);
  }
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
    return {
      kind: "invalid",
      issue: [
        skillLocation,
        `"${skillLocation}" is not a regular file in the skill directory.`
      ]
    };
  }
  if (skillStat.size > SKILL_SOURCE_MAX_BYTES) {
    return {
      kind: "invalid",
      issue: [
        skillLocation,
        `"${skillLocation}" exceeds the ${SKILL_SOURCE_MAX_BYTES}-byte source limit.`
      ]
    };
  }
  let text: string;
  try {
    text = readFileSync(skillPath, "utf8");
  } catch (error) {
    return unreadable(error);
  }
  const cachedSkill = SKILL_ENTRY_CACHE.get(skillLocation);
  if (cachedSkill && cachedSkill.text === text) {
    return cachedSkill.entry;
  }
  const frontmatter = text.match(SKILL_FRONTMATTER_PATTERN);
  if (!frontmatter) {
    return {
      kind: "invalid",
      issue: [skillLocation, `"${skillLocation}" must have YAML frontmatter.`]
    };
  }
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter[1]!);
  } catch {
    return {
      kind: "invalid",
      issue: [
        skillLocation,
        `"${skillLocation}" frontmatter is not valid YAML.`
      ]
    };
  }
  const problem = skillFrontmatterProblem(metadata, entry.name);
  if (problem !== null) {
    return { kind: "invalid", issue: [skillLocation, problem] };
  }
  const skillEntry: SkillEntry = {
    kind: "skill",
    skill: {
      name: entry.name,
      description: (metadata as { description: string }).description,
      path: skillLocation
    }
  };
  SKILL_ENTRY_CACHE.set(skillLocation, { text, entry: skillEntry });
  return skillEntry;
}

export interface RuleSyncCommandsState {
  readonly source: typeof COMMANDS_SOURCE;
  readonly valid: boolean | null;
  /** Why the source is invalid; empty when valid or not observed. */
  readonly issues: readonly RuleSyncValidationIssue[];
  readonly commands: readonly RuleSyncCommand[];
}

export interface RuleSyncCommandUpdateInput {
  readonly name: string;
  readonly expectedRevision: string;
  readonly content: string;
}

/**
 * The outcome of reading one canonical command.
 *
 * "The command does not exist" and "the command could not be read" are two
 * different claims, and a caller that answers "unknown prompt" for both tells
 * an operator their prompt is gone when it is there and unreadable. The
 * catalogue's own read already tells them apart -- an unreadable file makes
 * the whole catalogue invalid and names the fault -- so the detail read names
 * the same fault rather than swallowing it.
 */
export type RuleSyncCommandRead =
  | {
      readonly status: "found";
      readonly command: RuleSyncCommand;
    }
  | {
      readonly status: "not-found";
    }
  | {
      readonly status: "unreadable";
      /** Why the command could not be read, in the operator's terms. */
      readonly reason: string;
    };

export interface RuleSyncCommandVersionReference {
  readonly versionHash: string;
  readonly updatedAt: string;
}

/**
 * Which slice of a command's committed history to read.
 *
 * `offset` counts the versions already passed over and `limit` says how many
 * this page asks for. The slice is a window onto one ordered history, so
 * `hasMore` on a page answers "is there a version after this page", not "is
 * this the end of the history".
 */
export interface RuleSyncCommandHistoryPage {
  readonly offset: number;
  readonly limit: number;
}

export type RuleSyncCommandHistory =
  | {
      readonly status: "available";
      readonly versions: readonly RuleSyncCommandVersionReference[];
      readonly hasMore: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly versions: readonly [];
      readonly hasMore: false;
    };

export interface RuleSyncCommandVersion extends PromptVersion {
  readonly diff: string;
}

/**
 * The one "this repository's command history cannot be read" answer.
 *
 * `loadCommandHistory` used to spell this object out at five separate exits --
 * one per `catch` in a nest of them -- so a reader comparing the branches had
 * to diff the five literals to learn they were the same. Every field is
 * `readonly`, and `versions` is typed `readonly []`, so one shared instance is
 * as safe as five copies.
 */
const UNAVAILABLE_COMMAND_HISTORY: RuleSyncCommandHistory = {
  status: "unavailable",
  versions: [],
  hasMore: false
};

/**
 * Whether a requested page is one this repository can answer.
 *
 * The page is a transport-level window, so a page that is not a whole offset
 * of zero or more, or a limit outside the bounded range, is refused rather
 * than clamped: a clamped page would answer a different question than the one
 * that was asked.
 */
function isCommandHistoryPage(page: RuleSyncCommandHistoryPage): boolean {
  return (
    Number.isInteger(page.offset) &&
    page.offset >= 0 &&
    Number.isInteger(page.limit) &&
    page.limit >= 1 &&
    page.limit <= RULE_SYNC_COMMAND_HISTORY_MAX_PAGE_SIZE
  );
}

/**
 * A reader for this repository's Git.
 *
 * Every Git answer in this file is bounded and time-limited the same way, so
 * the runner is written once: a reader that forgot the timeout would let one
 * hung command hold a request open.
 */
function gitRunner(
  repositoryRoot: string
): (args: readonly string[], maxBuffer: number) => string {
  return (args, maxBuffer) =>
    execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: COMMAND_GIT_TIMEOUT_MS
    });
}

/** Runs `git`, or reports that it could not answer. */
function tryGit(
  git: (args: readonly string[], maxBuffer: number) => string,
  args: readonly string[],
  maxBuffer: number
): string | null {
  try {
    return git(args, maxBuffer).trim();
  } catch {
    return null;
  }
}

/**
 * Why there is no command history to report, when `git log` could not produce
 * any.
 *
 * `git log` fails for reasons a caller must not conflate, and the previous
 * three nested `catch` blocks -- one retyped "unavailable" object in each --
 * made the distinction something you had to reconstruct from control flow:
 *
 * - **not a repository.** Git answers `--is-inside-work-tree` with anything but
 *   `true`. There is no history and no repository to have it in.
 * - **a repository, but this command file has no history.** `--verify HEAD`
 *   succeeds, so the repository is real and simply has nothing for this path.
 * - **a real repository with no commits yet.** `--verify HEAD` fails, but
 *   `--porcelain` still answers, so this is a healthy repository with an empty
 *   history: reported *available* with no versions, which is what a freshly
 *   initialised repository genuinely is.
 * - **git cannot answer at all.** Everything above fails. Nothing is known, so
 *   this is unavailable.
 */
function commandHistoryFallback(
  git: (args: readonly string[], maxBuffer: number) => string
): RuleSyncCommandHistory {
  const insideWorkTree = tryGit(
    git,
    ["rev-parse", "--is-inside-work-tree"],
    1024
  );
  if (insideWorkTree !== null && insideWorkTree !== "true")
    return UNAVAILABLE_COMMAND_HISTORY;
  // Only worth asking whether the repository has commits if it is one. When
  // `--is-inside-work-tree` could not answer, git is unusable here and the
  // `--porcelain` probe below is the only remaining way to tell an empty
  // repository from a broken one.
  if (
    insideWorkTree === "true" &&
    tryGit(git, ["rev-parse", "--verify", "HEAD"], 1024) !== null
  )
    return UNAVAILABLE_COMMAND_HISTORY;
  // Either git could not answer about the tree, or this is a repository with no
  // commits yet. `--porcelain` is what tells those apart: it answers in the
  // second case and fails in the first.
  const workingTreeAnswers =
    tryGit(git, ["status", "--porcelain"], 8192) !== null;
  return workingTreeAnswers
    ? { status: "available", versions: [], hasMore: false }
    : UNAVAILABLE_COMMAND_HISTORY;
}

export class RuleSyncCommandHistoryUnavailableError extends Error {
  constructor(message = "Canonical command history is unavailable.") {
    super(message);
    this.name = "RuleSyncCommandHistoryUnavailableError";
  }
}

export class RuleSyncCommandConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyncCommandConflictError";
  }
}

export interface RuleSyncSkillsState {
  readonly source: typeof SKILLS_SOURCE;
  readonly valid: boolean | null;
  /** Why the source is invalid; empty when valid or not observed. */
  readonly issues: readonly RuleSyncValidationIssue[];
  readonly skills: readonly SkillDefinition[];
}

export interface RuleSyncSkillPromotionInput {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

export interface RuleSyncSkillSource {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly revision: string;
}

export interface RuleSyncSkillSourceUpdateInput {
  readonly name: string;
  readonly expectedRevision: string;
  readonly content: string;
}

export interface RuleSyncSkillArtifact {
  readonly name: string;
  readonly path: string;
  readonly uri: string;
  readonly revision: string;
}

export class RuleSyncSkillConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyncSkillConflictError";
  }
}

export class RuleSyncSkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyncSkillValidationError";
  }
}

export class RuleSyncSkillSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyncSkillSourceUnavailableError";
  }
}

/**
 * The canonical MCP declaration changed since it was loaded.
 *
 * A conflict is not a failure of the write: it means another writer changed
 * the declaration first, and the caller has to load it again to see what it
 * now says.
 */
export class RuleSyncMcpConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyncMcpConflictError";
  }
}

/** The requested MCP declaration change cannot be expressed. */
export class RuleSyncMcpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyncMcpValidationError";
  }
}

/**
 * The canonical hook declaration changed since it was loaded.
 *
 * A conflict is not a failure of the write: it means another writer changed the
 * declaration first, and the caller has to load it again to see what it now
 * says.
 */
export class RuleSyncHooksConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyncHooksConflictError";
  }
}

/** The requested hook declaration change cannot be expressed. */
export class RuleSyncHooksValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyncHooksValidationError";
  }
}

export interface RuleSyncHookEventUpdateInput {
  /** The event whose action list is written. */
  readonly event: HookEvent;
  /** The target whose declaration is written. */
  readonly target: string;
  /**
   * The event's complete action list.
   *
   * Complete, because the declaration replaces an event's list rather than
   * adding to it: a partial list would be read as the whole list and would
   * drop the actions it left out.
   */
  readonly actions: readonly HookAction[];
  /** The revision of the canonical declaration the caller loaded. */
  readonly expectedRevision: string;
}

export interface RuleSyncHookEventUpdateResult {
  readonly source: ".rulesync/hooks.jsonc";
  readonly event: HookEvent;
  readonly target: string;
  /** The revision of the declaration after the write. */
  readonly revision: string;
  /**
   * Where the written declaration lives.
   *
   * `shared` means the shared declaration holds it and every target inherits
   * it; `target` means the target's own declaration holds it.
   */
  readonly origin: HookDeclarationOrigin;
  /** The action list the target now declares for the event. */
  readonly actions: readonly HookAction[];
}

/**
 * The launch configuration one write sets.
 *
 * A key that is absent is left as the declaration has it; a key that is `null`
 * is removed. The write owns these keys and nothing else, so the target's own
 * enablement, approval mode and tool allowlist survive it.
 */
export interface RuleSyncMcpLaunchUpdate {
  readonly command?: string | null;
  readonly args?: readonly string[] | null;
  readonly cwd?: string | null;
  readonly url?: string | null;
  readonly bearerTokenEnvVar?: string | null;
  readonly httpHeaders?: Readonly<Record<string, string>> | null;
}

export interface RuleSyncMcpLaunchUpdateInput {
  /** The server whose launch configuration is written. */
  readonly name: string;
  /** The target whose own declaration is written. */
  readonly target: string;
  readonly launch: RuleSyncMcpLaunchUpdate;
  /** The revision of the canonical declaration the caller loaded. */
  readonly expectedRevision: string;
}

export interface RuleSyncMcpLaunchUpdateResult {
  readonly source: ".rulesync/mcp.jsonc";
  readonly name: string;
  readonly target: string;
  /** The revision of the declaration after the write. */
  readonly revision: string;
  /** The launch configuration the target now declares. */
  readonly launch: McpServerLaunchConfiguration;
}

function mcpTransport(config: Record<string, unknown>): McpServerTransport {
  const hasCommand =
    typeof config.command === "string" && config.command.trim().length > 0;
  const hasUrl = typeof config.url === "string" && config.url.trim().length > 0;
  if (hasCommand === hasUrl) return "unknown";
  return hasCommand ? "stdio" : "http";
}

type MutableMcpServer = {
  enabled: boolean | null;
  transport: McpServerTransport;
  targetOverrides: McpTargetOverride[];
  command?: string;
  args?: readonly string[];
  url?: string;
  envKeys?: readonly string[];
  cwd?: string;
  defaultToolsApprovalMode?: string;
};

function isMcpConfig(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (value.disabled === undefined || typeof value.disabled === "boolean")
  );
}

function projectBaseMcpServer(
  config: Record<string, unknown>
): MutableMcpServer {
  const args =
    Array.isArray(config.args) &&
    config.args.every((arg) => typeof arg === "string")
      ? (config.args as string[])
      : undefined;
  const envKeys = isRecord(config.env)
    ? Object.keys(config.env).sort(COLLATOR.compare)
    : undefined;
  const defaultToolsApprovalMode =
    typeof config.default_tools_approval_mode === "string"
      ? config.default_tools_approval_mode
      : undefined;

  return {
    enabled: config.disabled !== true,
    transport: mcpTransport(config),
    targetOverrides: [],
    ...(typeof config.command === "string" ? { command: config.command } : {}),
    ...(args ? { args } : {}),
    ...(typeof config.url === "string" ? { url: config.url } : {}),
    ...(envKeys ? { envKeys } : {}),
    ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
    ...(defaultToolsApprovalMode ? { defaultToolsApprovalMode } : {})
  };
}

/**
 * The base servers, or the first declaration that could not be read.
 *
 * Returning the offending key rather than a bare `null` is what lets the caller
 * name it. The alternative -- a second pass that re-walks the same structures
 * to find the fault -- is a second copy of the rules, and a second copy of a
 * validation rule drifts toward accepting what the first one refuses.
 */
function parseBaseMcpServers(declarations: Record<string, unknown>):
  | {
      readonly servers: Map<string, MutableMcpServer>;
      readonly invalid: null;
    }
  | {
      readonly servers: null;
      readonly invalid: {
        readonly name: string;
        /**
         * Which half is at fault. A server name that cannot be addressed and a
         * declaration that is not an MCP server are different edits in the same
         * file, and reporting one as the other sends an operator to fix the line
         * that was already correct.
         */
        readonly reason: "name" | "declaration";
      };
    } {
  const servers = new Map<string, MutableMcpServer>();
  for (const [name, config] of Object.entries(declarations)) {
    if (!name.trim()) {
      return { servers: null, invalid: { name, reason: "name" } };
    }
    if (!isMcpConfig(config)) {
      return { servers: null, invalid: { name, reason: "declaration" } };
    }
    servers.set(name, projectBaseMcpServer(config));
  }
  return { servers, invalid: null };
}

function isTargetMcpConfig(
  target: string,
  value: unknown
): value is Record<string, unknown> {
  return (
    target !== "$schema" &&
    target !== "mcpServers" &&
    isRecord(value) &&
    "mcpServers" in value
  );
}

/**
 * Apply every target's overrides, or name the target and server that failed.
 *
 * The base declaration and an override can both be malformed, and they are
 * different edits in the same file -- `mcpServers.lsp` against the top-level
 * `mcpServers` against `codex.cli.mcpServers.lsp` -- so the report carries both
 * halves of the location rather than one of them.
 */
function applyMcpTargetOverrides(
  document: Record<string, unknown>,
  servers: Map<string, MutableMcpServer>
): { readonly target: string; readonly server: string } | null {
  for (const [target, targetConfig] of Object.entries(document)) {
    if (!isTargetMcpConfig(target, targetConfig)) continue;
    const overrides = targetConfig.mcpServers;
    if (!isRecord(overrides)) return { target, server: "mcpServers" };
    const invalidName = applyMcpOverridesForTarget(target, overrides, servers);
    if (invalidName !== null) return { target, server: invalidName };
  }
  return null;
}

/** The first server whose override could not be read, or `null` when all applied. */
function applyMcpOverridesForTarget(
  target: string,
  overrides: Record<string, unknown>,
  servers: Map<string, MutableMcpServer>
): string | null {
  for (const [name, config] of Object.entries(overrides)) {
    if (config !== null && !isMcpConfig(config)) return name;
    let server = servers.get(name);
    if (!server) {
      server = {
        enabled: null,
        transport: config === null ? "unknown" : mcpTransport(config),
        targetOverrides: []
      };
      servers.set(name, server);
    }
    server.targetOverrides.push(projectMcpTargetOverride(target, config));
  }
  return null;
}

function projectMcpTargetOverride(
  target: string,
  config: unknown
): McpTargetOverride {
  const definition =
    config === null ? null : (config as Record<string, unknown>);
  const enabled = definition !== null && definition.disabled !== true;
  const defaultToolsApprovalMode =
    typeof definition?.default_tools_approval_mode === "string"
      ? definition.default_tools_approval_mode
      : undefined;
  const enabledTools =
    Array.isArray(definition?.enabled_tools) &&
    definition.enabled_tools.every((tool) => typeof tool === "string")
      ? (definition.enabled_tools as string[])
      : undefined;

  return {
    target,
    enabled,
    ...(defaultToolsApprovalMode ? { defaultToolsApprovalMode } : {}),
    ...(enabledTools ? { enabledTools } : {})
  };
}

function projectMcpDefinitions(
  servers: Map<string, MutableMcpServer>
): McpServerDefinition[] {
  return Array.from(servers, ([name, definition]) => ({
    name,
    enabled: definition.enabled,
    transport: definition.transport,
    targetOverrides: definition.targetOverrides.sort((left, right) =>
      COLLATOR.compare(left.target, right.target)
    ),
    ...(definition.command ? { command: definition.command } : {}),
    ...(definition.args ? { args: definition.args } : {}),
    ...(definition.url ? { url: definition.url } : {}),
    ...(definition.envKeys ? { envKeys: definition.envKeys } : {}),
    ...(definition.cwd ? { cwd: definition.cwd } : {}),
    ...(definition.defaultToolsApprovalMode
      ? { defaultToolsApprovalMode: definition.defaultToolsApprovalMode }
      : {})
  })).sort((left, right) => COLLATOR.compare(left.name, right.name));
}

function parseMcpState(content: string): RuleSyncMcpState | null {
  const source = MCP_SOURCE;
  const errors: ParseError[] = [];
  const document: unknown = parse(content, errors, {
    allowTrailingComma: true
  });
  if (errors.length > 0) {
    return {
      source,
      valid: false,
      issues: errors.map((error) => jsoncParseIssue(content, error)),
      servers: []
    };
  }
  if (!isRecord(document)) {
    return {
      source,
      valid: false,
      issues: [
        { location: source, message: "The MCP source must be a JSON object." }
      ],
      servers: []
    };
  }
  const declarations = document.mcpServers;
  if (!isRecord(declarations)) {
    return {
      source,
      valid: false,
      issues: [
        {
          location: "mcpServers",
          message: 'The MCP source must have an "mcpServers" object.'
        }
      ],
      servers: []
    };
  }

  const { servers, invalid } = parseBaseMcpServers(declarations);
  if (servers === null) {
    return {
      source,
      valid: false,
      issues: [
        invalid.reason === "name"
          ? {
              location: "mcpServers",
              message:
                "The MCP source has an empty server name, which no target can address."
            }
          : {
              location: `mcpServers.${invalid.name}`,
              message: `"${invalid.name}" is not a usable MCP server declaration.`
            }
      ],
      servers: []
    };
  }

  const invalidOverride = applyMcpTargetOverrides(document, servers);
  if (invalidOverride !== null) {
    return {
      source,
      valid: false,
      issues: [
        {
          location: `${invalidOverride.target}.mcpServers.${invalidOverride.server}`,
          message:
            invalidOverride.server === "mcpServers"
              ? `The overrides for "${invalidOverride.target}" must be an object of servers.`
              : `The override for "${invalidOverride.server}" under "${invalidOverride.target}" is not a usable MCP server declaration.`
        }
      ],
      servers: []
    };
  }

  return {
    source,
    valid: true,
    issues: [],
    servers: projectMcpDefinitions(servers)
  };
}

/**
 * The launch keys one MCP declaration carries.
 *
 * These are the keys the applied projection keeps, so a projection can be
 * compared against the declaration key by key. A key that is not a launch key
 * -- `disabled`, `default_tools_approval_mode`, `enabled_tools` -- says how a
 * server is *governed*, not how it is started, and the applied launch
 * configuration does not carry it.
 */
/**
 * The keys that say how a target governs a server rather than how it starts.
 *
 * A write owns the launch keys and leaves these alone: the enablement, the
 * approval mode and the tool allowlist are the target's own settings, and a
 * launch edit has no business changing them.
 */
const MCP_GOVERNANCE_KEYS = [
  "disabled",
  "default_tools_approval_mode",
  "enabled_tools"
] as const;

type McpLaunchKeys = {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  url?: string;
  bearer_token_env_var?: string;
  http_headers?: Record<string, string>;
};

/**
 * Whether a server is started as a subprocess rather than reached over HTTP.
 *
 * RuleSync drops the canonical `headers` key for a subprocess server, because
 * Codex accepts HTTP headers only on a URL server. Reading the same rule here
 * keeps the declared launch configuration equal to the projected one.
 */
function mcpServerIsStdio(config: Record<string, unknown>): boolean {
  return typeof config.command === "string";
}

/**
 * The launch configuration one declaration entry carries.
 *
 * The keys are the ones the Codex projection keeps. RuleSync spells HTTP
 * headers `headers` and writes them to Codex as `http_headers`; both spellings
 * are read here so the declared configuration matches the projected one
 * whichever one the declaration uses.
 */
function mcpLaunchKeys(config: Record<string, unknown>): McpLaunchKeys {
  const keys: McpLaunchKeys = {};
  if (typeof config.command === "string") keys.command = config.command;
  if (
    Array.isArray(config.args) &&
    config.args.every((arg) => typeof arg === "string")
  ) {
    keys.args = config.args as string[];
  }
  if (typeof config.cwd === "string") keys.cwd = config.cwd;
  if (typeof config.url === "string") keys.url = config.url;
  if (typeof config.bearer_token_env_var === "string")
    keys.bearer_token_env_var = config.bearer_token_env_var;
  const headers = config.http_headers ?? config.headers;
  if (
    isRecord(headers) &&
    Object.values(headers).every((value) => typeof value === "string") &&
    (config.http_headers !== undefined || !mcpServerIsStdio(config))
  ) {
    keys.http_headers = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, value as string])
    );
  }
  return keys;
}

/**
 * One server's effective declaration for one target.
 *
 * RuleSync's rule is wholesale: a target's own entry *replaces* the shared
 * entry for that server, key for key, rather than merging with it. A server
 * the target does not mention keeps the shared entry; an entry the target
 * sets to `null` is not declared for that target at all.
 *
 * The per-key merge this replaces reported a launch configuration RuleSync
 * would never generate -- a target that overrides one key of a server was
 * read as keeping the shared entry's other keys, while the generator drops
 * them -- so a comparison against the applied projection could report drift
 * that was not there.
 */
function effectiveMcpEntry(
  base: Record<string, unknown> | undefined,
  override: unknown
): Record<string, unknown> | null {
  if (override === null) return null;
  if (isRecord(override)) return override;
  return base ?? null;
}

/** The keys a declaration spells a launch key with, in either spelling. */
const MCP_LAUNCH_FILE_KEYS = [
  "command",
  "args",
  "cwd",
  "url",
  "bearer_token_env_var",
  "http_headers",
  "headers"
] as const;

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MCP_TARGET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HOOK_TARGET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * How the canonical declaration is written back.
 *
 * The library formats the edited region rather than the whole document, so
 * the comments and the layout outside the edited server entry survive.
 */
/**
 * How a canonical JSONC document is written back.
 *
 * One setting for every canonical document this repository writes, so a
 * declaration that is edited in place keeps the same shape as one that was
 * never edited.
 */
const JSONC_FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n"
};

/**
 * The normalized launch keys one write sets.
 *
 * `null` means the key is removed. A key the update does not mention is left
 * as the declaration has it.
 */
type NormalizedMcpLaunchUpdate = Readonly<
  Record<string, string | readonly string[] | Record<string, string> | null>
>;

/**
 * One launch key's value in a write.
 *
 * `absent` is a key the write does not mention, `remove` is a key the write
 * takes away, and `invalid` is a value this write does not accept.
 */
type McpLaunchKeyValue =
  | { readonly kind: "absent" }
  | { readonly kind: "remove" }
  | { readonly kind: "set"; readonly value: string }
  | { readonly kind: "invalid" };

function mcpLaunchTextValue(raw: unknown): McpLaunchKeyValue {
  if (raw === undefined) return { kind: "absent" };
  if (raw === null) return { kind: "remove" };
  if (typeof raw !== "string" || raw.length === 0) return { kind: "invalid" };
  return { kind: "set", value: raw };
}

function mcpLaunchArgsValue(
  raw: unknown
):
  | { readonly kind: "absent" }
  | { readonly kind: "remove" }
  | { readonly kind: "set"; readonly value: readonly string[] }
  | { readonly kind: "invalid" } {
  if (raw === undefined) return { kind: "absent" };
  if (raw === null) return { kind: "remove" };
  if (!Array.isArray(raw) || !raw.every((arg) => typeof arg === "string"))
    return { kind: "invalid" };
  return { kind: "set", value: raw as string[] };
}

function mcpLaunchHeadersValue(
  raw: unknown
):
  | { readonly kind: "absent" }
  | { readonly kind: "remove" }
  | { readonly kind: "set"; readonly value: Record<string, string> }
  | { readonly kind: "invalid" } {
  if (raw === undefined) return { kind: "absent" };
  if (raw === null) return { kind: "remove" };
  if (!isRecord(raw)) return { kind: "invalid" };
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(raw)) {
    if (typeof header !== "string") return { kind: "invalid" };
    headers[name] = header;
  }
  return { kind: "set", value: headers };
}

function mcpLaunchUpdate(
  update: RuleSyncMcpLaunchUpdate
): NormalizedMcpLaunchUpdate | null {
  const normalized: Record<
    string,
    string | readonly string[] | Record<string, string> | null
  > = {};
  const strings: readonly (readonly [string, unknown])[] = [
    ["command", update.command],
    ["cwd", update.cwd],
    ["url", update.url],
    ["bearer_token_env_var", update.bearerTokenEnvVar]
  ];
  for (const [key, raw] of strings) {
    const text = mcpLaunchTextValue(raw);
    if (text.kind === "invalid") return null;
    if (text.kind === "absent") continue;
    normalized[key] = text.kind === "remove" ? null : text.value;
  }
  const args = mcpLaunchArgsValue(update.args);
  if (args.kind === "invalid") return null;
  if (args.kind !== "absent") {
    normalized.args = args.kind === "remove" ? null : args.value;
  }
  const headers = mcpLaunchHeadersValue(update.httpHeaders);
  if (headers.kind === "invalid") return null;
  if (headers.kind !== "absent") {
    normalized.http_headers = headers.kind === "remove" ? null : headers.value;
  }
  return normalized;
}

/**
 * The key the declaration spells HTTP headers with.
 *
 * RuleSync's canonical spelling is `headers` and Codex's is `http_headers`;
 * a declaration that already uses one of them keeps it, so a write does not
 * leave two spellings of the same header table behind.
 */
function mcpHttpHeadersKey(effective: Record<string, unknown>): string {
  return Object.hasOwn(effective, "headers") &&
    !Object.hasOwn(effective, "http_headers")
    ? "headers"
    : "http_headers";
}

/**
 * The entry a target that does not declare the server receives.
 *
 * RuleSync replaces a server wholesale for the target that declares one, so
 * the entry is written complete: the shared entry's launch configuration and
 * the target's own governance keys are carried over, and the write's own keys
 * are applied on top.
 */
function mcpCreatedEntry(
  effective: Record<string, unknown>,
  update: NormalizedMcpLaunchUpdate
): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const key of MCP_LAUNCH_FILE_KEYS) {
    const value = effective[key];
    if (value !== undefined) entry[key] = value;
  }
  for (const key of MCP_GOVERNANCE_KEYS) {
    const value = effective[key];
    if (value !== undefined) entry[key] = value;
  }
  for (const [key, value] of Object.entries(update)) {
    const fileKey = key === "http_headers" ? mcpHttpHeadersKey(entry) : key;
    if (value === null) delete entry[fileKey];
    else entry[fileKey] = value;
  }
  return entry;
}

/**
 * The edits that write one server's launch configuration.
 *
 * A target that already declares the server gets its launch keys edited one
 * by one, so the rest of the entry -- its enablement, its approval mode, its
 * tool allowlist, and any comment inside it -- is left as it is. A target
 * that does not declare the server gets a complete entry: RuleSync replaces
 * a server wholesale for the target that declares one, so an entry carrying
 * only the changed key would take the server's launch configuration with it.
 */
function mcpLaunchEdits(
  content: string,
  input: {
    readonly target: string;
    readonly name: string;
    readonly effective: Record<string, unknown>;
    readonly hasOwnEntry: boolean;
    readonly update: NormalizedMcpLaunchUpdate;
  }
): EditResult {
  const entryPath = [input.target, "mcpServers", input.name];
  const options = { formattingOptions: JSONC_FORMATTING };
  if (!input.hasOwnEntry) {
    return modify(
      content,
      entryPath,
      mcpCreatedEntry(input.effective, input.update),
      options
    );
  }
  const edits: EditResult = [];
  for (const [key, value] of Object.entries(input.update)) {
    const fileKey =
      key === "http_headers" ? mcpHttpHeadersKey(input.effective) : key;
    if (value === null) {
      edits.push(
        ...modify(content, [...entryPath, fileKey], undefined, options)
      );
      continue;
    }
    edits.push(...modify(content, [...entryPath, fileKey], value, options));
  }
  return edits;
}

/**
 * The launch configuration one server declares for one target, read from a
 * document's text.
 *
 * Used to report what a write produced: the answer comes from the written
 * document rather than from what the write intended, so a write that did not
 * land says so.
 */
function mcpLaunchConfiguration(
  name: string,
  content: string,
  target: string
): McpServerLaunchConfiguration {
  const errors: ParseError[] = [];
  const document: unknown = parse(content, errors, {
    allowTrailingComma: true
  });
  if (errors.length > 0 || !isRecord(document)) return { name };
  const base = isRecord(document.mcpServers) ? document.mcpServers : {};
  const targetBlock = isRecord(document[target]) ? document[target] : null;
  const targetServers =
    targetBlock !== null && isRecord(targetBlock.mcpServers)
      ? targetBlock.mcpServers
      : null;
  const entry = effectiveMcpEntry(
    isRecord(base[name]) ? base[name] : undefined,
    targetServers !== null && Object.hasOwn(targetServers, name)
      ? targetServers[name]
      : undefined
  );
  if (entry === null) return { name };
  const launch = mcpLaunchKeys(entry);
  const published: {
    name: string;
    command?: string;
    args?: readonly string[];
    cwd?: string;
    url?: string;
    bearerTokenEnvVar?: string;
    httpHeaders?: Record<string, string>;
  } = { name };
  if (launch.command !== undefined) published.command = launch.command;
  if (launch.args !== undefined) published.args = launch.args;
  if (launch.cwd !== undefined) published.cwd = launch.cwd;
  if (launch.url !== undefined) published.url = launch.url;
  if (launch.bearer_token_env_var !== undefined)
    published.bearerTokenEnvVar = launch.bearer_token_env_var;
  if (launch.http_headers !== undefined)
    published.httpHeaders = launch.http_headers;
  return published;
}

/** One action, or `null` when it cannot be applied. The single rule set. */
function parseHookAction(value: unknown): HookAction | null {
  if (
    !isRecord(value) ||
    value.type !== "command" ||
    typeof value.command !== "string" ||
    value.command.trim().length === 0 ||
    (value.matcher !== undefined && typeof value.matcher !== "string") ||
    (value.statusMessage !== undefined &&
      typeof value.statusMessage !== "string")
  ) {
    return null;
  }
  return {
    type: "command",
    command: value.command,
    ...(typeof value.matcher === "string" ? { matcher: value.matcher } : {}),
    ...(typeof value.statusMessage === "string"
      ? { statusMessage: value.statusMessage }
      : {})
  };
}

/**
 * The action list one write sets.
 *
 * The list is written complete, so every action is checked here rather than
 * when it is read: an action the declaration cannot hold must be refused
 * before the document is touched, not after.
 */
function normalizeHookActions(
  actions: readonly HookAction[]
): readonly HookAction[] | null {
  const normalized: HookAction[] = [];
  for (const action of actions) {
    if (
      action.type !== "command" ||
      typeof action.command !== "string" ||
      action.command.trim().length === 0 ||
      (action.matcher !== undefined && typeof action.matcher !== "string") ||
      (action.statusMessage !== undefined &&
        typeof action.statusMessage !== "string")
    ) {
      return null;
    }
    normalized.push({
      type: "command",
      command: action.command,
      ...(typeof action.matcher === "string"
        ? { matcher: action.matcher }
        : {}),
      ...(typeof action.statusMessage === "string"
        ? { statusMessage: action.statusMessage }
        : {})
    });
  }
  return normalized;
}

function parseHookActions(value: unknown): HookAction[] | null {
  if (!Array.isArray(value)) return null;
  const actions: HookAction[] = [];
  for (const entry of value) {
    const action = parseHookAction(entry);
    if (action === null) return null;
    actions.push(action);
  }
  return actions;
}

/**
 * The first action that cannot be applied, or `null` when every one can.
 *
 * The index is carried rather than swallowed because "an action under
 * SessionStart is malformed" and "action 2 under SessionStart is malformed"
 * send an operator to different lines of the same file, and only this loader
 * knows which. Shares `parseHookAction` with the applying path so the diagnosis
 * and the decision cannot drift apart.
 */
function firstInvalidHookActionIndex(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  for (const [index, entry] of value.entries()) {
    if (parseHookAction(entry) === null) return index;
  }
  return null;
}

/**
 * A human sentence for one parse error, shared by every RuleSync source.
 *
 * The code name comes from the parser's own `printParseErrorCode` rather than a
 * local switch, so an error code this build of `jsonc-parser` adds later is
 * described by name instead of falling through to a generic sentence that would
 * make two different faults look identical.
 *
 * `offset` is a character offset, not a line. Counting the newlines before it is
 * what makes the message actionable: an operator editing `hooks.jsonc` needs the
 * line, not a byte count they would have to convert themselves.
 */
function jsoncParseIssue(
  content: string,
  error: ParseError
): RuleSyncValidationIssue {
  const before = content.slice(0, Math.max(0, error.offset));
  const line = before.split("\n").length;
  const codeName = printParseErrorCode(error.error);
  const words = codeName
    .replaceAll(/([a-z\d])([A-Z])/gu, "$1 $2")
    .toLowerCase();
  return {
    location: `line ${line}`,
    message: `${sentenceCase(words)}.`
  };
}

function sentenceCase(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

/**
 * Turn what the parser and the event checks observed into operator-facing issues.
 *
 * Everything here was already known when the loader decided the source was
 * invalid; returning it is the whole point. `issues` is empty only when the
 * source is valid or was never found, so a caller that receives `valid: false`
 * always receives a reason too.
 */
function hookValidationIssues(
  source: string,
  content: string,
  errors: readonly ParseError[],
  document: unknown,
  target: string
): RuleSyncValidationIssue[] {
  if (errors.length > 0) {
    return errors.map((error) => jsoncParseIssue(content, error));
  }
  if (!isRecord(document)) {
    return [
      { location: source, message: "The hook source must be a JSON object." }
    ];
  }
  const hooksValue = document.hooks;
  if (!isRecord(hooksValue)) {
    return [
      {
        location: "hooks",
        message: 'The hook source must have a "hooks" object.'
      }
    ];
  }
  const issues = hookEventIssues("hooks", hooksValue);
  // The target's own declaration is checked as well, because it is part of
  // what this target runs: RuleSync merges it over the shared declaration, so
  // a fault in it reaches Codex exactly as a fault in the shared block does.
  // The other targets' blocks are not checked here, because they are not part
  // of what this surface manages.
  const targetBlock = document[target];
  if (targetBlock === undefined) return issues;
  if (!isRecord(targetBlock)) {
    issues.push({
      location: target,
      message: `The "${target}" declaration must be an object.`
    });
    return issues;
  }
  const override = targetBlock.hooks;
  if (override === undefined) return issues;
  if (!isRecord(override)) {
    issues.push({
      location: `${target}.hooks`,
      message: `The "${target}" hook declaration must be an object.`
    });
    return issues;
  }
  issues.push(...hookEventIssues(`${target}.hooks`, override));
  return issues;
}

/**
 * The issues one hook event block holds.
 *
 * The block is the shared declaration or a target's own declaration of it,
 * and `location` names which: the shared block's events are located by their
 * own name, because that is where an operator looks for them, and a target's
 * own events are located under the block they are in.
 *
 * An event the Runtime cannot install is named here rather than dropped. A
 * declaration the console cannot describe is a declaration the operator
 * cannot act on, and dropping it would leave the console showing fewer hooks
 * than the declaration holds.
 */
function hookEventIssues(
  location: string,
  events: Record<string, unknown>
): RuleSyncValidationIssue[] {
  const issues: RuleSyncValidationIssue[] = [];
  for (const [event, value] of Object.entries(events)) {
    const where = location === "hooks" ? event : `${location}.${event}`;
    if (!isHookEvent(event)) {
      issues.push({
        location: where,
        message: `"${event}" is not a hook event the Codex runtime runs.`
      });
      continue;
    }
    // `firstInvalidHookActionIndex` answers "which action is bad", so it
    // answers `null` for a value that is not a list at all -- which is a
    // different fault and must be named here rather than passing as a clean
    // event with no actions.
    if (!Array.isArray(value)) {
      issues.push({
        location: where,
        message: `The actions for "${event}" must be an array.`
      });
      continue;
    }
    const invalidIndex = firstInvalidHookActionIndex(value);
    if (invalidIndex === null) continue;
    issues.push({
      location: `${where} action ${invalidIndex + 1}`,
      message: `Action ${invalidIndex + 1} of "${event}" is not a command hook with a non-empty command string.`
    });
  }
  return issues;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && character !== "\n" && character !== "\t") return true;
  }
  return false;
}

function hasUnsafeSkillSourceControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code < 32 &&
      character !== "\n" &&
      character !== "\r" &&
      character !== "\t"
    )
      return true;
  }
  return false;
}

async function ensureChildDirectory(
  parent: string,
  name: string
): Promise<string> {
  const directory = path.join(parent, name);
  try {
    await mkdir(directory);
  } catch (error) {
    if (!isExistingFileError(error)) throw error;
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new RuleSyncSkillConflictError(
      "RuleSync skill directory is not a real directory."
    );
  return directory;
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isExistingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

interface CanonicalRuleSyncDirectory {
  readonly valid: boolean | null;
  readonly path: string | null;
  /**
   * Why the directory could not be used, empty when it could.
   *
   * The resolver distinguishes four outcomes the loaders were collapsing into
   * one flag: the repository root is unreadable, `.rulesync` is a symlink or not
   * a directory, the child is a symlink or not a directory, or the child is
   * simply absent. Only the last is "not observed"; the first three are
   * different repairs, and reporting one flag for all of them sent an operator
   * to whichever of the three they happened to guess first.
   */
  readonly issues: readonly RuleSyncValidationIssue[];
}

function resolveCanonicalRuleSyncDirectory(
  repositoryRoot: string,
  childDirectory: "commands" | "skills"
): CanonicalRuleSyncDirectory {
  let root: string;
  try {
    root = realpathSync(repositoryRoot);
  } catch (error) {
    return unresolvableRuleSyncDirectory(error, repositoryRoot);
  }
  const rootPath = path.join(root, ".rulesync");
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(rootPath);
  } catch (error) {
    return unresolvableRuleSyncDirectory(error, rootPath);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return {
      valid: false,
      path: null,
      issues: [
        {
          location: ".rulesync",
          message: rootStat.isSymbolicLink()
            ? '".rulesync" is a symbolic link, and canonical RuleSync sources are read from the repository itself.'
            : '".rulesync" exists but is not a directory.'
        }
      ]
    };
  }
  const sourcePath = path.join(rootPath, childDirectory);
  let sourceStat: ReturnType<typeof lstatSync>;
  try {
    sourceStat = lstatSync(sourcePath);
  } catch (error) {
    return unresolvableRuleSyncDirectory(error, sourcePath);
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    return {
      valid: false,
      path: null,
      issues: [
        {
          location: `.rulesync/${childDirectory}`,
          message: sourceStat.isSymbolicLink()
            ? `".rulesync/${childDirectory}" is a symbolic link, and canonical RuleSync sources are read from the repository itself.`
            : `".rulesync/${childDirectory}" exists but is not a directory.`
        }
      ]
    };
  }
  return { valid: true, path: sourcePath, issues: [] };
}

/**
 * A path that could not be inspected at all.
 *
 * Absent is not observed and is not a fault, so it carries no issue and answers
 * `null`. Anything else failed in a way the operator has to know about, and the
 * errno is what separates "permission denied" from "the path is not there".
 */
function unresolvableRuleSyncDirectory(
  error: unknown,
  location: string
): CanonicalRuleSyncDirectory {
  if (isMissingFileError(error)) return { valid: null, path: null, issues: [] };
  return {
    valid: false,
    path: null,
    issues: [
      {
        location,
        message: `"${location}" could not be read: ${describeFileSystemError(
          error
        )}.`
      }
    ]
  };
}

/** A filesystem errno as a short phrase, without the absolute path it repeats. */
function describeFileSystemError(error: unknown): string {
  if (!isNodeError(error)) return "unknown error";
  switch (error.code) {
    case "EACCES":
    case "EPERM": {
      return "permission denied";
    }
    case "ELOOP": {
      return "too many symbolic links";
    }
    case "ENOTDIR": {
      return "a path component is not a directory";
    }
    case "EMFILE":
    case "ENFILE": {
      return "too many open files";
    }
    default: {
      return error.code ?? "unknown error";
    }
  }
}

function parseCachedRuleSyncCommand(
  entryPath: string,
  name: string,
  content: string
): RuleSyncCommand {
  const cached = COMMAND_PARSED_CACHE.get(entryPath);
  if (cached && cached.content === content) {
    return cached.command;
  }
  const parsed = parseRuleSyncCommand(name, content);
  COMMAND_PARSED_CACHE.set(entryPath, { content, command: parsed });
  return parsed;
}

export class RuleSyncRepository {
  readonly repositoryRoot: string;

  constructor(repositoryRoot: string = DEFAULT_REPO_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  loadCommands(): RuleSyncCommandsState {
    const directory = resolveCanonicalRuleSyncDirectory(
      this.repositoryRoot,
      "commands"
    );
    if (directory.valid !== true || directory.path === null) {
      return {
        source: COMMANDS_SOURCE,
        valid: directory.valid,
        issues: directory.issues,
        commands: []
      };
    }
    const commandsDir = directory.path;

    let entries: Dirent[];
    try {
      entries = readdirSync(commandsDir, { withFileTypes: true });
    } catch (error) {
      return {
        source: COMMANDS_SOURCE,
        valid: false,
        issues: [
          {
            location: ".rulesync/commands",
            message: `"${COMMANDS_SOURCE}" could not be listed: ${describeFileSystemError(
              error
            )}.`
          }
        ],
        commands: []
      };
    }

    const commands: RuleSyncCommand[] = [];
    // Per-entry rather than one `try` around the whole walk. A single catch
    // around the loop reported the same `valid: false` for "this file is a
    // symlink", "this file cannot be read", and "the directory listing failed",
    // and named none of them -- three different repairs behind one flag.
    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      const location = `.rulesync/commands/${entry.name}`;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        return {
          source: COMMANDS_SOURCE,
          valid: false,
          issues: [
            {
              location,
              message: entry.isSymbolicLink()
                ? `"${location}" is a symbolic link, and canonical commands are read from the repository itself.`
                : `"${location}" exists but is not a regular file.`
            }
          ],
          commands: []
        };
      }
      const name = entry.name.replace(MD_EXTENSION_PATTERN, "");
      let content: string;
      const entryPath = path.join(commandsDir, entry.name);
      try {
        content = readFileSync(entryPath, "utf8");
      } catch (error) {
        return {
          source: COMMANDS_SOURCE,
          valid: false,
          issues: [
            {
              location,
              message: `"${location}" could not be read: ${describeFileSystemError(
                error
              )}.`
            }
          ],
          commands: []
        };
      }
      try {
        commands.push(parseCachedRuleSyncCommand(entryPath, name, content));
      } catch (error) {
        // The parser already names the command, which is the one string an
        // operator can search for, so its message is carried through rather than
        // replaced by a generic walk failure.
        return {
          source: COMMANDS_SOURCE,
          valid: false,
          issues: [
            {
              location,
              message:
                error instanceof Error
                  ? error.message
                  : "The command could not be parsed."
            }
          ],
          commands: []
        };
      }
    }
    commands.sort((left, right) => COLLATOR.compare(left.name, right.name));
    return { source: COMMANDS_SOURCE, valid: true, issues: [], commands };
  }

  /**
   * Reads one canonical command.
   *
   * The three outcomes are the point: a command that is absent, a command
   * that could not be read, and a command that was read are three different
   * answers, and a caller that collapses them into "no such command" tells an
   * operator to look for a renamed prompt when the real fault is a file that
   * cannot be parsed.
   */
  loadCommand(name: string): RuleSyncCommandRead {
    if (!COMMAND_NAME_PATTERN.test(name)) return { status: "not-found" };
    const directory = resolveCanonicalRuleSyncDirectory(
      this.repositoryRoot,
      "commands"
    );
    if (directory.valid !== true || directory.path === null) {
      // An absent commands directory holds no command, so the prompt is
      // genuinely not there. A directory that is there and unusable is a fault
      // the operator has to know about, and it carries its own reason.
      if (directory.valid === null) return { status: "not-found" };
      return {
        status: "unreadable",
        reason:
          directory.issues[0]?.message ??
          "The canonical commands directory could not be read."
      };
    }
    const commandsDir = directory.path;
    const entryPath = path.join(commandsDir, `${name}.md`);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(entryPath);
    } catch (error) {
      if (isMissingFileError(error)) return { status: "not-found" };
      return {
        status: "unreadable",
        reason: `"${name}.md" could not be read: ${describeFileSystemError(error)}.`
      };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        status: "unreadable",
        reason: stat.isSymbolicLink()
          ? `"${name}.md" is a symbolic link, and canonical commands are read from the repository itself.`
          : `"${name}.md" exists but is not a regular file.`
      };
    }
    let content: string;
    try {
      content = readFileSync(entryPath, "utf8");
    } catch (error) {
      return {
        status: "unreadable",
        reason: `"${name}.md" could not be read: ${describeFileSystemError(error)}.`
      };
    }
    try {
      return {
        status: "found",
        command: parseCachedRuleSyncCommand(entryPath, name, content)
      };
    } catch (error) {
      // The parser names the command, which is the one string an operator can
      // search for, so its message is carried through rather than replaced by a
      // generic failure.
      return {
        status: "unreadable",
        reason:
          error instanceof Error
            ? error.message
            : "The command could not be parsed."
      };
    }
  }

  /**
   * Reads one page of a command's committed history.
   *
   * The page is a window onto one ordered history: `offset` versions are
   * passed over and `limit` versions are read. `hasMore` on the result
   * answers "is there a version after this page", so a caller can walk back
   * through the history one page at a time.
   */
  loadCommandHistory(
    name: string,
    page: RuleSyncCommandHistoryPage = FIRST_COMMAND_HISTORY_PAGE
  ): RuleSyncCommandHistory | null {
    if (!COMMAND_NAME_PATTERN.test(name)) return null;
    if (!isCommandHistoryPage(page)) {
      throw new RuleSyncCommandValidationError(
        "Command history page must be a whole offset of zero or more and a limit between 1 and 100."
      );
    }
    const cacheKey = `${this.repositoryRoot}:${name}:${page.offset}:${page.limit}`;
    const cached = COMMAND_HISTORY_CACHE.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < COMMAND_HISTORY_CACHE_TTL_MS) {
      return cached.history;
    }

    const state = this.loadCommands();
    // A catalogue that was read and found broken does not name this command,
    // and that is not the same as the catalogue naming it as absent: the
    // history is unavailable rather than unknown. An absent catalogue holds no
    // command, so the prompt is genuinely not there.
    if (state.valid === false) return UNAVAILABLE_COMMAND_HISTORY;
    if (
      state.valid !== true ||
      !state.commands.some((item) => item.name === name)
    )
      return null;

    let repositoryRoot: string;
    try {
      repositoryRoot = realpathSync(this.repositoryRoot);
    } catch {
      return UNAVAILABLE_COMMAND_HISTORY;
    }
    const git = gitRunner(repositoryRoot);

    let output: string;
    try {
      output = git(
        [
          "log",
          "--format=%H%x00%cI",
          `--max-count=${page.limit + 1}`,
          `--skip=${page.offset}`,
          "--",
          `${COMMANDS_SOURCE}/${name}.md`
        ],
        8192
      );
    } catch {
      const fallback = commandHistoryFallback(git);
      if (fallback.status === "available") {
        COMMAND_HISTORY_CACHE.set(cacheKey, {
          timestamp: now,
          history: fallback
        });
      }
      return fallback;
    }

    try {
      const entries = output
        .split(COMMAND_HISTORY_LINE_SPLIT_PATTERN)
        .filter(Boolean)
        .map((entry) => {
          const [versionHash, updatedAt] = entry.split("\0");
          if (
            !versionHash ||
            !GIT_REVISION_PATTERN.test(versionHash) ||
            !updatedAt ||
            !Number.isFinite(Date.parse(updatedAt))
          ) {
            throw new RuleSyncCommandHistoryUnavailableError(
              "Git returned malformed command history metadata."
            );
          }
          return { versionHash, updatedAt };
        });
      const result: RuleSyncCommandHistory = {
        status: "available",
        versions: entries.slice(0, page.limit),
        hasMore: entries.length > page.limit
      };
      COMMAND_HISTORY_CACHE.set(cacheKey, { timestamp: now, history: result });
      return result;
    } catch {
      return UNAVAILABLE_COMMAND_HISTORY;
    }
  }

  /**
   * Reads one committed revision of a command.
   *
   * The revision is resolved from Git itself rather than from a page of
   * history, because a revision the operator reached by paging back is older
   * than the newest page and would otherwise be refused as "not in the
   * history". Git answers three separate questions here: whether the
   * repository can answer at all, whether the revision is a commit, and
   * whether that commit changed *this* command -- a commit that never touched
   * the command file is not a version of it, however well-formed its hash is.
   */
  loadCommandVersion(
    name: string,
    versionHash: string
  ): RuleSyncCommandVersion | null {
    if (
      !COMMAND_NAME_PATTERN.test(name) ||
      !GIT_REVISION_PATTERN.test(versionHash)
    ) {
      return null;
    }
    const state = this.loadCommands();
    const command =
      state.valid === true
        ? state.commands.find((item) => item.name === name)
        : undefined;
    if (!command) return null;

    let repositoryRoot: string;
    try {
      repositoryRoot = realpathSync(this.repositoryRoot);
    } catch {
      throw new RuleSyncCommandHistoryUnavailableError();
    }
    const git = gitRunner(repositoryRoot);

    if (tryGit(git, ["rev-parse", "--is-inside-work-tree"], 1024) !== "true") {
      throw new RuleSyncCommandHistoryUnavailableError();
    }
    // A revision nobody committed is an unknown version, not an unavailable
    // history: the repository answered, and its answer was "no such commit".
    if (
      tryGit(git, ["cat-file", "-e", `${versionHash}^{commit}`], 1024) === null
    ) {
      return null;
    }
    const changedPaths = tryGit(
      git,
      [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        versionHash,
        "--",
        command.path
      ],
      8192
    );
    if (changedPaths === null) {
      throw new RuleSyncCommandHistoryUnavailableError(
        "The selected command version could not be read."
      );
    }
    if (!changedPaths.split("\n").includes(command.path)) return null;

    const updatedAt = tryGit(
      git,
      ["show", "--no-patch", "--format=%cI", versionHash],
      1024
    );
    if (updatedAt === null) {
      throw new RuleSyncCommandHistoryUnavailableError(
        "The selected command version could not be read."
      );
    }
    if (!Number.isFinite(Date.parse(updatedAt))) {
      throw new RuleSyncCommandHistoryUnavailableError(
        "Git returned malformed command version metadata."
      );
    }

    try {
      const content = git(
        ["show", `${versionHash}:${command.path}`],
        COMMAND_CONTENT_MAX_BYTES
      );
      const diff = git(
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-renames",
          "--unified=3",
          versionHash,
          "--",
          command.path
        ],
        COMMAND_DIFF_MAX_BYTES
      );
      return {
        name,
        versionHash,
        updatedAt,
        content,
        diff
      };
    } catch {
      throw new RuleSyncCommandHistoryUnavailableError(
        "The selected command version or its bounded diff could not be read."
      );
    }
  }

  updateCommand(input: RuleSyncCommandUpdateInput): Promise<RuleSyncCommand> {
    const name = input.name;
    if (!COMMAND_NAME_PATTERN.test(name)) {
      return Promise.reject(
        new RuleSyncCommandValidationError(
          "Command name must be a lowercase hyphenated slug."
        )
      );
    }
    if (!COMMAND_REVISION_PATTERN.test(input.expectedRevision)) {
      return Promise.reject(
        new RuleSyncCommandValidationError(
          "Expected command revision is invalid."
        )
      );
    }
    const content = input.content
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n");
    if (
      Buffer.byteLength(content, "utf8") > COMMAND_CONTENT_MAX_BYTES ||
      hasControlCharacters(content)
    ) {
      return Promise.reject(
        new RuleSyncCommandValidationError(
          "Command content contains unsafe controls or exceeds its safe size bound."
        )
      );
    }

    const directory = resolveCanonicalRuleSyncDirectory(
      this.repositoryRoot,
      "commands"
    );
    if (directory.valid !== true || directory.path === null) {
      return Promise.reject(
        new RuleSyncCommandValidationError(
          "Canonical RuleSync command source is not valid."
        )
      );
    }
    const commandsDir = directory.path;
    const commandPath = path.join(commandsDir, `${name}.md`);
    let updated: RuleSyncCommand;
    try {
      updated = parseRuleSyncCommand(name, content);
    } catch (error) {
      return Promise.reject(error);
    }
    return withSourceUpdateLock(commandPath, async () => {
      const state = this.loadCommands();
      if (state.valid !== true) {
        throw new RuleSyncCommandValidationError(
          "Canonical RuleSync command source is not valid."
        );
      }
      const current = state.commands.find((command) => command.name === name);
      if (!current) {
        throw new RuleSyncCommandConflictError(
          `Canonical command "${name}" no longer exists.`
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new RuleSyncCommandConflictError(
          `Canonical command "${name}" changed since it was loaded.`
        );
      }

      if (updated.revision === current.revision) return current;

      const commandStat = await lstat(commandPath);
      if (!commandStat.isFile() || commandStat.isSymbolicLink()) {
        throw new RuleSyncCommandConflictError(
          `Canonical command "${name}" is not a regular file.`
        );
      }
      const latestContent = await readFile(commandPath, "utf8");
      if (
        createHash("sha256").update(latestContent, "utf8").digest("hex") !==
        input.expectedRevision
      ) {
        throw new RuleSyncCommandConflictError(
          `Canonical command "${name}" changed before the update was written.`
        );
      }

      const temporaryPath = path.join(
        commandsDir,
        `.${name}.${randomUUID()}.tmp`
      );
      try {
        await writeFile(temporaryPath, content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o644
        });
        await rename(temporaryPath, commandPath);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }

      const persistedContent = await readFile(commandPath, "utf8");
      if (persistedContent !== content) {
        throw new RuleSyncCommandConflictError(
          `Canonical command "${name}" changed during the update.`
        );
      }
      const updatedCommand = parseRuleSyncCommand(name, persistedContent);
      COMMAND_PARSED_CACHE.set(commandPath, {
        content: persistedContent,
        command: updatedCommand
      });
      COMMAND_HISTORY_CACHE.delete(`${this.repositoryRoot}:${name}`);
      return updatedCommand;
    });
  }

  /**
   * The canonical hook declaration, read as one target receives it.
   *
   * RuleSync merges the shared declaration with the target's own declaration
   * one event at a time, so the target's effective declaration is the shared
   * one with the target's own merged over it, and a target that declares an
   * event replaces the shared declaration of that event rather than adding to
   * it. The events are published with the origin they come from, because the
   * origin is what decides who else an edit reaches.
   */
  loadHooksState(target: string): RuleSyncHooksState {
    const source = HOOKS_SOURCE;
    const hooksPath = path.join(this.repositoryRoot, source);
    if (!existsSync(hooksPath))
      return { source, valid: null, issues: [], target, events: [] };

    let content: string;
    try {
      content = readFileSync(hooksPath, "utf8");
    } catch {
      // Unreadable is not invalid. The file is there and the system has not
      // read it, so nothing about its contents may be claimed.
      return { source, valid: null, issues: [], target, events: [] };
    }

    const errors: ParseError[] = [];
    const document: unknown = parse(content, errors, {
      allowTrailingComma: true
    });

    const issues = hookValidationIssues(
      source,
      content,
      errors,
      document,
      target
    );
    if (issues.length > 0) {
      // No events are returned: the first issue is why the rest of the document
      // was never examined, and a partial list would read as the whole file.
      return { source, valid: false, issues, target, events: [] };
    }

    // No issues means the document parsed, is an object, has a `hooks` object,
    // and every event and action in it applied. The empty-object fallback is
    // unreachable for that reason alone; it exists so the narrowing is done by
    // the type system rather than by a cast.
    const shared =
      isRecord(document) && isRecord(document.hooks) ? document.hooks : {};
    const targetDeclaration = isRecord(document) ? document[target] : undefined;
    const targetBlock = isRecord(targetDeclaration)
      ? targetDeclaration
      : undefined;
    const override =
      targetBlock !== undefined && isRecord(targetBlock.hooks)
        ? targetBlock.hooks
        : {};
    const events: HookEventDeclaration[] = [];
    for (const [event, value] of Object.entries({ ...shared, ...override })) {
      if (!isHookEvent(event)) continue;
      const actions = parseHookActions(value);
      if (actions === null) continue;
      events.push({
        event,
        origin: Object.hasOwn(override, event) ? "target" : "shared",
        actions
      });
    }
    return { source, valid: true, issues: [], target, events };
  }

  /**
   * The revision of the canonical hook declaration.
   *
   * It is the handle a write compares against, so it is read with the
   * declaration it belongs to rather than on its own.
   */
  loadHooksRevision(): {
    readonly source: ".rulesync/hooks.jsonc";
    readonly revision: string | null;
    readonly valid: boolean | null;
  } {
    const source = HOOKS_SOURCE;
    const hooksPath = path.join(this.repositoryRoot, source);
    if (!existsSync(hooksPath)) return { source, revision: null, valid: null };
    let content: string;
    try {
      content = readFileSync(hooksPath, "utf8");
    } catch {
      return { source, revision: null, valid: null };
    }
    const errors: ParseError[] = [];
    const document: unknown = parse(content, errors, {
      allowTrailingComma: true
    });
    return {
      source,
      revision: createHash("sha256").update(content, "utf8").digest("hex"),
      valid: errors.length === 0 && isRecord(document) ? true : false
    };
  }

  /**
   * Write one event's action list to the canonical hook declaration.
   *
   * The write goes to the declaration that currently holds the event for the
   * target: the target's own declaration when it declares the event, and the
   * shared declaration when the target inherits it. That is where the value
   * lives, and writing it anywhere else would leave a second copy of the same
   * event in the document -- a shared list the target no longer inherits and a
   * target list that shadows it.
   *
   * The write is a compare-and-swap on the document's revision, and it edits
   * the document in place: the comments and the formatting outside the edited
   * event are preserved.
   */
  updateHookEvent(
    input: RuleSyncHookEventUpdateInput
  ): Promise<RuleSyncHookEventUpdateResult> {
    const { event, target, expectedRevision } = input;
    if (!isHookEvent(event)) {
      return Promise.reject(
        new RuleSyncHooksValidationError(
          "Hook event must be a hook event the Codex runtime runs."
        )
      );
    }
    if (!HOOK_TARGET_NAME_PATTERN.test(target)) {
      return Promise.reject(
        new RuleSyncHooksValidationError(
          "Hook target name must be a non-empty name of letters, digits, dots, dashes or underscores."
        )
      );
    }
    if (!COMMAND_REVISION_PATTERN.test(expectedRevision)) {
      return Promise.reject(
        new RuleSyncHooksValidationError("Expected hook revision is invalid.")
      );
    }
    const actions = normalizeHookActions(input.actions);
    if (actions === null) {
      return Promise.reject(
        new RuleSyncHooksValidationError(
          "A hook action must be a command hook with a non-empty command string."
        )
      );
    }

    const source = HOOKS_SOURCE;
    const hooksPath = path.join(this.repositoryRoot, source);
    if (!existsSync(hooksPath)) {
      return Promise.reject(
        new RuleSyncHooksConflictError(
          "The canonical hook declaration does not exist."
        )
      );
    }

    return withSourceUpdateLock(hooksPath, async () => {
      let content: string;
      try {
        content = await readFile(hooksPath, "utf8");
      } catch {
        throw new RuleSyncHooksConflictError(
          "The canonical hook declaration could not be read."
        );
      }
      const revision = createHash("sha256")
        .update(content, "utf8")
        .digest("hex");
      if (revision !== expectedRevision) {
        throw new RuleSyncHooksConflictError(
          "The canonical hook declaration changed since it was loaded."
        );
      }
      const errors: ParseError[] = [];
      const document: unknown = parse(content, errors, {
        allowTrailingComma: true
      });
      if (errors.length > 0 || !isRecord(document)) {
        throw new RuleSyncHooksValidationError(
          "The canonical hook declaration could not be applied."
        );
      }

      const targetDeclaration = document[target];
      const targetBlock = isRecord(targetDeclaration)
        ? targetDeclaration
        : undefined;
      const override =
        targetBlock !== undefined && isRecord(targetBlock.hooks)
          ? targetBlock.hooks
          : undefined;
      const origin: HookDeclarationOrigin =
        override !== undefined && Object.hasOwn(override, event)
          ? "target"
          : "shared";
      // RuleSync replaces an event's whole action list when a target declares
      // that event, so the list is written complete: a list carrying only the
      // changed actions would take the event's other actions with it.
      const eventPath =
        origin === "target" ? [target, "hooks", event] : ["hooks", event];
      const edits = modify(
        content,
        eventPath,
        actions.length === 0 ? undefined : actions,
        { formattingOptions: JSONC_FORMATTING }
      );
      const updated = applyEdits(content, edits);
      if (updated === content) {
        // The declaration already says this, so there is nothing to write.
        // A write that changes nothing is a successful write, not a conflict.
        return { source, event, target, revision, origin, actions };
      }

      const temporaryPath = path.join(
        this.repositoryRoot,
        `.hooks.${randomUUID()}.tmp`
      );
      try {
        await writeFile(temporaryPath, updated, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o644
        });
        await rename(temporaryPath, hooksPath);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      const persisted = await readFile(hooksPath, "utf8");
      if (persisted !== updated) {
        throw new RuleSyncHooksConflictError(
          "The canonical hook declaration changed during the update."
        );
      }

      return {
        source,
        event,
        target,
        revision: createHash("sha256").update(persisted, "utf8").digest("hex"),
        origin,
        actions
      };
    });
  }

  loadMcpState(): RuleSyncMcpState {
    const source = MCP_SOURCE;
    const mcpPath = path.join(this.repositoryRoot, source);
    if (!existsSync(mcpPath))
      return { source, valid: null, issues: [], servers: [] };

    let content: string;
    try {
      content = readFileSync(mcpPath, "utf8");
    } catch {
      // Unreadable is not invalid, and this loader used to disagree with the
      // hook loader about it. The file is present and nothing about its contents
      // has been read, so no fault may be attributed to it and no servers may be
      // projected from a guess.
      return { source, valid: null, issues: [], servers: [] };
    }

    return (
      parseMcpState(content) ?? {
        source,
        valid: false,
        issues: [
          {
            location: source,
            message: "The MCP source could not be applied."
          }
        ],
        servers: []
      }
    );
  }

  /**
   * The canonical launch configuration one target would receive.
   *
   * This is the declaration side of the MCP reconciliation: the applied
   * projection is compared against it key by key, so it has to carry the
   * launch keys losslessly rather than the summary the server list publishes.
   * A target's own declaration wins over the base declaration for the same
   * key.
   *
   * `valid: null` means the canonical source was not read at all, which is a
   * different fact from `valid: false`, which means it was read and could not
   * be applied. Neither ever produces a server list.
   */
  loadMcpLaunchState(target: string): RuleSyncMcpLaunchState {
    const source = MCP_SOURCE;
    const mcpPath = path.join(this.repositoryRoot, source);
    if (!existsSync(mcpPath))
      return { source, valid: null, issues: [], target, servers: [] };

    let content: string;
    try {
      content = readFileSync(mcpPath, "utf8");
    } catch {
      // Unreadable is not invalid. The file is present and nothing about its
      // contents has been read, so no fault may be attributed to it and no
      // server may be projected from a guess.
      return { source, valid: null, issues: [], target, servers: [] };
    }

    const errors: ParseError[] = [];
    const document: unknown = parse(content, errors, {
      allowTrailingComma: true
    });
    if (errors.length > 0) {
      return {
        source,
        valid: false,
        issues: errors.map((error) => jsoncParseIssue(content, error)),
        target,
        servers: []
      };
    }
    if (!isRecord(document)) {
      return {
        source,
        valid: false,
        issues: [
          { location: source, message: "The MCP source must be a JSON object." }
        ],
        target,
        servers: []
      };
    }

    const base = isRecord(document.mcpServers) ? document.mcpServers : {};
    const overrides: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(document)) {
      if (name === "$schema" || name === "mcpServers") continue;
      if (!isRecord(value)) continue;
      if (!isRecord(value.mcpServers)) continue;
      overrides[name] = value.mcpServers;
    }
    const targetOverrides = isRecord(overrides[target])
      ? overrides[target]
      : {};

    const names = new Set([
      ...Object.keys(base),
      ...Object.keys(targetOverrides)
    ]);
    const servers: McpServerLaunchConfiguration[] = [...names]
      .sort(COLLATOR.compare)
      .map((name) => {
        const baseConfig = isRecord(base[name]) ? base[name] : undefined;
        const entry = effectiveMcpEntry(
          baseConfig,
          Object.hasOwn(targetOverrides, name)
            ? targetOverrides[name]
            : undefined
        );
        if (entry === null) return null;
        const launch = mcpLaunchKeys(entry);
        // A server the projection would drop is not part of the declared
        // configuration: RuleSync writes a server that has no launch
        // configuration and is not disabled as nothing at all, so declaring it
        // here would report a difference the projection never had.
        if (Object.keys(launch).length === 0 && entry.disabled !== true)
          return null;
        // The launch keys are published under their contract names, and a key
        // the declaration does not carry is absent rather than empty: an
        // absent key and an empty one are different configurations.
        const published: {
          name: string;
          command?: string;
          args?: readonly string[];
          cwd?: string;
          url?: string;
          bearerTokenEnvVar?: string;
          httpHeaders?: Record<string, string>;
        } = { name };
        if (launch.command !== undefined) published.command = launch.command;
        if (launch.args !== undefined) published.args = launch.args;
        if (launch.cwd !== undefined) published.cwd = launch.cwd;
        if (launch.url !== undefined) published.url = launch.url;
        if (launch.bearer_token_env_var !== undefined)
          published.bearerTokenEnvVar = launch.bearer_token_env_var;
        if (launch.http_headers !== undefined)
          published.httpHeaders = launch.http_headers;
        return published;
      })
      .filter(
        (server): server is McpServerLaunchConfiguration => server !== null
      );
    return { source, valid: true, issues: [], target, servers };
  }

  /**
   * The revision of the canonical MCP declaration.
   *
   * The revision is the digest of the whole document, so it changes when any
   * part of the declaration changes -- including a part this write does not
   * own. That is the point: it is the handle a caller compares against to
   * know that the declaration it read is still the declaration on disk.
   */
  loadMcpRevision(): {
    readonly source: ".rulesync/mcp.jsonc";
    readonly revision: string | null;
    readonly valid: boolean | null;
  } {
    const source = MCP_SOURCE;
    const mcpPath = path.join(this.repositoryRoot, source);
    if (!existsSync(mcpPath)) return { source, revision: null, valid: null };
    let content: string;
    try {
      content = readFileSync(mcpPath, "utf8");
    } catch {
      return { source, revision: null, valid: null };
    }
    const errors: ParseError[] = [];
    const document: unknown = parse(content, errors, {
      allowTrailingComma: true
    });
    return {
      source,
      revision: createHash("sha256").update(content, "utf8").digest("hex"),
      valid: errors.length === 0 && isRecord(document) ? true : false
    };
  }

  /**
   * Write one server's launch configuration for one target.
   *
   * The write owns the launch keys of the target's own declaration and nothing
   * else: the target's enablement, approval mode and tool allowlist stay as
   * they are, and the shared declaration is left alone. RuleSync replaces a
   * server wholesale for a target that declares one, so the target's entry is
   * written complete -- when the target had no entry for the server, the
   * shared entry's launch configuration and governance keys are carried over
   * first, because an entry that carried only the changed key would take the
   * server's launch configuration with it.
   *
   * The write is a compare-and-swap on the document's revision, and it edits
   * the document in place: the comments and the formatting outside the edited
   * server entry are preserved.
   */
  updateMcpLaunch(
    input: RuleSyncMcpLaunchUpdateInput
  ): Promise<RuleSyncMcpLaunchUpdateResult> {
    const { name, target, expectedRevision } = input;
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      return Promise.reject(
        new RuleSyncMcpValidationError(
          "MCP server name must be a non-empty name of letters, digits, dots, dashes or underscores."
        )
      );
    }
    if (!MCP_TARGET_NAME_PATTERN.test(target)) {
      return Promise.reject(
        new RuleSyncMcpValidationError(
          "MCP target name must be a non-empty name of letters, digits, dots, dashes or underscores."
        )
      );
    }
    if (!COMMAND_REVISION_PATTERN.test(expectedRevision)) {
      return Promise.reject(
        new RuleSyncMcpValidationError("Expected MCP revision is invalid.")
      );
    }
    const update = mcpLaunchUpdate(input.launch);
    if (update === null) {
      return Promise.reject(
        new RuleSyncMcpValidationError(
          "The MCP launch configuration carries a value that is not a launch key."
        )
      );
    }

    const source = MCP_SOURCE;
    const mcpPath = path.join(this.repositoryRoot, source);
    if (!existsSync(mcpPath)) {
      return Promise.reject(
        new RuleSyncMcpConflictError(
          "The canonical MCP declaration does not exist."
        )
      );
    }

    return withSourceUpdateLock(mcpPath, async () => {
      let content: string;
      try {
        content = await readFile(mcpPath, "utf8");
      } catch {
        throw new RuleSyncMcpConflictError(
          "The canonical MCP declaration could not be read."
        );
      }
      const revision = createHash("sha256")
        .update(content, "utf8")
        .digest("hex");
      if (revision !== expectedRevision) {
        throw new RuleSyncMcpConflictError(
          "The canonical MCP declaration changed since it was loaded."
        );
      }
      const errors: ParseError[] = [];
      const document: unknown = parse(content, errors, {
        allowTrailingComma: true
      });
      if (errors.length > 0 || !isRecord(document)) {
        throw new RuleSyncMcpValidationError(
          "The canonical MCP declaration could not be applied."
        );
      }

      const base = isRecord(document.mcpServers) ? document.mcpServers : {};
      const targetBlock = isRecord(document[target]) ? document[target] : null;
      const targetServers =
        targetBlock !== null && isRecord(targetBlock.mcpServers)
          ? targetBlock.mcpServers
          : null;
      const hasOwnEntry =
        targetServers !== null && Object.hasOwn(targetServers, name);
      const effective = effectiveMcpEntry(
        isRecord(base[name]) ? base[name] : undefined,
        hasOwnEntry ? targetServers![name] : undefined
      );
      if (effective === null) {
        throw new RuleSyncMcpValidationError(
          `MCP server "${name}" is not declared for the target "${target}".`
        );
      }

      const edits = mcpLaunchEdits(content, {
        target,
        name,
        effective,
        hasOwnEntry: hasOwnEntry && targetServers !== null,
        update
      });
      const updated = applyEdits(content, edits);
      if (updated === content) {
        // The declaration already says this, so there is nothing to write.
        // A write that changes nothing is a successful write, not a conflict.
        return {
          source,
          name,
          target,
          revision,
          launch: mcpLaunchConfiguration(name, content, target)
        };
      }

      const temporaryPath = path.join(
        this.repositoryRoot,
        `.mcp.${randomUUID()}.tmp`
      );
      try {
        await writeFile(temporaryPath, updated, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o644
        });
        await rename(temporaryPath, mcpPath);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      const persisted = await readFile(mcpPath, "utf8");
      if (persisted !== updated) {
        throw new RuleSyncMcpConflictError(
          "The canonical MCP declaration changed during the update."
        );
      }

      return {
        source,
        name,
        target,
        revision: createHash("sha256").update(persisted, "utf8").digest("hex"),
        launch: mcpLaunchConfiguration(name, persisted, target)
      };
    });
  }

  async createSkill(
    input: RuleSyncSkillPromotionInput
  ): Promise<RuleSyncSkillArtifact> {
    const name = input.name.trim();
    const description = input.description.trim();
    const content = input.content
      .trim()
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n");
    if (
      !SKILL_NAME_PATTERN.test(name) ||
      name.startsWith("-") ||
      name.endsWith("-") ||
      name.includes("--")
    )
      throw new TypeError("Skill name must be a lowercase hyphenated slug.");
    if (
      !description ||
      description.length > SKILL_DESCRIPTION_MAX ||
      hasControlCharacters(description)
    ) {
      throw new TypeError("Skill description is invalid.");
    }
    if (
      !content ||
      content.length > SKILL_CONTENT_MAX ||
      hasControlCharacters(content)
    ) {
      throw new TypeError("Skill content is empty or exceeds its size bound.");
    }

    const root = await realpath(this.repositoryRoot);
    const rulesyncDir = await ensureChildDirectory(root, ".rulesync");
    const skillsDir = await ensureChildDirectory(rulesyncDir, "skills");
    const skillDir = await ensureChildDirectory(skillsDir, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    const source = [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      "---",
      "",
      "<!-- Promoted from verified AutoDev procedural memory. -->",
      "",
      content,
      ""
    ].join("\n");
    const revision = createHash("sha256").update(source, "utf8").digest("hex");

    try {
      const existing = await lstat(skillPath);
      if (!existing.isFile() || existing.isSymbolicLink())
        throw new RuleSyncSkillConflictError(
          "Skill destination is not a regular file."
        );
      const existingSource = await readFile(skillPath, "utf8");
      if (existingSource !== source)
        throw new RuleSyncSkillConflictError(
          "A different canonical skill already uses this name."
        );
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const temporaryPath = path.join(skillDir, `.${name}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, source, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o644
        });
        try {
          // A hard link publishes the fully-written file atomically without
          // replacing a skill another process created concurrently.
          await link(temporaryPath, skillPath);
        } catch (writeError) {
          if (!isExistingFileError(writeError)) throw writeError;
          const existingSource = await readFile(skillPath, "utf8");
          if (existingSource !== source)
            throw new RuleSyncSkillConflictError(
              "A different canonical skill already uses this name."
            );
        }
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }

    const canonicalPath = await realpath(skillPath);
    const relativePath = path.relative(root, canonicalPath);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new RuleSyncSkillConflictError(
        "Skill destination escaped the repository root."
      );
    }
    SKILL_ENTRY_CACHE.delete(canonicalPath);
    return {
      name,
      path: `.rulesync/skills/${name}/SKILL.md`,
      uri: `rulesync://skills/${name}/SKILL.md`,
      revision
    };
  }

  readSkillSource(name: string): RuleSyncSkillSource {
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new RuleSyncSkillValidationError(
        "Skill name must contain lowercase letters, digits, and hyphens."
      );
    }
    const directory = resolveCanonicalRuleSyncDirectory(
      this.repositoryRoot,
      "skills"
    );
    if (directory.valid !== true || directory.path === null) {
      throw skillDirectoryError(directory);
    }
    const skillDir = path.join(directory.path, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    try {
      const directoryStat = lstatSync(skillDir);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error(SKILL_SOURCE_UNSAFE_MESSAGE);
      }
      const fileStat = lstatSync(skillPath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(SKILL_SOURCE_UNSAFE_MESSAGE);
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }

    const state = this.loadSkills();
    if (state.valid !== true) throw skillCatalogError(state);
    if (!state.skills.some((skill) => skill.name === name)) {
      throw new RuleSyncSkillConflictError(
        `Canonical skill "${name}" does not exist.`
      );
    }

    const content = readFileSync(skillPath, "utf8");
    if (Buffer.byteLength(content, "utf8") > SKILL_SOURCE_MAX_BYTES) {
      throw new RuleSyncSkillValidationError(
        "Canonical skill source exceeds its safe size bound."
      );
    }
    const revision = createHash("sha256").update(content, "utf8").digest("hex");
    return {
      name,
      path: `${SKILLS_SOURCE}/${name}/SKILL.md`,
      content,
      revision
    };
  }

  updateSkillSource(
    input: RuleSyncSkillSourceUpdateInput
  ): Promise<RuleSyncSkillSource> {
    const { name, expectedRevision, content } = input;
    try {
      if (!SKILL_NAME_PATTERN.test(name)) {
        throw new RuleSyncSkillValidationError(
          "Skill name must contain lowercase letters, digits, and hyphens."
        );
      }
      if (!COMMAND_REVISION_PATTERN.test(expectedRevision)) {
        throw new RuleSyncSkillValidationError(
          "Expected skill revision is invalid."
        );
      }
      if (
        Buffer.byteLength(content, "utf8") > SKILL_SOURCE_MAX_BYTES ||
        hasUnsafeSkillSourceControls(content)
      ) {
        throw new RuleSyncSkillValidationError(
          "Skill source contains unsafe controls or exceeds its safe size bound."
        );
      }
      validateSkillSource(name, content);
    } catch (error) {
      return Promise.reject(error);
    }

    const directory = resolveCanonicalRuleSyncDirectory(
      this.repositoryRoot,
      "skills"
    );
    if (directory.valid !== true || directory.path === null) {
      return Promise.reject(skillDirectoryError(directory));
    }
    const skillsDir = directory.path;
    const skillDir = path.join(skillsDir, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    return withSourceUpdateLock(skillPath, async () => {
      let directoryStat: Awaited<ReturnType<typeof lstat>>;
      let fileStat: Awaited<ReturnType<typeof lstat>>;
      try {
        directoryStat = await lstat(skillDir);
        fileStat = await lstat(skillPath);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        const state = this.loadSkills();
        if (state.valid !== true) throw skillCatalogError(state);
        throw new RuleSyncSkillConflictError(
          `Canonical skill "${name}" no longer exists.`
        );
      }
      if (
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        !fileStat.isFile() ||
        fileStat.isSymbolicLink()
      ) {
        throw new Error(SKILL_SOURCE_UNSAFE_MESSAGE);
      }
      const state = this.loadSkills();
      if (state.valid !== true) throw skillCatalogError(state);
      if (!state.skills.some((skill) => skill.name === name)) {
        throw new RuleSyncSkillConflictError(
          `Canonical skill "${name}" no longer exists.`
        );
      }
      const latestContent = await readFile(skillPath, "utf8");
      const latestRevision = createHash("sha256")
        .update(latestContent, "utf8")
        .digest("hex");
      if (latestRevision !== expectedRevision) {
        throw new RuleSyncSkillConflictError(
          `Canonical skill "${name}" changed since it was loaded.`
        );
      }
      const temporaryPath = path.join(skillDir, `.${name}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o644
        });
        await rename(temporaryPath, skillPath);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      const persistedContent = await readFile(skillPath, "utf8");
      if (persistedContent !== content) {
        throw new RuleSyncSkillConflictError(
          `Canonical skill "${name}" changed during the update.`
        );
      }
      SKILL_ENTRY_CACHE.delete(skillPath);
      return {
        name,
        path: `${SKILLS_SOURCE}/${name}/SKILL.md`,
        content: persistedContent,
        revision: createHash("sha256")
          .update(persistedContent, "utf8")
          .digest("hex")
      };
    });
  }

  loadSkills(): RuleSyncSkillsState {
    const directory = resolveCanonicalRuleSyncDirectory(
      this.repositoryRoot,
      "skills"
    );
    if (directory.valid !== true || directory.path === null) {
      return {
        source: SKILLS_SOURCE,
        valid: directory.valid,
        issues: directory.issues,
        skills: []
      };
    }
    const skillsDir = directory.path;

    let entries: Dirent[];
    try {
      entries = readdirSync(skillsDir, { withFileTypes: true });
    } catch (error) {
      return invalidSkills(
        ".rulesync/skills",
        `"${SKILLS_SOURCE}" could not be listed: ${describeFileSystemError(
          error
        )}.`
      );
    }

    const skills: SkillDefinition[] = [];
    // One fault per return, each naming the skill it is about. This walk had
    // six distinct failures behind a single `valid: false` and a blanket catch,
    // so a skill directory that was a symlink and a SKILL.md whose frontmatter
    // named a different skill were indistinguishable on the page.
    for (const entry of entries) {
      const outcome = readSkillEntry(skillsDir, entry);
      if (outcome.kind === "invalid") return invalidSkills(...outcome.issue);
      if (outcome.kind === "skill") skills.push(outcome.skill);
    }
    skills.sort((left, right) => COLLATOR.compare(left.name, right.name));
    return { source: SKILLS_SOURCE, valid: true, issues: [], skills };
  }
}
