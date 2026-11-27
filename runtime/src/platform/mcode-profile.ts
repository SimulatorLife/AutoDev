/**
MiniMax Code (`mcode`) profile materialization.

MiniMax Code resolves the profile it reads from `--data-dir`,
`MINIMAX_DATA_DIR`, `MAVIS_DATA_DIR` or `~/.minimax`. It never reads
`MCODE_HOME`, so the profile AutoDev owns has to be handed over through
`MINIMAX_DATA_DIR` (see `runtime/src/acp/provider-profiles.ts`).

This module owns the artifacts MiniMax Code discovers natively inside that
profile. Every artifact is produced by stock RuleSync targets reading the
canonical `.rulesync/` sources; nothing here renders provider syntax by
hand:

- `AGENTS.md` -- the canonical rule projection (`agentsmd`).
- `hooks.json` -- the canonical hook projection (`claudecode`), in the
  Claude hook envelope MiniMax Code parses for user hooks. The document
  carries `enabled: true`, because MiniMax Code keeps user hooks off
  unless the document enables them.
- `permission.json` -- the canonical deny list (`claudecode` permissions),
  in MiniMax Code's native v2 rule shape.

The profile deliberately holds no MCP configuration. The role's authorized
MCP servers are injected into the ACP session from the canonical execution
contract, and MiniMax Code merges session servers over profile servers by
name; a profile-level server list would therefore expose servers to roles
that do not hold them.

The profile links the operator's own MiniMax Code `config.yaml` and `auth`
directory, so a session runs with the models and credentials the operator
already configured without copying secrets into AutoDev's tree.

The same canonical projection also enrolls the operator's standalone
profile (`~/.minimax`, read by the MiniMax Code desktop app and the
standalone `mcode` CLI) -- see {@link enrollMcodeOperatorProfile}. That
profile belongs to the operator, so enrollment merges AutoDev's
contribution into it instead of replacing it, and the two profiles must
never overlap. Its MCP registrations (`mcp.json`) are not reconciled here.
*/

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { isRecord } from "@simulatorlife/autodev-core";
import {
  atomicWriteSync,
  pathsOverlap
} from "@simulatorlife/autodev-data/files";
import { CANONICAL_TO_MCODE_TOOL_NAMES } from "@simulatorlife/autodev-runtime/shared/tool-names";

import { runRulesyncGenerate } from "./runtime-files.ts";

const PROFILE_INSTRUCTIONS_FILE = "AGENTS.md";
const PROFILE_HOOKS_FILE = "hooks.json";
const PROFILE_PERMISSION_FILE = "permission.json";
const OBSOLETE_PROFILE_FILES = ["permissions.json", "mcp.json"] as const;

const CLAUDE_SETTINGS_RELATIVE = path.join(".claude", "settings.json");

/**
The operator's own MiniMax Code profile directory.
*/
const OPERATOR_PROFILE_DIRECTORY = ".minimax";

const CANONICAL_MATCHER_INLINE_FLAGS = /\(\?[a-zA-Z]+\)/gu;

const FILE_NAME_COLLATOR = new Intl.Collator();

const MCODE_MATCHER_PART_PATTERN = /^[A-Za-z0-9_.:/-]+$/u;

/**
Claude permission categories and the MiniMax Code tools they name. A
category MiniMax Code does not know (an MCP server selector, for example)
stays with the canonical role contract and the gateway, because MiniMax
Code matches a rule by exact tool name and cannot express "every tool of
one MCP server".
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
  /**
  The canonical hooks, keyed by MiniMax Code hook event.
  */
  readonly hooks: Readonly<Record<string, unknown>>;
  /**
  The canonical deny rules in MiniMax Code's native v2 shape.
  */
  readonly deny: readonly McodePermissionEntry[];
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

function expandHome(pattern: string, home: string): string {
  if (pattern === "~") return home;
  return pattern.startsWith("~/") ? path.join(home, pattern.slice(2)) : pattern;
}

