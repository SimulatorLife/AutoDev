/**
The registry boundary against a hostile registry, proved against the real
operating system.

The registry is the one party that answers the package manager with a body it
chose. That body names the tarball the child downloads, so a registry that
answers maliciously could point the child at a host of its choosing. Two
things stand between that body and the child: the proxy fetches only the
approved registry and serves only what it fetched itself, and the confined
child may open exactly one network peer -- the proxy's own port.

These tests answer with a crafted body and show what actually happens. The
host the body named is never contacted, by the proxy or by the child: the
proxy's outbound traffic goes to the approved registry alone, and the
operating system refuses the child's own attempt to reach the steered host.
*/
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startRegistryProxy } from "../src/mcp/commands-registry-proxy.ts";
import {
  connectThroughSandbox,
  connectWithoutSandbox,
  hasSandbox,
  scopeFixture
} from "./support/confined-network.ts";

interface UpstreamRequest {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

test(
  "a registry that answers with a crafted body cannot steer the confined child",
  {
    skip: !hasSandbox
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-registry-hostile-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    // The host the crafted body tries to steer the child to.
    const steeredRequests: string[] = [];
    let steeredConnections = 0;
    const steered = createServer((request, response) => {
      steeredRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0]));
    });
    steered.on("connection", () => {
      steeredConnections += 1;
    });
    steered.listen(0, "127.0.0.1");
    await once(steered, "listening");
    const steeredPort = (steered.address() as AddressInfo).port;

    // The approved registry, answering with a crafted body: one version
    // points at the steered host, the other carries credentials.
    const upstreamRequests: UpstreamRequest[] = [];
    const registry = createServer((request, response) => {
      upstreamRequests.push({
        url: request.url ?? "",
        headers: request.headers
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: "pkg",
          versions: {
            "1.0.0": {
              dist: {
                tarball: `http://127.0.0.1:${steeredPort}/pkg/-/pkg-1.0.0.tgz`
              }
            },
            "2.0.0": {
              dist: {
                tarball:
                  "https://user:secret@registry.example/pkg/-/pkg-2.0.0.tgz"
              }
            }
          }
        })
      );
    });
    registry.listen(0, "127.0.0.1");
    await once(registry, "listening");
    const registryOrigin = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;

    const proxy = await startRegistryProxy({ registry: registryOrigin });
    try {
      const metadata = await fetch(`${proxy.endpoint}/pkg`);
      assert.equal(metadata.status, 200);
      const body = (await metadata.json()) as {
        versions: Record<string, { dist: { tarball: string } }>;
      };

      // The body really does name a host of the registry's choosing: the
      // child would follow it, which is what makes the next steps a proof
      // rather than a formality.
      const steeredTarball = body.versions["1.0.0"]!.dist.tarball;
      assert.equal(
        steeredTarball,
        `http://127.0.0.1:${steeredPort}/pkg/-/pkg-1.0.0.tgz`
      );
      assert.notEqual(steeredTarball, proxy.endpoint + "/pkg/-/pkg-1.0.0.tgz");

      // The proxy did not turn the credentialed URL into one of its own, so
      // the credential never enters a URL the proxy serves.
      assert.equal(
        body.versions["2.0.0"]!.dist.tarball,
        "https://user:secret@registry.example/pkg/-/pkg-2.0.0.tgz"
      );
      assert.doesNotMatch(
        JSON.stringify(body),
        /127\.0\.0\.1:\d+\/pkg\/-\/pkg-2\.0\.0\.tgz/u
      );

      // The proxy forwards no credentials of its own to the registry.
      assert.equal(upstreamRequests.length, 1);
      assert.equal(upstreamRequests[0]!.url, "/pkg");
      for (const header of ["authorization", "cookie", "proxy-authorization"]) {
        assert.equal(
          upstreamRequests[0]!.headers[header],
          undefined,
          `the proxy forwarded a ${header} header`
        );
      }

      // The child's own attempt to reach the steered host is refused by the
      // operating system. The peer answers the same connection without any
      // confinement, so the refusal is the boundary at work and not a host
      // that was never listening.
      assert.equal(
        await connectWithoutSandbox(steeredPort),
        "connected",
        "the steered host did not answer the control connection"
      );
      assert.equal(
        steeredConnections,
        1,
        "the control connection did not reach the steered host"
      );
      const scope = {
        ...scopeFixture(root),
        registryEndpoint: proxy.endpoint
      };
      const attempt = await connectThroughSandbox(
        scope,
        steeredPort,
        "dependency_install"
      );
      assert.notEqual(attempt, "connected");
      assert.match(attempt, /refused/u);
      assert.equal(
        steeredConnections,
        1,
        "the proxy or the confined child opened a connection to the steered host"
      );
      assert.deepEqual(
        steeredRequests,
        [],
        "the steered host served a request to the proxy or to the child"
      );
    } finally {
      await proxy.close();
      steered.closeAllConnections();
      registry.closeAllConnections();
      await new Promise<void>((resolve) => steered.close(() => resolve()));
      await new Promise<void>((resolve) => registry.close(() => resolve()));
    }
  }
);
