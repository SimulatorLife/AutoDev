import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { resolveRuntimeSourceRoot } from "./runtime-source-root.ts";

export function resolveSkillRoots(configuredRepoRoot?: string): string[] {
  const home = homedir();
  const repoRoot =
    configuredRepoRoot?.trim() ||
    resolveRuntimeSourceRoot(
      import.meta.dirname,
      process.env.AUTODEV_REPO_ROOT
    );

  return [
    path.join(home, ".agents", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, "AutoDev", ".agents", "skills"),
    path.join(home, "AutoDev", ".rulesync", "skills"),
    path.join(repoRoot, ".agents", "skills"),
    path.join(repoRoot, ".rulesync", "skills")
  ].filter((p) => existsSync(p));
}

export const SKILL_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "readfile",
  "read",
  "view_file",
  "viewfile",
  "view",
  "cat_file",
  "catfile"
]);

export const SKILL_EXEC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "run_command",
  "exec_command",
  "execcommand",
  "execute_command",
  "execute",
  "bash",
  "shell"
]);

export const SKILL_READ_COMMANDS: ReadonlySet<string> = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "awk",
  "grep"
]);

export const SHELL_CONTROL_TOKENS: ReadonlySet<string> = new Set([
  "|",
  "&&",
  "||",
  ";",
  "&"
]);

const DIRECT_PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "filepath",
  "AbsolutePath",
  "absolutePath",
  "targetFile",
  "TargetFile",
  "file"
] as const;

const ARRAY_PATH_KEYS = ["files", "paths", "file_paths"] as const;

const LEADING_SEPARATORS = /^[\\/]+/;

export function normaliseSkillReadPath(raw: unknown): string | null {
  const home = homedir();
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replaceAll(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  let result = trimmed;
  if (result.startsWith("~")) result = path.join(home, result.slice(1));
  if (!path.isAbsolute(result)) result = path.resolve(result);
  return result;
}

export function tokenizeShellWords(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cmd)) !== null) {
    let token = match[0];
    if (
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))
    ) {
      token = token.slice(1, -1);
    }
    tokens.push(token);
  }
  return tokens;
}

export function isPathLikeToken(token: unknown): string | null {
  if (typeof token !== "string" || !token || token.startsWith("-")) return null;
  if (token.startsWith("/") || token.startsWith("~")) return token;
  return null;
}

export function flattenCommandValue(raw: unknown): string {
  let value: unknown = raw;
  while (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const next =
      record.cmd ?? record.command ?? record.script ?? record.value ?? null;
    if (next === undefined || next === null || next === value) break;
    value = next;
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string").join(" ");
  }
  return typeof value === "string" ? value : "";
}

export function matchExecReadPaths(raw: unknown): string[] {
  const cmd = flattenCommandValue(raw);
  if (!cmd || cmd.length > 4096) return [];
  const tokens = tokenizeShellWords(cmd);
  const candidates: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i] ?? "";
    const isSedPrint = word === "sed" && tokens[i + 1] === "-n";
    if (!SKILL_READ_COMMANDS.has(word) && !isSedPrint) continue;
    const start = isSedPrint ? i + 2 : i + 1;
    for (let j = start; j < tokens.length && j < start + 8; j++) {
      const next = tokens[j] ?? "";
      if (SHELL_CONTROL_TOKENS.has(next)) break;
      const candidate = isPathLikeToken(next);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

export function matchSkillReadTarget(
  filePath: string | null,
  customRoots?: readonly string[]
): { skill: string; root: string } | null {
  if (!filePath) return null;
  const normalised = filePath.replaceAll(/[\\/]+/g, path.sep);
  if (
    !normalised.endsWith(path.sep + "SKILL.md") &&
    !normalised.endsWith("/SKILL.md") &&
    normalised !== "SKILL.md"
  ) {
    return null;
  }
  const roots = customRoots ?? resolveSkillRoots();
  for (const rootRaw of roots) {
    const root = rootRaw.replaceAll(/[\\/]+/g, path.sep);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (!normalised.startsWith(rootWithSep)) continue;
    const relative = normalised
      .slice(root.length)
      .replace(LEADING_SEPARATORS, "");
    if (
      !relative.endsWith(path.sep + "SKILL.md") &&
      !relative.endsWith("/SKILL.md") &&
      relative !== "SKILL.md"
    )
      continue;
    const segments = relative.split(path.sep).filter(Boolean);
    const skill = segments[0];
    if (!skill || skill.includes("..") || segments.length > 2) continue;
    return { skill, root };
  }
  return null;
}

export function matchSkillReadPath(
  filePath: string | null,
  customRoots?: readonly string[]
): string | null {
  return matchSkillReadTarget(filePath, customRoots)?.skill ?? null;
}

export function extractSkillReadPath(
  toolName: unknown,
  argsObject: unknown
): string | null {
  const name = String(toolName ?? "")
    .trim()
    .toLowerCase();

  const isObject =
    argsObject && typeof argsObject === "object" && !Array.isArray(argsObject);
  const args = isObject ? (argsObject as Record<string, unknown>) : {};

  if (SKILL_READ_TOOL_NAMES.has(name)) {
    for (const key of DIRECT_PATH_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    for (const key of ARRAY_PATH_KEYS) {
      const value = args[key];
      if (Array.isArray(value) && value.length > 0) {
        const first = value.find(
          (entry) => typeof entry === "string" && entry.trim()
        );
        if (typeof first === "string") return first.trim();
      }
    }
    return null;
  }

  if (SKILL_EXEC_TOOL_NAMES.has(name)) {
    const command =
      typeof argsObject === "string"
        ? argsObject
        : (args.command ?? args.cmd ?? argsObject);
    const candidates = matchExecReadPaths(command);
    for (const candidate of candidates) {
      if (matchSkillReadPath(normaliseSkillReadPath(candidate))) {
        return candidate;
      }
    }
    return candidates[0] ?? null;
  }

  return null;
}
