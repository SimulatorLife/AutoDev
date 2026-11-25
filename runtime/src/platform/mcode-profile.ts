/**
 * MiniMax Code (`mcode`) profile materialization.
 *
 * MiniMax Code resolves the profile it reads from `--data-dir`,
 * `MINIMAX_DATA_DIR`, `MAVIS_DATA_DIR` or `~/.minimax`. It never reads
 * `MCODE_HOME`, so the profile AutoDev owns has to be handed over through
 * `MINIMAX_DATA_DIR` (see `runtime/src/acp/provider-profiles.ts`).
 *
 * This module owns the artifacts MiniMax Code discovers natively inside that
 * profile. Every artifact is produced by stock RuleSync targets reading the
 * canonical `.rulesync/` sources; nothing here renders provider syntax by
 * hand:
 *
 * - `AGENTS.md` -- the canonical rule projection (`agentsmd`).
 * - `hooks.json` -- the canonical hook projection (`claudecode`), in the
 *   Claude hook envelope MiniMax Code parses for user hooks. The document
 *   carries `enabled: true`, because MiniMax Code keeps user hooks off
 *   unless the document enables them.
 * - `permission.json` -- the canonical deny list (`claudecode` permissions),
 *   in MiniMax Code's native v2 rule shape.
 *
 * The profile deliberately holds no MCP configuration. The role's authorized
 * MCP servers are injected into the ACP session from the canonical execution
 * contract, and MiniMax Code merges session servers over profile servers by
 * name; a profile-level server list would therefore expose servers to roles
 * that do not hold them.
 *
 * The profile links the operator's own MiniMax Code `config.yaml` and `auth`
 * directory, so a session runs with the models and credentials the operator
 * already configured without copying secrets into AutoDev's tree.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { CANONICAL_TO_MCODE_TOOL_NAMES } from "@simulatorlife/autodev-runtime/shared/tool-names";

import { runRulesyncGenerate } from "./runtime-files.ts";

const PROFILE_INSTRUCTIONS_FILE = "AGENTS.md";
const PROFILE_HOOKS_FILE = "hooks.json";
const PROFILE_PERMISSION_FILE = "permission.json";
const OBSOLETE_PROFILE_FILES = ["permissions.json", "mcp.json"] as const;

const CLAUDE_SETTINGS_RELATIVE = path.join(".claude", "settings.json");

/** The operator's own MiniMax Code profile directory. */
const OPERATOR_PROFILE_DIRECTORY = ".minimax";

const CANONICAL_MATCHER_INLINE_FLAGS = /\(\?[a-zA-Z]+\)/gu;

const FILE_NAME_COLLATOR = new Intl.Collator();

const MCODE_MATCHER_PART_PATTERN = /^[A-Za-z0-9_.:/-]+$/u;

/**
 * Claude permission categories and the MiniMax Code tools they name. A
 * category MiniMax Code does not know (an MCP server selector, for example)
 * stays with the canonical role contract and the gateway, because MiniMax
 * Code matches a rule by exact tool name and cannot express "every tool of
 * one MCP server".
 */
const MCODE_TOOL_NAMES: Readonly<Record<string, string>> = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  Write: "write",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "web_fetch",
  WebSearch: "web_search"
};

const MCODE_PATH_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  read: ["read"],
  edit: ["write"],
  write: ["write"],
  glob: ["read"],
  grep: ["read"]
};

export interface McodeProfileArtifacts {
  readonly agentsMd: string;
  readonly hooksJson: string;
  readonly permissionJson: string;
}

export interface McodeProfileResult {
  readonly profileDirectory: string;
  readonly written: readonly string[];
  readonly drifted: readonly string[];
  readonly removed: readonly string[];
}

