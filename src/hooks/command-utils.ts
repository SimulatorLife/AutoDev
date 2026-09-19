import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
}

export function repositoryRoot(): string {
  return path.resolve(
    process.env.AUTODEV_REPO_ROOT?.trim() ||
      path.join(path.dirname(import.meta.dirname), "..")
  );
}

export function findHookScript(name: string): string {
  const candidates = [
    path.join(codexHome(), "hooks", name),
    path.join(repositoryRoot(), "scripts", name)
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? candidates[0]!;
}
