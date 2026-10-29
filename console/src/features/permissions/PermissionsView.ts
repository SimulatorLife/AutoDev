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
import { PermissionPolicyForm } from "./PermissionPolicyForm.ts";

export interface PermissionsViewProps {
  /**
   * The policy the canonical source states.
   *
   * Null when the source could not be read: the page says so and leaves the
   * control disabled rather than filling the cards with a policy the operator
   * never chose.
   */
  readonly policy: PermissionPolicy | null;
  /** Whether the canonical source could be read, and whether it parsed. */
  readonly policyStatus: "valid" | "invalid" | "unavailable";
  /** Why the policy could not be read; null when it could. */
  readonly policyReason: string | null;
  /** The revision of the canonical source a write is compared against. */
  readonly revision: string | null;
  /** The policy the Runtime applied, read from the composed configuration. */
  readonly applied: PermissionPolicy | null;
  /** Where the applied policy was read from. */
  readonly appliedSource: string;
  readonly roleMatrices: readonly RoleCapabilityMatrix[];
  /**
   * Whether the execution contract was read.
   *
   * The role matrices are the contract's roles, and an unread contract falls
   * back to an empty one. The page says which of the two it is showing: an
   * empty matrix set is a different claim from a contract nobody read.
   */
  readonly executionContractObserved: boolean;
  /** Where the write answers to. */
  readonly returnTo: string;
}

/**
 * What a fact that was not observed reads as.
 *
 * One label, because a page that writes it out differently in two places is a
 * page whose two places do not agree.
 */
const NOT_OBSERVED = "Not observed";

/**
 * How a sandbox mode reads in prose, so the column is not raw config text.
 *
 * A mode that was not observed reads as not observed. The column used to
 * answer every mode but the read-only one with "Unrestricted", so a role whose
 * declaration could not be read was shown as the product's most privileged
 * sandbox -- and a drifted mode was shown the same way.
 */
function sandboxLabel(mode: RoleCapabilityMatrix["sandboxMode"]): string {
  if (mode === "read-only") return "Read-only";
  if (mode === "workspace-write") return "Workspace write";
  if (mode === "unrestricted") return "Unrestricted";
  return NOT_OBSERVED;
}

/**
 * How the applied state reads.
 *
 * The canonical source and the composed configuration are two facts, and the
 * page says which of them it is showing. A policy that was written and never
 * composed is pending: the operator's change is recorded and the product is
 * not running it yet.
 */
function appliedStateLabel(
  policy: PermissionPolicy | null,
  applied: PermissionPolicy | null
): string {
  if (policy === null) return NOT_OBSERVED;
  if (applied === null) return "Pending";
  const same =
    applied.approvalPolicy === policy.approvalPolicy &&
    applied.sandboxMode === policy.sandboxMode &&
    applied.approvalsReviewer === policy.approvalsReviewer &&
    applied.networkAccess === policy.networkAccess &&
    applied.webSearch === policy.webSearch;
  return same ? "Converged" : "Pending";
}

export function PermissionsView({
  policy,
  policyStatus,
  policyReason,
  revision,
  applied,
  appliedSource,
  roleMatrices,
  executionContractObserved,
  returnTo
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
            // The mode is the fact the column shows, so the attribute carries
            // the mode itself rather than a boolean derived from it. The
            // orchestrator is declared `danger-full-access`, and the column
            // used to report it as a workspace-write role.
            "data-permission-mode": r.sandboxMode ?? "not-observed"
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
      "section",
      {
        className: "flex flex-col gap-3",
        "aria-labelledby": "permission-policy-heading"
      },
      React.createElement(
        "h2",
        {
          id: "permission-policy-heading",
          className: SECTION_HEADING_CLASS
        },
        "Permission Policy"
      ),
      policyReason === null
        ? null
        : React.createElement(
            "p",
            {
              className: MUTED_TEXT_CLASS,
              "data-permission-policy-unavailable": policyStatus
            },
            policyReason
          ),
      React.createElement(PermissionPolicyForm, {
        policy,
        revision,
        policyStatus,
        returnTo
      }),
      React.createElement(
        StatGrid,
        { columns: 2 },
        React.createElement(StatCard, {
          title: "Applied State",
          value: appliedStateLabel(policy, applied),
          subtitle: applied === null ? NOT_OBSERVED : appliedSource
        }),
        React.createElement(StatCard, {
          title: "Canonical Source",
          value: policyStatus === "valid" ? "Readable" : NOT_OBSERVED,
          subtitle:
            revision === null
              ? NOT_OBSERVED
              : `revision ${revision.slice(0, 12)}`
        })
      )
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
        // Observed and genuinely empty: the policy's own read fails closed, so
        // reaching here with a readable policy means the contract declared no
        // role. A contract nobody read is a different claim, and the page says
        // which of the two it is showing.
        emptyMessage: executionContractObserved
          ? "No role capability matrices were observed."
          : "The execution contract was not read, so no role capability matrix is known.",
        // The heading above already names the matrix; the region says so too,
        // because the matrix is the one table on this page whose cells hold
        // nothing focusable, and a named, focusable region is the only way a
        // keyboard operator reaches its right-hand columns.
        label: "Effective role capability matrix"
      })
    ),
    // Below the matrix rather than as a fifth column: a role's tool grants run
    // to a dozen names per server, and the Console measures every table header
    // against a browser-measured minimum that cannot be produced here. The
    // question this section answers -- may this role call *this* tool -- needs
    // the vertical room anyway.
    React.createElement(RoleToolExposure, {
      roleMatrices,
      executionContractObserved
    })
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
  roleMatrices,
  executionContractObserved
}: {
  readonly roleMatrices: readonly RoleCapabilityMatrix[];
  readonly executionContractObserved: boolean;
}): React.JSX.Element {
  const granted = roleMatrices.filter(
    (role) => Object.keys(role.allowedMcpTools).length > 0
  );
  return React.createElement(
    "section",
    {
      className: "flex flex-col gap-3",
      "data-testid": "role-tool-exposure"
    },
    React.createElement(
      "h2",
      { className: SECTION_HEADING_CLASS },
      "Role Tool Exposure"
    ),
    granted.length === 0
      ? React.createElement(
          "p",
          { className: MUTED_TEXT_CLASS },
          // The grants are the execution contract's, and a contract nobody read
          // grants nothing to everybody. "No role has a grant" and "the grants
          // were not read" are different claims.
          executionContractObserved
            ? "No role has an MCP tool grant recorded in the execution contract."
            : "The execution contract was not read, so no MCP tool grants are known."
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
                      className:
                        "flex flex-wrap items-baseline gap-x-3 gap-y-1",
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