interface McodePermissionEntry {
  readonly tool_name: string;
  readonly matcher: {
    readonly kind: "tool" | "command" | "path";
    readonly pattern?: string;
    readonly actions?: readonly string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expandHome(pattern: string, home: string): string {
  if (pattern === "~") return home;
  return pattern.startsWith("~/")
    ? path.join(home, pattern.slice(2))
    : pattern;
}

/**
 * Split a Claude permission rule into its tool name and its optional
 * pattern: `Bash`, `Bash(rm -rf *)`.
 */
function parseClaudePermissionRule(
  rule: string
): { readonly tool: string; readonly pattern?: string } | null {
  const trimmed = rule.trim();
  const open = trimmed.indexOf("(");
  if (open === -1) return trimmed ? { tool: trimmed } : null;
  if (!trimmed.endsWith(")")) return null;
  return {
    tool: trimmed.slice(0, open),
    pattern: trimmed.slice(open + 1, -1)
  };
}

/**
 * Translate one RuleSync/Claude permission rule into MiniMax Code's native
 * v2 rule. Returns `null` for a rule MiniMax Code cannot express, which is
 * reported rather than silently dropped.
 */
export function toMcodePermissionEntry(
  rule: string,
  home: string
): McodePermissionEntry | null {
  const parsed = parseClaudePermissionRule(rule);
  if (!parsed) return null;
  const { tool: claudeTool, pattern } = parsed;
  const toolName = MCODE_TOOL_NAMES[claudeTool];
  if (!toolName) return null;
  if (pattern === undefined) {
    return { tool_name: toolName, matcher: { kind: "tool" } };
  }
  if (toolName === "bash") {
    return { tool_name: "bash", matcher: { kind: "command", pattern } };
  }
  const actions = MCODE_PATH_ACTIONS[toolName];
  if (!actions) {
    return { tool_name: toolName, matcher: { kind: "tool" } };
  }
  return {
    tool_name: toolName,
    matcher: {
      kind: "path",
      pattern: expandHome(pattern, home),
      actions: [...actions]
    }
  };
}

/**
 * Project a canonical hook matcher onto the tool names MiniMax Code offers.
 *
 * The canonical hook declarations are written in the Codex/Claude dialect:
 * inline case-insensitive flags and separator-tolerant names
 * (`apply[_ -]?patch`). MiniMax Code matches a hook against the names of the
 * tools it offers and rejects a matcher that carries an inline flag, so the
 * matcher is resolved against the canonical tool vocabulary and re-emitted in
 * MiniMax Code's dialect.
 *
 * Returns `null` for a matcher that names no canonical tool, which means the
 * canonical dialect and MiniMax Code's dialect have drifted apart and the
 * matcher cannot be projected.
 */
export function toMcodeHookMatcher(matcher: string): string | null {
  const stripped = matcher
    .replaceAll(CANONICAL_MATCHER_INLINE_FLAGS, "")
    .trim();
  if (["", ".*", "^.*$"].includes(stripped)) return ".*";
  let canonical: RegExp;
  try {
    canonical = new RegExp(stripped, "iu");
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const [toolName, mcodeName] of Object.entries(
    CANONICAL_TO_MCODE_TOOL_NAMES
  )) {
    if (canonical.test(toolName)) names.add(mcodeName);
  }
  if (names.size === 0) return null;
  const parts = [...names].sort(FILE_NAME_COLLATOR.compare);
  if (parts.every((part) => MCODE_MATCHER_PART_PATTERN.test(part))) {
    return parts.join("|");
  }
  return `^(${parts.join("|")})$`;
}

/**
 * The canonical hook declarations in MiniMax Code's dialect.
 *
 * Every matcher is projected onto the tool names MiniMax Code offers, so the
 * hooks fire there instead of being rejected by MiniMax Code's matcher
 * validation. A matcher that cannot be projected is an error: a hook that
 * never fires would leave the role boundary unenforced while the profile
 * claimed it was configured.
 */
export function renderMcodeHooks(hooks: Record<string, unknown>): unknown {
  const rendered: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      rendered[event] = groups;
      continue;
    }
    rendered[event] = groups.map((group) => {
      if (!isRecord(group)) return group;
      const matcher = group.matcher;
      if (typeof matcher !== "string") return group;
      const projected = toMcodeHookMatcher(matcher);
      if (projected === null) {
        throw new Error(
          `The canonical hook matcher for ${event} ("${matcher}") names no AutoDev tool, so it cannot be projected onto MiniMax Code's tool names`
        );
      }
      return { ...group, matcher: projected };
    });
  }
  return rendered;
}

/**
 * The canonical permission document in MiniMax Code's native v2 shape.
 *
 * Only the deny rules are projected. An allow rule in MiniMax Code's engine
 * answers a tool call without asking the ACP client, which would take the
 * role contract out of the decision; the canonical allows therefore stay with
 * the execution contract and the ACP permission boundary, exactly like the
 * per-role capability enforcement the canonical source documents.
 */
