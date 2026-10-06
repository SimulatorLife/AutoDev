/**
 * URL helpers for the Providers resource. Every Providers link, toggle return
 * path, and mutation redirect is built here so list rows, detail views, and
 * route handlers agree on one URL shape.
 */

export const PROVIDERS_PATH = "/providers";
export const PROVIDERS_TABS = ["providers", "models"] as const;
export type ProvidersTab = (typeof PROVIDERS_TABS)[number];

/** Query flag a mutation route sets when a change could not be confirmed. */
export const CONTROL_FAILED_PARAM = "control";
const CONTROL_FAILED_VALUE = "failed";

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const RETURN_PATH_PATTERN = new RegExp(
  String.raw`^/providers(?:\?tab=(?:providers|models)|/${SEGMENT}(?:/models/${SEGMENT})?)?$`,
  "u"
);

export function providersPath(tab: ProvidersTab = "providers"): string {
  return tab === "providers" ? PROVIDERS_PATH : `${PROVIDERS_PATH}?tab=${tab}`;
}

export function providerPath(provider: string): string {
  return `${PROVIDERS_PATH}/${encodeURIComponent(provider)}`;
}

export function modelPath(provider: string, model: string): string {
  return `${providerPath(provider)}/models/${encodeURIComponent(model)}`;
}

/** Only Providers pages may be a toggle's return destination. */
export function isProvidersReturnPath(value: string | null): value is string {
  return value !== null && RETURN_PATH_PATTERN.test(value);
}

export function withControlFailure(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${CONTROL_FAILED_PARAM}=${CONTROL_FAILED_VALUE}`;
}

export function isControlFailure(
  raw: string | readonly string[] | undefined
): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === CONTROL_FAILED_VALUE;
}
