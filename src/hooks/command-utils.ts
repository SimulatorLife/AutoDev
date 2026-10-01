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
