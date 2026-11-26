/**
 * The client surface a session was started from -- the Codex desktop app, the
 * interactive Codex CLI, `codex exec`, or the Codex VS Code extension.
 *
 * Codex names its own client in the `originator` it sends with every model
 * request (the `originator` header, and the first token of its `User-Agent`)
 * and records the same value in each rollout's `session_meta`. This module is
 * the single owner of turning that observed value into the bounded
 * `ClientSurface` vocabulary that router events, OTel spans and metrics
 * (`autodev.client.surface`), the session diagnostics contract and the Console
 * all speak.
 *
 * A value that was observed but is not recognised is `other`, never guessed
 * into a known surface; a session that carried no originator has no surface
 * (`null`), which is distinct from `other`.
 */

/** Every client surface AutoDev distinguishes, in display order. */
export const CLIENT_SURFACES = [
  "codex_desktop",
  "codex_cli",
  "codex_exec",
  "codex_vscode",
  "other"
] as const;

/** A bounded, metric-safe client surface. */
export type ClientSurface = (typeof CLIENT_SURFACES)[number];

/** The OTel attribute that carries a request's `ClientSurface`. */
export const ATTR_AUTODEV_CLIENT_SURFACE = "autodev.client.surface";

const ORIGINATOR_SURFACES: Readonly<Record<string, ClientSurface>> = {
  "codex desktop": "codex_desktop",
  codex_cli_rs: "codex_cli",
  "codex-tui": "codex_cli",
  codex_exec: "codex_exec",
  codex_vscode: "codex_vscode"
};

/**
 * Maps an observed Codex `originator` to its client surface. Returns `null`
 * when nothing was observed and `other` for an unrecognised originator.
 */
export function clientSurfaceFromOriginator(
  originator: string | null | undefined
): ClientSurface | null {
  const normalized = originator?.trim().toLowerCase();
  if (!normalized) return null;
  return Object.hasOwn(ORIGINATOR_SURFACES, normalized)
    ? ORIGINATOR_SURFACES[normalized]!
    : "other";
}

/**
 * Maps a request `User-Agent` to its client surface. Codex builds its
 * `User-Agent` as `<originator>/<version> (...)`, so the product token before
 * the first `/` is the originator.
 */
export function clientSurfaceFromUserAgent(
  userAgent: string | null | undefined
): ClientSurface | null {
  if (!userAgent) return null;
  const versionSeparator = userAgent.indexOf("/");
  return clientSurfaceFromOriginator(
    versionSeparator === -1 ? userAgent : userAgent.slice(0, versionSeparator)
  );
}

/** Narrows an untrusted value (a persisted event, a contract field) to a `ClientSurface`. */
export function isClientSurface(value: unknown): value is ClientSurface {
  return (
    typeof value === "string" &&
    (CLIENT_SURFACES as readonly string[]).includes(value)
  );
}

const CLIENT_SURFACE_LABELS: Readonly<Record<ClientSurface, string>> = {
  codex_desktop: "Codex app",
  codex_cli: "Codex CLI",
  codex_exec: "codex exec",
  codex_vscode: "Codex VS Code extension",
  other: "Other client"
};

/** The operator-facing label for a client surface; `null` reads "Not observed". */
export function formatClientSurface(surface: ClientSurface | null): string {
  return surface ? CLIENT_SURFACE_LABELS[surface] : "Not observed";
}
