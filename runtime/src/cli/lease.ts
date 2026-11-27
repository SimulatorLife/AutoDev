/**
The operator's view of the workspace leases the Runtime holds.

A lease is taken when a command starts and released when it finishes. A
server that dies in between leaves the lease behind, and the workspace it
protects stays closed until somebody proves the command is gone. This
command is how that proof -- or the operator's own judgement -- reaches the
lease.
*/
import { homedir } from "node:os";

import { ConfigError } from "@simulatorlife/autodev-runtime/config";
import { autodevRunDirectory } from "@simulatorlife/autodev-runtime/shared/autodev-home";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";

import {
  inspectCommandLeases,
  releaseCommandLease
} from "../mcp/commands-main.ts";
import { unsupportedChoice } from "./command-choice.ts";

/*
The repo vocabulary, owned here and consumed by validation and errors.
*/
export const LEASE_SUBCOMMANDS = ["list", "release"] as const;

export type LeaseSubcommand = (typeof LEASE_SUBCOMMANDS)[number];

export interface LeaseCommandBackend {
  /**
  The run directory the leases were read from, so the operator can see which
  state home answered rather than wondering why nothing is listed.
  */
  readonly location: string;
  list(): readonly string[];
  release(
    workspaceKey: string,
    isForced: boolean
  ): { readonly released: boolean; readonly reason: string };
}

/**
The run directory the leases live in, resolved the way the Runtime resolves
it: from the Runtime's own state home, never from the caller's workspace.
*/
function leaseRunDirectory(): string {
  const environment = process.env;
  return autodevRunDirectory(
    environment,
    environment.HOME?.trim() || homedir()
  );
}

/**
One lease, as one line of the operator's listing.

The state is the point of the listing: `held` is a workspace that is busy,
`abandoned` is one whose command has finished and whose lease was never
released, and `unverifiable` is one that cannot be judged and needs the
operator's own eyes.
*/
function describeLease(report: {
  readonly workspaceKey: string;
  readonly state: string;
  readonly holder: number | null;
  readonly isHolderAlive: boolean;
  readonly command: number | null;
  readonly isCommandAlive: boolean;
}): string {
  const holder =
    report.holder === null
      ? "unknown"
      : `${report.holder}${report.isHolderAlive ? " (running)" : " (gone)"}`;
  const command =
    report.command === null
      ? "not recorded"
      : `${report.command}${report.isCommandAlive ? " (running)" : " (gone)"}`;
  return `${report.workspaceKey}  ${report.state}  holder ${holder}  command ${command}`;
}

export const defaultLeaseBackend: LeaseCommandBackend = {
  location: leaseRunDirectory(),
  list: () =>
    inspectCommandLeases(leaseRunDirectory()).map((report) =>
      describeLease(report)
    ),
  release: (workspaceKey, isForced) =>
    releaseCommandLease(leaseRunDirectory(), workspaceKey, { force: isForced })
};

export function dispatchLeaseCommand(
  subcommand: string,
  arguments_: readonly string[],
  backend: LeaseCommandBackend = defaultLeaseBackend
): number {
  if (subcommand === "list") return listLeases(backend);
  if (subcommand === "release") return releaseLease(arguments_, backend);
  throw unsupportedChoice("lease subcommand", subcommand, LEASE_SUBCOMMANDS);
}

function listLeases(backend: LeaseCommandBackend): number {
  const leases = backend.list();
  writeLine(`Run directory: ${backend.location}`);
  if (leases.length === 0) {
    writeLine("No workspace leases are held.");
    return 0;
  }
  for (const lease of leases) writeLine(lease);
  return 0;
}

function releaseLease(
  arguments_: readonly string[],
  backend: LeaseCommandBackend
): number {
  const isForced = arguments_.includes("--force");
  const workspaceKey = arguments_.find(
    (argument) => !argument.startsWith("--")
  );
  if (!workspaceKey) {
    throw new ConfigError("lease release requires a workspace key.");
  }
  const outcome = backend.release(workspaceKey, isForced);
  if (!outcome.released) {
    writeErrorLine(`The lease was not released: ${outcome.reason}.`);
    return 1;
  }
  writeLine(`The lease for ${workspaceKey} was released: ${outcome.reason}.`);
  return 0;
}
