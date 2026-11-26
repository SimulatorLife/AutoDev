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
import { homedir } from "node:os";
import path from "node:path";

import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { autodevHome } from "@simulatorlife/autodev-runtime/shared/autodev-home";

import { parseCommandCatalogueText } from "../mcp/commands-catalogue.ts";
import {
  APPROVED_CATALOGUE_FILE,
  catalogueDigest,
  readApprovedCatalogue
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
  parseCommandCatalogueText(content);
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
    const content = readApprovedCatalogue(approvedPath);
    parseCommandCatalogueText(content);
    return catalogueDigest(content);
  } catch {
    return null;
  }
}

/**
The digest of the approved catalogue installed in a Runtime home -- the
revision its Commands MCP serves -- or null when it has none it would accept.
*/
export function installedCommandCatalogueDigest(
  runtimeHome: string
): string | null {
  return readApprovedDigest(approvedCommandCataloguePath(runtimeHome));
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
  // write-file-atomic resolves an existing target's realpath. Never let
  // approval write through a symlink, even when the digest is explicit.
  // The installed parent is owned by the trusted installer.
  for (const candidate of [
    path.dirname(current.approvedPath),
    current.approvedPath
  ]) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new Error("Refusing command catalogue approval through a symbolic link.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  atomicWriteSync(current.approvedPath, proposed, { mode: 0o644 });
  return approvalOf(proposed, runtimeHome);
}

/**
The approval state as the Control API and the Console publish it.

The proposal and the approved copy are two independent reads, and either can
fail. A state that merged them would have to call a catalogue nobody could
read "pending", which is a claim about an approval rather than about a read.
*/
export interface CommandCataloguePublication {
  /**
  `approved`: the installed copy is the checkout's proposal.
  `pending`: it is a different revision than the checkout's proposal.
  `unavailable`: no approved copy is installed, so the backend serves none.
  `unknown`: the proposal could not be read, so the two cannot be compared.
  */
  readonly state: "approved" | "pending" | "unavailable" | "unknown";
  /**
  The digest of the approved copy, or null when none is installed.
  */
  readonly approvedDigest: string | null;
  /**
  The digest the checkout proposes, or null when it could not be read.
  */
  readonly proposedDigest: string | null;
  /**
  Where the approved copy lives.
  */
  readonly approvedPath: string;
}

/**
Publish the approval state of one Runtime home's approved copy, read-only.

The proposal is a proposal: it may be unreadable, and it is never trusted. The
approved copy is the one the backend serves, so its absence is what makes the
backend unavailable rather than what makes it pending.
*/
export function publishedCommandCatalogueApproval(
  repositoryRoot: string,
  runtimeHome: string
): CommandCataloguePublication {
  const approvedPath = approvedCommandCataloguePath(runtimeHome);
  const approvedDigest = readApprovedDigest(approvedPath);
  let proposedDigest: string | null = null;
  try {
    proposedDigest = catalogueDigest(readProposed(repositoryRoot));
  } catch {
    proposedDigest = null;
  }
  if (approvedDigest === null) {
    return {
      state: "unavailable",
      approvedDigest: null,
      proposedDigest,
      approvedPath
    };
  }
  if (proposedDigest === null) {
    return {
      state: "unknown",
      approvedDigest,
      proposedDigest: null,
      approvedPath
    };
  }
  return {
    state: approvedDigest === proposedDigest ? "approved" : "pending",
    approvedDigest,
    proposedDigest,
    approvedPath
  };
}

/**
The Runtime homes that serve a Commands MCP.

The AutoDev home serves the provider sessions' MCP launchers and the Codex
home serves the ChatGPT gateway's, and each home holds its own approved copy.
The same catalogue is therefore approved twice, and an operator looking at one
backend needs to know about both.
*/
export function commandCatalogueHomes(
  environment: NodeJS.ProcessEnv = process.env,
  home = environment.HOME?.trim() || homedir()
): readonly string[] {
  return [
    autodevHome(environment, home),
    environment.CODEX_HOME?.trim() || path.join(home, ".codex")
  ];
}

/**
The operator-facing explanation of a pending revision.
*/
export function pendingCommandCatalogueMessage(
  approval: CommandCatalogueApproval
): string {
  return [
    `Command catalogue revision ${approval.proposedDigest} is not approved in ${approval.approvedPath}; the Commands MCP there keeps serving ${approval.approvedDigest ?? "no catalogue (it refuses to start)"}.`,
    `Review config/commands.json, then approve exactly this revision by rerunning the installer with ${APPROVE_COMMAND_CATALOGUE_FLAG}=${approval.proposedDigest}.`
  ].join("\n");
}
