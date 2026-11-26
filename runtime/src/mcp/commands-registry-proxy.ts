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
  type ServerResponse} from "node:http";
import { request as httpsRequest } from "node:https";

/**
The slash, as a character code, so the path helpers below do not need a
regular expression whose repetition the security linter reads as unsafe.
*/
const SLASH = 47;
/**
The characters an npm package name may use after its first character.
*/
const PACKAGE_CHARACTERS: readonly string[] = [
  "a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z",
  "0","1","2","3","4","5","6","7","8","9",
  ".","_","-"
];
/**
The characters an npm package name may start with.
*/
const PACKAGE_FIRST_CHARACTERS: readonly string[] = [
  "a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z",
  "0","1","2","3","4","5","6","7","8","9"
];

/**
The npm package name grammar.

The name is checked character by character rather than with one regular
expression: a scoped name and an unscoped one differ in shape, and a single
expression covering both needs a repetition inside an optional group.
*/
function isPackageName(value: string): boolean {
  if (value.length === 0 || value.length > 214) return false;
  let index = value.startsWith("@") ? 1 : 0;
  const first = value[index]!;
  if (!PACKAGE_FIRST_CHARACTERS.includes(first)) return false;
  for (; index < value.length; index += 1) {
    const character = value[index]!;
    if (!PACKAGE_CHARACTERS.includes(character)) return false;
  }
  return true;
}

/**
A path with no trailing slash.
*/
function withoutTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH) end -= 1;
  return value.slice(0, end);
}

/**
A path with exactly one leading slash.
*/
function withSingleLeadingSlash(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === SLASH) start += 1;
  return `/${value.slice(start)}`;
}

/**
Whether a path segment is a tarball file name.
*/
function isTarballName(value: string): boolean {
  return value.endsWith(".tgz") && value.length > ".tgz".length;
}

/**
The largest response the proxy will relay in either direction.
*/
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

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

export class RegistryProxyError extends Error {
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
    throw new RegistryProxyError(`Invalid package registry: ${registry}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RegistryProxyError(
      `Unsupported package registry protocol: ${url.protocol}`
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
export function classifyRegistryPath(pathname: string): "metadata" | "tarball" | null {
  if (pathname.length < 2 || pathname.startsWith("//")) return null;
  const segments = pathname.slice(1).split("/");
  // A scoped package occupies two path segments.
  const packageSegments = segments[0]?.startsWith("@") ? 2 : 1;
  if (segments.length < packageSegments) return null;
  const name = segments.slice(0, packageSegments).join("/");
  if (!isPackageName(name)) return null;
  const rest = segments.slice(packageSegments);
  if (rest.length === 0) return "metadata";
  // `/<package>/-/<file>.tgz` is the tarball; `/<package>/<version>` is
  // metadata for one version.
  if (rest.length === 2 && rest[0] === "-" && isTarballName(rest[1]!)) {
    return "tarball";
  }
  if (rest.length === 1) return "metadata";
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
  const origin = withoutTrailingSlash(registry);
  return body.split(origin).join(withoutTrailingSlash(endpoint));
}

function relay(
  client: IncomingMessage,
  response: ServerResponse,
  options: {
    readonly origin: URL;
    readonly secure: boolean;
    readonly endpoint: string;
    readonly registry: string;
  }
): void {
  const target = new URL(withSingleLeadingSlash(client.url ?? "/"), options.origin);
  const upstream = (
    options.secure ? httpsRequest : httpRequest
  )(
    target,
    {
      method: client.method ?? "GET",
      headers: {
        accept: client.headers.accept ?? "application/json",
        "accept-encoding": "identity",
        "user-agent": "autodev-commands-registry-proxy"
      }
    },
    (upstreamResponse) => {
      const status = upstreamResponse.statusCode ?? 502;
      const contentType = upstreamResponse.headers["content-type"] ?? "";
      const chunks: Buffer[] = [];
      let bytes = 0;
      upstreamResponse.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          upstreamResponse.destroy();
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on("end", () => {
        if (response.destroyed) return;
        let body = Buffer.concat(chunks);
        if (contentType.includes("json")) {
          body = Buffer.from(
            rewriteRegistryUrls(body.toString("utf8"), options.registry, options.endpoint),
            "utf8"
          );
        }
        response.writeHead(status, {
          "content-type": contentType,
          "content-length": body.length
        });
        response.end(body);
      });
      upstreamResponse.on("error", () => {
        if (response.destroyed) {
          return;
        }

        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "registry upstream failed" }));
      });
    }
  );
  upstream.on("error", () => {
    if (response.destroyed) {
      return;
    }

    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "registry upstream failed" }));
  });
  client.on("aborted", () => upstream.destroy());
  client.pipe(upstream);
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
  const registry = withoutTrailingSlash(options.registry);
  const server = createServer((client, response) => {
    if (client.method !== "GET" && client.method !== "HEAD") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const pathname = new URL(client.url ?? "/", "http://127.0.0.1").pathname;
    if (!classifyRegistryPath(pathname)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "path is not served by the registry proxy" }));
      return;
    }
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const endpoint = `http://127.0.0.1:${port}`;
    relay(client, response, { origin, secure, endpoint, registry });
  });
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
