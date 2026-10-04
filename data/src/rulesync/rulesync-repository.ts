import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
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

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COLLATOR = new Intl.Collator();
const MD_EXTENSION_PATTERN = /\.md$/u;
const SKILL_DESCRIPTION_PATTERN = /description:\s*([^\n]+)/i;
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

function parseBaseMcpServers(
  declarations: Record<string, unknown>
): Map<string, MutableMcpServer> | null {
  const servers = new Map<string, MutableMcpServer>();
  for (const [name, config] of Object.entries(declarations)) {
    if (!name.trim() || !isMcpConfig(config)) return null;
    const command =
      typeof config.command === "string" ? config.command : undefined;
    const args =
      Array.isArray(config.args) &&
      config.args.every((arg) => typeof arg === "string")
        ? (config.args as string[])
        : undefined;
    const url = typeof config.url === "string" ? config.url : undefined;
    const envKeys = isRecord(config.env)
      ? Object.keys(config.env).sort(COLLATOR.compare)
      : undefined;
    const cwd = typeof config.cwd === "string" ? config.cwd : undefined;
    const defaultToolsApprovalMode =
      typeof config.default_tools_approval_mode === "string"
        ? config.default_tools_approval_mode
        : undefined;

    servers.set(name, {
      enabled: config.disabled !== true,
      transport: mcpTransport(config),
      targetOverrides: [],
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      ...(url ? { url } : {}),
      ...(envKeys ? { envKeys } : {}),
      ...(cwd ? { cwd } : {}),
      ...(defaultToolsApprovalMode ? { defaultToolsApprovalMode } : {})
    });
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
    for (const [name, config] of Object.entries(overrides)) {
      if (config !== null && !isMcpConfig(config)) return false;
      const enabled = config !== null && config.disabled !== true;
      let server = servers.get(name);
      if (!server) {
        server = {
          enabled: null,
          transport: config === null ? "unknown" : mcpTransport(config),
          targetOverrides: []
        };
        servers.set(name, server);
      }
      const defaultToolsApprovalMode =
        config && typeof config.default_tools_approval_mode === "string"
          ? config.default_tools_approval_mode
          : undefined;
      const enabledTools =
        config &&
        Array.isArray(config.enabled_tools) &&
        config.enabled_tools.every((tool) => typeof tool === "string")
          ? (config.enabled_tools as string[])
          : undefined;
      server.targetOverrides.push({
        target,
        enabled,
        ...(defaultToolsApprovalMode ? { defaultToolsApprovalMode } : {}),
        ...(enabledTools ? { enabledTools } : {})
      });
    }
  }
  return true;
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

export class RuleSyncRepository {
  readonly repositoryRoot: string;

  constructor(repositoryRoot: string = DEFAULT_REPO_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  loadCommands(): PromptAsset[] {
    const commandsDir = path.join(this.repositoryRoot, ".rulesync", "commands");
    if (!existsSync(commandsDir)) return [];
    try {
      const files = readdirSync(commandsDir);
      return files
        .filter((file) => file.endsWith(".md"))
        .sort((a, b) => COLLATOR.compare(a, b))
        .map((file) => {
          const name = file.replace(MD_EXTENSION_PATTERN, "");
          const fullPath = path.join(commandsDir, file);
          let content = "";
          try {
            content = readFileSync(fullPath, "utf8");
          } catch {
            // Ignore unreadable file
          }
          return {
            name,
            path: `.rulesync/commands/${file}`,
            description: `RuleSync command ${name}`,
            content
          };
        });
    } catch {
      return [];
    }
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

  loadSkills(): SkillDefinition[] {
    const skillsDir = path.join(this.repositoryRoot, ".rulesync", "skills");
    if (!existsSync(skillsDir)) return [];
    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const name = entry.name;
          const skillMd = path.join(skillsDir, name, "SKILL.md");
          let description = `RuleSync skill ${name}`;
          if (existsSync(skillMd)) {
            try {
              const text = readFileSync(skillMd, "utf8");
              const descMatch = text.match(SKILL_DESCRIPTION_PATTERN);
              if (descMatch?.[1]) {
                const rawDescription = descMatch[1].trim();
                if (rawDescription.startsWith('"')) {
                  try {
                    const parsed: unknown = JSON.parse(rawDescription);
                    if (typeof parsed === "string") description = parsed;
                  } catch {
                    description = rawDescription;
                  }
                } else {
                  description = rawDescription;
                }
              }
            } catch {
              // Ignore unreadable SKILL.md
            }
          }
          return {
            name,
            description,
            path: `.rulesync/skills/${name}/SKILL.md`
          };
        })
        .sort((a, b) => COLLATOR.compare(a.name, b.name));
    } catch {
      return [];
    }
  }
}