/**
Split a Claude permission rule into its tool name and its optional
pattern: `Bash`, `Bash(rm -rf *)`.
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
Translate one RuleSync/Claude permission rule into MiniMax Code's native
v2 rule. Returns `null` for a rule MiniMax Code cannot express, which is
reported rather than silently dropped.
*/
export function toMcodePermissionEntry(
  rule: string,
  home: string
): McodePermissionEntry | null {
  const parsed = parseClaudePermissionRule(rule);
  if (!parsed) return null;
  const { tool: claudeTool, pattern } = parsed;
  if (!Object.hasOwn(MCODE_TOOL_NAMES, claudeTool)) return null;
  const toolName = MCODE_TOOL_NAMES[claudeTool]!;
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
Project a canonical hook matcher onto the tool names MiniMax Code offers.

The canonical hook declarations are written in the Codex/Claude dialect:
inline case-insensitive flags and separator-tolerant names
(`apply[_ -]?patch`). MiniMax Code matches a hook against the names of the
tools it offers and rejects a matcher that carries an inline flag, so the
matcher is resolved against the canonical tool vocabulary and re-emitted in
MiniMax Code's dialect.

Returns `null` for a matcher that names no canonical tool, which means the
canonical dialect and MiniMax Code's dialect have drifted apart and the
matcher cannot be projected.
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
The canonical hook declarations in MiniMax Code's dialect.

Every matcher is projected onto the tool names MiniMax Code offers, so the
hooks fire there instead of being rejected by MiniMax Code's matcher
validation. A matcher that cannot be projected is an error: a hook that
never fires would leave the role boundary unenforced while the profile
claimed it was configured.
*/
export function renderMcodeHooks(
  hooks: Record<string, unknown>
): Record<string, unknown> {
  const rendered: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      rendered[event] = groups;
      continue;
    }
    rendered[event] = groups.map((group) => {
      if (!isRecord(group)) return group;
      // The standalone host does not inherit Runtime's AUTODEV_PROVIDER.
      // Add a fixed client identity only to the shared lifecycle handlers.
      const handlers = Array.isArray(group.hooks)
        ? group.hooks.map((handler: unknown) => {
            if (!isRecord(handler) || typeof handler.command !== "string")
              return handler;
            const command = handler.command;
            if (
              !/\/hooks\/(?:session-start\.ts|native-session\.ts (?:prompt|stop|end))$/u.test(
                command
              )
            )
              return handler;
            return { ...handler, command: command + " --client=mcode" };
          })
        : group.hooks;
      const projectedGroup = { ...group, hooks: handlers };
      const matcher = group.matcher;
      if (typeof matcher !== "string") return projectedGroup;
      const projected = toMcodeHookMatcher(matcher);
      if (projected === null) {
        throw new Error(
          `The canonical hook matcher for ${event} ("${matcher}") names no AutoDev tool, so it cannot be projected onto MiniMax Code's tool names`
        );
      }
      return { ...projectedGroup, matcher: projected };
    });
  }
  return rendered;
}

/**
The canonical permission document in MiniMax Code's native v2 shape.

Only the deny rules are projected. An allow rule in MiniMax Code's engine
answers a tool call without asking the ACP client, which would take the
role contract out of the decision; the canonical allows therefore stay with
the execution contract and the ACP permission boundary, exactly like the
per-role capability enforcement the canonical source documents.
*/
export function renderMcodeDenyEntries(
  claudePermissions: unknown,
  home: string
): McodePermissionEntry[] {
  const deny =
    isRecord(claudePermissions) && Array.isArray(claudePermissions.deny)
      ? claudePermissions.deny.filter(
          (entry): entry is string => typeof entry === "string"
        )
      : [];
  return deny
    .map((rule) => toMcodePermissionEntry(rule, home))
    .filter((entry): entry is McodePermissionEntry => entry !== null);
}

function renderPermissionDocument(
  deny: readonly McodePermissionEntry[]
): string {
  return `${JSON.stringify({ version: 2, allow: [], deny, ask: [] }, null, 2)}\n`;
}

function generateInto(
  repositoryRoot: string,
  outputRoot: string,
  targets: readonly string[],
  features: readonly string[]
): void {
  mkdirSync(outputRoot);
  runRulesyncGenerate(repositoryRoot, {
    inputRoots: [path.join(repositoryRoot, ".rulesync")],
    targets: [...targets],
    features: [...features],
    outputRoots: [outputRoot],
    silent: true
  });
}

