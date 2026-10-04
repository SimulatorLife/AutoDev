import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentDefinition,
  AgentRole,
  PermissionPolicy,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;

export interface WorkspaceCatalogRead {
  readonly status: "valid" | "invalid" | "unavailable";
  readonly workspaces: readonly WorkspaceEntry[];
}

export class ConfigRepository {
  readonly repositoryRoot: string;

  constructor(repositoryRoot: string = DEFAULT_REPO_ROOT) {
    this.repositoryRoot = repositoryRoot;
  }

  loadAgents(): AgentDefinition[] {
    const contractPath = path.join(
      this.repositoryRoot,
      "config",
      "execution-contract.json"
    );
    if (!existsSync(contractPath)) return [];
    try {
      const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
        roles?: Record<string, Record<string, unknown>>;
      };
      const roles = contract.roles ?? {};
      return Object.entries(roles).map(([role, raw]) => {
        const isOrchestrator = role === "orchestrator";
        const kind =
          typeof raw.kind === "string"
            ? (raw.kind as "orchestrator" | "leaf")
            : isOrchestrator
              ? "orchestrator"
              : "leaf";
        const readOnly = Boolean(raw.readOnly);
        const mcps = Array.isArray(raw.mcp) ? (raw.mcp as string[]) : [];
        const skills = Array.isArray(raw.skills)
          ? (raw.skills as string[])
          : [];
        const tools: Array<{
          name: string;
          type: "mcp" | "skill";
          server?: string;
        }> = [];
        for (const mcp of mcps)
          tools.push({ name: mcp, type: "mcp", server: mcp });
        for (const skill of skills) tools.push({ name: skill, type: "skill" });

        return {
          id: role,
          role: role as AgentRole,
          kind,
          readOnly,
          configured: true,
          valid: true,
          status: "ready" as const,
          convergence: "converged" as const,
          primaryModel: isOrchestrator
            ? "autodev/orchestrator"
            : "autodev/subagent",
          models: ["gpt-5.6-terra", "claude-3-5-sonnet", "gemini-1.5-pro"],
          providers: ["codex", "claude", "antigravity", "copilot", "minimax"],
          tools,
          toolNames: tools.map((t) => t.name)
        };
      });
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
    if (!existsSync(catalogPath))
      return { status: "unavailable", workspaces: [] };
    try {
      const raw = JSON.parse(readFileSync(catalogPath, "utf8")) as unknown;
      if (
        raw === null ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        (raw as { schema?: unknown }).schema !== "autodev-workspaces-v1" ||
        !Array.isArray((raw as { workspaces?: unknown }).workspaces)
      ) {
        return { status: "invalid", workspaces: [] };
      }
      const records = (raw as { workspaces: unknown[] }).workspaces;
      const workspaces: WorkspaceEntry[] = [];
      const names = new Set<string>();
      for (const workspace of records) {
        if (
          workspace === null ||
          typeof workspace !== "object" ||
          Array.isArray(workspace)
        ) {
          return { status: "invalid", workspaces: [] };
        }
        const entry = workspace as Record<string, unknown>;
        const agentRoles = entry.agentRoles;
        if (
          typeof entry.id !== "string" ||
          !WORKSPACE_ID_PATTERN.test(entry.id) ||
          typeof entry.baseBranch !== "string" ||
          !entry.baseBranch.trim() ||
          typeof entry.enabled !== "boolean" ||
          (agentRoles !== null &&
            (!Array.isArray(agentRoles) ||
              !agentRoles.every(
                (role) =>
                  typeof role === "string" &&
                  role.trim().length > 0 &&
                  role.trim() === role
              ) ||
              new Set(agentRoles).size !== agentRoles.length)) ||
          names.has(entry.id)
        ) {
          return { status: "invalid", workspaces: [] };
        }
        names.add(entry.id);
        workspaces.push({
          id: entry.id,
          baseBranch: entry.baseBranch,
          enabled: entry.enabled,
          agentRoles: agentRoles === null ? null : (agentRoles as string[])
        });
      }
      return { status: "valid", workspaces };
    } catch {
      return { status: "invalid", workspaces: [] };
    }
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
