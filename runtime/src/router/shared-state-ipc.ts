import { randomUUID } from "node:crypto";
import { chmodSync, rmSync, statSync } from "node:fs";
import {
  connect as connectUnixSocket,
  createServer,
  type Server,
  type Socket
} from "node:net";

import { isRecord } from "@simulatorlife/autodev-core";
import {
  type ConcurrencyDenialRecord,
  SUBAGENT_SLOT_KIND
} from "@simulatorlife/autodev-runtime/router/concurrency";
import type {
  CooldownEntry,
  PersistedCooldownEntry
} from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  effectiveStateFile,
  RouterPersistence
} from "@simulatorlife/autodev-runtime/router/persistence";

export interface CooldownSyncSnapshot {
  cooldowns: Record<string, CooldownEntry>;
  modelCooldowns: Record<string, CooldownEntry>;
  failureStreaks: Record<string, number>;
  probeStreaks: Record<string, number>;
}

export interface SharedConcurrencyState {
  storedLimit: number | null | undefined;
  revision: number;
  denials: number;
  denialsByReason: Record<string, number>;
  lastDenial: ConcurrencyDenialRecord | null;
}

export interface SharedSubagentSlotRecord {
  slotId: string;
  generationId: string;
  sessionKey: string;
  acquiredAt: number;
}

export interface SharedRouterStateSnapshot {
  version: number;
  persistedSections: Record<string, unknown>;
  concurrency: SharedConcurrencyState;
  cooldowns: CooldownSyncSnapshot;
  subagentSlotsByGeneration: Record<string, Record<string, number>>;
  activeProviderRequestsByGeneration: Record<string, Record<string, number>>;
}

interface RpcRequestMessage {
  type: "rpc";
  id: string;
  action: string;
  payload: Record<string, unknown>;
}

interface RpcResponseMessage {
  type: "rpc_result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface SyncBroadcastMessage {
  type: "sync";
  snapshot: SharedRouterStateSnapshot;
}

const ROUTING_POLICY_KEYS = [
  "roleAssignments",
  "disabledProviders",
  "disabledModels",
  "disabledAgentRoles",
  "agentEnablementRevisions",
  "providerLimits",
  "agentModels"
] as const;

const PASS_THROUGH_PERSISTED_KEYS = [
  "providerTelemetry",
  "providerModelDiscovery",
  "usage",
  "spawnFailures",
  "correlation",
  "subagents",
  "quotaPoll",
  "liveFeed",
  "recentEvents"
] as const;

function cloneRecord<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function emptyCooldownSyncSnapshot(): CooldownSyncSnapshot {
  return {
    cooldowns: {},
    modelCooldowns: {},
    failureStreaks: {},
    probeStreaks: {}
  };
}

function hardEntriesFromCooldowns(
  cooldowns: Record<string, CooldownEntry>
): PersistedCooldownEntry[] {
  return Object.entries(cooldowns)
    .filter(([, entry]) => entry.kind === "hard")
    .map(([provider, entry]) => ({
      provider,
      until: entry.until,
      kind: entry.kind,
      failureClass: entry.failureClass,
      resetsAt: entry.resetsAt,
      since: entry.since
    }));
}

/**
Aggregate counts by key across all generations OTHER than `excludingGenerationId`.
*/
export function sumCountsExcludingGeneration(
  byGeneration: Record<string, Record<string, number>>,
  excludingGenerationId: string
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [generationId, counts] of Object.entries(byGeneration)) {
    if (generationId === excludingGenerationId) continue;
    for (const [key, count] of Object.entries(counts)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      totals[key] = (totals[key] ?? 0) + count;
    }
  }
  return totals;
}

/**
Single authoritative cross-process store and single `codex-router-state.json`
persistence owner hosted inside the long-lived ingress supervisor.
Both Generation A and Generation B read/mutate global routing policy,
cooldowns, concurrency limits/slots, active provider counts, and persisted
state sections through this server so limits never double and writes never race.
*/
export class SharedRouterStateServer {
  readonly socketPath: string;
  private server: Server | null = null;
  private readonly clients = new Map<Socket, { generationId: string | null }>();
  private readonly persistence: RouterPersistence;
  private version = 1;

