import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER
} from "next/constants.js";

/** Production output served by the Console LaunchAgent (`next start`). */
export const CONSOLE_BUILD_DIST_DIR = ".next";
/**
 * `next dev` output. Kept separate from the production build so the Runtime
 * installer's `next build` never deletes or overwrites the chunks a running
 * dev server is loading, and a dev server never rewrites the production build.
 */
export const CONSOLE_DEV_DIST_DIR = ".next-dev";

const STAGING_DIST_DIR_PATTERN = /^\.next-staging-[A-Za-z0-9-]+$/u;

export function consoleDistDir(
  phase: string,
  stagedBuildDir = process.env.AUTODEV_CONSOLE_BUILD_DIST_DIR,
  stagedServerDir = process.env.AUTODEV_CONSOLE_SERVE_DIST_DIR
): string {
  if (phase === PHASE_DEVELOPMENT_SERVER) return CONSOLE_DEV_DIST_DIR;
  if (
    phase === PHASE_PRODUCTION_BUILD &&
    stagedBuildDir !== undefined &&
    STAGING_DIST_DIR_PATTERN.test(stagedBuildDir)
  ) {
    return stagedBuildDir;
  }
  if (
    phase === PHASE_PRODUCTION_SERVER &&
    stagedServerDir !== undefined &&
    STAGING_DIST_DIR_PATTERN.test(stagedServerDir)
  ) {
    return stagedServerDir;
  }
  return CONSOLE_BUILD_DIST_DIR;
}
