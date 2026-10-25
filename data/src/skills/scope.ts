/**
 * The live read of where a skill is installed.
 *
 * The scope of a skill is a fact about the machine, not about the catalogue:
 * a skill that is in the canonical catalog and nowhere else cannot be reached
 * by any agent, and a skill that is also in a repository belongs to that
 * repository's workspace. Both are read from the filesystem at the moment the
 * Console asks, so a skill that has just been installed or removed shows what
 * is true now.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  skillScopeCandidates,
  type SkillScopeFacts,
  type SkillScopeRoots
} from "@simulatorlife/autodev-core";

export interface SkillScopeReadOptions {
  readonly roots: SkillScopeRoots;
  /**
   * The workspaces the repository may belong to, from the workspace catalogue.
   *
   * The repository's own remote names a workspace, but a remote is not a
   * workspace: a repository can have a remote nobody has registered, and a
   * skill that belongs to no configured workspace belongs to no workspace at
   * all. The catalogue is what makes the difference.
   */
  readonly workspaces?: readonly string[] | undefined;
}

/**
 * The scope of every named skill that is installed somewhere.
 *
 * A skill that is not installed is absent from the map rather than present
 * with a null scope: "not installed" is not a scope, and a caller that has to
 * tell them apart should not have to read a null to do it.
 */
export function resolveSkillScopes(
  names: readonly string[],
  options: SkillScopeReadOptions
): ReadonlyMap<string, SkillScopeFacts> {
  const scopes = new Map<string, SkillScopeFacts>();
  const workspace = readRepositoryWorkspaceId(
    options.roots.repositoryRoot,
    options.workspaces
  );
  for (const name of names) {
    for (const candidate of skillScopeCandidates(name, options.roots)) {
      if (!existsSync(candidate.directory)) continue;
      scopes.set(name, {
        scope: candidate.scope,
        location: candidate.directory,
        workspace: candidate.scope === "repo" ? workspace : null
      });
      break;
    }
  }
  return scopes;
}

/**
 * The workspace the repository belongs to, from its own git remote.
 *
 * A repository's remote says which project it is: `SimulatorLife/AutoDev` is
 * the workspace id the catalogue uses, and it is the only place that mapping
 * exists. The remote is read from the repository rather than configured,
 * because a skill's scope follows the repository it lives in and a setting
 * that says otherwise would be a second, competing truth.
 *
 * `null` when the repository has no usable remote, or when the remote names
 * a project the workspace catalogue does not know: an unregistered project is
 * not a workspace, and a skill in it is not available to any of them.
 */
export function readRepositoryWorkspaceId(
  repositoryRoot: string,
  workspaces?: readonly string[] | undefined
): string | null {
  const ids = repositoryRemoteIds(repositoryRoot);
  if (ids.length === 0) return null;
  if (workspaces === undefined) return ids[0] ?? null;
  for (const id of ids) {
    if (workspaces.includes(id)) return id;
  }
  return null;
}

/**
 * The project ids the repository's remotes name.
 *
 * A repository can have more than one remote, and the order they are read in
 * is the order they are written in the git configuration, which is the order
 * the operator set them up in.
 */
function repositoryRemoteIds(repositoryRoot: string): readonly string[] {
  const configPath = gitConfigPath(repositoryRoot);
  if (configPath === null) return [];
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const ids: string[] = [];
  let inRemote = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inRemote = /^\[remote\s+"[^"]+"\]$/u.test(trimmed);
      continue;
    }
    if (!inRemote) continue;
    const match = /^url\s*=\s*(.+)$/u.exec(trimmed);
    if (match === null) continue;
    const id = projectIdFromRemoteUrl(match[1].trim());
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Where the repository's git configuration lives.
 *
 * A worktree or a submodule has a `.git` file that names the real directory,
 * and a repository that was copied without its history has none at all.
 */
function gitConfigPath(repositoryRoot: string): string | null {
  const dotGit = path.join(repositoryRoot, ".git");
  if (existsSync(path.join(dotGit, "config"))) {
    return path.join(dotGit, "config");
  }
  if (!existsSync(dotGit)) return null;
  try {
    const pointer = readFileSync(dotGit, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/mu.exec(pointer);
  if (match === null) return null;
  const config = path.join(match[1].trim(), "config");
  return existsSync(config) ? config : null;
}

/**
 * The `owner/repository` a remote URL names.
 *
 * Both shapes a remote takes are read: the `https://` form a browser would
 * clone and the `git@host:` form a person would write. A URL that names
 * neither is not a project, and a remote that names no project names no
 * workspace.
 */
export function projectIdFromRemoteUrl(url: string): string | null {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
  const withoutCredentials = withoutScheme.replace(/^[^/@]*@/u, "");
  const path = withoutCredentials.replace(/^[^/:]+[:/]/u, "");
  const segments = path
    .replace(/\.git$/u, "")
    .replace(/^\/+|\/+$/gu, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[segments.length - 2];
  const repository = segments[segments.length - 1];
  if (!/^[^/\s]+$/u.test(owner) || !/^[^/\s]+$/u.test(repository)) return null;
  return `${owner}/${repository}`;
}
