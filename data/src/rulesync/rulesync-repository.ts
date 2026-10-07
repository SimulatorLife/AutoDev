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

import type {
  HookAction,
  HookDefinition,
  HookEvent,
  McpServerDefinition,
  McpServerTransport,
  McpTargetOverride,
  PromptAsset,
  PromptVersion,
  RuleSyncMcpState,
  RuleSyncValidationIssue,
  SkillDefinition
} from "@simulatorlife/autodev-core";
import { parse, type ParseError, printParseErrorCode } from "jsonc-parser";
import { parse as parseYaml } from "yaml";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COLLATOR = new Intl.Collator();
const MD_EXTENSION_PATTERN = /\.md$/u;
const COMMANDS_SOURCE = ".rulesync/commands" as const;
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const COMMAND_CONTENT_MAX_BYTES = 48_000;
const COMMAND_DIFF_MAX_BYTES = 196_608;
const COMMAND_HISTORY_LIMIT = 20;
const COMMAND_HISTORY_FETCH_LIMIT = COMMAND_HISTORY_LIMIT + 1;
const COMMAND_HISTORY_LINE_SPLIT_PATTERN = /\r?\n/u;
const COMMAND_GIT_TIMEOUT_MS = 3000;
const COMMAND_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const COMMAND_FRONTMATTER_PATTERN =
  /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u;
const SKILLS_SOURCE = ".rulesync/skills" as const;
const SKILL_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/u;
const SKILL_DESCRIPTION_MAX = 512;
const SKILL_CONTENT_MAX = 20_000;
const HOOK_EVENTS: ReadonlySet<string> = new Set([
  "sessionStart",
  "subagentStart",
  "beforeSubmitPrompt",
  "preToolUse"
]);
const COMMAND_UPDATE_QUEUES = new Map<string, Promise<void>>();