/**
Render the MiniMax Code profile artifacts from the canonical `.rulesync/`
sources through stock RuleSync targets.
*/
export function renderMcodeProfileArtifacts(options: {
  readonly repositoryRoot: string;
  readonly home?: string;
}): McodeProfileArtifacts {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const home = options.home ?? process.env.HOME?.trim() ?? homedir();
  const temporary = mkdtempDisposableSync(
    path.join(tmpdir(), "autodev-mcode-rulesync-")
  );
  try {
    const rulesRoot = path.join(temporary.path, "rules");
    const claudeRoot = path.join(temporary.path, "claude");
    generateInto(repositoryRoot, rulesRoot, ["agentsmd"], ["rules"]);
    generateInto(
      repositoryRoot,
      claudeRoot,
      ["claudecode"],
      ["hooks", "permissions"]
    );
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
    const mcodeHooks = renderMcodeHooks(hooks);
    const deny = renderMcodeDenyEntries(permissions, home);
    return {
      agentsMd: readFileSync(agentsMdPath, "utf8"),
      hooks: mcodeHooks,
      deny,
      hooksJson: `${JSON.stringify(
        { enabled: true, hooks: mcodeHooks },
        null,
        2
      )}\n`,
      permissionJson: renderPermissionDocument(deny)
    };
  } finally {
    temporary.remove();
  }
}

/**
Whether `linkPath` is already a link to `target`.
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
Make `linkPath` a link to `target`, replacing whatever it holds. The
profile directory belongs to AutoDev, so an entry that is not a link is
replaced rather than left behind.
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
The operator's own model configuration and credentials stay in the
operator's profile; the AutoDev profile links them so a session runs with
the models the operator configured.
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
Resolve existing ancestors even when the final profile is not created yet.
In particular, a symlinked parent must not turn managed-profile cleanup
into writes inside the operator's standalone profile.
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

/**
The operator's standalone MiniMax Code profile for `home`.
*/
export function operatorMcodeProfileDirectory(home: string): string {
  return path.join(home, OPERATOR_PROFILE_DIRECTORY);
}

/**
Refuse any lexical or resolved-path overlap between the managed profile and
the operator profile. The managed profile's reconciliation replaces and
removes files, and the operator enrollment merges into what it finds, so
neither may ever act on the other's tree.
*/
function assertProfilesDisjoint(
  managedProfile: string,
  operatorProfile: string
): void {
  if (
    pathsOverlap(path.resolve(managedProfile), path.resolve(operatorProfile)) ||
    pathsOverlap(
      resolvedProfilePath(managedProfile),
      resolvedProfilePath(operatorProfile)
    )
  ) {
    throw new Error(
      "Managed MiniMax Code profile overlaps the operator profile."
    );
  }
}

/**
Materialize (or verify, with `check: true`) the AutoDev-managed MiniMax
Code profile. Never apply its destructive reconciliation rules to the
operator's standalone profile.
*/
export function materializeMcodeProfile(options: {
  readonly repositoryRoot: string;
  readonly profileDirectory: string;
  readonly home?: string;
  readonly check?: boolean;
  readonly artifacts?: McodeProfileArtifacts;
}): McodeProfileResult {
  const home = options.home ?? process.env.HOME?.trim() ?? homedir();
  const operatorProfile = operatorMcodeProfileDirectory(home);
  const profileDirectory = path.resolve(options.profileDirectory);
  assertProfilesDisjoint(profileDirectory, operatorProfile);
  const artifacts =
    options.artifacts ??
    renderMcodeProfileArtifacts({
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
  const obsolete = removeObsoleteProfileFiles(profileDirectory, {
    check: isCheck
  });

  return {
    profileDirectory,
    written: files.written,
    drifted: [...files.drifted, ...links, ...obsolete.drifted],
    removed: obsolete.removed
  };
}

// ---------------------------------------------------------------------------
// Operator profile enrollment
// ---------------------------------------------------------------------------

/**
Delimits AutoDev's canonical rules inside the operator's own `AGENTS.md`.
Everything outside the block is the operator's and is preserved verbatim.
*/
const OPERATOR_RULES_BEGIN =
  "<!-- BEGIN AutoDev canonical rules: generated from .rulesync/rules by the AutoDev installer; edit the canonical source, not this block -->";
const OPERATOR_RULES_END = "<!-- END AutoDev canonical rules -->";

/**
MiniMax Code reads at most this many bytes of the global `AGENTS.md`
(`GLOBAL_INSTRUCTIONS_MAX_BYTES` in MiniMax Code 3.1). A longer document is
truncated silently, which would drop canonical rules while the profile
claimed to carry them.
*/
export const MCODE_GLOBAL_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

/**
Where the installer records which hook groups and deny rules it merged
into the operator profile. It lives in the AutoDev home, never in the
operator profile, so a later reconciliation can retire exactly AutoDev's
own former contributions and nothing the operator wrote.
*/
export const OPERATOR_ENROLLMENT_RECORD = path.join(
  "providers",
  "mcode-operator-enrollment.json"
);

interface OperatorEnrollmentRecord {
  readonly version: 1;
  readonly hooks: Readonly<Record<string, readonly string[]>>;
  readonly deny: readonly string[];
}

export interface McodeOperatorEnrollmentResult {
  /**
  `null` when the operator profile does not exist, so nothing is enrolled.
  */
  readonly profileDirectory: string | null;
  readonly written: readonly string[];
  readonly drifted: readonly string[];
  /**
  Operator state enrollment will not override; each entry names the file
  and the operator choice that blocks it.
  */
  readonly conflicts: readonly string[];
}

/**
JSON with sorted object keys, so equal values compare equal.
*/
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    isRecord(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([left], [right]) =>
            FILE_NAME_COLLATOR.compare(left, right)
          )
        )
      : inner
  );
}

