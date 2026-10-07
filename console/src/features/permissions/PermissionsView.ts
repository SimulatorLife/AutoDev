import type {
  PermissionPolicy,
  RoleCapabilityMatrix
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { Tag } from "../../components/status/Tag.ts";
import { CHIP_TONE_CLASS, chipList } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  MONO_ID_CLASS,
  MONO_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";

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

/**
 * How the approval policy reads in prose, for the same reason as
 * `sandboxLabel`: its neighbours in that row already render as words
 * ("Workspace write", "Allowed", "Enabled"), and one card reading
 * `on-demand` put the raw config value on the page in a display-sized type.
 *
 * Keyed by the closed union rather than switched, so a fourth member added to
 * the policy fails to compile here instead of silently rendering as itself.
 */
const APPROVAL_LABELS: Record<PermissionPolicy["approvalPolicy"], string> = {
  never: "Never",
  always: "Always",
  "on-demand": "On demand"
};

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
        React.createElement("span", { className: MONO_ID_CLASS }, r.role)
    },
    {
      id: "sandboxMode",
      header: "Sandbox Mode",
      weight: 160,
      cell: (r) =>
        React.createElement(Tag, {
          className: CHIP_TONE_CLASS,
          dataAttributes: {
            "data-permission-mode": r.readOnly ? "read-only" : "workspace-write"
          },
          children: sandboxLabel(r.sandboxMode)
        })
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
    PageBody,
    { feature: "permissions" },
    React.createElement(
      StatGrid,
      { columns: 4 },
      React.createElement(StatCard, {
        title: "Approval Policy",
        value: APPROVAL_LABELS[policy.approvalPolicy]
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
      React.createElement<DataTableProps<RoleCapabilityMatrix>>(DataTable, {
        data: roleMatrices,
        columns,
        keyExtractor: (r: RoleCapabilityMatrix) => r.role,
        // Observed and genuinely empty: the page fails closed when the policy
        // read fails, so reaching here means the Control API returned a policy
        // with no roles behind it. Wording follows the matrix it replaces
        // rather than a generic "nothing to show".
        emptyMessage: "No role capability matrices were observed."
      })
    ),
    // Below the matrix rather than as a fifth column: a role's tool grants run
    // to a dozen names per server, and the Console measures every table header
    // against a browser-measured minimum that cannot be produced here. The
    // question this section answers -- may this role call *this* tool -- needs
    // the vertical room anyway.
    React.createElement(RoleToolExposure, { roleMatrices })
  );
}

/**
 * Which tools each role may call on each server it can reach.
 *
 * The matrix above names the servers; this names the tools inside them.
 * Omitting the second half did not read as "not reported" -- it read as
 * unrestricted, because a role listed against `lsp` looked like a role that may
 * call all of it.
 *
 * A role with no grants gets an explicit line rather than a missing entry,
 * because "reaches no MCP tools" and "its grants were not reported" must not
 * look alike.
 */
function RoleToolExposure({
  roleMatrices
}: {
  readonly roleMatrices: readonly RoleCapabilityMatrix[];
}): React.JSX.Element {
  const granted = roleMatrices.filter(
    (role) => Object.keys(role.allowedMcpTools).length > 0
  );
  return React.createElement(
    "section",
    { className: "mt-6 flex flex-col gap-3", "data-testid": "role-tool-exposure" },
    React.createElement("h2", { className: SECTION_HEADING_CLASS }, "Role Tool Exposure"),
    granted.length === 0
      ? React.createElement(
          "p",
          { className: MUTED_TEXT_CLASS },
          "No role has an MCP tool grant recorded in the execution contract."
        )
      : React.createElement(
          "ul",
          { className: "flex flex-col gap-3" },
          granted.map((role) =>
            React.createElement(
              "li",
              {
                key: role.role,
                className: "flex flex-col gap-2",
                "data-tool-role": role.role
              },
              React.createElement(
                "span",
                { className: MONO_ID_CLASS },
                role.role
              ),
              React.createElement(
                "div",
                { className: "flex flex-col gap-1.5" },
                Object.entries(role.allowedMcpTools).map(([server, names]) =>
                  React.createElement(
                    "div",
                    {
                      key: server,
                      className: "flex flex-wrap items-baseline gap-x-3 gap-y-1",
                      "data-tool-server": server
                    },
                    React.createElement(
                      "span",
                      { className: MONO_META_CLASS },
                      server
                    ),
                    chipList({
                      items: names,
                      // Empty is a real grant state: the contract named this
                      // server for the role with no tools on it.
                      emptyLabel: "No tools on this server",
                      testId: "role-mcp-tools",
                      className: "font-mono text-accent"
                    })
                  )
                )
              )
            )
          )
        )
  );
}
