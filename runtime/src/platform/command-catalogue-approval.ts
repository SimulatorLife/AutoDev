/**
The operator approval boundary for the Commands MCP catalogue.

`config/commands.json` in the checkout is a *proposal*: when AutoDev itself
is the authorized workspace, the agents it confines can edit it. The
Commands MCP only ever trusts the approved copy in the Runtime home, and
that copy changes only when the operator approves the exact revision the
installer is about to apply -- by passing its digest on the installer's
command line ({@link APPROVE_COMMAND_CATALOGUE_FLAG}). The approval is never
read from the environment: the installer loads the checkout's `.env`, which
a workspace agent can write. A reinstall or reconciliation never approves a
changed catalogue on its own, so an agent cannot grant itself a command by
editing the checkout and waiting for the next install. The installer itself
runs from the checkout, so the operator still reviews what they install;
this boundary makes a catalogue change visible and explicit, it does not
make unreviewed installer code trustworthy.
*/
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";

import { parseCommandCatalogue } from "../mcp/commands-catalogue.ts";
import {
  APPROVED_CATALOGUE_FILE,
  catalogueDigest
} from "../mcp/commands-main.ts";

/**
The installer flag that carries the operator's approval digest.
*/
export const APPROVE_COMMAND_CATALOGUE_FLAG = "--approve-command-catalogue";

export type CommandCatalogueApprovalState =
  /**
  The approved copy is the checkout's revision.
  */
  | "approved"
  /**
  The checkout proposes a revision the operator has not approved.
  */
  | "pending";

export interface CommandCatalogueApproval {
  readonly state: CommandCatalogueApprovalState;
  /**
  The digest of the checkout's proposed catalogue.
  */
  readonly proposedDigest: string;
  /**
  The digest of the approved copy, or null when none is installed.
  */
  readonly approvedDigest: string | null;
  /**
  Where the approved copy lives.
  */
  readonly approvedPath: string;
}

/**
The approved catalogue's path in a Runtime home.
*/
export function approvedCommandCataloguePath(runtimeHome: string): string {
  return path.join(runtimeHome, "config", APPROVED_CATALOGUE_FILE);
}

function readProposed(repositoryRoot: string): string {
  const content = readFileSync(
    path.join(repositoryRoot, "config", APPROVED_CATALOGUE_FILE),
    "utf8"
  );
  // A proposal that is not a valid catalogue is never offered for approval.
  parseCommandCatalogue(JSON.parse(content));
  return content;
}

function approvalOf(
  proposed: string,
  runtimeHome: string
): CommandCatalogueApproval {
  const proposedDigest = catalogueDigest(proposed);
  const approvedPath = approvedCommandCataloguePath(runtimeHome);
  const approvedDigest = readApprovedDigest(approvedPath);
  return {
    state: approvedDigest === proposedDigest ? "approved" : "pending",
    proposedDigest,
    approvedDigest,
    approvedPath
  };
}

function readApprovedDigest(approvedPath: string): string | null {
  try {
    if (!lstatSync(approvedPath).isFile()) return null;
    return catalogueDigest(readFileSync(approvedPath, "utf8"));
  } catch {
    return null;
  }
}

/**
Compare the checkout's proposal with the approved copy, read-only.
*/
export function commandCatalogueApproval(
  repositoryRoot: string,
  runtimeHome: string
): CommandCatalogueApproval {
  return approvalOf(readProposed(repositoryRoot), runtimeHome);
}

/**
Install the checkout's catalogue only if it is already the approved one or
the operator approved exactly this revision. The bytes written are the bytes
whose digest was approved, so a proposal swapped after it was read cannot be
installed in its place. Anything else leaves the approved copy as it was --
absent included, in which case the Commands MCP refuses to start -- and
reports the pending revision.
*/
export function applyCommandCatalogueApproval(
  repositoryRoot: string,
  runtimeHome: string,
  { approvedDigest }: { readonly approvedDigest?: string | undefined } = {}
): CommandCatalogueApproval {
  const proposed = readProposed(repositoryRoot);
  const current = approvalOf(proposed, runtimeHome);
  if (current.state === "approved") return current;
  if (approvedDigest?.trim() !== current.proposedDigest) return current;
  atomicWriteSync(current.approvedPath, proposed, { mode: 0o644 });
  return approvalOf(proposed, runtimeHome);
}

/**
The operator-facing explanation of a pending revision.
*/
export function pendingCommandCatalogueMessage(
  approval: CommandCatalogueApproval
): string {
  return [
    `Command catalogue revision ${approval.proposedDigest} is not approved; the Commands MCP keeps serving ${approval.approvedDigest ?? "no catalogue (it refuses to start)"}.`,
    `Review config/commands.json, then approve exactly this revision by rerunning the installer with ${APPROVE_COMMAND_CATALOGUE_FLAG}=${approval.proposedDigest}.`
  ].join("\n");
}
