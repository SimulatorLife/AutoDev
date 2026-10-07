import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
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
  SkillDefinition
} from "@simulatorlife/autodev-core";
import { parse, type ParseError,printParseErrorCode } from "jsonc-parser";
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

/**
 * One reason a canonical source cannot be applied.
 *
 * `location` names the part of the document at fault in the same terms the
 * operator is looking at -- an event name, an action index, or a source line --
 * and `message` says what is wrong with it. Neither is a diagnosis of the fix;
 * both are the fact the loader observed and would otherwise have discarded.
 */
export interface RuleSyncValidationIssue {
  readonly location: string;
  readonly message: string;
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

export interface RuleSyncCommandsState {
  readonly source: typeof COMMANDS_SOURCE;
  readonly valid: boolean | null;
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

function parseBaseMcpServers(
  declarations: Record<string, unknown>
): Map<string, MutableMcpServer> | null {
  const servers = new Map<string, MutableMcpServer>();
  for (const [name, config] of Object.entries(declarations)) {
    if (!name.trim() || !isMcpConfig(config)) return null;
    servers.set(name, projectBaseMcpServer(config));
  }
  return servers;
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

function applyMcpTargetOverrides(
  document: Record<string, unknown>,
  servers: Map<string, MutableMcpServer>
): boolean {
  for (const [target, targetConfig] of Object.entries(document)) {
    if (!isTargetMcpConfig(target, targetConfig)) continue;
    const overrides = targetConfig.mcpServers;
    if (!isRecord(overrides)) return false;
    if (!applyMcpOverridesForTarget(target, overrides, servers)) return false;
  }
  return true;
}

function applyMcpOverridesForTarget(
  target: string,
  overrides: Record<string, unknown>,
  servers: Map<string, MutableMcpServer>
): boolean {
  for (const [name, config] of Object.entries(overrides)) {
    if (config !== null && !isMcpConfig(config)) return false;
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
  return true;
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
  const errors: ParseError[] = [];
  const document: unknown = parse(content, errors, {
    allowTrailingComma: true
  });
  if (errors.length > 0 || !isRecord(document)) return null;
  if (!isRecord(document.mcpServers)) return null;
  const servers = parseBaseMcpServers(document.mcpServers);
  if (!servers || !applyMcpTargetOverrides(document, servers)) return null;
  return {
    source: ".rulesync/mcp.jsonc",
    valid: true,
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
 * A human sentence for one parse error.
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
function hookParseIssue(
  content: string,
  error: ParseError
): RuleSyncValidationIssue {
  const before = content.slice(0, Math.max(0, error.offset));
  const line = before.split("\n").length;
  const codeName = printParseErrorCode(error.error);
  const words = codeName.replaceAll(/([a-z\d])([A-Z])/gu, "$1 $2").toLowerCase();
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
    return errors.map((error) => hookParseIssue(content, error));
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
}

function resolveCanonicalRuleSyncDirectory(
  repositoryRoot: string,
  childDirectory: "commands" | "skills"
): CanonicalRuleSyncDirectory {
  let root: string;
  try {
    root = realpathSync(repositoryRoot);
  } catch (error) {
    return {
      valid: isMissingFileError(error) ? null : false,
      path: null
    };
  }
  const rootPath = path.join(root, ".rulesync");
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(rootPath);
  } catch (error) {
    return {
      valid: isMissingFileError(error) ? null : false,
      path: null
    };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { valid: false, path: null };
  }
  const sourcePath = path.join(rootPath, childDirectory);
  let sourceStat: ReturnType<typeof lstatSync>;
  try {
    sourceStat = lstatSync(sourcePath);
  } catch (error) {
    return {
      valid: isMissingFileError(error) ? null : false,
      path: null
    };
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    return { valid: false, path: null };
  }
  return { valid: true, path: sourcePath };
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
        commands: []
      };
    }
    const commandsDir = directory.path;

    try {
      const commands: RuleSyncCommand[] = [];
      for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
        if (!entry.name.endsWith(".md")) continue;
        if (entry.isSymbolicLink() || !entry.isFile()) {
          return { source: COMMANDS_SOURCE, valid: false, commands: [] };
        }
        const name = entry.name.replace(MD_EXTENSION_PATTERN, "");
        commands.push(
          parseRuleSyncCommand(
            name,
            readFileSync(path.join(commandsDir, entry.name), "utf8")
          )
        );
      }
      commands.sort((left, right) => COLLATOR.compare(left.name, right.name));
      return { source: COMMANDS_SOURCE, valid: true, commands };
    } catch {
      return { source: COMMANDS_SOURCE, valid: false, commands: [] };
    }
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
    if (!existsSync(mcpPath)) return { source, valid: null, servers: [] };

    let content: string;
    try {
      content = readFileSync(mcpPath, "utf8");
    } catch {
      return { source, valid: false, servers: [] };
    }

    return parseMcpState(content) ?? { source, valid: false, servers: [] };
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
      return { source: SKILLS_SOURCE, valid: directory.valid, skills: [] };
    }
    const skillsDir = directory.path;

    try {
      const skills: SkillDefinition[] = [];
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          return { source: SKILLS_SOURCE, valid: false, skills: [] };
        }
        if (!entry.isDirectory()) continue;
        if (!SKILL_NAME_PATTERN.test(entry.name)) {
          return { source: SKILLS_SOURCE, valid: false, skills: [] };
        }
        const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
        const skillStat = lstatSync(skillPath);
        if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
          return { source: SKILLS_SOURCE, valid: false, skills: [] };
        }
        const text = readFileSync(skillPath, "utf8");
        const frontmatter = text.match(SKILL_FRONTMATTER_PATTERN);
        if (!frontmatter) {
          return { source: SKILLS_SOURCE, valid: false, skills: [] };
        }
        const metadata: unknown = parseYaml(frontmatter[1]!);
        if (
          !isRecord(metadata) ||
          metadata.name !== entry.name ||
          typeof metadata.description !== "string" ||
          metadata.description.trim().length === 0
        ) {
          return { source: SKILLS_SOURCE, valid: false, skills: [] };
        }
        skills.push({
          name: entry.name,
          description: metadata.description,
          path: `.rulesync/skills/${entry.name}/SKILL.md`
        });
      }
      skills.sort((left, right) => COLLATOR.compare(left.name, right.name));
      return { source: SKILLS_SOURCE, valid: true, skills };
    } catch {
      return { source: SKILLS_SOURCE, valid: false, skills: [] };
    }
  }
}
