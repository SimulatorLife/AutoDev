import { lstatSync } from "node:fs";
import path from "node:path";

import {
  ACP_PIN_LEDGER_SCHEMA,
  type AcpPinLedger,
  type AcpPinRecord,
  MAX_ACP_PIN_LEDGER_ENTRIES,
  parseAcpPinLedger
} from "@simulatorlife/autodev-core";

import {
  ensurePrivateDirectory,
  privateRead,
  privateWrite
} from "../shared/private-service-files.ts";

/**
Canonical bounded private ledger file for Runtime/ACP/OpenCLI session pins.
*/
export function acpPinsFile(codexHome: string): string {
  return path.join(codexHome, "run", "acp-pins.json");
}

const COLLATOR = new Intl.Collator();

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function seedLedgerEntries(
  file: string,
  entries: Map<string, AcpPinRecord>
): void {
  try {
    const stat = lstatSync(path.dirname(file));
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) return;
    const raw = privateRead(file);
    if (!raw) return;
    const parsed = parseAcpPinLedger(JSON.parse(raw));
    if (!parsed) return;
    const isPriorAlive =
      parsed.pid === process.pid || isProcessAlive(parsed.pid);
    for (const entry of parsed.pins) {
      if (entries.has(entry.sessionId)) continue;
      entries.set(entry.sessionId, {
        ...entry,
        closedAt:
          isPriorAlive || entry.closedAt !== null
            ? entry.closedAt
            : parsed.updatedAt
      });
    }
  } catch {
    // Missing or unreadable prior ledger never blocks Runtime pin writes.
  }
}

function writeLedgerSnapshot(file: string, ledger: AcpPinLedger): void {
  try {
    ensurePrivateDirectory(path.dirname(file));
    privateWrite(file, `${JSON.stringify(ledger)}\n`);
  } catch {
    // Publishing pin diagnostics is best-effort and must never fail turns.
  }
}

export interface PinSeedRecord {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly transport: "acp" | "opencli";
  readonly cwd: string;
  readonly createdAt: string;
}

/**
Publishes a bounded private ledger of active and recently closed ACP/OpenCLI
session pins so offline and online session diagnostics can attribute threads by
source-confirmed session identities.
*/
export class AcpPinLedgerPublisher {
  private readonly fileResolver: () => string;
  private readonly now: () => Date;
  private readonly entries = new Map<string, AcpPinRecord>();
  private seededForFile: string | null = null;

  constructor(
    fileResolver: string | (() => string),
    options?: { readonly now?: () => Date }
  ) {
    this.fileResolver =
      typeof fileResolver === "string" ? () => fileResolver : fileResolver;
    this.now = options?.now ?? (() => new Date());
  }

  private ensureSeeded(file: string): void {
    if (this.seededForFile === file) return;
    this.seededForFile = file;
    seedLedgerEntries(file, this.entries);
  }

  recordPin(pin: PinSeedRecord, acpSessionId: string | null = null): void {
    const file = this.fileResolver();
    this.ensureSeeded(file);
    const existing = this.entries.get(pin.sessionId);
    const at = this.now().toISOString();
    this.entries.set(pin.sessionId, {
      sessionId: pin.sessionId,
      parentSessionId: pin.parentSessionId,
      acpSessionId: acpSessionId ?? existing?.acpSessionId ?? null,
      role: pin.role,
      provider: pin.provider,
      model: pin.model,
      reasoningEffort: pin.reasoningEffort,
      transport: pin.transport,
      cwd: pin.cwd,
      createdAt: pin.createdAt,
      updatedAt: at,
      closedAt: null
    });
    writeLedgerSnapshot(file, this.snapshot());
  }

  recordAcpSession(sessionId: string, acpSessionId: string): void {
    const file = this.fileResolver();
    this.ensureSeeded(file);
    const existing = this.entries.get(sessionId);
    if (!existing) return;
    this.entries.set(sessionId, {
      ...existing,
      acpSessionId,
      updatedAt: this.now().toISOString()
    });
    writeLedgerSnapshot(file, this.snapshot());
  }

  markClosed(sessionId: string): void {
    const file = this.fileResolver();
    this.ensureSeeded(file);
    const existing = this.entries.get(sessionId);
    if (!existing) return;
    const at = this.now().toISOString();
    this.entries.set(sessionId, {
      ...existing,
      updatedAt: at,
      closedAt: at
    });
    writeLedgerSnapshot(file, this.snapshot());
  }

  snapshot(): AcpPinLedger {
    const sorted = this.entries
      .values()
      .toArray()
      .sort((left, right) => {
        const leftActive = left.closedAt === null ? 0 : 1;
        const rightActive = right.closedAt === null ? 0 : 1;
        if (leftActive !== rightActive) return leftActive - rightActive;
        return COLLATOR.compare(right.updatedAt, left.updatedAt);
      });
    const bounded = sorted.slice(0, MAX_ACP_PIN_LEDGER_ENTRIES);
    if (bounded.length < this.entries.size) {
      const keepIds = new Set(bounded.map((entry) => entry.sessionId));
      for (const key of this.entries.keys()) {
        if (!keepIds.has(key)) this.entries.delete(key);
      }
    }
    return {
      schema: ACP_PIN_LEDGER_SCHEMA,
      pid: process.pid,
      updatedAt: this.now().toISOString(),
      pins: bounded
    };
  }
}
