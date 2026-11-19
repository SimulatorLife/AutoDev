/**
 * The shebang for a fake CLI written as a Node script.
 *
 * It names the Node running the test rather than `#!/usr/bin/env node`. The
 * `node` on PATH may be pnpm's runtime shim, which resolves the project's
 * pinned Node through pnpm's store relative to HOME -- and the bridges under
 * test run their CLI with an isolated HOME, so `env node` failed with
 * "pnpm: failed to prepare node@runtime" before the fake ever ran.
 */
if (/\s/u.test(process.execPath))
  throw new Error(
    `a shebang cannot name a Node path with whitespace: ${process.execPath}`
  );

export const NODE_SHEBANG = `#!${process.execPath}`;
