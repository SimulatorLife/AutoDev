/**
 * The one owner of process output.
 *
 * AutoDev's CLIs print results to stdout, and its long-running services write
 * their structured logs to stderr, where launchd keeps them. Both go through
 * here rather than `console`, so an output channel is always a deliberate
 * choice -- stray debugging output is a lint error everywhere else. Values are
 * formatted exactly as `console.log` formats them.
 */

import { format } from "node:util";

/** One line of command output, on stdout. */
export function writeLine(...values: unknown[]): void {
  process.stdout.write(`${format(...values)}\n`);
}

/** One line of diagnostics or structured logging, on stderr. */
export function writeErrorLine(...values: unknown[]): void {
  process.stderr.write(`${format(...values)}\n`);
}
