import { execFileSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync
} from "node:fs";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";

import { findExecutable } from "../shared/executables.ts";

export type HostArch = "arm64" | "amd64";
export type ExecutableArch = HostArch | "universal";

const MACH_O_64_MAGIC = 0xfe_ed_fa_cf;
const MACH_O_FAT_MAGIC = 0xca_fe_ba_be;
const MACH_O_CPU_ARM64 = 0x01_00_00_0c;
const MACH_O_CPU_X86_64 = 0x01_00_00_07;
const ELF_MAGIC = 0x7f_45_4c_46;
const ELF_MACHINE_X86_64 = 0x3e;
const ELF_MACHINE_AARCH64 = 0xb7;
const NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/u;
const CODEX_VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/u;

/**
 * The machine's architecture, not this process's: a Node running under
 * Rosetta reports `x64` on Apple Silicon, and choosing binaries by that picks
 * Intel builds that Rosetta must translate on every cold start.
 */
export function hostArch(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  appleSilicon: () => boolean = sysctlReportsArm64
): HostArch {
  if (platform === "darwin" && appleSilicon()) return "arm64";
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "amd64";
  throw new Error(`unsupported host architecture: ${platform}/${arch}`);
}

function sysctlReportsArm64(): boolean {
  try {
    return (
      execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim() === "1"
    );
  } catch {
    return false;
  }
}

/** The architecture a Mach-O or ELF executable was built for, from its header. */
export function executableArch(filePath: string): ExecutableArch | null {
  const header = Buffer.alloc(20);
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    if (readSync(fd, header, 0, header.length, 0) < header.length) return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (header.readUInt32BE(0) === MACH_O_FAT_MAGIC) return "universal";
  if (header.readUInt32LE(0) === MACH_O_64_MAGIC) {
    const cpu = header.readUInt32LE(4);
    if (cpu === MACH_O_CPU_ARM64) return "arm64";
    if (cpu === MACH_O_CPU_X86_64) return "amd64";
    return null;
  }
  if (header.readUInt32BE(0) === ELF_MAGIC) {
    const machine = header.readUInt16LE(18);
    if (machine === ELF_MACHINE_AARCH64) return "arm64";
    if (machine === ELF_MACHINE_X86_64) return "amd64";
  }
  return null;
}

export function runsNatively(
  filePath: string,
  host: HostArch = hostArch()
): boolean {
  const arch = executableArch(filePath);
  return arch === "universal" || arch === host;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function newestNvmNode(home: string): string | null {
  const versions = path.join(home, ".nvm", "versions", "node");
  let entries: string[];
  try {
    entries = readdirSync(versions);
  } catch {
    return null;
  }
  const newest = entries
    .map((name) => ({ name, parts: NODE_VERSION_PATTERN.exec(name) }))
    .filter((entry) => entry.parts !== null)
    .sort((left, right) => {
      for (let index = 1; index <= 3; index += 1) {
        const difference =
          Number(right.parts![index]) - Number(left.parts![index]);
        if (difference !== 0) return difference;
      }
      return 0;
    })[0];
  return newest ? path.join(versions, newest.name, "bin", "node") : null;
}

/**
 * The Node binary launchd services should run on: the first native one among
 * the installer's own Node and the usual install locations. launchd's PATH
 * otherwise finds `/usr/local/bin/node` first, an Intel build on many Apple
 * Silicon Macs, and every service then runs translated by Rosetta.
 */
export function resolveServiceNode(
  home: string,
  host: HostArch = hostArch(),
  candidates: readonly (string | null)[] = [
    process.execPath,
    newestNvmNode(home),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node"
  ]
): string {
  const usable = candidates.filter(
    (candidate): candidate is string =>
      candidate !== null && isExecutable(candidate)
  );
  return (
    usable.find((candidate) => runsNatively(candidate, host)) ??
    usable[0] ??
    process.execPath
  );
}

const defaultCodexVersionCache = new Map<
  string,
  {
    readonly mtimeMs: number;
    readonly size: number;
    readonly version: string | null;
  }
>();

function defaultCodexVersionRunner(
  file: string,
  args: readonly string[]
): string {
  return execFileSync(file, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000
  });
}

