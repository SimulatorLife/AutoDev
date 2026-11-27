/**
The shared MCP gateway's own observations of the tool calls it serves.

Every MCP tool call an agent makes -- from any provider, role or workspace --
passes through the gateway's backend pool, so the gateway is the one producer
that sees each call complete. It keeps a bounded per-server ledger (calls,
failures, durations, the roles that called and the tools called) for the life
of the gateway process and publishes it as a private file in its own
directory. The Control API reads that file for `/control/mcp-runtime`; it never
reaches into the gateway process.

The ledger holds names and counts only: no arguments, results, workspace
paths, sessions or error text. A role is recorded only when the call's
admission verified it.
*/
import path from "node:path";

import type { ControlApiMcpRuntimeServer } from "@simulatorlife/autodev-core";
import { z } from "zod";

import {
  assertPrivateDirectory,
  privateRead,
  privateWrite
} from "../shared/private-service-files.ts";
import { mcpGatewayDirectory } from "./gateway-admission.ts";

export const MCP_GATEWAY_OBSERVATIONS_SCHEMA =
  "autodev-mcp-gateway-observations-v1";

/**
Bounds that keep the ledger finite whatever the catalogue holds.
*/
const MAX_SERVERS = 256;
const MAX_ENTRIES_PER_SERVER = 256;

/**
How long the published file may lag the ledger after a call completes.
*/
const PUBLISH_DELAY_MS = 1000;

export type GatewayCallStatus = "ok" | "error";

/**
One completed `tools/call`, as the gateway saw it.
*/
export interface GatewayToolCall {
  readonly server: string;
  readonly tool: string;
  /**
  The role the call's admission verified, or null when it verified none.
  */
  readonly role: string | null;
  readonly status: GatewayCallStatus;
  readonly durationMs: number;
}

const statusSchema = z.enum(["ok", "error"]);
const countSchema = z.number().int().nonnegative();

const roleSchema = z
  .object({
    role: z.string().min(1),
    lastCallAt: z.iso.datetime(),
    lastStatus: statusSchema
  })
  .strict();

const toolSchema = z
  .object({
    name: z.string().min(1),
    calls: countSchema,
    failures: countSchema
  })
  .strict();

const serverSchema = z
  .object({
    name: z.string().min(1),
    calls: countSchema,
    failures: countSchema,
    totalDurationMs: z.number().nonnegative(),
    lastCallAt: z.iso.datetime(),
    lastStatus: statusSchema,
    roles: z.array(roleSchema),
    tools: z.array(toolSchema)
  })
  .strict();

const observationsSchema = z
  .object({
    schema: z.literal(MCP_GATEWAY_OBSERVATIONS_SCHEMA),
    pid: z.number().int().positive(),
    startedAt: z.iso.datetime(),
    servers: z.array(serverSchema)
  })
  .strict();

export type GatewayObservations = z.infer<typeof observationsSchema>;

interface ServerLedger {
  calls: number;
  failures: number;
  totalDurationMs: number;
  lastCallAt: string;
  lastStatus: GatewayCallStatus;
  readonly roles: Map<
    string,
    { lastCallAt: string; lastStatus: GatewayCallStatus }
  >;
  readonly tools: Map<string, { calls: number; failures: number }>;
}

const COLLATOR = new Intl.Collator();

/**
The gateway's ledger. `onRecord` runs after each recorded call, so the owner
can publish without the pool knowing where the ledger goes.
*/
export class GatewayCallObservations {
  readonly #servers = new Map<string, ServerLedger>();
  readonly #startedAt: string;
  readonly #now: () => Date;
  readonly #onRecord: () => void;

  constructor(
    options: { readonly now?: () => Date; readonly onRecord?: () => void } = {}
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#onRecord = options.onRecord ?? (() => {});
    this.#startedAt = this.#now().toISOString();
  }

  record(call: GatewayToolCall): void {
    const at = this.#now().toISOString();
    const server = this.#serverLedger(call.server, at, call.status);
    if (!server) return;
    server.calls += 1;
    if (call.status === "error") server.failures += 1;
    if (Number.isFinite(call.durationMs) && call.durationMs > 0)
      server.totalDurationMs += call.durationMs;
    server.lastCallAt = at;
    server.lastStatus = call.status;
    if (
      call.role &&
      (server.roles.has(call.role) ||
        server.roles.size < MAX_ENTRIES_PER_SERVER)
    )
      server.roles.set(call.role, { lastCallAt: at, lastStatus: call.status });
    const tool = server.tools.get(call.tool);
    if (tool) {
      tool.calls += 1;
      if (call.status === "error") tool.failures += 1;
    } else if (server.tools.size < MAX_ENTRIES_PER_SERVER) {
      server.tools.set(call.tool, {
        calls: 1,
        failures: call.status === "error" ? 1 : 0
      });
    }
    this.#onRecord();
  }