function readOptionalText(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

function readEnrollmentRecord(recordPath: string): OperatorEnrollmentRecord {
  const empty: OperatorEnrollmentRecord = { version: 1, hooks: {}, deny: [] };
  const text = readOptionalText(recordPath);
  if (text === null) return empty;
  const parsed = JSON.parse(text) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !isRecord(parsed.hooks) ||
    !Array.isArray(parsed.deny)
  ) {
    throw new Error(
      `The MiniMax Code operator enrollment record is not in the expected shape: ${recordPath}`
    );
  }
  const hooks: Record<string, string[]> = {};
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    if (Array.isArray(groups)) {
      hooks[event] = groups.filter((group) => typeof group === "string");
    }
  }
  return {
    version: 1,
    hooks,
    deny: parsed.deny.filter((entry) => typeof entry === "string")
  };
}

const OPERATOR_RULES_BLOCK = new RegExp(
  String.raw`${RegExp.escape(OPERATOR_RULES_BEGIN)}[\s\S]*?${RegExp.escape(OPERATOR_RULES_END)}\n?`,
  "u"
);

/**
The operator's `AGENTS.md` with AutoDev's canonical block reconciled. The
operator's own text is kept; the block replaces a previous block in place
or is appended after the operator's text.
*/
export function mergeOperatorInstructions(
  current: string | null,
  canonicalRules: string
): string {
  const block = `${OPERATOR_RULES_BEGIN}\n${canonicalRules.trimEnd()}\n${OPERATOR_RULES_END}\n`;
  if (current === null || current.trim() === "") return block;
  if (OPERATOR_RULES_BLOCK.test(current)) {
    return current.replace(OPERATOR_RULES_BLOCK, () => block);
  }
  return `${current.trimEnd()}\n\n${block}`;
}

/**
The operator's hooks document with AutoDev's canonical groups reconciled.
Groups the record says AutoDev wrote earlier are retired; every other
operator group is kept in its place, ahead of the canonical groups.
*/
function mergeOperatorHooks(
  current: Record<string, unknown>,
  canonical: Readonly<Record<string, unknown>>,
  record: OperatorEnrollmentRecord
): Record<string, unknown> {
  const currentHooks = isRecord(current.hooks) ? current.hooks : {};
  const merged: Record<string, unknown> = {};
  const events = new Set([
    ...Object.keys(currentHooks),
    ...Object.keys(canonical)
  ]);
  for (const event of events) {
    const operatorGroups = currentHooks[event];
    const canonicalGroups = Array.isArray(canonical[event])
      ? (canonical[event] as unknown[])
      : [];
    if (operatorGroups !== undefined && !Array.isArray(operatorGroups)) {
      merged[event] = operatorGroups;
      continue;
    }
    const canonicalKeys = new Set(canonicalGroups.map(stableJson));
    const retired = new Set(record.hooks[event]);
    const kept = (operatorGroups ?? []).filter((group) => {
      const key = stableJson(group);
      return !retired.has(key) && !canonicalKeys.has(key);
    });
    const groups = [...kept, ...canonicalGroups];
    if (groups.length > 0) merged[event] = groups;
  }
  return { ...current, enabled: true, hooks: merged };
}

