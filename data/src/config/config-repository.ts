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
const REPOSITORY_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/u;

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
    const weightsPath = path.join(
      this.repositoryRoot,
      ".github",
      "workflows",
      "weights.json"
    );
    if (!existsSync(weightsPath))
      return { status: "unavailable", workspaces: [] };
    try {
      const raw = JSON.parse(readFileSync(weightsPath, "utf8")) as unknown;
      if (
        raw === null ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        !Array.isArray((raw as { repositories?: unknown }).repositories)
      ) {
        return { status: "invalid", workspaces: [] };
      }
      const repositories = (raw as { repositories: unknown[] }).repositories;
      const workspaces: WorkspaceEntry[] = [];
      const names = new Set<string>();
      for (const repository of repositories) {
        if (
          repository === null ||
          typeof repository !== "object" ||
          Array.isArray(repository)
        ) {
          return { status: "invalid", workspaces: [] };
        }
        const entry = repository as Record<string, unknown>;
        if (
          typeof entry.name !== "string" ||
          !REPOSITORY_NAME_PATTERN.test(entry.name) ||
          typeof entry.baseBranch !== "string" ||
          !entry.baseBranch.trim() ||
          typeof entry.weight !== "number" ||
          !Number.isFinite(entry.weight) ||
          entry.weight < 0 ||
          names.has(entry.name)
        ) {
          return { status: "invalid", workspaces: [] };
        }
        names.add(entry.name);
        workspaces.push({
          name: entry.name,
          baseBranch: entry.baseBranch,
          weight: entry.weight
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
