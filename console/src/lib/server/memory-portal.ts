/**
 * Server-only resolver for the transitional external Memory UI destination.
 *
 * The AutoDev Console is the primary Memory operator surface. This module
 * never talks to the Memory Control API and never reads a service token; it
 * only resolves the temporary external UI URL and normalizes it to the fixed
 * `/memory` path.
 *
 * The configured value is a server environment variable, never a
 * browser-supplied header, query parameter, or request host. The resolved
 * URL is rejected unless it is http/https and carries no embedded
 * credentials (for example `https://user:pass@host`).
 */

const DEFAULT_OPENLIT_UI_BASE_URL = "http://127.0.0.1:3000";

export type OpenLITUiEnvironment = Readonly<Record<string, string | undefined>>;

export interface MemoryPortalConfig {
  /** The validated external Memory UI URL, always ending in `/memory`. */
  readonly href: string;
}

/**
 * Resolves the configured (or default local) external Memory UI URL and
 * normalizes it to the fixed `/memory` path.
 *
 * Returns `null` when the configured value is not a valid http/https URL or
 * embeds credentials; callers must render an explicit unavailable state in
 * that case instead of falling back to a guessed or partial URL.
 */
export function readMemoryPortalConfig(
  env: OpenLITUiEnvironment = process.env
): MemoryPortalConfig | null {
  const configured = env.AUTODEV_OPENLIT_UI_URL?.trim();
  const baseUrl = configured || DEFAULT_OPENLIT_UI_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;

  return { href: `${parsed.origin}/memory` };
}
