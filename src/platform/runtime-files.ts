import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync
} from "node:fs";
import path from "node:path";

import { writeErrorLine, writeLine } from "../shared/output.ts";

export type RuntimeFileMode = 0o644 | 0o755;

export function runtimeTarget(
  repoPath: string,
  codexHome: string,
  hooksDir = path.join(codexHome, "hooks")
): string {
  return repoPath.startsWith("scripts/")
    ? path.join(hooksDir, repoPath.slice("scripts/".length))
    : path.join(codexHome, repoPath);
}

function ensureParent(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

/** Atomically materialize a versioned runtime file with its execution mode. */
export function materializeRuntimeFile(
  source: string,
  target: string,
  mode: RuntimeFileMode
): void {
  ensureParent(target);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.autodev-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed or absent */
    }
  }
}

export function linkRuntimeSource(source: string, target: string): void {
  if (!source.startsWith("/"))
    throw new Error(`refusing-relative-symlink-source ${source}`);
  ensureParent(target);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      if (readlinkSync(target) === source) return;
      unlinkSync(target);
    } else if (stat.isDirectory()) {
      throw new Error(`refusing to replace directory ${target}`);
    } else {
      unlinkSync(target);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    symlinkSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() && readlinkSync(target) === source) return;
      unlinkSync(target);
      symlinkSync(source, target);
    } else {
      throw error;
    }
  }
}

export function runtimeLinkMatches(source: string, target: string): boolean {
  try {
    return (
      source.startsWith("/") &&
      lstatSync(target).isSymbolicLink() &&
      readlinkSync(target) === source
    );
  } catch {
    return false;
  }
}

export function validateSkillSource(source: string): void {
  if (!source.startsWith("/"))
    throw new Error(`refusing-relative-skill-source ${source}`);
  const directory = lstatSync(source);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error(`invalid-skill-directory ${source}`);
  const document = lstatSync(`${source}/SKILL.md`);
  if (!document.isFile() || document.isSymbolicLink())
    throw new Error(`invalid-skill-document ${source}/SKILL.md`);
}

export function linkSkillSource(source: string, target: string): void {
  validateSkillSource(source);
  linkRuntimeSource(source, target);
}

export function skillLinkMatches(source: string, target: string): boolean {
  try {
    validateSkillSource(source);
    return (
      runtimeLinkMatches(source, target) &&
      lstatSync(`${target}/SKILL.md`).isFile() &&
      !lstatSync(`${target}/SKILL.md`).isSymbolicLink()
    );
  } catch {
    return false;
  }
}

export function runtimeFileMatches(source: string, target: string): boolean {
  try {
    if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())
      return false;
    return readFileSync(source).equals(readFileSync(target));
  } catch {
    return false;
  }
}

function parseMode(value: string | undefined): RuntimeFileMode {
  if (value === "0644") return 0o644;
  if (value === "0755") return 0o755;
  throw new Error(`unsupported runtime file mode: ${value ?? "(missing)"}`);
}

function cli(argv: string[]): number {
  const [command, ...args] = argv;
  if (command === "target" && args.length === 3) {
    writeLine(runtimeTarget(args[2]!, args[0]!, args[1]!));
    return 0;
  }
  if (command === "copy" && args.length === 3) {
    materializeRuntimeFile(args[1]!, args[2]!, parseMode(args[0]));
    return 0;
  }
  if (command === "check" && args.length === 2)
    return runtimeFileMatches(args[0]!, args[1]!) ? 0 : 1;
  if (command === "link" && args.length === 2) {
    linkRuntimeSource(args[0]!, args[1]!);
    return 0;
  }
  if (command === "check-link" && args.length === 2)
    return runtimeLinkMatches(args[0]!, args[1]!) ? 0 : 1;
  if (command === "link-skill" && args.length === 2) {
    linkSkillSource(args[0]!, args[1]!);
    return 0;
  }
  if (command === "check-skill" && args.length === 2)
    return skillLinkMatches(args[0]!, args[1]!) ? 0 : 1;
  throw new Error(
    "usage: runtime-files target <codex-home> <hooks-dir> <repo-path> | copy <0644|0755> <source> <target> | check <source> <target> | link <source> <target> | check-link <source> <target> | link-skill <source> <target> | check-skill <source> <target>"
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    writeErrorLine(
      `runtime-files: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
