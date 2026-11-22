import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `moduleUrl` is the entry point the process started with.
 *
 * `$CODEX_HOME/src` is a symlink to the active `.src-<hash>` generation, and
 * macOS temp paths sit behind `/var` -> `/private/var`. Node sets
 * `import.meta.url` to the resolved physical file while `process.argv[1]` stays
 * unresolved, so comparing raw strings evaluates to `false` under launchd and
 * causes supervised services to exit 0 in a crash loop.
 */
export function isEntryPoint(
  moduleUrl: string | URL,
  entryArgument: string | undefined = process.argv[1]
): boolean {
  if (!entryArgument) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(entryArgument) === realpathSync(modulePath);
  } catch {
    return path.resolve(entryArgument) === path.resolve(modulePath);
  }
}
