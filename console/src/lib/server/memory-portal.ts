/**
 * Server-only resolver for the public OpenLIT Memory portal URL.
 *
 * The retained, AutoDev-branded OpenLIT `/memory` page is the sole Memory
 * operator UI (lifecycle actions, provenance/history, per-experience
 * outcomes, and the bounded cohort view). This module never talks to the
 * Memory Control API and never reads a service token; it only resolves a
 * public browser-facing base URL and normalizes it to the fixed `/memory`
 * path so the Console can link out to it.
 *
 * The configured value is a server environment variable, never a
 * browser-supplied header, query parameter, or request host. The resolved
 * URL is rejected unless it is http/https and carries no embedded
 * credentials (for example `https://user:pass@host`).
 */

const DEFAULT_OPENLIT_UI_BASE_URL = "http://127.0.0.1:3000";

export type OpenLITUiEnvironment = Readonly<Record<string, string | undefined>>;

export interface MemoryPortalConfig {
  /** The public OpenLIT Memory page URL, always ending in `/memory`. */
  readonly href: string;
}

/**
 * Resolves the configured (or default local) OpenLIT UI base URL and
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