export function renderMcodePermissionDocument(
  claudePermissions: unknown,
  home: string
): string {
  const deny = isRecord(claudePermissions) && Array.isArray(claudePermissions.deny)
    ? claudePermissions.deny.filter(
        (entry): entry is string => typeof entry === "string"
      )
    : [];
  const entries = deny
    .map((rule) => toMcodePermissionEntry(rule, home))
    .filter((entry): entry is McodePermissionEntry => entry !== null);
  return `${JSON.stringify(
    { version: 2, allow: [], deny: entries, ask: [] },
    null,
    2
  )}\n`;
}

function generateInto(
  repositoryRoot: string,
  targets: readonly string[],
  features: readonly string[]
): string {
  const outputRoot = mkdtempSync(
    path.join(tmpdir(), "autodev-mcode-rulesync-")
  );
  runRulesyncGenerate(repositoryRoot, {
    inputRoots: [path.join(repositoryRoot, ".rulesync")],
    targets: [...targets],
    features: [...features],
    outputRoots: [outputRoot],
    silent: true
  });
  return outputRoot;
}

/**
 * Render the MiniMax Code profile artifacts from the canonical `.rulesync/`
 * sources through stock RuleSync targets.
 */
export function renderMcodeProfileArtifacts(options: {
  readonly repositoryRoot: string;
  readonly home?: string;
}): McodeProfileArtifacts {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const home = options.home ?? process.env.HOME?.trim() ?? homedir();
  const rulesRoot = generateInto(repositoryRoot, ["agentsmd"], ["rules"]);
  const claudeRoot = generateInto(
    repositoryRoot,
    ["claudecode"],
    ["hooks", "permissions"]
  );
  try {
    const agentsMdPath = path.join(rulesRoot, PROFILE_INSTRUCTIONS_FILE);
    if (!existsSync(agentsMdPath)) {
      throw new Error(
        `RuleSync did not generate the MiniMax Code instructions: ${agentsMdPath}`
      );
    }
    const settingsPath = path.join(claudeRoot, CLAUDE_SETTINGS_RELATIVE);
    if (!existsSync(settingsPath)) {
      throw new Error(
        `RuleSync did not generate the MiniMax Code hook projection: ${settingsPath}`
      );
    }
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    const hooks = isRecord(settings) ? settings.hooks : undefined;
    if (!isRecord(hooks)) {
      throw new Error(
        `RuleSync generated no hooks for MiniMax Code: ${settingsPath}`
      );
    }
    const permissions = isRecord(settings) ? settings.permissions : undefined;
    return {
      agentsMd: readFileSync(agentsMdPath, "utf8"),
      hooksJson: `${JSON.stringify(
        { enabled: true, hooks: renderMcodeHooks(hooks) },
        null,
        2
      )}\n`,
      permissionJson: renderMcodePermissionDocument(permissions, home)
    };
  } finally {
    rmSync(rulesRoot, { recursive: true, force: true });
    rmSync(claudeRoot, { recursive: true, force: true });
  }
}

/**
 * Whether `linkPath` is already a link to `target`.
 */
function isLinkTo(linkPath: string, target: string): boolean {
  try {
    return (
      lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath) === target
    );
  } catch {
    return false;
  }
}

/**
 * Make `linkPath` a link to `target`, replacing whatever it holds. The
 * profile directory belongs to AutoDev, so an entry that is not a link is
 * replaced rather than left behind.
 */
function writeLink(linkPath: string, target: string): void {
  try {
    if (lstatSync(linkPath).isSymbolicLink()) unlinkSync(linkPath);
    else rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // Nothing to replace.
  }
  mkdirSync(path.dirname(linkPath), { recursive: true, mode: 0o700 });
  symlinkSync(target, linkPath);
}

function writeProfileFiles(
  files: ReadonlyArray<readonly [string, string]>,
  options: { readonly check?: boolean }
): { readonly written: string[]; readonly drifted: string[] } {
  const written: string[] = [];
  const drifted: string[] = [];
  for (const [filePath, expected] of files) {
    const current = existsSync(filePath)
      ? readFileSync(filePath, "utf8")
      : null;
    if (current === expected) continue;
    if (options.check) {
      drifted.push(filePath);
      continue;
    }
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    atomicWriteSync(filePath, expected, { mode: 0o600 });
    written.push(filePath);
  }
  return { written, drifted };
}

