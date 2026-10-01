import React, { useState } from "react";

import type {
  AgentDefinition,
  CanonicalNavSection,
  EvaluationResult,
  HookDefinition,
  McpRoleExposure,
  MemoryRecord,
  PermissionPolicy,
  PromptAsset,
  RoleCapabilityMatrix,
  SkillDefinition,
  ToolCatalogItem,
  WorkspaceEntry
} from "../../../core/src/index.ts";
import { AppShell } from "../components/layout/AppShell.ts";
import { AgentsView } from "./agents/AgentsView.ts";
import { EvaluationsView } from "./evaluations/EvaluationsView.ts";
import { HooksView } from "./hooks/HooksView.ts";
import { McpsView } from "./mcps/McpsView.ts";
import { MemoryView } from "./memory/MemoryView.ts";
import { PermissionsView } from "./permissions/PermissionsView.ts";
import { PromptsView } from "./prompts/PromptsView.ts";
import { SkillsView } from "./skills/SkillsView.ts";
import { ToolsView } from "./tools/ToolsView.ts";
import { UsageView } from "./usage/UsageView.ts";
import { WorkspacesView } from "./workspaces/WorkspacesView.ts";

export interface ConsoleAppData {
  readonly agents: readonly AgentDefinition[];
  readonly mcps: readonly McpRoleExposure[];
  readonly skills: readonly SkillDefinition[];
  readonly hooks: readonly HookDefinition[];
  readonly memory?: readonly MemoryRecord[] | undefined;
  readonly evaluations?: readonly EvaluationResult[] | undefined;
  readonly permissions: {
    readonly policy: PermissionPolicy;
    readonly roleMatrices: readonly RoleCapabilityMatrix[];
  };
  readonly tools: readonly ToolCatalogItem[];
  readonly prompts: readonly PromptAsset[];
  readonly workspaces: readonly WorkspaceEntry[];
}

export interface ConsoleAppProps {
  readonly initialSection?: CanonicalNavSection | undefined;
  readonly data: ConsoleAppData;
}

export function ConsoleApp({
  initialSection = "Agents",
  data
}: ConsoleAppProps): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<CanonicalNavSection>(initialSection);

  const counts: Partial<Record<CanonicalNavSection, number>> = {
    Agents: data.agents.length,
    MCPs: data.mcps.length,
    Skills: data.skills.length,
    Hooks: data.hooks.length,
    Memory: data.memory?.length ?? 0,
    Evaluations: data.evaluations?.length ?? 0,
    Tools: data.tools.length,
    Prompts: data.prompts.length,
    Workspaces: data.workspaces.length
  };

  function renderFeatureView(): React.JSX.Element {
    switch (activeSection) {
      case "Agents": {
        return React.createElement(AgentsView, { agents: data.agents });
      }
      case "MCPs": {
        return React.createElement(McpsView, { servers: data.mcps });
      }
      case "Skills": {
        return React.createElement(SkillsView, { skills: data.skills });
      }
      case "Hooks": {
        return React.createElement(HooksView, { hooks: data.hooks });
      }
      case "Memory": {
        return React.createElement(MemoryView, { records: data.memory });
      }
      case "Evaluations": {
        return React.createElement(EvaluationsView, { evaluations: data.evaluations });
      }
      case "Permissions": {
        return React.createElement(PermissionsView, {
          policy: data.permissions.policy,
          roleMatrices: data.permissions.roleMatrices
        });
      }
      case "Tools": {
        return React.createElement(ToolsView, { tools: data.tools });
      }
      case "Usage": {
        return React.createElement(UsageView, null);
      }
      case "Prompts": {
        return React.createElement(PromptsView, { commands: data.prompts });
      }
      case "Workspaces": {
        return React.createElement(WorkspacesView, { workspaces: data.workspaces });
      }
      default: {
        const _exhaustive: never = activeSection;
        return React.createElement("div", null, `Unknown Section: ${_exhaustive}`);
      }
    }
  }

  return React.createElement(
    AppShell,
    {
      activeSection,
      onSelectSection: setActiveSection,
      counts
    },
    renderFeatureView()
  );
}
