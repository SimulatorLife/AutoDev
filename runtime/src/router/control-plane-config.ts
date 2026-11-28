/**
Shared listener resolution for the Router Control API HTTP server.
Used identically by the standalone Router process (`server.ts`) and the
long-lived ingress supervisor (`ingress-main.ts`) so `:4101` obeys one policy.
*/

export interface ControlApiListenerConfig {
  readonly host: string;
  readonly port: number;
}

/**
Resolve the optional standalone Control API HTTP listener address, or `null`
when disabled or implicitly suppressed on non-default Router ports.
*/
export function configuredControlApiListener(
  routerPort: number,
  environment: NodeJS.ProcessEnv = process.env
): ControlApiListenerConfig | null {
  if (
    environment.AUTODEV_CONTROL_API_DISABLED === "1" ||
    environment.AUTODEV_CONTROL_API_LISTEN_HOST === "none"
  ) {
    return null;
  }
  // Only bind the default port 4101 when running on standard router port 4100 or when explicitly configured.
  if (routerPort !== 4100 && !environment.AUTODEV_CONTROL_API_LISTEN_HOST) {
    return null;
  }
  const host = environment.AUTODEV_CONTROL_API_LISTEN_HOST?.trim() || "0.0.0.0";
  const rawPort = environment.AUTODEV_CONTROL_API_LISTEN_PORT?.trim();
  const port = rawPort ? Number(rawPort) : 4101;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "AUTODEV_CONTROL_API_LISTEN_PORT must be between 1 and 65535."
    );
  }
  return { host, port };
}
