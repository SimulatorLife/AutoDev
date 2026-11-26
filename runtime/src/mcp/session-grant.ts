/**
Gateway session grants: how a local client is admitted to the shared MCP
gateway in whatever directory it was launched, without registering that
directory first.

The Runtime resolves the workspace from trusted launch context (the client's
realpath'd launch directory, never an MCP argument or header), checks it
against the admission policy, and signs a short grant naming that workspace,
the role and the session. The client-side adapter attaches the grant to every
request it relays; the gateway's backend pool verifies it and runs the
request in backends confined to that workspace. A grant is an HMAC over its
claims with the gateway's private admission secret, so a holder can neither
widen its role nor move it to another workspace or session.
*/
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import {
  isPathWithin,
  pathsOverlap,
  resolvePathWithExistingAncestor
} from "@simulatorlife/autodev-data/files";
import { z } from "zod";

/**
The request metadata key that carries a grant to the gateway.
*/
export const SESSION_GRANT_META_KEY = "autodev/grant";

const GRANT_VERSION = "v1";
// Long enough for a working session; the adapter renews long before expiry.
export const SESSION_GRANT_TTL_MS = 12 * 60 * 60 * 1000;

const claimsSchema = z
  .object({
    workspace: z.string().refine(path.isAbsolute),
    role: z.string().regex(/^[a-z0-9-]+$/u),
    session: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/u),
    // The session is the Runtime's AutoDev session, which router telemetry
    // also carries; a root client's random session joins no other trace.
    runtimeSession: z.literal(true).optional(),
    expiresAt: z.number().int().positive()
  })
  .strict();
export type SessionGrantClaims = z.infer<typeof claimsSchema>;

function signature(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/**
A fresh, unguessable session identity.
*/
export function newGrantSession(): string {
  return randomBytes(18).toString("base64url");
}

export function issueSessionGrant(
  secret: string,
  claims: Omit<SessionGrantClaims, "expiresAt">,
  now: number = Date.now(),
  ttlMs: number = SESSION_GRANT_TTL_MS
): string {
  const body = Buffer.from(
    JSON.stringify(claimsSchema.parse({ ...claims, expiresAt: now + ttlMs }))
  ).toString("base64url");
  return `${GRANT_VERSION}.${body}.${signature(secret, body).toString("base64url")}`;
}

/**
The grant's claims, or null for a forged, malformed or expired grant.
*/
export function verifySessionGrant(
  secret: string,
  token: unknown,
  now: number = Date.now()
): SessionGrantClaims | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const [version, body, mac, extra] = token.split(".", 4);
  if (version !== GRANT_VERSION || !body || !mac || extra !== undefined)
    return null;
  const expected = signature(secret, body);
  const presented = Buffer.from(mac, "base64url");
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  )
    return null;
  try {
    const claims = claimsSchema.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    );
    return claims.expiresAt > now ? claims : null;
  } catch {
    return null;
  }
}

/**
Resolve a launch directory into an admissible workspace, or explain why it is
refused. Any directory is admissible except the home directory and its
ancestors (which would grant blanket access to the user's files) and anything
overlapping the AutoDev configuration homes.
*/
export function admitWorkspace(
  launchDirectory: string,
  protectedRoots: { home: string; configuration: readonly string[] }
): { workspace: string } | { refused: string } {
  if (!path.isAbsolute(launchDirectory))
    return { refused: "The launch directory is not absolute." };
  let workspace: string;
  try {
    workspace = realpathSync(launchDirectory);
    if (!statSync(workspace).isDirectory())
      return { refused: "The launch directory is not a directory." };
  } catch {
    return { refused: "The launch directory does not exist." };
  }
  let home: string;
  let config: string[];
  try {
    home = realpathSync(protectedRoots.home);
    config = protectedRoots.configuration.map(resolvePathWithExistingAncestor);
  } catch {
    return { refused: "Protected workspace boundaries could not be resolved." };
  }
  if (isPathWithin(workspace, home))
    return {
      refused:
        "The home directory and its ancestors are never a workspace; start the client inside a project directory."
    };
  for (const root of config) {
    if (pathsOverlap(workspace, root))
      return {
        refused: "AutoDev configuration directories are never a workspace."
      };
  }
  return { workspace };
}
