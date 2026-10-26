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

  readWorkspaceCatalog(): WorkspaceCatalogRead {
    const catalogPath = path.join(
      this.repositoryRoot,
      "config",
      "workspaces.json"
    );
    // The catalog's schema is decided once, in the module that owns it. The
    // reader here decides nothing about what the file means: it says where
    // the file is and what came back.
    const read = readWorkspaceCatalogFile(catalogPath);
    if (read.status !== "valid") {
      return { status: read.status, workspaces: [] };
    }
    return {
      status: "valid",
      workspaces: read.workspaces.map((workspace) => ({
        id: workspace.id,
        baseBranch: workspace.baseBranch,
        enabled: workspace.enabled,
        agentRoles: workspace.agentRoles
      }))
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