async function withCommandUpdateLock<T>(
  commandPath: string,
  update: () => Promise<T>
): Promise<T> {
  const previous = COMMAND_UPDATE_QUEUES.get(commandPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  COMMAND_UPDATE_QUEUES.set(commandPath, current);
  await previous;
  try {
    return await update();
  } finally {
    release();
    if (COMMAND_UPDATE_QUEUES.get(commandPath) === current) {
      COMMAND_UPDATE_QUEUES.delete(commandPath);
    }
  }
}

export interface RuleSyncHooksState {
  readonly source: ".rulesync/hooks.jsonc";
  readonly valid: boolean | null;
  /**
   * Why the source is invalid, empty when it is valid or was not observed.
   *
   * Required rather than optional so that a caller cannot read `valid: false`
   * and conclude there is nothing more to say. The loader knows which event
   * failed and what the parser objected to; reporting only the boolean made an
   * operator hunt through the file for a fault the system had already located.
   */
  readonly issues: readonly RuleSyncValidationIssue[];
  readonly hooks: readonly HookDefinition[];
}

export interface RuleSyncCommand extends PromptAsset {
  readonly name: string;
  readonly path: string;
  readonly kind: "command";
  readonly content: string;
  readonly prompt: string;
  readonly targets: readonly string[];
  readonly revision: string;
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

/** One located fault in the skill catalog. */
function invalidSkills(location: string, message: string): RuleSyncSkillsState {
  return {
    source: SKILLS_SOURCE,
    valid: false,
    issues: [{ location, message }],
    skills: []
  };
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
  let text: string;
  try {
    text = readFileSync(skillPath, "utf8");
  } catch (error) {
    return unreadable(error);
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
  return {
    kind: "skill",
    skill: {
      name: entry.name,
      description: (metadata as { description: string }).description,
      path: skillLocation
    }
  };
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

export interface RuleSyncCommandVersionReference {
  readonly versionHash: string;
  readonly updatedAt: string;
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

export class RuleSyncCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSyncCommandValidationError";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const source = ".rulesync/mcp.jsonc" as const;
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

function isHookEvent(value: string): value is HookEvent {
  return HOOK_EVENTS.has(value);
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
  document: unknown
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
  const issues: RuleSyncValidationIssue[] = [];
  for (const [event, value] of Object.entries(hooksValue)) {
    if (!isHookEvent(event)) {
      issues.push({
        location: event,
        message: `"${event}" is not a known hook event.`
      });
      continue;
    }
    // `firstInvalidHookActionIndex` answers "which action is bad", so it
    // answers `null` for a value that is not a list at all -- which is a
    // different fault and must be named here rather than passing as a clean
    // event with no actions.
    if (!Array.isArray(value)) {
      issues.push({
        location: event,
        message: `The actions for "${event}" must be an array.`
      });
      continue;
    }
    const invalidIndex = firstInvalidHookActionIndex(value);
    if (invalidIndex === null) continue;
    issues.push({
      location: `${event} action ${invalidIndex + 1}`,
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

function parseRuleSyncCommand(name: string, content: string): RuleSyncCommand {
  const frontmatter = content.match(COMMAND_FRONTMATTER_PATTERN);
  if (!frontmatter) {
    throw new RuleSyncCommandValidationError(
      `Command "${name}" must have valid YAML frontmatter.`
    );
  }
  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter[1]!);
  } catch {
    throw new RuleSyncCommandValidationError(
      `Command "${name}" frontmatter is invalid YAML.`
    );
  }
  if (!isRecord(metadata)) {
    throw new RuleSyncCommandValidationError(
      `Command "${name}" frontmatter must be a mapping.`
    );
  }
  const description = metadata.description;
  const targets = metadata.targets ?? ["*"];
  if (
    (description !== undefined && typeof description !== "string") ||
    !Array.isArray(targets) ||
    !targets.every((target) => typeof target === "string") ||
    (metadata.name !== undefined && metadata.name !== name)
  ) {
    throw new RuleSyncCommandValidationError(
      `Command "${name}" frontmatter metadata is invalid.`
    );
  }
  return {
    name,
    path: `${COMMANDS_SOURCE}/${name}.md`,
    kind: "command",
    content,
    prompt: frontmatter[2]?.trim() ?? "",
    targets,
    revision: createHash("sha256").update(content, "utf8").digest("hex"),
    ...(description === undefined ? {} : { description })
  };
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
      try {
        content = readFileSync(path.join(commandsDir, entry.name), "utf8");
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
        commands.push(parseRuleSyncCommand(name, content));
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

  loadCommandHistory(name: string): RuleSyncCommandHistory | null {
    if (!COMMAND_NAME_PATTERN.test(name)) return null;
    const state = this.loadCommands();
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
    const git = (args: readonly string[], maxBuffer: number): string =>
      execFileSync("git", ["-C", repositoryRoot, ...args], {
        encoding: "utf8",
        maxBuffer,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: COMMAND_GIT_TIMEOUT_MS
      });

    let output: string;
    try {
      output = git(
        [
          "log",
          "--format=%H%x00%cI",
          `--max-count=${COMMAND_HISTORY_FETCH_LIMIT}`,
          "--",
          `${COMMANDS_SOURCE}/${name}.md`
        ],
        8192
      );
    } catch {
      return commandHistoryFallback(git);
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
      return {
        status: "available",
        versions: entries.slice(0, COMMAND_HISTORY_LIMIT),
        hasMore: entries.length > COMMAND_HISTORY_LIMIT
      };
    } catch {
      return UNAVAILABLE_COMMAND_HISTORY;
    }
  }

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

    const history = this.loadCommandHistory(name);
    if (history === null || history.status === "unavailable") {
      throw new RuleSyncCommandHistoryUnavailableError();
    }
    const version = history.versions.find(
      (item) => item.versionHash === versionHash
    );
    if (!version) return null;

    try {
      const repositoryRoot = realpathSync(this.repositoryRoot);
      const content = execFileSync(
        "git",
        ["-C", repositoryRoot, "show", `${versionHash}:${command.path}`],
        {
          encoding: "utf8",
          maxBuffer: COMMAND_CONTENT_MAX_BYTES,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: COMMAND_GIT_TIMEOUT_MS
        }
      );
      const diff = execFileSync(
        "git",
        [
          "-C",
          repositoryRoot,
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
        {
          encoding: "utf8",
          maxBuffer: COMMAND_DIFF_MAX_BYTES,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: COMMAND_GIT_TIMEOUT_MS
        }
      );
      return {
        name,
        versionHash,
        updatedAt: version.updatedAt,
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
    return withCommandUpdateLock(commandPath, async () => {
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
      return parseRuleSyncCommand(name, persistedContent);
    });
  }

  loadHooksState(): RuleSyncHooksState {
    const hooksPath = path.join(
      this.repositoryRoot,
      ".rulesync",
      "hooks.jsonc"
    );
    const source = ".rulesync/hooks.jsonc" as const;
    if (!existsSync(hooksPath))
      return { source, valid: null, issues: [], hooks: [] };

    let content: string;
    try {
      content = readFileSync(hooksPath, "utf8");
    } catch {
      // Unreadable is not invalid. The file is there and the system has not
      // read it, so nothing about its contents may be claimed.
      return { source, valid: null, issues: [], hooks: [] };
    }

    const errors: ParseError[] = [];
    const document: unknown = parse(content, errors, {
      allowTrailingComma: true
    });

    const issues = hookValidationIssues(source, content, errors, document);
    if (issues.length > 0) {
      // No hooks are returned: the first issue is why the rest of the document
      // was never examined, and a partial list would read as the whole file.
      return { source, valid: false, issues, hooks: [] };
    }

    // No issues means the document parsed, is an object, has a `hooks` object,
    // and every event and action in it applied. The empty-object fallback is
    // unreachable for that reason alone; it exists so the narrowing is done by
    // the type system rather than by a cast.
    const hooksDocument =
      isRecord(document) && isRecord(document.hooks) ? document.hooks : {};
    const hooks: HookDefinition[] = [];
    for (const [event, value] of Object.entries(hooksDocument)) {
      if (!isHookEvent(event)) continue;
      const actions = parseHookActions(value);
      if (actions === null) continue;
      hooks.push({ event, actions });
    }
    return { source, valid: true, issues: [], hooks };
  }

  loadMcpState(): RuleSyncMcpState {
    const source = ".rulesync/mcp.jsonc" as const;
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
    return {
      name,
      path: `.rulesync/skills/${name}/SKILL.md`,
      uri: `rulesync://skills/${name}/SKILL.md`,
      revision
    };
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
