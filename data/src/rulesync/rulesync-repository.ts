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
  RuleSyncMcpState,
  SkillDefinition
} from "@simulatorlife/autodev-core";
import { parse, type ParseError } from "jsonc-parser";
import { parse as parseYaml } from "yaml";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COLLATOR = new Intl.Collator();
const MD_EXTENSION_PATTERN = /\.md$/u;
const COMMANDS_SOURCE = ".rulesync/commands" as const;
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const COMMAND_CONTENT_MAX_BYTES = 48_000;
const COMMAND_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
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

export interface RuleSyncHooksState {
  readonly source: ".rulesync/hooks.jsonc";
  readonly valid: boolean | null;
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

function parseHookActions(value: unknown): HookAction[] | null {
  if (!Array.isArray(value)) return null;
  const actions: HookAction[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      entry.type !== "command" ||
      typeof entry.command !== "string" ||
      entry.command.trim().length === 0 ||
      (entry.matcher !== undefined && typeof entry.matcher !== "string") ||
      (entry.statusMessage !== undefined &&
        typeof entry.statusMessage !== "string")
    ) {
      return null;
    }
    actions.push({
      type: "command",
      command: entry.command,
      ...(typeof entry.matcher === "string" ? { matcher: entry.matcher } : {}),
      ...(typeof entry.statusMessage === "string"
        ? { statusMessage: entry.statusMessage }
        : {})
    });
  }
  return actions;
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
  const metadata: unknown = parseYaml(frontmatter[1]!);
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

/**
 * Parsed RuleSync sources keyed by absolute file path. Parsing is a pure
 * function of the file content, so a cached result is reused only while the
 * content read on this request is byte-identical; any edit re-parses. Every
 * catalog read still lists and reads its directory, so additions, removals,
 * and edits are observed immediately.
 */
const parsedCommandCache = new Map<
  string,
  { readonly content: string; readonly command: RuleSyncCommand }
>();
const parsedSkillMetadataCache = new Map<
  string,
  { readonly content: string; readonly metadata: unknown }
>();

/** Drops cached parses whose source file was not listed on this read. */
function pruneParsedSources(
  cache: Map<string, unknown>,
  listed: ReadonlySet<string>,
  isInDirectory: (filePath: string) => boolean
): void {
  for (const filePath of cache.keys()) {
    if (isInDirectory(filePath) && !listed.has(filePath)) {
      cache.delete(filePath);
    }
  }
}

function cachedRuleSyncCommand(
  filePath: string,
  name: string,
  content: string
): RuleSyncCommand {
  const cached = parsedCommandCache.get(filePath);
  if (cached?.content === content) return cached.command;
  const command = parseRuleSyncCommand(name, content);
  parsedCommandCache.set(filePath, { content, command });
  return command;
}

function cachedSkillMetadata(filePath: string, frontmatter: string): unknown {
  const cached = parsedSkillMetadataCache.get(filePath);
  if (cached?.content === frontmatter) return cached.metadata;
  const metadata: unknown = parseYaml(frontmatter);
  parsedSkillMetadataCache.set(filePath, { content: frontmatter, metadata });
  return metadata;
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
      const listed = new Set<string>();
      for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
        if (!entry.name.endsWith(".md")) continue;
        if (entry.isSymbolicLink() || !entry.isFile()) {
          return { source: COMMANDS_SOURCE, valid: false, commands: [] };
        }
        const name = entry.name.replace(MD_EXTENSION_PATTERN, "");
        const filePath = path.join(commandsDir, entry.name);
        listed.add(filePath);
        commands.push(
          cachedRuleSyncCommand(filePath, name, readFileSync(filePath, "utf8"))
        );
      }
      pruneParsedSources(
        parsedCommandCache,
        listed,
        (filePath) => path.dirname(filePath) === commandsDir
      );
      commands.sort((left, right) => COLLATOR.compare(left.name, right.name));
      return { source: COMMANDS_SOURCE, valid: true, commands };
    } catch {
      return { source: COMMANDS_SOURCE, valid: false, commands: [] };
    }
  }

  async updateCommand(
    input: RuleSyncCommandUpdateInput
  ): Promise<RuleSyncCommand> {
    const name = input.name;
    if (!COMMAND_NAME_PATTERN.test(name)) {
      throw new RuleSyncCommandValidationError(
        "Command name must be a lowercase hyphenated slug."
      );
    }
    if (!COMMAND_REVISION_PATTERN.test(input.expectedRevision)) {
      throw new RuleSyncCommandValidationError(
        "Expected command revision is invalid."
      );
    }
    const content = input.content
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n");
    if (
      Buffer.byteLength(content, "utf8") > COMMAND_CONTENT_MAX_BYTES ||
      hasControlCharacters(content)
    ) {
      throw new RuleSyncCommandValidationError(
        "Command content contains unsafe controls or exceeds its safe size bound."
      );
    }

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

    const updated = parseRuleSyncCommand(name, content);
    if (updated.revision === current.revision) return current;

    const directory = resolveCanonicalRuleSyncDirectory(
      this.repositoryRoot,
      "commands"
    );
    if (directory.valid !== true || directory.path === null) {
      throw new RuleSyncCommandConflictError(
        "Canonical RuleSync command directory is no longer available."
      );
    }
    const commandsDir = directory.path;
    const commandPath = path.join(commandsDir, `${name}.md`);
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
  }

  loadHooksState(): RuleSyncHooksState {
    const hooksPath = path.join(
      this.repositoryRoot,
      ".rulesync",
      "hooks.jsonc"
    );
    const source = ".rulesync/hooks.jsonc" as const;
    if (!existsSync(hooksPath)) return { source, valid: null, hooks: [] };

    let content: string;
    try {
      content = readFileSync(hooksPath, "utf8");
    } catch {
      return { source, valid: null, hooks: [] };
    }

    const errors: ParseError[] = [];
    const document: unknown = parse(content, errors, {
      allowTrailingComma: true
    });
    if (errors.length > 0 || !isRecord(document) || !isRecord(document.hooks)) {
      return { source, valid: false, hooks: [] };
    }

    const hooks: HookDefinition[] = [];
    for (const [event, value] of Object.entries(document.hooks)) {
      if (!isHookEvent(event)) return { source, valid: false, hooks: [] };
      const actions = parseHookActions(value);
      if (!actions) return { source, valid: false, hooks: [] };
      hooks.push({ event, actions });
    }
    return { source, valid: true, hooks };
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
      const listed = new Set<string>();
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
        listed.add(skillPath);
        const metadata = cachedSkillMetadata(skillPath, frontmatter[1]!);
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
      pruneParsedSources(
        parsedSkillMetadataCache,
        listed,
        (filePath) => path.dirname(path.dirname(filePath)) === skillsDir
      );
      skills.sort((left, right) => COLLATOR.compare(left.name, right.name));
      return { source: SKILLS_SOURCE, valid: true, skills };
    } catch {
      return { source: SKILLS_SOURCE, valid: false, skills: [] };
    }
  }
}
