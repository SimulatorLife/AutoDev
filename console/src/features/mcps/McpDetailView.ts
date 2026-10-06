import type {
  McpServerResource,
  ToolCatalogItem
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  ENTITY_EYEBROW_CLASS,
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import {
  resolveActiveTabId,
  type TabDefinition,
  TabNav
} from "../../components/tabs/Tabs.ts";

const SECTION_PANEL_CLASS =
  "rounded-lg border border-border bg-surface p-6 shadow";
const CONFIGURED_STATUS = "configured" as const;
const NOT_OBSERVED_STATUS = "not-observed" as const;
const FLEX_COLUMN_DETAILS_CLASS = "flex flex-col gap-2";
const CONFIGURATION_FIELD_CLASS =
  "rounded border border-border bg-background/40 p-3";
const CONFIGURATION_LABEL_CLASS = "text-fg-muted block mb-1";
const CONFIGURATION_VALUE_CLASS = "text-fg break-all";
const STATUS_HELP_CLASS = "text-xs text-fg-muted";

/**
 * MCP detail tabs in the target-state-mandated order. The id values are the
 * `?tab=` query values; the labels are the visible tab text.
 */
export const MCP_DETAIL_TABS: readonly TabDefinition[] = [
  { id: "overview", label: "Overview" },
  { id: "configuration", label: "Configuration" },
  { id: "connection-health", label: "Connection / Health" },
  { id: "tools", label: "Tools" },
  { id: "resources", label: "Resources" },
  { id: "prompts", label: "Prompts" },
  { id: "role-access", label: "Role Access" },
  { id: "activity", label: "Activity" },
  { id: "errors-logs", label: "Errors / Logs" }
];

const DEFAULT_MCP_DETAIL_TAB = "overview";

export interface McpDetailViewProps {
  readonly server: McpServerResource;
  readonly sourceValidity: boolean;
  /**
   * Partial projection of explicitly enumerated role MCP/plugin allowlist
   * tools joined from the Tools capability catalog. These entries describe
   * what is configured for role access -- they are NOT a live server-discovered
   * tool inventory, and they do NOT prove the remote server is connected.
   *
   * - `null`: the tools source was unavailable or unknown (Control API
   *   unreadable, coverage not `partial`). Render explicit "Unknown".
   * - `[]`: the partial projection contained no enumerated tool entries whose
   *   `server` matches this MCP. This does not prove the server has no tools;
   *   render "No allowlist entries enumerated" and keep live inventory unknown.
   * - non-empty: render the configured tool names and exposed roles.
   */
  readonly configuredTools: readonly ToolCatalogItem[] | null;
  /**
   * Raw `?tab=` query value, if any. An unknown or missing value falls back
   * to the Overview tab; this resolution happens here so the component is
   * safe to call directly with untrusted input.
   */
  readonly activeTab?: string | undefined;
}

function DesiredState({
  enabled
}: {
  readonly enabled: boolean | null;
}): React.JSX.Element {
  return React.createElement(StatusBadge, {
    status: enabled === null ? NOT_OBSERVED_STATUS : CONFIGURED_STATUS,
    label:
      enabled === null
        ? "Unknown"
        : enabled
          ? "Enabled by default"
          : "Disabled by default"
  });
}

/**
 * Renders the partial configured tool allowlist projection.
 *
 * Three explicit cases:
 * - `null` source: the Tools projection was unavailable (Control API
 *   unreachable or coverage not `partial`). Report "Unknown" and never
 *   fabricate a connected/ready state.
 * - empty list: the partial projection had no enumerated tools for this
 *   server. This does not prove the server exposes no tools, so report that
 *   no allowlist entries were enumerated while keeping live inventory unknown.
 * - populated list: render each configured tool name and its exposed
 *   roles under a "Configured tool allowlist" section so it is clearly
 *   distinct from the (unobserved) live tool inventory.
 */
function ConfiguredToolAllowlist({
  configuredTools
}: {
  readonly configuredTools: readonly ToolCatalogItem[] | null;
}): React.JSX.Element {
  if (configuredTools === null) {
    return React.createElement(
      "div",
      {
        "data-tool-allowlist-projection": "unknown",
        className: FLEX_COLUMN_DETAILS_CLASS
      },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: "Unknown"
      }),
      React.createElement(
        "p",
        { className: "text-xs text-fg-muted" },
        "The Tools capability projection was not observed; the configured tool allowlist cannot be read."
      )
    );
  }

  if (configuredTools.length === 0) {
    return React.createElement(
      "div",
      {
        "data-tool-allowlist-projection": "partial-empty",
        "data-enumerated-tool-count": "0",
        className: FLEX_COLUMN_DETAILS_CLASS
      },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: "No allowlist entries enumerated"
      }),
      React.createElement(
        "p",
        { className: "text-xs text-fg-muted" },
        "No tool entries were enumerated for this MCP in the partial Tools projection. This does not establish that the server has no tools; its live inventory remains unknown."
      )
    );
  }

  return React.createElement(
    "ul",
    {
      className: FLEX_COLUMN_DETAILS_CLASS,
      "aria-label": "Configured tool allowlist",
      "data-tool-allowlist-projection": "partial",
      "data-enumerated-tool-count": String(configuredTools.length)
    },
    ...configuredTools.map((tool) =>
      React.createElement(
        "li",
        {
          key: tool.name,
          className:
            "rounded border border-border bg-background/40 p-3 font-mono text-xs"
        },
        React.createElement(
          "div",
          { className: "flex flex-wrap items-center gap-2" },
          React.createElement(
            "span",
            { className: "font-semibold text-fg" },
            tool.name
          ),
          React.createElement(
            "span",
            {
              className: "text-[10px] uppercase tracking-wider text-fg-muted"
            },
            `source: ${tool.source}`
          )
        ),
        React.createElement(
          "div",
          { className: "mt-2 flex flex-wrap gap-1" },
          tool.exposedRoles.length === 0
            ? React.createElement(
                "span",
                {
                  className:
                    "text-[10px] uppercase tracking-wider text-fg-muted"
                },
                "No configured role exposure"
              )
            : tool.exposedRoles.map((role) =>
                React.createElement(
                  "span",
                  {
                    key: role,
                    className:
                      "text-[10px] bg-surface-raised text-fg-secondary px-1.5 py-0.5 rounded border border-border-strong"
                  },
                  role
                )
              )
        )
      )
    )
  );
}

