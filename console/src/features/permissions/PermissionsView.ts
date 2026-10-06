import type {
  PermissionPolicy,
  RoleCapabilityMatrix
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { TAG_SHAPE } from "../../components/status/Tag.ts";
import { chipList } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

export interface PermissionsViewProps {
  readonly policy: PermissionPolicy;
  readonly roleMatrices: readonly RoleCapabilityMatrix[];
}

/** How a sandbox mode reads in prose, so the column is not raw config text. */
function sandboxLabel(mode: RoleCapabilityMatrix["sandboxMode"]): string {
  if (mode === "read-only") return "Read-only";
  if (mode === "workspace-write") return "Workspace write";
  return "Unrestricted";
}

export function PermissionsView({
  policy,
  roleMatrices
}: PermissionsViewProps): React.JSX.Element {
  const columns: ColumnDef<RoleCapabilityMatrix>[] = [
    {
      id: "role",
      header: "Agent Role",
      weight: 176,
      cell: (r) =>
        React.createElement(
          "span",
          { className: "font-semibold text-fg font-mono" },
          r.role
        )
    },
    {
      id: "sandboxMode",
      header: "Sandbox Mode",
      weight: 160,
      cell: (r) =>
        React.createElement(
          "span",
          {
            className: `${TAG_SHAPE} border-border-strong bg-surface-raised text-fg-secondary`,
            "data-permission-mode": r.readOnly ? "read-only" : "workspace-write"
          },
          sandboxLabel(r.sandboxMode)
        )
    },
    {
      id: "mcps",
      header: "Allowed MCP Servers",
      align: "tokens",
      cell: (r) =>
        chipList({
          items: r.allowedMcpServers,
          emptyLabel: "No MCP servers",
          testId: "role-mcps",
          className: "font-mono text-accent"
        })
    },
    {
      id: "skills",
      header: "Allowed Skills",
      align: "tokens",
      cell: (r) =>
        chipList({
          items: r.allowedSkills,
          emptyLabel: "No skills",
          testId: "role-skills"
        })
    }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "permissions" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-4 gap-4" },
      React.createElement(StatCard, {
        title: "Approval Policy",
        value: policy.approvalPolicy
      }),
      React.createElement(StatCard, {
        title: "Default Sandbox",
        value: sandboxLabel(policy.sandboxMode)
      }),
      React.createElement(StatCard, {
        title: "Network Access",
        value: policy.networkAccess ? "Allowed" : "Blocked"
      }),
      React.createElement(StatCard, {
        title: "Web Search",
        value: policy.webSearch ? "Enabled" : "Disabled"
      })
    ),
    React.createElement(
      "div",
      null,
      React.createElement(
        "h2",
        {
          className: SECTION_HEADING_CLASS
        },
        "Effective Role Capability Matrix"
      ),
      DataTable({
        data: roleMatrices,
        columns,
        keyExtractor: (r: RoleCapabilityMatrix) => r.role
      })
    )
  );
}
