/**
 * Private, source-empty workspace for Smart-direct decision turns.
 *
 * The Router resolves a turn's workspace from structured request metadata and
 * refuses to guess one; the providers behind it then bootstrap that turn in
 * the resolved directory. The Smart-direct policy plays a game, so its turn
 * must not be able to read or edit the game checkout. Binding it to a private
 * root with no source in it gives the turn a resolvable workspace without
 * exposing the game -- the same boundary the playtest analyst role uses.
 *
 * The root is a local Git repository because some providers omit their
 * structured workspace metadata for a non-Git working directory, which makes
 * the Router refuse the request.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIRECTORY_MODE = 0o700;

export interface PlaytestPolicyWorkspace {
  /** Temporary root that owns the workspace directory and its Git metadata. */
  readonly root: string;
  /** Absolute path of the empty Git root a decision turn is bound to. */
  readonly workspacePath: string;
}

export interface PlaytestPolicyWorkspaceOptions {
  /** Prefix for the temporary root directory name. */
  readonly prefix?: string;
  /** Environment for the local `git init`; the workspace must stay untracked. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly execFileSyncImpl?: typeof execFileSync;
}

export function createPlaytestPolicyWorkspace(
  options: PlaytestPolicyWorkspaceOptions = {}
): PlaytestPolicyWorkspace {
  const environment = options.environment ?? process.env;
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const root = mkdtempSync(
    path.join(tmpdir(), options.prefix ?? "autodev-visual-policy-")
  );
  chmodSync(root, DIRECTORY_MODE);
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { mode: DIRECTORY_MODE });
  chmodSync(workspacePath, DIRECTORY_MODE);
  const canonicalRoot = realpathSync(root);
  const canonicalWorkspace = realpathSync(workspacePath);
  try {
    const gitTemplate = path.join(canonicalRoot, "git-template");
    mkdirSync(gitTemplate, { mode: DIRECTORY_MODE });
    chmodSync(gitTemplate, DIRECTORY_MODE);
    execFileSyncImpl("git", ["init", "--quiet"], {
      cwd: canonicalWorkspace,
      env: {
        PATH: environment.PATH ?? process.env.PATH,
        HOME: canonicalRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(canonicalRoot, "empty-gitconfig"),
        GIT_TEMPLATE_DIR: gitTemplate
      },
      stdio: "ignore"
    });
    chmodSync(path.join(canonicalWorkspace, ".git"), DIRECTORY_MODE);
  } catch (error) {
    removePlaytestPolicyWorkspace({
      root: canonicalRoot,
      workspacePath: canonicalWorkspace
    });
    throw new Error(
      "Smart-direct policy private workspace could not be prepared.",
      { cause: error }
    );
  }
  return { root: canonicalRoot, workspacePath: canonicalWorkspace };
}

export function removePlaytestPolicyWorkspace(
  workspace: PlaytestPolicyWorkspace
): void {
  rmSync(workspace.root, { recursive: true, force: true });
}
