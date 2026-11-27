/**
A real dependency installation, through the real registry proxy, under the real
macOS Seatbelt profile.

The proxy has been proven against mocked bodies and the sandbox's network
boundary against a refused connection. Neither showed that a package manager
can actually install a package that way, because a registry and a store are
configured through environment variables and a package manager reads those
from its own namespace -- a setting written in npm's namespace never reaches
pnpm, so the install would reach the public registry and the operator's home
instead of the approved proxy and the private cache.

This test drives the real executor with the catalogue's own install command
and a real package manager, and shows the package installed from a registry
that only the proxy can reach.
*/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { CommandDefinition } from "../src/mcp/commands-catalogue.ts";
import { runApprovedCommand } from "../src/mcp/commands-execution.ts";
import { startRegistryProxy } from "../src/mcp/commands-registry-proxy.ts";
import { findPnpmGlobalBinary } from "../src/shared/executables.ts";

const SANDBOX = "/usr/bin/sandbox-exec";
const PACKAGE = "autodev-fixture-pkg";
const TAR = "/usr/bin/tar";

/*
The catalogue's own install command.
*/
const install = {
  description: "Install dependencies",
  executable: "pnpm",
  args: ["install", "--no-frozen-lockfile"],
  parameters: {},
  timeoutMs: 180_000,
  executionClass: "dependency_install",
  concurrency: "exclusive"
} satisfies CommandDefinition;

/**
A package the registry serves: a real tarball with the layout a package
manager expects, so the install exercises the whole path rather than a
metadata-only shortcut.
*/
function buildPackage(root: string): { tarball: Buffer; shasum: string } {
  const staging = path.join(root, "staging");
  const packageDirectory = path.join(staging, "package");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: PACKAGE, version: "1.0.0", main: "index.js" }) + "\n"
  );
  writeFileSync(
    path.join(packageDirectory, "index.js"),
    "module.exports = 42;\n"
  );
  const tarball = path.join(root, `${PACKAGE}-1.0.0.tgz`);
  execFileSync(TAR, ["-czf", tarball, "-C", staging, "package"]);
  const bytes = readFileSync(tarball);
  return {
    tarball: bytes,
    shasum: createHash("sha1").update(bytes).digest("hex")
  };
}

test(
  "a real package manager installs a package through the registry proxy, inside the sandbox",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync(SANDBOX) ||
      !findPnpmGlobalBinary("pnpm")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-install-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { tarball, shasum } = buildPackage(root);

    // Every request the registry receives is recorded: the test proves which
    // requests the install actually made.
    const requests: string[] = [];
    let origin = "";
    const registry = createServer((request, response) => {
      const url = request.url ?? "";
      requests.push(url);
      if (url === `/${PACKAGE}`) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            name: PACKAGE,
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                name: PACKAGE,
                version: "1.0.0",
                dist: {
                  tarball: `${origin}/${PACKAGE}/-/${PACKAGE}-1.0.0.tgz`,
                  shasum
                }
              }
            }
          })
        );
        return;
      }
      if (url === `/${PACKAGE}/-/${PACKAGE}-1.0.0.tgz`) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(tarball);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
    registry.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => registry.once("listening", resolve));
    origin = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
    t.after(() => {
      registry.closeAllConnections();
      registry.close();
    });

    const proxy = await startRegistryProxy({ registry: origin });
    t.after(() => proxy.close());

    const pnpm = findPnpmGlobalBinary("pnpm")!;
    const workspace = path.join(root, "workspace");
    const scratch = path.join(root, "scratch");
    const cache = path.join(root, "cache");
    for (const directory of [workspace, scratch, cache]) {
      mkdirSync(directory, { mode: 0o700 });
      // The Runtime's private roots are 0700 whatever the umask is, and the
      // package manager insists on owning a directory it alone can write to.
      chmodSync(directory, 0o700);
    }
    // The workspace pins a package manager version that is not the one
    // installed. The install must not download that version and run it: the
    // operator approved an executable, not whatever it fetches at install
    // time.
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "install-fixture",
        version: "1.0.0",
        packageManager: "pnpm@99.0.0",
        dependencies: { [PACKAGE]: "1.0.0" }
      }) + "\n"
    );

    const result = await runApprovedCommand(
      "install_dependencies",
      install,
      install.args,
      {
        workspace,
        scratch,
        cache,
        toolchainRoots: [path.dirname(pnpm), path.dirname(path.dirname(pnpm))],
        executables: { pnpm },
        registryEndpoint: proxy.endpoint
      },
      AbortSignal.timeout(240_000)
    );

    assert.equal(
      result.status,
      "succeeded",
      `install failed: ${result.stdout}\n${result.stderr}`
    );
    // The package landed in the workspace, from the registry only the proxy
    // can reach.
    const installed = path.join(
      workspace,
      "node_modules",
      PACKAGE,
      "package.json"
    );
    assert.ok(existsSync(installed), "the package was not installed");
    assert.equal(JSON.parse(readFileSync(installed, "utf8")).name, PACKAGE);
    assert.ok(
      requests.includes(`/${PACKAGE}`),
      "the registry never saw the package metadata"
    );
    assert.ok(
      requests.includes(`/${PACKAGE}/-/${PACKAGE}-1.0.0.tgz`),
      "the registry never saw the package tarball"
    );
    // No package manager was downloaded: the pinned version was not fetched.
    assert.deepEqual(
      requests.filter((url) => url === "/pnpm"),
      [],
      "the install downloaded a different package manager"
    );
    // The store stayed inside the private cache, not in the operator's home.
    assert.ok(
      existsSync(path.join(cache, "pnpm-store")),
      "the package store did not land in the private cache"
    );
    // A real pnpm install: its own virtual store, not a plain copy.
    assert.ok(
      existsSync(path.join(workspace, "node_modules", ".pnpm")),
      "the package manager's virtual store was not used"
    );
    /*
    The lock that coordinates the processes sharing the store stayed inside the
    private cache too.

    pnpm keeps it outside the store, in a per-user directory that is
    `$XDG_RUNTIME_DIR` when that variable names a directory the user owns and
    no other user can write to, and `/tmp` otherwise. The profile grants
    writes only inside the workspace, the scratch and the cache, so a lock in
    `/tmp` cannot be created at all.
    */
    const effectiveUser = process.getuid?.();
    assert.ok(
      effectiveUser !== undefined,
      "the effective user id is unavailable"
    );
    assert.deepEqual(
      readdirSync(cache).filter((entry) =>
        entry.startsWith("pnpm-store-operation-locks-")
      ),
      ["pnpm-store-operation-locks-" + effectiveUser],
      "the store operation lock did not land in the private cache"
    );
  }
);