  private persistedSections: Record<string, unknown> = {};
  private concurrency: SharedConcurrencyState = {
    storedLimit: undefined,
    revision: 1,
    denials: 0,
    denialsByReason: {},
    lastDenial: null
  };
  private cooldowns: CooldownSyncSnapshot = emptyCooldownSyncSnapshot();
  private readonly subagentSlotsBySession = new Map<
    string,
    SharedSubagentSlotRecord[]
  >();
  private readonly activeProviderRequestsByGeneration = new Map<
    string,
    Map<string, number>
  >();
  private subagentSlotSeq = 0;

  constructor(options: { socketPath: string; stateFile?: () => string }) {
    this.socketPath = options.socketPath;
    this.persistence = new RouterPersistence({
      stateFile: options.stateFile ?? (() => effectiveStateFile()),
      isMain: true,
      debounceMs: 500,
      getSnapshot: () => this.buildDiskSnapshot(),
      restoreSection: (section, value) => this.restoreDiskSection(section, value)
    });
    this.persistence.load();
  }

  private buildDiskSnapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ROUTING_POLICY_KEYS) {
      if (key in this.persistedSections) {
        out[key] = this.persistedSections[key];
      }
    }
    for (const key of PASS_THROUGH_PERSISTED_KEYS) {
      if (key in this.persistedSections) {
        out[key] = this.persistedSections[key];
      }
    }
    out.concurrency = {
      denials: this.concurrency.denials,
      denialsByReason: { ...this.concurrency.denialsByReason },
      lastDenial: this.concurrency.lastDenial,
      ...(this.concurrency.storedLimit !== undefined && {
        storedLimit: this.concurrency.storedLimit
      }),
      revision: this.concurrency.revision
    };
    out.providerCooldowns = hardEntriesFromCooldowns(this.cooldowns.cooldowns);
    return out;
  }

  private restoreDiskSection(section: string, value: unknown): void {
    if (section === "concurrency" && isRecord(value)) {
      if (Number.isInteger(value.denials) && (value.denials as number) >= 0) {
        this.concurrency.denials = value.denials as number;
      }
      if (isRecord(value.denialsByReason)) {
        const clean: Record<string, number> = {};
        for (const [reason, count] of Object.entries(value.denialsByReason)) {
          if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
            clean[reason] = count;
          }
        }
        this.concurrency.denialsByReason = clean;
      }
      if (value.lastDenial === null || isRecord(value.lastDenial)) {
        this.concurrency.lastDenial =
          value.lastDenial as ConcurrencyDenialRecord | null;
      }
      if ("storedLimit" in value) {
        const limit = value.storedLimit;
        if (
          limit === null ||
          (typeof limit === "number" && Number.isInteger(limit) && limit >= 0)
        ) {
          this.concurrency.storedLimit = limit;
        }
      }
      if (typeof value.revision === "number" && Number.isInteger(value.revision)) {
        this.concurrency.revision = value.revision;
      }
      return;
    }

    if (section === "providerCooldowns" && Array.isArray(value)) {
      const now = Date.now();
      for (const entry of value) {
        if (
          !isRecord(entry) ||
          entry.kind !== "hard" ||
          typeof entry.provider !== "string"
        ) {
          continue;
        }
        const until = Number(entry.until);
        if (!Number.isFinite(until) || until <= now) continue;
        this.cooldowns.cooldowns[entry.provider] = {
          until,
          kind: "hard",
          failureClass:
            typeof entry.failureClass === "string" ? entry.failureClass : null,
          resetsAt: typeof entry.resetsAt === "string" ? entry.resetsAt : null,
          since: typeof entry.since === "number" ? entry.since : now
        };
      }
      return;
    }

    this.persistedSections[section] = value;
  }

  snapshot(): SharedRouterStateSnapshot {
    const subagentSlotsByGeneration: Record<string, Record<string, number>> = {};
    for (const [sessionKey, slots] of this.subagentSlotsBySession) {
      for (const slot of slots) {
        const perGeneration =
          subagentSlotsByGeneration[slot.generationId] ??
          (subagentSlotsByGeneration[slot.generationId] = {});
        perGeneration[sessionKey] = (perGeneration[sessionKey] ?? 0) + 1;
      }
    }
    const activeProviderRequestsByGeneration: Record<
      string,
      Record<string, number>
    > = {};
    for (const [generationId, counts] of this.activeProviderRequestsByGeneration) {
      activeProviderRequestsByGeneration[generationId] = Object.fromEntries(counts);
    }

    return {
      version: this.version,
      persistedSections: cloneRecord(this.persistedSections),
      concurrency: {
        storedLimit: this.concurrency.storedLimit,
        revision: this.concurrency.revision,
        denials: this.concurrency.denials,
        denialsByReason: { ...this.concurrency.denialsByReason },
        lastDenial: cloneRecord(this.concurrency.lastDenial)
      },
      cooldowns: cloneRecord(this.cooldowns),
      subagentSlotsByGeneration,
      activeProviderRequestsByGeneration
    };
  }

  private totalSubagentSlotsForSession(sessionKey: string): number {
    return this.subagentSlotsBySession.get(sessionKey)?.length ?? 0;
  }

  private broadcast(excludingSocket?: Socket): void {
    const message: SyncBroadcastMessage = {
      type: "sync",
      snapshot: this.snapshot()
    };
    const wire = `${JSON.stringify(message)}\n`;
    for (const socket of this.clients.keys()) {
      if (socket === excludingSocket || socket.destroyed) continue;
      socket.write(wire);
    }
  }

  /**
  Purge all ephemeral slots and active provider request counts owned by a
  retired or exited worker generation so limits never leak after crashes.
  */
  purgeGeneration(generationId: string): void {
    let changed = false;
    for (const [sessionKey, slots] of this.subagentSlotsBySession) {
      const remaining = slots.filter(
        (slot) => slot.generationId !== generationId
      );
      if (remaining.length !== slots.length) {
        changed = true;
        if (remaining.length === 0) {
          this.subagentSlotsBySession.delete(sessionKey);
        } else {
          this.subagentSlotsBySession.set(sessionKey, remaining);
        }
      }
    }
    if (this.activeProviderRequestsByGeneration.delete(generationId)) {
      changed = true;
    }
    if (changed) {
      this.version += 1;
      this.broadcast();
    }
  }

  private async handleRpc(
    socket: Socket,
    action: string,
    payload: Record<string, unknown>
  ): Promise<unknown> {
    switch (action) {
      case "hello": {
        const generationId =
          typeof payload.generationId === "string" ? payload.generationId : null;
        this.clients.set(socket, { generationId });
        return this.snapshot();
      }

      case "set_concurrency_limit": {
        const expectedRevision =
          typeof payload.expectedRevision === "number" &&
          Number.isInteger(payload.expectedRevision)
            ? payload.expectedRevision
            : undefined;
        if (
          expectedRevision !== undefined &&
          expectedRevision !== this.concurrency.revision
        ) {
          return {
            ok: false,
            conflict: true,
            currentRevision: this.concurrency.revision
          };
        }
        const previousStoredLimit = this.concurrency.storedLimit;
        const previousRevision = this.concurrency.revision;
        const nextLimit =
          payload.resetToConfigFile === true
            ? undefined
            : (payload.storedLimit as number | null | undefined);
        this.concurrency.storedLimit = nextLimit;
        this.concurrency.revision += 1;
        this.version += 1;
        const persisted = await this.persistence.persistNow();
        if (!persisted) {
          this.concurrency.storedLimit = previousStoredLimit;
          this.concurrency.revision = previousRevision;
          return { ok: false, persistenceFailed: true };
        }
        this.broadcast();
        return {
          ok: true,
          revision: this.concurrency.revision,
          snapshot: this.snapshot()
        };
      }

      case "record_concurrency_denial": {
        const reason =
          typeof payload.reason === "string" && payload.reason
            ? payload.reason
            : "unknown";
        this.concurrency.denials += 1;
        this.concurrency.denialsByReason[reason] =
          (this.concurrency.denialsByReason[reason] ?? 0) + 1;
        if (isRecord(payload.lastDenial)) {
          this.concurrency.lastDenial =
            payload.lastDenial as ConcurrencyDenialRecord;
        }
        this.version += 1;
        this.persistence.schedulePersist();
        this.broadcast(socket);
        return { ok: true, snapshot: this.snapshot() };
      }

      case "reset_concurrency_telemetry": {
        this.subagentSlotsBySession.clear();
        this.concurrency.denials = 0;
        this.concurrency.denialsByReason = {};
        this.concurrency.lastDenial = null;
        this.cooldowns = emptyCooldownSyncSnapshot();
        this.version += 1;
        this.persistence.schedulePersist();
        this.broadcast(socket);
        return { ok: true, snapshot: this.snapshot() };
      }

      case "try_acquire_subagent_slot": {
        const generationId = String(payload.generationId ?? "");
        const sessionKey = String(payload.sessionKey ?? "");
        const perSessionLimit =
          typeof payload.perSessionLimit === "number" &&
          Number.isFinite(payload.perSessionLimit)
            ? payload.perSessionLimit
            : null;
        const currentTotal = this.totalSubagentSlotsForSession(sessionKey);
        if (perSessionLimit !== null && currentTotal >= perSessionLimit) {
          return {
            ok: false,
            reason: "max_concurrent_threads_per_session"
          };
        }
        this.subagentSlotSeq += 1;
        const slotId = `${SUBAGENT_SLOT_KIND}:${sessionKey}:${generationId}:${this.subagentSlotSeq}`;
        const list = this.subagentSlotsBySession.get(sessionKey) ?? [];
        list.push({
          slotId,
          generationId,
          sessionKey,
          acquiredAt: Date.now()
        });
        this.subagentSlotsBySession.set(sessionKey, list);
        this.version += 1;
        this.broadcast();
        return { ok: true, slotId, snapshot: this.snapshot() };
      }

      case "set_generation_subagent_slots": {
        const generationId = String(payload.generationId ?? "");
        const slotsBySession = isRecord(payload.slotsBySession)
          ? payload.slotsBySession
          : {};
        for (const [sessionKey, existing] of this.subagentSlotsBySession) {
          const retained = existing.filter(
            (slot) => slot.generationId !== generationId
          );
          if (retained.length === 0) {
            this.subagentSlotsBySession.delete(sessionKey);
          } else {
            this.subagentSlotsBySession.set(sessionKey, retained);
          }
        }
        const now = Date.now();
        for (const [sessionKey, rawCount] of Object.entries(slotsBySession)) {
          const count =
            typeof rawCount === "number" && Number.isInteger(rawCount)
              ? Math.max(0, rawCount)
              : 0;
          if (count === 0) continue;
          const list = this.subagentSlotsBySession.get(sessionKey) ?? [];
          for (let index = 0; index < count; index += 1) {
            this.subagentSlotSeq += 1;
            list.push({
              slotId: `${SUBAGENT_SLOT_KIND}:${sessionKey}:${generationId}:${this.subagentSlotSeq}`,
              generationId,
              sessionKey,
              acquiredAt: now
            });
          }
          this.subagentSlotsBySession.set(sessionKey, list);
        }
        this.version += 1;
        this.broadcast(socket);
        return { ok: true };
      }

      case "release_subagent_slot": {
        const generationId = String(payload.generationId ?? "");
        const sessionKey = String(payload.sessionKey ?? "");
        const slotId =
          typeof payload.slotId === "string" ? payload.slotId : undefined;
        const list = this.subagentSlotsBySession.get(sessionKey);
        if (list && list.length > 0) {
          let index = -1;
          if (slotId) {
            index = list.findIndex((item) => item.slotId === slotId);
          } else {
            for (let cursor = list.length - 1; cursor >= 0; cursor -= 1) {
              if (list[cursor]!.generationId === generationId) {
                index = cursor;
                break;
              }
            }
          }
          if (index >= 0) {
            list.splice(index, 1);
            if (list.length === 0) {
              this.subagentSlotsBySession.delete(sessionKey);
            }
            this.version += 1;
            this.broadcast();
          }
        }
        return { ok: true };
      }

      case "patch_routing_policy": {
        if (!isRecord(payload.routingPolicy)) {
          throw new Error("routingPolicy object is required");
        }
        for (const key of ROUTING_POLICY_KEYS) {
          if (key in payload.routingPolicy) {
            this.persistedSections[key] = cloneRecord(payload.routingPolicy[key]);
          }
        }
        this.version += 1;
        if (payload.persistNow === true) {
          const persisted = await this.persistence.persistNow();
          if (!persisted) return { ok: false, persistenceFailed: true };
        } else {
          this.persistence.schedulePersist();
        }
        this.broadcast(socket);
        return { ok: true, version: this.version };
      }

      case "update_cooldowns": {
        if (!isRecord(payload.cooldowns)) {
          throw new Error("cooldowns object is required");
        }
        const incoming = payload.cooldowns as unknown as CooldownSyncSnapshot;
        this.cooldowns = {
          cooldowns: cloneRecord(incoming.cooldowns ?? {}),
          modelCooldowns: cloneRecord(incoming.modelCooldowns ?? {}),
          failureStreaks: cloneRecord(incoming.failureStreaks ?? {}),
          probeStreaks: cloneRecord(incoming.probeStreaks ?? {})
        };
        this.version += 1;
        this.persistence.schedulePersist();
        this.broadcast(socket);
        return { ok: true, version: this.version };
      }

      case "update_active_provider_requests": {
        const generationId = String(payload.generationId ?? "");
        const counts = isRecord(payload.counts) ? payload.counts : {};
        const nextMap = new Map<string, number>();
        for (const [provider, count] of Object.entries(counts)) {
          if (typeof count === "number" && Number.isFinite(count) && count > 0) {
            nextMap.set(provider, count);
          }
        }
        if (nextMap.size === 0) {
          this.activeProviderRequestsByGeneration.delete(generationId);
        } else {
          this.activeProviderRequestsByGeneration.set(generationId, nextMap);
        }
        this.version += 1;
        this.broadcast(socket);
        return { ok: true };
      }

      case "report_persisted_sections": {
        if (isRecord(payload.sections)) {
          for (const key of PASS_THROUGH_PERSISTED_KEYS) {
            if (key in payload.sections) {
              this.persistedSections[key] = cloneRecord(payload.sections[key]);
            }
          }
        }
        if (payload.persistNow === true) {
          const persisted = await this.persistence.persistNow();
          return { ok: persisted };
        }
        this.persistence.schedulePersist();
        return { ok: true };
      }

      default:
        throw new Error(`Unknown shared state RPC action: ${action}`);
    }
  }

  async listen(): Promise<void> {
    if (this.server) return;
    try {
      if (statSync(this.socketPath).isSocket()) {
        rmSync(this.socketPath, { force: true });
      }
    } catch {
      /* absent */
    }
    const server = createServer((socket) => {
      this.clients.set(socket, { generationId: null });
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        while (true) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex === -1) break;
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;
          let message: RpcRequestMessage;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!isRecord(parsed) || parsed.type !== "rpc") continue;
            message = parsed as unknown as RpcRequestMessage;
          } catch {
            continue;
          }
          void this.handleRpc(
            socket,
            String(message.action ?? ""),
            isRecord(message.payload) ? message.payload : {}
          )
            .then((result) => {
              if (socket.destroyed) return;
              const response: RpcResponseMessage = {
                type: "rpc_result",
                id: message.id,
                ok: true,
                result
              };
              socket.write(`${JSON.stringify(response)}\n`);
            })
            .catch((error: unknown) => {
              if (socket.destroyed) return;
              const response: RpcResponseMessage = {
                type: "rpc_result",
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error)
              };
              socket.write(`${JSON.stringify(response)}\n`);
            });
        }
      });
      socket.once("close", () => {
        this.clients.delete(socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    this.persistence.cancelScheduledPersist();
    await this.persistence.persistNow().catch(() => false);
    for (const socket of this.clients.keys()) {
      socket.destroy();
    }
    this.clients.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      if (statSync(this.socketPath).isSocket()) {
        rmSync(this.socketPath, { force: true });
      }
    } catch {
      /* ignore cleanup errors */
    }
  }
}