/**
The operator's permission document with AutoDev's canonical deny rules
reconciled. The operator's allow and ask rules, and deny rules AutoDev did
not write, are kept unchanged.
*/
function mergeOperatorPermissions(
  current: Record<string, unknown>,
  canonicalDeny: readonly McodePermissionEntry[],
  record: OperatorEnrollmentRecord
): Record<string, unknown> {
  const canonicalKeys = new Set(canonicalDeny.map(stableJson));
  const retired = new Set(record.deny);
  const operatorDeny = Array.isArray(current.deny) ? current.deny : [];
  const kept = operatorDeny.filter((entry) => {
    const key = stableJson(entry);
    return !retired.has(key) && !canonicalKeys.has(key);
  });
  // The operator's key order is kept; a new document gets MiniMax Code's own.
  const merged: Record<string, unknown> = {
    version: 2,
    allow: [],
    deny: [],
    ask: [],
    ...current
  , deny: [...kept, ...canonicalDeny],};
  return { ...current, ...merged };
}

function parseOperatorJson(
  filePath: string,
  conflicts: string[]
): Record<string, unknown> | null {
  const text = readOptionalText(filePath);
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // Reported below.
  }
  conflicts.push(`${filePath} is not a JSON object; it was left unchanged`);
  return null;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
Enroll (or verify, with `check: true`) the operator's standalone MiniMax
Code profile with the canonical RuleSync projection: the canonical rules
in its global `AGENTS.md`, the canonical hooks (session bootstrap, command
policy, skill-read telemetry, role sandbox) in its `hooks.json`, and the
canonical deny rules in its `permission.json`. Skills need no write here:
MiniMax Code reads the user-level `~/.agents/skills` AutoDev already
materializes.

Enrollment merges and never replaces. The operator's own instructions,
hooks, allow/ask rules, model configuration, credentials, history and
`mcp.json` are left as they are; an operator choice enrollment would have
to override (user hooks explicitly disabled, a file that is not JSON, an
unsupported permission schema) is reported as a conflict instead.

