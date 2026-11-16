import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `moduleUrl` is the one the process was started with.
 *
 * A hook is a program Codex starts, and the program only acts when it is
 * that program. The caller passes its own module URL, because the question is
 * about the hook and not about the helper that answers it.
 *
 * The comparison resolves both paths first, because a path that runs through
 * a symbolic link is one file under two names: a temporary directory on macOS
 * is `/var/folders/...` while the resolved path is
 * `/private/var/folders/...`, and a hook that compared the two as written
 * would never run when it was invoked by the path its caller was given.
 *
 * The failure is silent -- the hook exits zero and the policy it enforces is
 * simply not enforced -- so the check is the one thing every hook shares.
 */
export function isHookEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
