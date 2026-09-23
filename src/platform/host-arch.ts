import { execFileSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readdirSync,
  readSync
} from "node:fs";
import path from "node:path";

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
