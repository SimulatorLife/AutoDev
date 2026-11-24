import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";

import { resolveCommandOnPath } from "./runtime-files.ts";

export const SUPERGATEWAY_VERSION = "4.2.2";

/** Install a pinned local CLI with the project's existing package manager.
 * No registry resolution or package installation occurs during service startup.
 * The private installation retains its own lockfile across normal installs.
 */
export function ensureSupergateway(directory: string): string {
  const root = path.join(directory, "supergateway");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const manifest = path.join(root, "package.json");
  const lock = path.join(root, "pnpm-lock.yaml");
  const executable = path.join(root, "node_modules", ".bin", "supergateway");
  const installedManifest = path.join(root, "node_modules", "supergateway", "package.json");
  const desired = JSON.stringify({
    name: "autodev-local-supergateway",
    private: true,
    dependencies: { supergateway: SUPERGATEWAY_VERSION }
  }, null, 2) + "\n";
  const manifestMatches = existsSync(manifest) && readFileSync(manifest, "utf8") === desired;
  function installed(): boolean {
    try {
      const pkg = JSON.parse(readFileSync(installedManifest, "utf8")) as { version?: string };
      return pkg.version === SUPERGATEWAY_VERSION && resolveCommandOnPath(executable) !== null;
    } catch {
      return false;
    }
  }
  if (manifestMatches && existsSync(lock) && installed()) return executable;

  const pnpm = resolveCommandOnPath("pnpm");
  if (!pnpm) throw new Error("pnpm is required to install Supergateway");
  atomicWriteSync(manifest, desired, { mode: 0o600, skipUnchanged: true });
  execFileSync(pnpm, [
    "--dir", root, "install", "--prod", "--ignore-scripts",
    manifestMatches && existsSync(lock) ? "--frozen-lockfile" : "--no-frozen-lockfile"
  ], { cwd: root, stdio: "inherit" });
  if (!installed()) throw new Error("Pinned Supergateway installation could not be verified");
  return executable;
}
