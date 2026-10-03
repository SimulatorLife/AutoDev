/**
 * Console process-liveness endpoint.
 *
 * The Console exposes this single endpoint over the loopback LaunchAgent
 * listener so an external supervisor (reverse proxy, SSH tunnel host, or
 * deployment health check) can confirm the Next.js server process is
 * running and accepting HTTP requests.
 *
 * It is intentionally a process-liveness probe only. It MUST NOT make
 * any backend-readiness claim:
 *
 *   - It never reads AUTODEV_CONTROL_API_TOKEN or
 *     AUTODEV_OPENLIT_USAGE_TOKEN; both values stay in
 *     process.env for the server-side adapters that need them and are
 *     never echoed here.
 *   - It never issues a fetch to the Control API, the OpenLIT Usage
 *     endpoint, ClickHouse, or any other downstream service. The Console
 *     pages render the documented "credential not configured" /
 *     "control API unreachable" states when those backends are
 *     unavailable; this endpoint must never collapse that into a single
 *     optimistic value.
 *   - It returns the same payload whether or not the operator has
 *     finished configuring credentials. That is the contract:
 *     /api/health answers "is the Console server process up and serving
 *     HTTP?", nothing more.
 *
 * The response is JSON-only and includes the process PID, the Node
 * version the server is running on, and the resolved console port. These
 * are process-local facts; they do not leak any operator data or
 * credentials.
 */

import { NextResponse } from "next/server.js";

export interface ConsoleHealthPayload {
  readonly schema: "autodev-console-health-v1";
  readonly status: "alive";
  readonly service: "autodev-console";
  readonly pid: number;
  readonly nodeVersion: string;
  readonly port: number;
  readonly timestamp: string;
}

const DEFAULT_CONSOLE_PORT = 3300;

function resolveConsolePort(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env.AUTODEV_CONSOLE_PORT?.trim();
  if (!raw) return DEFAULT_CONSOLE_PORT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    return DEFAULT_CONSOLE_PORT;
  }
  return value;
}

export function getConsolePort(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  return resolveConsolePort(env);
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): NextResponse<ConsoleHealthPayload> {
  const payload: ConsoleHealthPayload = {
    schema: "autodev-console-health-v1",
    status: "alive",
    service: "autodev-console",
    pid: process.pid,
    nodeVersion: process.version,
    port: resolveConsolePort(),
    timestamp: new Date().toISOString()
  };
  return NextResponse.json(payload, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
