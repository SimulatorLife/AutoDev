export interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

export const ROUTER_AUTH_REQUIRED_MESSAGE =
  "Router authentication is required.";
export const ROUTER_AUTH_ERROR_CODE = "router_authentication_error";

const IPV4_MAPPED_PREFIX = /^::ffff:/;

export function isLoopbackAddress(address?: string | null): boolean {
  if (!address || typeof address !== "string") return false;
  const normalized = address.replace(IPV4_MAPPED_PREFIX, "").trim();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized === "localhost"
  );
}

export function resolveRouterAuthToken(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.CODEX_ROUTER_AUTH_TOKEN ?? "";
}

let configuredRouterAuthToken: string = resolveRouterAuthToken();

export function getRouterAuthToken(): string {
  return configuredRouterAuthToken;
}

export function setRouterAuthTokenForTests(token?: string | null): void {
  configuredRouterAuthToken = typeof token === "string" ? token : "";
}

export function isRouterAuthEnabled(
  configuredToken: string = getRouterAuthToken()
): boolean {
  return Boolean(configuredToken);
}

export function authStatus(configuredToken: string = getRouterAuthToken()): {
  responseRequests: boolean;
} {
  return { responseRequests: isRouterAuthEnabled(configuredToken) };
}

export function routerAuthorizationValid(
  request: RequestWithHeaders,
  configuredToken: string = getRouterAuthToken()
): boolean {
  if (!configuredToken) return true;
  const raw = request.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value === `Bearer ${configuredToken}`;
}
