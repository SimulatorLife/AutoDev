import {
  parseRouterRuntimeStatus,
  type RouterRuntimeStatus
} from "../router/status.ts";

export async function fetchRouterStatus(): Promise<RouterRuntimeStatus> {
  const host = process.env.CODEX_MODEL_ROUTER_HOST ?? "127.0.0.1";
  const port = process.env.CODEX_MODEL_ROUTER_PORT ?? "4100";
  const endpoint = `http://${host}:${port}/status`;

  let response: Response;
  try {
    response = await fetch(endpoint);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to reach router status endpoint ${endpoint}: ${detail}`
    );
  }

  let body: RouterRuntimeStatus;
  try {
    body = parseRouterRuntimeStatus(await response.json());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid router status response from ${endpoint}: ${detail}`
    );
  }

  if (!response.ok) {
    const error = body.error;
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : `Router status request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return body;
}
