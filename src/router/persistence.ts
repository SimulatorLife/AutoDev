import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";

import { writeErrorLine } from "../shared/output.ts";

export const PERSISTED_STATE_SCHEMA = "autodev-router-persisted-state";
export const PERSISTED_STATE_VERSION = "v3";

export function defaultCodexHome(): string {
  return (
    process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`
  );
}

export function defaultStateFile(): string {
  return (
    process.env.CODEX_ROUTER_STATE_FILE ??
    `${defaultCodexHome()}/codex-router-state.json`
  );
}

export function effectiveStateFile(customFile?: string | null): string {
  if (typeof customFile === "string" && customFile.trim()) {
    return customFile.trim();
  }
  return process.env.CODEX_ROUTER_STATE_FILE ?? defaultStateFile();
}

export interface StateProviderTelemetryEntry {
  attempts: number;
  successes: number;
  failures: number;
  skipped: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureClass: string | null;
  lastFailure: unknown;
}

export function restoreProviderTelemetrySection(
  currentCollection:
    | Map<string, StateProviderTelemetryEntry>
    | Record<string, StateProviderTelemetryEntry>
    | ((provider: string) => StateProviderTelemetryEntry | null | undefined),
  savedSection: unknown
): void {
  if (!savedSection || typeof savedSection !== "object") return;
  for (const [provider, saved] of Object.entries(
    savedSection as Record<string, unknown>
  )) {
    if (!saved || typeof saved !== "object") continue;
    let current: StateProviderTelemetryEntry | null | undefined;
    if (typeof currentCollection === "function") {
      current = currentCollection(provider);
    } else if (currentCollection instanceof Map) {
      current = currentCollection.get(provider);
    } else {
      current = currentCollection[provider];
    }
    if (!current) continue;

    const savedEntry = saved as Record<string, unknown>;
    for (const field of [
      "attempts",
      "successes",
      "failures",
      "skipped"
    ] as const) {
      const val = savedEntry[field];
      if (Number.isInteger(val) && (val as number) >= 0) {
        current[field] = val as number;
      }
    }
    for (const field of [
      "lastAttemptAt",
      "lastSuccessAt",
      "lastFailureAt",
      "lastFailureClass"
    ] as const) {
      const val = savedEntry[field];
      if (val === null || typeof val === "string") {
        current[field] = val;
      }
    }
    if (
      savedEntry.lastFailure === null ||
      (savedEntry.lastFailure && typeof savedEntry.lastFailure === "object")
    ) {
      current.lastFailure = savedEntry.lastFailure;
    }
  }
}

export interface RouterPersistenceSnapshot {
  schema: string;
  updatedAt: string;
  disabledProviders?: string[] | undefined;
  providerTelemetry?: Record<string, unknown> | undefined;
  usage?: unknown;
  concurrency?: unknown;
  subagents?: unknown;
  spawnFailures?: unknown;
  providerCooldowns?: unknown[] | undefined;
  recentEvents?: unknown[] | undefined;
  otelTelemetry?: unknown;
  [key: string]: unknown;
}

export interface RouterPersistenceOptions {
  stateFile?: string | (() => string) | undefined;
  isMain?: boolean | undefined;
  debounceMs?: number | undefined;
  getSnapshot?: (() => Record<string, unknown>) | undefined;
  restoreSection?:
    | ((
        section: string,
        value: unknown,
        fullParsed: Record<string, unknown>
      ) => void)
    | undefined;
  onPostRestore?: ((parsed: Record<string, unknown>) => void) | undefined;
}

export class RouterPersistence {
  private readonly stateFileOption?: string | (() => string) | undefined;
  private readonly isMain: boolean;
  private readonly debounceMs: number;
  private readonly getSnapshot?: (() => Record<string, unknown>) | undefined;
  private readonly restoreSectionCallback?:
    | ((
        section: string,
        value: unknown,
        fullParsed: Record<string, unknown>
      ) => void)
    | undefined;
  private readonly onPostRestoreCallback?:
    ((parsed: Record<string, unknown>) => void) | undefined;

  persistedStateUpdatedAt: string | null = null;
  private persistTimeout: NodeJS.Timeout | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: RouterPersistenceOptions = {}) {
    this.stateFileOption = options.stateFile;
    this.isMain = options.isMain ?? true;
    this.debounceMs = options.debounceMs ?? 500;
    this.getSnapshot = options.getSnapshot;
    this.restoreSectionCallback = options.restoreSection;
    this.onPostRestoreCallback = options.onPostRestore;
  }

  getStateFile(override?: string | null): string {
    if (typeof override === "string" && override.trim()) {
      return override.trim();
    }
    if (typeof this.stateFileOption === "function") {
      return this.stateFileOption();
    }
    if (
      typeof this.stateFileOption === "string" &&
      this.stateFileOption.trim()
    ) {
      return this.stateFileOption.trim();
    }
    return effectiveStateFile();
  }

  serialize(customSnapshot?: Record<string, unknown>): string {
    const base = customSnapshot ?? (this.getSnapshot ? this.getSnapshot() : {});
    const payload: RouterPersistenceSnapshot = {
      schema: `${PERSISTED_STATE_SCHEMA}-${PERSISTED_STATE_VERSION}`,
      updatedAt: new Date().toISOString(),
      ...base
    };
    return JSON.stringify(payload, null, 2);
  }

  load(file?: string): boolean {
    const targetFile = this.getStateFile(file);
    if (!existsSync(targetFile)) return false;
    try {
      const parsed = JSON.parse(readFileSync(targetFile, "utf8"));
      if (
        typeof parsed?.schema !== "string" ||
        !parsed.schema.startsWith(PERSISTED_STATE_SCHEMA)
      ) {
        return false;
      }

      if (this.restoreSectionCallback) {
        for (const [section, value] of Object.entries(parsed)) {
          if (section === "schema" || section === "updatedAt") continue;
          this.restoreSectionCallback(section, value, parsed);
        }
      }

      if (this.onPostRestoreCallback) {
        this.onPostRestoreCallback(parsed);
      }

      this.persistedStateUpdatedAt =
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
      return true;
    } catch (error) {
      writeErrorLine(
        `Warning: could not load router state from ${targetFile}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  async persistNow(file?: string): Promise<void> {
    if (this.persistTimeout) {
      clearTimeout(this.persistTimeout);
      this.persistTimeout = null;
    }
    const targetFile = this.getStateFile(file);
    const temporaryFile = `${targetFile}.${process.pid}.${Date.now()}.tmp`;

    this.persistChain = this.persistChain
      .catch(() => {})
      .then(async () => {
        await writeFile(temporaryFile, this.serialize(), {
          encoding: "utf8",
          mode: 0o600
        });
        await rename(temporaryFile, targetFile);
        this.persistedStateUpdatedAt = new Date().toISOString();
      })
      .catch((error) => {
        writeErrorLine(
          `Warning: could not persist router state to ${targetFile}: ${error instanceof Error ? error.message : String(error)}`
        );
      });

    return this.persistChain;
  }

  schedulePersist(file?: string): void {
    if (!this.isMain || this.persistTimeout) return;
    this.persistTimeout = setTimeout(() => {
      this.persistTimeout = null;
      void this.persistNow(file);
    }, this.debounceMs);
  }

  cancelScheduledPersist(): void {
    if (this.persistTimeout) {
      clearTimeout(this.persistTimeout);
      this.persistTimeout = null;
    }
  }

  getUpdatedAt(): string | null {
    return this.persistedStateUpdatedAt;
  }

  setUpdatedAt(value: string | null): void {
    this.persistedStateUpdatedAt = value;
  }
}

let defaultPersistenceManager: RouterPersistence | null = null;

export function getDefaultPersistenceManager(): RouterPersistence {
  if (!defaultPersistenceManager) {
    defaultPersistenceManager = new RouterPersistence();
  }
  return defaultPersistenceManager;
}

export function setDefaultPersistenceManager(
  manager: RouterPersistence | null
): void {
  defaultPersistenceManager = manager;
}

export function serializeRouterState(
  customSnapshot?: Record<string, unknown>
): string {
  return getDefaultPersistenceManager().serialize(customSnapshot);
}

export function loadRouterState(file?: string): boolean {
  return getDefaultPersistenceManager().load(file);
}

export function persistRouterStateNow(file?: string): Promise<void> {
  return getDefaultPersistenceManager().persistNow(file);
}

export function scheduleRouterStatePersist(file?: string): void {
  getDefaultPersistenceManager().schedulePersist(file);
}
