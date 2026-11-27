/**
A loopback package-registry proxy.

Dependency installation is a required capability, and a sandbox that denies
the network outright cannot provide it. macOS Seatbelt can restrict an
outbound connection to a *port*, but it cannot restrict it to a *host*, so
granting a sandboxed package manager general outbound access would hand the
whole internet to every script the registry's packages run.

This proxy closes that gap without weakening the sandbox: the confined
child may reach one loopback port and nothing else, and this trusted
process is the only thing that speaks to the registry. It forwards package
metadata and tarballs for the approved registry, refuses every other path,
forwards no credentials, and rewrites the tarball URLs in the metadata so
the child keeps resolving them through the proxy.
*/
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse
} from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
A single npm name segment, with no path separators or URL escapes.
*/
function isPackageSegment(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,213}$/u.test(value);
}

/**
npm version/tag and tarball segments may contain semver's + character.
*/
function isArtifactSegment(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,255}$/u.test(value);
}

const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_TARBALL_BYTES = 256 * 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 8;
const UPSTREAM_DEADLINE_MS = 120_000;

export interface RegistryProxyOptions {
  /**
  The registry the proxy is allowed to reach.
  */
  readonly registry: string;
  /**
  The loopback host the proxy listens on.
  */
  readonly host?: string;
}

export interface RegistryProxy {
  /**
  The registry URL the confined child is pointed at.
  */
  readonly endpoint: string;
  /**
  The loopback port the proxy listens on.
  */
  readonly port: number;
  close(): Promise<void>;
}

class RegistryProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryProxyError";
  }
}

function registryOrigin(registry: string): { origin: URL; secure: boolean } {
  let url: URL;
  try {
    url = new URL(registry);
  } catch {
    throw new RegistryProxyError("Invalid package registry URL.");
  }
  // An HTTP loopback registry is useful for isolated fixtures. Remote
  // registries must use HTTPS, and only a root origin is supported.
  if (
    (url.protocol !== "https:" &&
      (url.protocol !== "http:" ||
        !["127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new RegistryProxyError(
      "Package registry must be a root HTTPS origin (or an HTTP loopback fixture)."
    );
  }
  return { origin: url, secure: url.protocol === "https:" };
}

/**
The path the proxy serves.

Only package metadata and package tarballs are served. npm's own service
endpoints (`/-/ping`, the audit endpoint, the abbreviated metadata
negotiation endpoints) are refused: the audit endpoint would report the
dependency tree to a third party, and pnpm is told not to call it.
*/
export function classifyRegistryPath(
  pathname: string
): "metadata" | "tarball" | null {
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.length > 1024
  )
    return null;
  const segments = pathname.slice(1).split("/");
  // npm uses both /@scope/name and /@scope%2fname. Only this encoded
  // separator is legal; never decode a complete request path.
  if (segments[0]?.startsWith("@")) {
    const first = segments.shift()!;
    const encoded = /^@([^%/]+)%2[fF]([^%/]+)$/u.exec(first);
    const scope = encoded ? encoded[1]! : first.slice(1);
    const name = encoded ? encoded[2]! : segments.shift();
    if (!isPackageSegment(scope) || !name || !isPackageSegment(name))
      return null;
  } else {
    const name = segments.shift();
    if (!name || !isPackageSegment(name)) return null;
  }
  if (segments.length === 0) return "metadata";
  if (segments.length === 1 && isArtifactSegment(segments[0]!))
    return "metadata";
  if (
    segments.length === 2 &&
    segments[0] === "-" &&
    isArtifactSegment(segments[1]!) &&
    segments[1]!.endsWith(".tgz")
  )
    return "tarball";
  return null;
}

/**
Rewrite the registry's own tarball URLs to point back at the proxy.

The metadata npm serves names the tarball with an absolute URL on the
registry. A confined child may not reach that host, so the URLs are
rewritten to the proxy's own loopback endpoint before the body leaves.
*/
export function rewriteRegistryUrls(
  body: string,
  registry: string,
  endpoint: string
): string {
  const origin = new URL(registry).origin;
  const proxy = new URL(endpoint).origin;
  const metadata: unknown = JSON.parse(body);
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const rewrite = (value: unknown): void => {
    const distribution = object(object(value)?.dist);
    if (!distribution || typeof distribution.tarball !== "string") return;
    let target: URL;
    try {
      target = new URL(distribution.tarball);
    } catch {
      return;
    }
    if (
      target.origin === origin &&
      !target.username &&
      !target.password &&
      !target.search &&
      !target.hash &&
      classifyRegistryPath(target.pathname) === "tarball"
    ) {
      distribution.tarball = proxy + target.pathname;
    }
  };
  rewrite(metadata);
  const versions = object(object(metadata)?.versions);
  if (versions) {
    for (const version of Object.values(versions)) rewrite(version);
  }
  return JSON.stringify(metadata);
}

function fail(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: message }));
}

