import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/** Production output served by the Console LaunchAgent (`next start`). */
export const CONSOLE_BUILD_DIST_DIR = ".next";
/**
 * `next dev` output. Kept separate from the production build so the Runtime
 * installer's `next build` never deletes or overwrites the chunks a running
 * dev server is loading, and a dev server never rewrites the production build.
 */
export const CONSOLE_DEV_DIST_DIR = ".next-dev";

export function consoleDistDir(phase: string): string {
  return phase === PHASE_DEVELOPMENT_SERVER
    ? CONSOLE_DEV_DIST_DIR
    : CONSOLE_BUILD_DIST_DIR;
}
