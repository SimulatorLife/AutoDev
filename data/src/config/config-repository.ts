import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  PermissionPolicy,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";

import { readWorkspaceCatalogFile } from "./workspace-catalog.ts";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface WorkspaceCatalogRead {
  readonly status: "valid" | "invalid" | "unavailable";
  readonly workspaces: readonly WorkspaceEntry[];
  /**
   * The revision of the catalog file: the sha256 of its exact bytes, or null
   * when the file could not be read.
   *
   * Optional because a stand-in catalog -- a fixture that names the workspaces
   * it admits -- has no file behind it and no revision to publish.
   */
  readonly revision?: string | null;
}

export class ConfigRepository {
  readonly repositoryRoot: string;

  constructor(repositoryRoot: string = DEFAULT_REPO_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  loadAgentRoles(): string[] {
    const contractPath = path.join(
      this.repositoryRoot,
      "config",
      "execution-contract.json"
    );
    if (!existsSync(contractPath)) return [];
    try {
      const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
        roles?: unknown;
      };
      return contract.roles !== null &&
        typeof contract.roles === "object" &&
        !Array.isArray(contract.roles)
        ? Object.keys(contract.roles)
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Where the canonical workspace catalog lives under this repository root.
   *
   * The catalog's own rules live in the module that owns them; where the file
   * sits is this repository's decision, and a writer that has to name the file
   * asks here rather than building the path itself.
   */
  workspaceCatalogPath(): string {
    return path.join(this.repositoryRoot, "config", "workspaces.json");
  }

  readWorkspaceCatalog(): WorkspaceCatalogRead {
    const catalogPath = this.workspaceCatalogPath();
    // The catalog's schema is decided once, in the module that owns it. The
    // reader here decides nothing about what the file means: it says where
    // the file is and what came back.
    const read = readWorkspaceCatalogFile(catalogPath);
    if (read.status !== "valid") {
      return { status: read.status, workspaces: [], revision: read.revision };
    }
    return {
      status: "valid",
      workspaces: read.workspaces.map((workspace) => ({
        id: workspace.id,
        baseBranch: workspace.baseBranch,
        enabled: workspace.enabled,
        agentRoles: workspace.agentRoles
      })),
      revision: read.revision
    };
  }

  loadPermissionPolicy(): PermissionPolicy {
    return {
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      networkAccess: true,
      webSearch: true,
      approvalsReviewer: "user",
      defaultToolsApprovalMode: "approve"
    };
  }
}