function relay(
  client: IncomingMessage,
  response: ServerResponse,
  options: {
    readonly origin: URL;
    readonly secure: boolean;
    readonly endpoint: string;
    readonly registry: string;
    readonly pathname: string;
    readonly kind: "metadata" | "tarball";
  }
): void {
  // Only the previously validated path is forwarded. No request body,
  // credentials, query string, absolute-form URL or redirects are relayed.
  const target = new URL(options.pathname, options.origin);
  const deadline = AbortSignal.timeout(UPSTREAM_DEADLINE_MS);
  const upstream = (options.secure ? httpsRequest : httpRequest)(
    target,
    {
      method: client.method === "HEAD" ? "HEAD" : "GET",
      signal: deadline,
      headers: {
        // Caller-controlled header values could carry arbitrary data to
        // the registry. Use the fixed media types the proxy actually serves.
        accept:
          options.kind === "metadata"
            ? "application/vnd.npm.install-v1+json, application/json"
            : "application/octet-stream",
        "accept-encoding": "identity",
        "user-agent": "autodev-commands-registry-proxy"
      }
    },
    (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        upstreamResponse.destroy();
        fail(response, 502, "registry redirects are not served");
        return;
      }
      const contentType = upstreamResponse.headers["content-type"] ?? "";
      const limit =
        options.kind === "metadata" ? MAX_METADATA_BYTES : MAX_TARBALL_BYTES;
      const declaredLength = Number(upstreamResponse.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > limit) {
        upstreamResponse.destroy();
        fail(response, 502, "registry response exceeds limit");
        return;
      }
      if (client.method === "HEAD") {
        upstreamResponse.resume();
        response.writeHead(status, { "content-type": contentType });
        response.end();
        return;
      }
      if (options.kind === "tarball") {
        let bytes = 0;
        const bound = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > limit)
              callback(new Error("registry response exceeds limit"));
            else callback(null, chunk);
          }
        });
        response.writeHead(status, { "content-type": contentType });
        void pipeline(upstreamResponse, bound, response, {
          signal: deadline
        }).catch(() => response.destroy());
        return;
      }
      // Metadata alone needs buffering for URL rewriting. Its per-request
      // limit and the listener's concurrency cap bound aggregate memory.
      const chunks: Buffer[] = [];
      let bytes = 0;
      upstreamResponse.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) {
          upstreamResponse.destroy();
          fail(response, 502, "registry response exceeds limit");
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on("end", () => {
        if (response.destroyed || response.writableEnded) return;
        try {
          const raw = Buffer.concat(chunks);
          const body = contentType.includes("json")
            ? Buffer.from(
                rewriteRegistryUrls(
                  raw.toString("utf8"),
                  options.registry,
                  options.endpoint
                )
              )
            : raw;
          if (body.length > limit) {
            fail(response, 502, "registry response exceeds limit");
            return;
          }
          response.writeHead(status, {
            "content-type": contentType,
            "content-length": body.length
          });
          response.end(body);
        } catch {
          fail(response, 502, "registry metadata is invalid");
        }
      });
      upstreamResponse.on("error", () =>
        fail(response, 502, "registry upstream failed")
      );
    }
  );
  upstream.on("error", () => fail(response, 502, "registry upstream failed"));
  response.once("close", () => {
    if (!response.writableFinished) upstream.destroy();
  });
  upstream.end();
}

/**
Start the proxy.

The listener is bound to loopback and to an ephemeral port, so nothing
outside this machine can reach it and the confined child's profile can name
the exact port it is allowed to open.
*/
export async function startRegistryProxy(
  options: RegistryProxyOptions
): Promise<RegistryProxy> {
  const { origin, secure } = registryOrigin(options.registry);
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1")
    throw new RegistryProxyError("Registry proxy must bind to IPv4 loopback.");
  const registry = origin.origin;
  let active = 0;
  const server = createServer((client, response) => {
    if (client.method !== "GET" && client.method !== "HEAD") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const pathname = client.url ?? "/";
    const kind = classifyRegistryPath(pathname);
    if (
      !kind ||
      client.headers["transfer-encoding"] ||
      Number(client.headers["content-length"] ?? 0) !== 0
    ) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: "path is not served by the registry proxy" })
      );
      return;
    }
    if (active >= MAX_ACTIVE_REQUESTS) {
      fail(response, 503, "registry proxy is busy");
      return;
    }
    active += 1;
    response.once("close", () => {
      active -= 1;
    });
    response.setTimeout(30_000, () => response.destroy());
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const endpoint = `http://127.0.0.1:${port}`;
    relay(client, response, {
      origin,
      secure,
      endpoint,
      registry,
      pathname,
      kind
    });
  });
  server.maxConnections = MAX_ACTIVE_REQUESTS * 4;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
