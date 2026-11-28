import type { ControlApiMcpGateway } from "@simulatorlife/autodev-core";
import React from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge,
  type StatusBadgeStatus
} from "../../components/status/StatusBadge.ts";
import { chipList } from "../../components/tables/Chips.ts";
import { MUTED_BODY_CLASS } from "../../components/ui/text-classes.ts";

/**
The shared MCP gateway, as the Runtime installed and observes it.

Read-only by contract: role/tool grants are repository-owned, so this panel
shows the role contract's reviewed grants beside the effective ones and
offers no control that changes either. Gateway health is the gateway's own
verdict; the optional ChatGPT tunnel's health is reported separately.
*/
export interface McpGatewayPanelProps {
  // `null` when the MCP catalog read that carries the gateway failed.
  readonly gateway: ControlApiMcpGateway | null;
}

function gatewayStatus(gateway: ControlApiMcpGateway | null): {
  readonly status: StatusBadgeStatus;
  readonly label: string;
} {
  if (gateway === null)
    return { status: NOT_OBSERVED_STATUS, label: NOT_OBSERVED_LABEL };
  if (gateway.error !== null) return { status: "error", label: "Unreadable" };
  if (!gateway.installed)
    return { status: "unavailable", label: "Not installed" };
  return gateway.ready
    ? { status: "ready", label: "Ready" }
    : { status: "error", label: "Installed, not ready" };
}

const SERVER_COLLATOR = new Intl.Collator("en");

function grantRows(
  gateway: ControlApiMcpGateway
): readonly React.ReactElement[] {
  const servers = [
    ...new Set([
      ...Object.keys(gateway.reviewed),
      ...Object.keys(gateway.grants)
    ])
  ].sort(SERVER_COLLATOR.compare);
  return servers.map((server) => {
    const reviewedCount = gateway.reviewed[server]?.length ?? 0;
    const isNarrowed = reviewedCount > (gateway.grants[server]?.length ?? 0);
    return React.createElement(
      DetailValue,
      {
        key: server,
        label: server,
        valueClassName: null,
        dataAttributes: { "data-mcp-gateway-grant": server }
      },
      chipList({
        items: gateway.grants[server] ?? [],
        emptyLabel: "No effective grant",
        testId: "mcp-gateway-effective-grants"
      }),
      isNarrowed
        ? React.createElement(
            "p",
            { className: `mt-1 ${MUTED_BODY_CLASS}` },
            `Narrowed from ${String(reviewedCount)} reviewed`
          )
        : null
    );
  });
}

export function McpGatewayPanel({
  gateway
}: McpGatewayPanelProps): React.JSX.Element {
  const verdict = gatewayStatus(gateway);
  const grants = gateway === null ? [] : grantRows(gateway);
  return React.createElement(
    "section",
    {
      className: `${DETAIL_PANEL_CLASS} flex flex-col gap-4`,
      "aria-labelledby": "mcp-gateway-heading",
      "data-mcp-gateway-status": verdict.label
    },
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3" },
      React.createElement(
        "h2",
        { id: "mcp-gateway-heading", className: SECTION_HEADING_CLASS },
        "Shared MCP Gateway"
      ),
      React.createElement(StatusBadge, verdict)
    ),
    gateway === null
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          "Gateway status is unavailable because the MCP catalog could not be read."
        )
      : React.createElement(
          React.Fragment,
          null,
          gateway.error
            ? React.createElement(
                "p",
                { className: "text-sm text-error", role: "alert" },
                gateway.error
              )
            : null,
          React.createElement(
            DetailGrid,
            { columns: 3 },
            React.createElement(
              DetailValue,
              { label: "Service" },
              gateway.label
            ),
            React.createElement(
              DetailValue,
              { label: "Readiness" },
              gateway.readinessUrl ?? NOT_OBSERVED_LABEL
            ),
            React.createElement(
              DetailValue,
              { label: "Generation" },
              gateway.generation ?? NOT_OBSERVED_LABEL
            ),
            React.createElement(
              DetailValue,
              { label: "Primary role" },
              gateway.role || NOT_OBSERVED_LABEL
            ),
            React.createElement(
              DetailValue,
              { label: "Workspace", rowClassName: "sm:col-span-2" },
              gateway.workspace ?? NOT_OBSERVED_LABEL
            )
          ),
          React.createElement(
            "div",
            { className: "flex min-w-0 flex-col gap-2" },
            React.createElement(
              "h3",
              { className: SECTION_HEADING_CLASS },
              "Published role surfaces"
            ),
            chipList({
              items: gateway.surfaces,
              renderKey: (surface) => surface.role,
              renderItem: (surface) =>
                React.createElement(
                  "span",
                  {
                    className: "min-w-0 max-w-full break-all font-mono text-sm",
                    title: surface.url
                  },
                  `${surface.role} → ${surface.url}`
                ),
              emptyLabel: gateway.installed
                ? "No role surface published"
                : "No surface is published until the gateway is installed",
              testId: "mcp-gateway-surfaces"
            })
          ),
          React.createElement(
            "div",
            { className: "flex flex-col gap-2" },
            React.createElement(
              "h3",
              { className: SECTION_HEADING_CLASS },
              `Effective grants for ${gateway.role || "the primary role"}`
            ),
            React.createElement(
              "p",
              { className: MUTED_BODY_CLASS },
              "Read-only. Grants come from the canonical role contract and `.rulesync/permissions.jsonc`; an operator may only narrow them."
            ),
            grants.length === 0
              ? React.createElement(
                  "p",
                  { className: MUTED_BODY_CLASS },
                  "No reviewed MCP tool grants."
                )
              : React.createElement(DetailGrid, { columns: 3 }, ...grants)
          )
        )
  );
}
