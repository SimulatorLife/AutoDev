/**
The network boundary of a confined command, proved against the real operating
system.

The Seatbelt profile names the one network peer a dependency install may
reach: the registry proxy's own loopback port. A profile that only says so
is a claim, not a boundary. These tests drive the real executor under the
real profile and show that an unapproved peer is refused by the operating
system, and that the approved one is not.
*/
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startRegistryProxy } from "../src/mcp/commands-registry-proxy.ts";
import {
  connectThroughSandbox,
  hasSandbox,
  scopeFixture
} from "./support/confined-network.ts";

test(
  "a confined command reaches the registry proxy's port and nothing else",
  {
    skip: !hasSandbox
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-network-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // An unapproved peer on loopback: the kind of service a compromised
    // package's install script would try to reach.
    const unapproved = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    unapproved.listen(0, "127.0.0.1");
    await once(unapproved, "listening");
    const unapprovedPort = (unapproved.address() as AddressInfo).port;
    const registry = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ dist: { tarball: "http://127.0.0.1/x.tgz" } })
      );
    });
    registry.listen(0, "127.0.0.1");
    await once(registry, "listening");
    const registryOrigin = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
    const proxy = await startRegistryProxy({ registry: registryOrigin });
    try {
      // A command that is not a dependency install has no network at all.
      const withoutRegistry = await connectThroughSandbox(
        scopeFixture(root),
        unapprovedPort,
        "validation"
      );
      assert.notEqual(withoutRegistry, "connected");
      assert.match(withoutRegistry, /refused/u);

      // A dependency install reaches the registry proxy and nothing else.
      const withRegistry = {
        ...scopeFixture(root),
        registryEndpoint: proxy.endpoint
      };
      const toProxy = await connectThroughSandbox(
        withRegistry,
        proxy.port,
        "dependency_install"
      );
      assert.equal(toProxy, "connected");
      const toUnapproved = await connectThroughSandbox(
        withRegistry,
        unapprovedPort,
        "dependency_install"
      );
      assert.notEqual(toUnapproved, "connected");
      assert.match(toUnapproved, /refused/u);
    } finally {
      await proxy.close();
      unapproved.closeAllConnections();
      registry.closeAllConnections();
      await new Promise<void>((resolve) => unapproved.close(() => resolve()));
      await new Promise<void>((resolve) => registry.close(() => resolve()));
    }
  }
);
