import type {
  PermissionPolicy,
  RoleCapabilityMatrix
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";

export interface PermissionsViewProps {
  readonly policy: PermissionPolicy;
  readonly roleMatrices: readonly RoleCapabilityMatrix[];
}

export function PermissionsView({
  policy,
  roleMatrices
}: PermissionsViewProps): React.JSX.Element {
  const columns: ColumnDef<RoleCapabilityMatrix>[] = [
    {
      id: "role",
      header: "Agent Role",
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
      cell: (r) =>
        React.createElement(
          "span",
          {
            className:
              "text-xs bg-surface-raised text-fg-secondary px-2 py-0.5 rounded font-mono border border-border-strong"
          },
          r.sandboxMode
        )
    },
    {
      id: "readOnly",
      header: "Capability",
      cell: (r) =>
        React.createElement(
          "span",
          {
            className: "text-xs text-fg-secondary",
            "data-permission-mode": r.readOnly ? "read-only" : "workspace-write"
          },
          r.readOnly ? "Read-Only" : "Workspace-Write"
        )
    },
    {
      id: "mcps",
      header: "Allowed MCP Servers",
      cell: (r) =>
        React.createElement(
          "div",
          { className: "flex flex-wrap gap-1" },
          r.allowedMcpServers.map((mcp) =>
            React.createElement(
              "span",
              {
                key: mcp,
                className:
                  "text-xs bg-surface-raised text-accent px-1.5 py-0.5 rounded border border-border-strong font-mono"
              },
              mcp
            )
          ),
          r.allowedMcpServers.length === 0
            ? React.createElement(
                "span",
                { className: "text-xs text-fg-muted" },
                "None"
              )
            : null
        )
    },
    {
      id: "skills",
      header: "Allowed Skills",
      cell: (r) =>
        React.createElement(
          "div",
          { className: "flex flex-wrap gap-1" },
          r.allowedSkills.map((skill) =>
            React.createElement(
              "span",
              {
                key: skill,
                className:
                  "text-xs bg-surface-raised text-fg-secondary px-1.5 py-0.5 rounded border border-border-strong font-mono"
              },
              skill
            )
          ),
          r.allowedSkills.length === 0
            ? React.createElement(
                "span",
                { className: "text-xs text-fg-muted" },
                "None"
              )
            : null
        )
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
        value: policy.sandboxMode
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
          className:
            "text-sm font-semibold uppercase tracking-wider text-fg-muted mb-3"
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