/**
 * The operator's own model configuration and credentials stay in the
 * operator's profile; the AutoDev profile links them so a session runs with
 * the models the operator configured.
 */
function reconcileProfileLinks(
  links: ReadonlyArray<readonly [string, string]>,
  options: { readonly check?: boolean }
): string[] {
  const drifted: string[] = [];
  for (const [linkPath, target] of links) {
    if (!existsSync(target)) {
      if (existsSync(linkPath) && !options.check) {
        rmSync(linkPath, { force: true });
      }
      continue;
    }
    if (isLinkTo(linkPath, target)) continue;
    if (options.check) {
      drifted.push(linkPath);
      continue;
    }
    writeLink(linkPath, target);
  }
  return drifted;
}

function removeObsoleteProfileFiles(
  profileDirectory: string,
  options: { readonly check?: boolean }
): { readonly removed: string[]; readonly drifted: string[] } {
  const removed: string[] = [];
  const drifted: string[] = [];
  for (const obsolete of OBSOLETE_PROFILE_FILES) {
    const obsoletePath = path.join(profileDirectory, obsolete);
    if (!existsSync(obsoletePath)) continue;
    if (options.check) {
      drifted.push(obsoletePath);
      continue;
    }
    rmSync(obsoletePath, { force: true });
    removed.push(obsoletePath);
  }
  return { removed, drifted };
}

/**
 * Resolve existing ancestors even when the final profile is not created yet.
 * In particular, a symlinked parent must not turn managed-profile cleanup
 * into writes inside the operator's standalone profile.
 */
function resolvedProfilePath(value: string): string {
  const absolute = path.resolve(value);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(resolvedProfilePath(parent), path.basename(absolute));
  }
}

function profilesOverlap(left: string, right: string): boolean {
  const within = (root: string, candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep))
    );
  };
  return within(left, right) || within(right, left);
}

/**
 * Materialize (or verify, with `check: true`) the AutoDev-managed MiniMax
 * Code profile. Never apply its destructive reconciliation rules to the
 * operator's standalone profile.
 */
export function materializeMcodeProfile(options: {
  readonly repositoryRoot: string;
  readonly profileDirectory: string;
  readonly home?: string;
  readonly check?: boolean;
}): McodeProfileResult {
  const home = options.home ?? process.env.HOME?.trim() ?? homedir();
  const operatorProfile = path.join(home, OPERATOR_PROFILE_DIRECTORY);
  const profileDirectory = path.resolve(options.profileDirectory);
  if (
    profilesOverlap(profileDirectory, path.resolve(operatorProfile)) ||
    profilesOverlap(
      resolvedProfilePath(profileDirectory),
      resolvedProfilePath(operatorProfile)
    )
  ) {
    throw new Error(
      "Managed MiniMax Code profile overlaps the operator profile."
    );
  }
  const artifacts = renderMcodeProfileArtifacts({
    repositoryRoot: options.repositoryRoot,
    home
  });
  const isCheck = options.check === true;

  const files = writeProfileFiles(
    [
      [
        path.join(profileDirectory, PROFILE_INSTRUCTIONS_FILE),
        artifacts.agentsMd
      ],
      [path.join(profileDirectory, PROFILE_HOOKS_FILE), artifacts.hooksJson],
      [
        path.join(profileDirectory, PROFILE_PERMISSION_FILE),
        artifacts.permissionJson
      ]
    ],
    { check: isCheck }
  );
  const links = reconcileProfileLinks(
    [
      [
        path.join(profileDirectory, "config.yaml"),
        path.join(operatorProfile, "config.yaml")
      ],
      [path.join(profileDirectory, "auth"), path.join(operatorProfile, "auth")]
    ],
    { check: isCheck }
  );
  const obsolete = removeObsoleteProfileFiles(profileDirectory, { check: isCheck });

  return {
    profileDirectory,
    written: files.written,
    drifted: [...files.drifted, ...links, ...obsolete.drifted],
    removed: obsolete.removed
  };
}