/**
Worker-side client connected to `SharedRouterStateServer`.
Keeps synchronous worker views (`ROUTING_POLICY`, `COOLDOWNS`, `ConcurrencyManager`,
`activeProviderRequests`) synchronized across all live generations and forwards
linearizable admission/configuration/persistence mutations to the single owner.
*/
export class SharedRouterStateClient {
  readonly socketPath: string;
  readonly generationId: string;
  private readonly onSync: (snapshot: SharedRouterStateSnapshot) => void;
  private socket: Socket | null = null;
  private isClosed = false;
  private latestSnapshot: SharedRouterStateSnapshot | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(options: {
    socketPath: string;
    generationId: string;
    onSync: (snapshot: SharedRouterStateSnapshot) => void;
  }) {
    this.socketPath = options.socketPath;
    this.generationId = options.generationId;
    this.onSync = options.onSync;
  }

  get currentSnapshot(): SharedRouterStateSnapshot | null {
    return this.latestSnapshot;
  }

  async connectAndSync(): Promise<SharedRouterStateSnapshot> {
    if (this.socket && !this.socket.destroyed && this.latestSnapshot) {
      return this.latestSnapshot;
    }
    const socket = connectUnixSocket(this.socketPath);
    let buffer = "";
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve();
      });
      socket.once("error", reject);
    });
    socket.unref();
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(parsed)) continue;
        if (parsed.type === "rpc_result" && typeof parsed.id === "string") {
          const waiter = this.pending.get(parsed.id);
          if (!waiter) continue;
          this.pending.delete(parsed.id);
          if (parsed.ok === true) {
            waiter.resolve(parsed.result);
          } else {
            waiter.reject(
              new Error(
                typeof parsed.error === "string"
                  ? parsed.error
                  : "Shared state RPC failed"
              )
            );
          }
        } else if (parsed.type === "sync" && isRecord(parsed.snapshot)) {
          const snapshot = parsed.snapshot as unknown as SharedRouterStateSnapshot;
          this.latestSnapshot = snapshot;
          this.onSync(snapshot);
        }
      }
    });
    socket.once("close", () => {
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error("Shared state IPC socket closed"));
      }
      this.pending.clear();
      this.socket = null;
    });

    const initial = (await this.call("hello", {
      generationId: this.generationId
    })) as SharedRouterStateSnapshot;
    this.latestSnapshot = initial;
    this.onSync(initial);
    return initial;
  }

  async call(action: string, payload: Record<string, unknown>): Promise<unknown> {
    if (this.isClosed || !this.socket || this.socket.destroyed) {
      throw new Error("Shared state client is not connected");
    }
    const id = randomUUID();
    const request: RpcRequestMessage = {
      type: "rpc",
      id,
      action,
      payload
    };
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(`${JSON.stringify(request)}\n`);
    });
  }

  notify(action: string, payload: Record<string, unknown>): void {
    if (this.isClosed || !this.socket || this.socket.destroyed) return;
    void this.call(action, payload).catch(() => undefined);
  }

  close(): void {
    this.isClosed = true;
    for (const [, waiter] of this.pending) {
      waiter.reject(new Error("Shared state client closed"));
    }
    this.pending.clear();
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }
}