An absent operator profile means MiniMax Code has never run as this user,
so nothing is created.
*/
export function enrollMcodeOperatorProfile(options: {
  readonly repositoryRoot: string;
  readonly managedProfileDirectory: string;
  readonly enrollmentRecord: string;
  readonly home?: string;
  readonly check?: boolean;
  readonly artifacts?: McodeProfileArtifacts;
}): McodeOperatorEnrollmentResult {
  const home = options.home ?? process.env.HOME?.trim() ?? homedir();
  const profileDirectory = operatorMcodeProfileDirectory(home);
  assertProfilesDisjoint(options.managedProfileDirectory, profileDirectory);
  if (
    pathsOverlap(
      resolvedProfilePath(options.enrollmentRecord),
      resolvedProfilePath(profileDirectory)
    )
  ) {
    throw new Error(
      "The MiniMax Code operator enrollment record must live outside the operator profile."
    );
  }
  let profileStat;
  try {
    profileStat = lstatSync(profileDirectory);
  } catch {
    return { profileDirectory: null, written: [], drifted: [], conflicts: [] };
  }
  if (!profileStat.isDirectory()) {
    return {
      profileDirectory,
      written: [],
      drifted: [],
      conflicts: [
        `${profileDirectory} is not a directory; MiniMax Code operator enrollment was skipped`
      ]
    };
  }

  const artifacts =
    options.artifacts ??
    renderMcodeProfileArtifacts({
      repositoryRoot: options.repositoryRoot,
      home
    });
  const record = readEnrollmentRecord(options.enrollmentRecord);
  const conflicts: string[] = [];
  const files: Array<readonly [string, string]> = [];
  // A part that is not enrolled keeps its previous record, so AutoDev's
  // former contribution can still be retired once the conflict is resolved.
  let recordedHooks = record.hooks;
  let recordedDeny = record.deny;

  const instructionsPath = path.join(
    profileDirectory,
    PROFILE_INSTRUCTIONS_FILE
  );
  const instructions = mergeOperatorInstructions(
    readOptionalText(instructionsPath),
    artifacts.agentsMd
  );
  if (Buffer.byteLength(instructions) > MCODE_GLOBAL_INSTRUCTIONS_MAX_BYTES) {
    conflicts.push(
      `${instructionsPath} would exceed MiniMax Code's ${MCODE_GLOBAL_INSTRUCTIONS_MAX_BYTES}-byte global instruction limit with the canonical rules; it was left unchanged`
    );
  } else {
    files.push([instructionsPath, instructions]);
  }

  const hooksPath = path.join(profileDirectory, PROFILE_HOOKS_FILE);
  const hooksDocument = parseOperatorJson(hooksPath, conflicts);
  if (hooksDocument !== null) {
    const hasOperatorGroups =
      isRecord(hooksDocument.hooks) &&
      Object.values(hooksDocument.hooks).some(
        (groups) => Array.isArray(groups) && groups.length > 0
      );
    if (hooksDocument.enabled === false) {
      conflicts.push(
        `${hooksPath} disables user hooks ("enabled": false); the canonical hooks were not enrolled`
      );
    } else if (hasOperatorGroups && hooksDocument.enabled !== true) {
      conflicts.push(
        `${hooksPath} holds operator hooks that are not enabled; enabling user hooks for the canonical hooks would also enable them, so it was left unchanged`
      );
    } else {
      files.push([
        hooksPath,
        formatJson(mergeOperatorHooks(hooksDocument, artifacts.hooks, record))
      ]);
      recordedHooks = Object.fromEntries(
        Object.entries(artifacts.hooks).map(([event, groups]) => [
          event,
          Array.isArray(groups) ? groups.map(stableJson) : []
        ])
      );
    }
  }

  const permissionPath = path.join(profileDirectory, PROFILE_PERMISSION_FILE);
  const permissionDocument = parseOperatorJson(permissionPath, conflicts);
  if (permissionDocument !== null) {
    if (
      permissionDocument.version === undefined ||
      permissionDocument.version === 2
    ) {
      files.push([
        permissionPath,
        formatJson(
          mergeOperatorPermissions(permissionDocument, artifacts.deny, record)
        )
      ]);
      recordedDeny = artifacts.deny.map(stableJson);
    } else {
      conflicts.push(
        `${permissionPath} uses permission schema version ${String(permissionDocument.version)}, not 2; the canonical deny rules were not enrolled`
      );
    }
  }

  const isCheck = options.check === true;
  const written = writeProfileFiles(files, { check: isCheck });
  const nextRecord: OperatorEnrollmentRecord = {
    version: 1,
    hooks: recordedHooks,
    deny: recordedDeny
  };
  const recordFiles = writeProfileFiles(
    [[options.enrollmentRecord, formatJson(nextRecord)]],
    { check: isCheck }
  );
  return {
    profileDirectory,
    written: [...written.written, ...recordFiles.written],
    drifted: [...written.drifted, ...recordFiles.drifted],
    conflicts
  };
}

export interface McodeProfilesResult {
  readonly managed: McodeProfileResult;
  readonly operator: McodeOperatorEnrollmentResult;
}

/**
Reconcile (or verify, with `check: true`) both MiniMax Code profiles from
one rendering of the canonical sources: the AutoDev-managed profile that
Runtime-managed `mcode acp` sessions run against, and the operator's
standalone profile.
*/
export function reconcileMcodeProfiles(options: {
  readonly repositoryRoot: string;
  readonly autodevHome: string;
  readonly home?: string;
  readonly check?: boolean;
}): McodeProfilesResult {
  const home = options.home ?? process.env.HOME?.trim() ?? homedir();
  const managedProfileDirectory = path.join(
    options.autodevHome,
    "providers",
    "mcode"
  );
  assertProfilesDisjoint(
    managedProfileDirectory,
    operatorMcodeProfileDirectory(home)
  );
  const artifacts = renderMcodeProfileArtifacts({
    repositoryRoot: options.repositoryRoot,
    home
  });
  const managed = materializeMcodeProfile({
    repositoryRoot: options.repositoryRoot,
    profileDirectory: managedProfileDirectory,
    home,
    check: options.check === true,
    artifacts
  });
  const operator = enrollMcodeOperatorProfile({
    repositoryRoot: options.repositoryRoot,
    managedProfileDirectory,
    enrollmentRecord: path.join(
      options.autodevHome,
      OPERATOR_ENROLLMENT_RECORD
    ),
    home,
    check: options.check === true,
    artifacts
  });
  return { managed, operator };
}