function probeCodexCliVersion(
  binary: string,
  run: (file: string, args: readonly string[]) => string
): string | null {
  let output: string;
  try {
    output = run(binary, ["--version"]);
  } catch {
    return null;
  }
  return CODEX_VERSION_PATTERN.exec(output)?.[0] ?? null;
}

/** The version a Codex CLI reports, or null when it does not report one. */
export function codexCliVersion(
  binary: string,
  run?: (file: string, args: readonly string[]) => string
): string | null {
  if (!run) {
    let stat: { mtimeMs: number; size: number } | null = null;
    try {
      stat = statSync(binary);
    } catch {
      /* unavailable */
    }
    const cached = stat ? defaultCodexVersionCache.get(binary) : undefined;
    if (
      stat &&
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.version;
    }
    const version = probeCodexCliVersion(binary, defaultCodexVersionRunner);
    if (stat) {
      defaultCodexVersionCache.set(binary, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        version
      });
    }
    return version;
  }
  return probeCodexCliVersion(binary, run);
}

function compareVersions(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The Codex CLI launchd services should run on.
 *
 * The services dispatch roles through the Codex CLI, and the CLI has to be
 * the one the operator's own session runs: launchd's pinned PATH finds
 * `/usr/local/bin/codex` first, which on many machines is an old CLI that
 * rejects the flags the role bridge passes. The newest CLI the machine has
 * wins, so a stale copy on the default PATH cannot shadow the current one.
 */
export function resolveServiceCodex(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  versionOf: (binary: string) => string | null = codexCliVersion
): string | null {
  const configured = env.CODEX_BIN?.trim();
  if (configured) {
    if (isExecutable(configured)) return configured;
    throw new Error(`Codex CLI is not executable: ${configured}`);
  }
  const candidates = [
    ...new Set(
      [
        path.join(home, ".local/bin/codex"),
        findExecutable("codex", env.PATH),
        ...nvmCodexBinaries(home)
      ].filter(
        (candidate): candidate is string =>
          candidate !== null && isExecutable(candidate)
      )
    )
  ];
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map((candidate) => ({ candidate, version: versionOf(candidate) }))
    .sort((left, right) => compareVersions(left.version, right.version));
  return ranked[0]?.candidate ?? null;
}

function nvmCodexBinaries(home: string): readonly string[] {
  const versions = path.join(home, ".nvm", "versions", "node");
  let entries: string[];
  try {
    entries = readdirSync(versions);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => NODE_VERSION_PATTERN.test(entry))
    .sort()
    .map((entry) => path.join(versions, entry, "bin", "codex"));
}

export const NATIVE_NODE_PROFILE_BEGIN = "# >>> AutoDev native node >>>";
export const NATIVE_NODE_PROFILE_END = "# <<< AutoDev native node <<<";

const SYSTEM_NODE_CANDIDATES = ["/usr/local/bin/node"] as const;

export interface NativeNodeLoginProfileOptions {
  readonly host?: HostArch;
  readonly systemCandidates?: readonly string[];
  readonly nodeCandidates?: readonly (string | null)[];
}

function escapeDoubleQuotedShell(value: string): string {
  return value.replaceAll(/["$\\`]/gu, String.raw`\$&`);
}

/**
 * First executable system Node whose architecture does not match the machine
 * (e.g. an Intel `/usr/local/bin/node` on Apple Silicon). macOS `/etc/zprofile`
 * runs `/usr/libexec/path_helper -s`, which puts `/usr/local/bin` back near the
 * front of `PATH` on every login shell (`zsh -lc`).
 */
export function foreignArchSystemNodePath(
  host: HostArch = hostArch(),
  candidates: readonly string[] = SYSTEM_NODE_CANDIDATES
): string | null {
  return (
    candidates.find(
      (candidate) => isExecutable(candidate) && !runsNatively(candidate, host)
    ) ?? null
  );
}

/**
 * Directory of the native Node binary to prepend in `~/.zprofile` so login
 * shells do not resolve a Rosetta `node` from `/usr/local/bin`, or null when
 * no shadowing foreign-arch system Node exists or no alternative native binary
 * is installed.
 */
export function nativeNodeLoginProfileDir(
  home: string,
  options: NativeNodeLoginProfileOptions = {}
): string | null {
  const host = options.host ?? hostArch();
  const foreign = foreignArchSystemNodePath(host, options.systemCandidates);
  if (foreign === null) return null;
  const nativeNode = resolveServiceNode(home, host, options.nodeCandidates);
  if (!isExecutable(nativeNode) || !runsNatively(nativeNode, host)) return null;
  const nodeDir = path.dirname(nativeNode);
  return nodeDir === path.dirname(foreign) ? null : nodeDir;
}

/** Render the managed `.zprofile` snippet placing `nodeDir` ahead of system paths. */
export function renderNativeNodeLoginProfileBlock(nodeDir: string): string {
  const quoted = escapeDoubleQuotedShell(nodeDir);
  return [
    NATIVE_NODE_PROFILE_BEGIN,
    "# Keep macOS login shells (e.g. zsh -lc after path_helper) on native Node",
    "# instead of a Rosetta binary under /usr/local/bin.",
    `if [ -d "${quoted}" ]; then`,
    `  export PATH="${quoted}:$PATH"`,
    "fi",
    NATIVE_NODE_PROFILE_END
  ].join("\n");
}

function stripManagedNativeNodeBlock(existing: string): string {
  const lines = existing.replaceAll("\r\n", "\n").split("\n");
  const output: string[] = [];
  let insideBlock = false;
  for (const line of lines) {
    if (!insideBlock && line === NATIVE_NODE_PROFILE_BEGIN) {
      insideBlock = true;
      continue;
    }
    if (insideBlock) {
      if (line === NATIVE_NODE_PROFILE_END) insideBlock = false;
      continue;
    }
    output.push(line);
  }
  return output.join("\n").trimEnd();
}

/**
 * Idempotently insert, update, or remove the AutoDev native-node login-shell
 * block in `.zprofile` while preserving all operator-owned content.
 */
export function applyNativeNodeLoginProfileContent(
  existing: string,
  nodeDir: string | null
): string {
  const cleanedBase = stripManagedNativeNodeBlock(existing);
  if (nodeDir === null) return cleanedBase ? `${cleanedBase}\n` : "";
  const block = renderNativeNodeLoginProfileBlock(nodeDir);
  return cleanedBase ? `${cleanedBase}\n\n${block}\n` : `${block}\n`;
}

/**
 * Ensure `$HOME/.zprofile` resolves native Node after macOS `path_helper` when
 * a foreign-arch system Node would otherwise shadow it in login shells.
 */
export function syncNativeNodeLoginProfile(
  home: string,
  options: NativeNodeLoginProfileOptions = {}
): {
  readonly profilePath: string;
  readonly nodeDir: string | null;
  readonly changed: boolean;
} {
  const profilePath = path.join(home, ".zprofile");
  const nodeDir = nativeNodeLoginProfileDir(home, options);
  const fileExists = existsSync(profilePath);
  if (!fileExists && nodeDir === null) {
    return { profilePath, nodeDir, changed: false };
  }
  const existing = fileExists ? readFileSync(profilePath, "utf8") : "";
  const next = applyNativeNodeLoginProfileContent(existing, nodeDir);
  if (next === existing) {
    return { profilePath, nodeDir, changed: false };
  }
  atomicWriteSync(profilePath, next, { mode: 0o644, skipUnchanged: true });
  return { profilePath, nodeDir, changed: true };
}

/** Whether `$HOME/.zprofile` matches the expected native-node login-shell state. */
export function nativeNodeLoginProfileMatches(
  home: string,
  options: NativeNodeLoginProfileOptions = {}
): boolean {
  const profilePath = path.join(home, ".zprofile");
  const nodeDir = nativeNodeLoginProfileDir(home, options);
  if (!existsSync(profilePath)) return nodeDir === null;
  const existing = readFileSync(profilePath, "utf8");
  return existing === applyNativeNodeLoginProfileContent(existing, nodeDir);
}
