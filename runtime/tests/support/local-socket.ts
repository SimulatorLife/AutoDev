/**
 * A local Unix socket a test can hand the sandbox.
 *
 * The sandbox's argv builder refuses a socket that is not a socket, because a
 * container started against a path that is not one cannot reach the daemon.
 * A test that measures the arguments rather than a running daemon stands a
 * socket up for the builder to accept.
 *
 * The socket path is budgeted: `sun_path` is 104 bytes on macOS and 108 on
 * Linux, and the operating system's temporary directory is sometimes longer
 * than that (a CI runner's session directories, a sandbox's own working
 * root). The directory is therefore created in the shortest root that fits,
 * and every rejected root is reported so a genuine failure says which roots
 * were unusable and why, rather than surfacing as an opaque `EINVAL` from
 * `listen()`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const SUN_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;
// Short prefix: every character here comes out of the socket path budget, and
// `mkdtemp` appends six more.
const SOCKET_DIR_PREFIX = "agy-";
const SOCKET_NAME = "engine.sock";

/** Standard temporary roots, shortest-fitting first; `tmpdir` is preferred. */
function socketTempRoots(): string[] {
  const roots = [tmpdir()];
  if (process.platform !== "win32") roots.push("/tmp", "/var/tmp");
  return roots;
}

/**
 * Create the directory that will hold the socket, preferring `tmpdir()` but
 * falling back to shorter standard roots when `tmpdir()` alone would overflow
 * `sun_path`.
 */
function createSocketDirectory(): string {
  const rejected: string[] = [];
  for (const root of socketTempRoots()) {
    const directory = path.join(root, `${SOCKET_DIR_PREFIX}XXXXXX`);
    // mkdtemp replaces the six X characters with random ones.
    const projected = path.join(directory, SOCKET_NAME);
    if (Buffer.byteLength(projected) >= SUN_PATH_LIMIT) {
      rejected.push(
        `${projected} needs ${Buffer.byteLength(projected)} bytes of a ${SUN_PATH_LIMIT}-byte sun_path`
      );
      continue;
    }
    try {
      return mkdtempSync(directory);
    } catch (error) {
      rejected.push(
        `${root}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  throw new Error(
    `Unable to create a directory for a Unix socket path: ${rejected.join("; ")}`
  );
}

/**
 * Run a body against a local socket that exists for the body's duration.
 *
 * The socket is removed with the directory that holds it, so a test leaves
 * nothing behind.
 */
export async function withLocalSocket<T>(
  run: (socket: string) => Promise<T>
): Promise<T> {
  const directory = createSocketDirectory();
  const socket = path.join(directory, SOCKET_NAME);
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    return await run(socket);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}
