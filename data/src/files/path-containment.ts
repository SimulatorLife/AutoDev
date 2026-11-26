import path from "node:path";

/**
 * The one owner of "this path stays beneath that root".
 *
 * Workspaces approvals, playtest artifact stores, sandbox snapshots, approved
 * configurations and memory capture each refuse a path that escapes the root
 * it was configured under -- a `..` segment, a symlink resolved elsewhere, a
 * sibling that merely shares a name prefix (`/a/bc` is not beneath `/a/b`).
 * Every one of them used to spell the check for itself.
 *
 * The root itself counts as beneath the root. A caller that needs a strict
 * descendant also refuses the root. Both paths are compared as given, after
 * resolution against the working directory; canonicalising symlinks with
 * `realpath` is the caller's job, because only the caller knows whether the
 * path must already exist.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Equal paths or an ancestor/descendant pair overlap. Like isPathWithin,
 * this is lexical; callers resolve physical paths when needed.
 */
export function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}