  #serverLedger(
    name: string,
    at: string,
    status: GatewayCallStatus
  ): ServerLedger | null {
    const existing = this.#servers.get(name);
    if (existing) return existing;
    if (this.#servers.size >= MAX_SERVERS) return null;
    const created: ServerLedger = {
      calls: 0,
      failures: 0,
      totalDurationMs: 0,
      lastCallAt: at,
      lastStatus: status,
      roles: new Map(),
      tools: new Map()
    };
    this.#servers.set(name, created);
    return created;
  }

  snapshot(): GatewayObservations {
    return {
      schema: MCP_GATEWAY_OBSERVATIONS_SCHEMA,
      pid: process.pid,
      startedAt: this.#startedAt,
      servers: [...this.#servers]
        .sort(([left], [right]) => COLLATOR.compare(left, right))
        .map(([name, server]) => ({
          name,
          calls: server.calls,
          failures: server.failures,
          totalDurationMs: server.totalDurationMs,
          lastCallAt: server.lastCallAt,
          lastStatus: server.lastStatus,
          roles: [...server.roles]
            .sort(([left], [right]) => COLLATOR.compare(left, right))
            .map(([role, seen]) => ({ role, ...seen })),
          tools: [...server.tools]
            .sort(([left], [right]) => COLLATOR.compare(left, right))
            .map(([tool, counts]) => ({ name: tool, ...counts }))
        }))
    };
  }
}

export function mcpGatewayObservationsFile(codexHome: string): string {
  return path.join(mcpGatewayDirectory(codexHome), "observations.json");
}

/**
A ledger whose snapshot the gateway publishes to its private directory: once
at start (so a read can tell "running, nothing called yet" from "no gateway"),
then at most once per `delayMs` after calls, and on `close()`.
*/
export function publishedGatewayCallObservations(
  codexHome: string,
  options: { readonly delayMs?: number; readonly now?: () => Date } = {}
): { readonly observations: GatewayCallObservations; close(): void } {
  const file = mcpGatewayObservationsFile(codexHome);
  let timer: NodeJS.Timeout | null = null;
  const publish = (): void => {
    timer = null;
    try {
      privateWrite(file, JSON.stringify(observations.snapshot()) + "\n");
    } catch {
      // Publishing is evidence, never a reason to fail the call it observes.
    }
  };
  const observations = new GatewayCallObservations({
    ...(options.now && { now: options.now }),
    onRecord: () => {
      timer ??= setTimeout(publish, options.delayMs ?? PUBLISH_DELAY_MS);
      timer.unref();
    }
  });
  publish();
  return {
    observations,
    close: () => {
      if (timer) clearTimeout(timer);
      publish();
    }
  };
}

/**
The observations the installed gateway last published, or null when it has
published none (or none that is valid).
*/
export function readMcpGatewayObservations(
  codexHome: string
): GatewayObservations | null {
  try {
    assertPrivateDirectory(mcpGatewayDirectory(codexHome));
    const text = privateRead(mcpGatewayObservationsFile(codexHome));
    if (!text) return null;
    const parsed = observationsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
The published observations in the Control API's per-server shape. A ledger
whose gateway process has exited is still true about the past, but it no
longer describes a server that is up, so every verdict becomes `stale`.
*/
export function mcpRuntimeServersFromGateway(
  observations: GatewayObservations,
  isAlive: (pid: number) => boolean = isProcessAlive
): ControlApiMcpRuntimeServer[] {
  const isLive = isAlive(observations.pid);
  const verdict = (status: GatewayCallStatus) =>
    isLive ? (status === "ok" ? "ready" : "error") : "stale";
  return observations.servers.map((server) => ({
    name: server.name,
    health: verdict(server.lastStatus),
    lastSeenAt: server.lastCallAt,
    lastStatus: server.lastStatus,
    // The gateway answers initialization and discovery from its own cache,
    // so it publishes no attempt count rather than a count that means
    // nothing.
    initAttempts: null,
    toolDiscoveryAttempts: null,
    failures: server.failures,
    toolCalls: server.calls,
    averageDurationMs:
      server.calls > 0 ? Math.round(server.totalDurationMs / server.calls) : 0,
    roles: server.roles.map((seen) => ({
      role: seen.role,
      health: verdict(seen.lastStatus),
      lastSeenAt: seen.lastCallAt,
      lastStatus: seen.lastStatus
    })),
    tools: server.tools.map((tool) => ({
      name: tool.name,
      count: tool.calls,
      errors: tool.failures
    }))
  }));
}
