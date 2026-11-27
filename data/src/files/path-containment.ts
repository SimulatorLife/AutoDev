import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/**
The one owner of "this path stays beneath that root".

Workspaces approvals, playtest artifact stores, sandbox snapshots, approved
configurations and memory capture each refuse a path that escapes the root
it was configured under -- a `..` segment, a symlink resolved elsewhere, a
sibling that merely shares a name prefix (`/a/bc` is not beneath `/a/b`).
Every one of them used to spell the check for itself.

The root itself counts as beneath the root. A caller that needs a strict
descendant also refuses the root. Both paths are compared as given, after
resolution against the working directory; canonicalising symlinks with
`realpath` is the caller's job, because only the caller knows whether the
path must already exist.
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
this is lexical; callers resolve physical paths when needed.
*/
export function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

/**
Resolve an as-yet uncreated path through its nearest existing ancestor.
Only missing components may be appended; an inaccessible path or dangling
symlink is not evidence of a safe location. This is a snapshot, not an OS
confinement guarantee against concurrent filesystem changes.
*/
export function resolvePathWithExistingAncestor(target: string): string {
  const absolute = path.resolve(target);
  let ancestor = absolute;
  for (;;) {
    try {
      return path.join(
        realpathSync(ancestor),
        path.relative(ancestor, absolute)
      );
    } catch (error) {
      const parent = path.dirname(ancestor);
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        parent === ancestor
      ) {
        throw error;
      }
      // realpath may return ENOENT for an existing dangling symlink.
      // Do not silently turn that redirect into a missing path component.
      try {
        lstatSync(ancestor);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw statError;
        }
        ancestor = parent;
        continue;
      }
      throw error;
    }
  }
}