export function McpDetailView({
  server,
  sourceValidity,
  configuredTools,
  activeTab
}: McpDetailViewProps): React.JSX.Element {
  const activeTabId = resolveActiveTabId(
    MCP_DETAIL_TABS,
    activeTab,
    DEFAULT_MCP_DETAIL_TAB
  );
  const basePath = `/mcps/${encodeURIComponent(server.name)}`;

  const targetOverrides =
    server.targetOverrides.length === 0
      ? React.createElement(
          "p",
          { className: "text-sm text-fg-muted" },
          "No explicit target overrides."
        )
      : React.createElement(
          "ul",
          {
            className: "flex flex-wrap gap-2",
            "aria-label": "Target overrides"
          },
          ...server.targetOverrides.map(
            ({ target, enabled, defaultToolsApprovalMode, enabledTools }) => {
              const details = [
                `${target}: ${enabled ? "enabled" : "disabled"}`,
                defaultToolsApprovalMode
                  ? `mode: ${defaultToolsApprovalMode}`
                  : null,
                enabledTools ? `tools: ${enabledTools.join(", ")}` : null
              ]
                .filter(Boolean)
                .join(" | ");
              return React.createElement(
                "li",
                { key: target },
                React.createElement(StatusBadge, {
                  status: CONFIGURED_STATUS,
                  label: details
                })
              );
            }
          )
        );

  const panelsByTabId: Record<string, React.JSX.Element> = {
    overview: React.createElement(
      "section",
      {
        className: "grid gap-4 md:grid-cols-3",
        "aria-label": "MCP state",
        "data-section": "mcp-overview"
      },
      React.createElement(
        "div",
        { className: "rounded-lg border border-border bg-surface p-5" },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Desired state"
        ),
        React.createElement(DesiredState, { enabled: server.enabled }),
        React.createElement(
          "p",
          { className: "mt-2 text-xs text-fg-muted" },
          `Transport: ${server.transport.toUpperCase()}`
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-border bg-surface p-5" },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Runtime connection"
        ),
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Not observed"
        }),
        React.createElement(
          "p",
          { className: "mt-2 text-xs text-fg-muted" },
          "A canonical declaration does not prove that a server is connected or healthy."
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-border bg-surface p-5" },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Source validation"
        ),
        React.createElement(StatusBadge, {
          status: sourceValidity ? "valid" : "invalid",
          label: sourceValidity
            ? "RuleSync source valid"
            : "RuleSync source invalid"
        })
      )
    ),
    configuration: React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-label": "Server configuration",
        "data-section": "mcp-configuration"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Server configuration"
      ),
      React.createElement(
        "div",
        { className: "grid gap-3 sm:grid-cols-2 text-xs font-mono" },
        React.createElement(
          "div",
          { className: CONFIGURATION_FIELD_CLASS },
          React.createElement(
            "span",
            { className: CONFIGURATION_LABEL_CLASS },
            "Transport"
          ),
          React.createElement(
            "span",
            { className: "text-fg uppercase font-semibold" },
            server.transport
          )
        ),
        server.command
          ? React.createElement(
              "div",
              {
                className: CONFIGURATION_FIELD_CLASS
              },
              React.createElement(
                "span",
                { className: CONFIGURATION_LABEL_CLASS },
                "Command"
              ),
              React.createElement(
                "span",
                { className: CONFIGURATION_VALUE_CLASS },
                server.command
              )
            )
          : null,
        server.args && server.args.length > 0
          ? React.createElement(
              "div",
              {
                className: `col-span-2 ${CONFIGURATION_FIELD_CLASS}`
              },
              React.createElement(
                "span",
                { className: CONFIGURATION_LABEL_CLASS },
                "Arguments"
              ),
              React.createElement(
                "span",
                { className: CONFIGURATION_VALUE_CLASS },
                server.args.join(" ")
              )
            )
          : null,
        server.url
          ? React.createElement(
              "div",
              {
                className: CONFIGURATION_FIELD_CLASS
              },
              React.createElement(
                "span",
                { className: CONFIGURATION_LABEL_CLASS },
                "Endpoint URL"
              ),
              React.createElement(
                "span",
                { className: CONFIGURATION_VALUE_CLASS },
                server.url
              )
            )
          : null,
        server.cwd
          ? React.createElement(
              "div",
              {
                className: CONFIGURATION_FIELD_CLASS
              },
              React.createElement(
                "span",
                { className: CONFIGURATION_LABEL_CLASS },
                "Working directory"
              ),
              React.createElement(
                "span",
                { className: CONFIGURATION_VALUE_CLASS },
                server.cwd
              )
            )
          : null,
        server.envKeys && server.envKeys.length > 0
          ? React.createElement(
              "div",
              {
                className: CONFIGURATION_FIELD_CLASS
              },
              React.createElement(
                "span",
                { className: CONFIGURATION_LABEL_CLASS },
                "Environment keys (values withheld)"
              ),
              React.createElement(
                "span",
                { className: "text-fg" },
                server.envKeys.join(", ")
              )
            )
          : null,
        server.defaultToolsApprovalMode
          ? React.createElement(
              "div",
              {
                className: CONFIGURATION_FIELD_CLASS
              },
              React.createElement(
                "span",
                { className: CONFIGURATION_LABEL_CLASS },
                "Default tools approval mode"
              ),
              React.createElement(
                "span",
                { className: "text-fg" },
                server.defaultToolsApprovalMode
              )
            )
          : null
      ),
      React.createElement(
        "div",
        { className: "mt-4" },
        React.createElement(
          "h4",
          { className: SECTION_HEADING_CLASS },
          "Target overrides"
        ),
        targetOverrides
      )
    ),
    "connection-health": React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-label": "Connection and health",
        "data-section": "mcp-connection-health"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Connection & Health"
      ),
      React.createElement(
        "div",
        { className: FLEX_COLUMN_DETAILS_CLASS },
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Probe status: Not observed"
        }),
        React.createElement(
          "p",
          { className: STATUS_HELP_CLASS },
          "Ping round trip and process health are unprobed in the static configuration. Connection requires an active runtime session."
        )
      )
    ),
    tools: React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-label": "Configured tool allowlist",
        "data-mcp-configured-tools-section": "true",
        "data-section": "mcp-tools"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Configured tool allowlist"
      ),
      React.createElement(
        "p",
        { className: "mb-3 text-xs text-fg-muted" },
        "Partial projection of explicitly enumerated role MCP/plugin allowlist tools joined from the Tools capability catalog. Does not imply the remote server is connected or that these are its full live tool inventory."
      ),
      React.createElement(ConfiguredToolAllowlist, { configuredTools })
    ),
    resources: React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-label": "MCP resources",
        "data-section": "mcp-resources"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Resources"
      ),
      React.createElement(
        "div",
        { className: FLEX_COLUMN_DETAILS_CLASS },
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Resources inventory: Not observed"
        }),
        React.createElement(
          "p",
          { className: STATUS_HELP_CLASS },
          "Live server resource schemas, URIs, and read/preview capabilities require an active MCP session connection."
        )
      )
    ),
    prompts: React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-label": "MCP prompts",
        "data-section": "mcp-prompts"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Prompts"
      ),
      React.createElement(
        "div",
        { className: FLEX_COLUMN_DETAILS_CLASS },
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Prompts inventory: Not observed"
        }),
        React.createElement(
          "p",
          { className: STATUS_HELP_CLASS },
          "Server prompt templates and arguments require an active MCP session connection."
        )
      )
    ),
    "role-access": React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-label": "Role access",
        "data-section": "mcp-role-access"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Configured role access"
      ),
      server.roles.length === 0
        ? React.createElement(
            "p",
            { className: "text-sm text-fg-muted" },
            "No roles assigned to this server."
          )
        : React.createElement(
            "ul",
            { className: "flex flex-wrap gap-2" },
            ...server.roles.map((role) =>
              React.createElement(
                "li",
                { key: role },
                React.createElement(StatusBadge, {
                  status: CONFIGURED_STATUS,
                  label: role
                })
              )
            )
          )
    ),
    activity: React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-label": "Activity and telemetry",
        "data-section": "mcp-activity"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Activity & Telemetry"
      ),
      React.createElement(
        "div",
        { className: FLEX_COLUMN_DETAILS_CLASS },
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Activity: Not observed"
        }),
        React.createElement(
          "p",
          { className: STATUS_HELP_CLASS },
          "Tools, resources, prompts, and activity round-trips are observed by the Codex-tools MCP shim span. No telemetry traces observed for this server."
        )
      )
    ),
    "errors-logs": React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-label": "Errors and logs",
        "data-section": "mcp-errors-logs"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Errors & Logs"
      ),
      React.createElement(
        "div",
        { className: FLEX_COLUMN_DETAILS_CLASS },
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Error logs: Not observed"
        }),
        React.createElement(
          "p",
          { className: STATUS_HELP_CLASS },
          "No errors observed. Failure states are reported when the MCP process exits non-zero or returns JSON-RPC protocol error envelopes."
        )
      )
    )
  };

  return React.createElement(
    "article",
    { className: "flex flex-col gap-6", "data-feature": "mcp-detail" },
    React.createElement(
      "header",
      {
        className:
          "flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-surface p-6 shadow"
      },
      React.createElement(
        "div",
        null,
        React.createElement(Breadcrumbs, {
          items: [{ label: "MCPs", href: "/mcps" }, { label: server.name }]
        }),
        React.createElement(
          "p",
          {
            className: ENTITY_EYEBROW_CLASS
          },
          "Model Context Protocol server"
        ),
        React.createElement(EntityTitle, { mono: true }, server.name),
        React.createElement(
          "p",
          { className: "mt-2 font-mono text-xs text-fg-muted" },
          ".rulesync/mcp.jsonc"
        )
      ),
      React.createElement(StatusBadge, {
        status: server.declared ? CONFIGURED_STATUS : "invalid",
        label: server.declared ? "Canonical declaration" : "Missing declaration"
      })
    ),
    React.createElement(TabNav, {
      navLabel: `${server.name} detail sections`,
      basePath,
      tabs: MCP_DETAIL_TABS,
      activeTabId
    }),
    panelsByTabId[activeTabId]
  );
}
