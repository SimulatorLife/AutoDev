import type {
  ControlApiMcpAppliedResponse,
  ControlApiMcpRuntimeResponse,
  ControlApiMcpRuntimeServer,
  McpServerResource,
  ToolCatalogItem
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  ENTITY_EYEBROW_CLASS,
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import {
  DETAIL_PANEL_CLASS,
  NESTED_PANEL_CLASS
} from "../../components/layout/Panel.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import {
  FIELD_BOX_CLASS,
  FieldBox,
  gridRowClass
} from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import { CHIP_TONE_CLASS } from "../../components/tables/Chips.ts";
import {
  resolveActiveTabId,
  type TabDefinition,
  TabNav
} from "../../components/tabs/Tabs.ts";
import {
  MONO_META_CLASS,
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { McpAppliedConfiguration } from "./applied-configuration.ts";
import { McpDeclarationEditor } from "./declaration-editor.ts";
import {
  McpConnectionBadge,
  McpObservedTools,
  McpRuntimeEvidence
} from "./runtime-evidence.ts";

const CONFIGURED_STATUS = "configured" as const;
const FLEX_COLUMN_DETAILS_CLASS = "flex flex-col gap-2";

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

/**
 * The tabs of one MCP server, named for that server.
 *
 * "Tools" and "Prompts" are also top-level page names, and the navigation
 * carries both on every page. A tab named "Tools" and the Tools catalog are
 * two different destinations under one name, so the tab says which server's
 * tools it opens. The visible label does not change, and the name still
 * contains it.
 */
export function mcpDetailTabs(serverName: string): readonly TabDefinition[] {
  return MCP_DETAIL_TABS.map((tab) =>
    tab.id === "tools" || tab.id === "prompts"
      ? { ...tab, ariaLabel: `${tab.label} for ${serverName}` }
      : tab
  );
}

const DEFAULT_MCP_DETAIL_TAB = "overview";

export interface McpDetailViewProps {
  readonly server: McpServerResource;
  /**
   * What the Runtime has observed of the MCP servers it has seen.
   *
   * `null` covers the state where the observation read could not be read at
   * all, and a read that carried no record for this server covers the state
   * where the Runtime has simply never seen it. Neither is a verdict, so
   * neither is rendered as one, and the page says which of the two it is.
   */
  readonly runtime: ControlApiMcpRuntimeResponse | null;
  /**
   * The MCP configuration the Runtime applied, against the canonical
   * declaration.
   *
   * `null` means the applied read could not be read at all, which is a
   * different state from an applied configuration that holds no servers.
   */
  readonly applied: ControlApiMcpAppliedResponse | null;
  /**
   * The revision of the canonical MCP declaration.
   *
   * A write is compared against it, so the editor has to be filled from the
   * revision it was read at. `null` means the declaration could not be read,
   * and the editor stays disabled with the reason rather than offering a write
   * that has nothing to compare.
   */
  readonly revision: string | null;
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
        ? NOT_OBSERVED_LABEL
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
 *   unreachable or coverage not `partial`). Report "Not observed" and never
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
        status: NOT_OBSERVED_STATUS
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
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
        { className: MUTED_META_CLASS },
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
          className: `${FIELD_BOX_CLASS} font-mono text-xs`
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
              className: "text-micro uppercase tracking-wider text-fg-muted"
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
                  className: "text-micro uppercase tracking-wider text-fg-muted"
                },
                "No configured role exposure"
              )
            : tool.exposedRoles.map((role) =>
                React.createElement(Tag, {
                  key: role,
                  className: CHIP_TONE_CLASS,
                  children: role
                })
              )
        )
      )
    )
  );
}

/**
 * The activity the Runtime has observed on one server.
 *
 * Every count here is the Runtime's own. A server the Runtime has not
 * observed reports no activity at all rather than reporting zeroes.
 */
function ObservedActivity({
  observation,
  observationAvailable
}: {
  readonly observation: ControlApiMcpRuntimeServer | null;
  readonly observationAvailable: boolean;
}): React.JSX.Element {
  if (!observation) {
    return React.createElement(McpRuntimeEvidence, {
      evidence: null,
      observationAvailable
    });
  }
  return React.createElement(
    "div",
    { className: FLEX_COLUMN_DETAILS_CLASS },
    React.createElement(
      "dl",
      { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
      React.createElement(
        FieldBox,
        { label: "Observed calls" },
        String(observation.toolCalls)
      ),
      React.createElement(
        FieldBox,
        { label: "Average call duration" },
        `${String(Math.round(observation.averageDurationMs))} ms`
      ),
      React.createElement(
        FieldBox,
        { label: "Roles observed" },
        observation.roles.length === 0
          ? NOT_OBSERVED_LABEL
          : observation.roles.map((role) => role.role).join(", ")
      )
    ),
    observation.roles.length === 0
      ? null
      : React.createElement(
          "dl",
          { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
          ...observation.roles.map((role) =>
            React.createElement(
              FieldBox,
              { label: role.role, valueClassName: "text-sm text-fg" },
              `${role.health}${
                role.lastSeenAt ? `, last seen ${role.lastSeenAt}` : ""
              }`
            )
          )
        )
  );
}

/**
 * The failures the Runtime has observed on one server.
 *
 * The failure count is the Runtime's own, and a server it has never observed
 * reports no failures because nothing has been observed, not because nothing
 * has failed.
 */
function ObservedFailures({
  observation,
  observationAvailable
}: {
  readonly observation: ControlApiMcpRuntimeServer | null;
  readonly observationAvailable: boolean;
}): React.JSX.Element {
  if (!observation) {
    return React.createElement(McpRuntimeEvidence, {
      evidence: null,
      observationAvailable
    });
  }
  return React.createElement(
    "div",
    { className: FLEX_COLUMN_DETAILS_CLASS },
    React.createElement(StatusBadge, {
      status: observation.failures > 0 ? "error" : "ready",
      label:
        observation.failures > 0
          ? `Failures: ${String(observation.failures)}`
          : "No failures observed"
    }),
    React.createElement(
      "dl",
      { className: "grid grid-cols-1 gap-2 sm:grid-cols-2" },
      React.createElement(
        FieldBox,
        { label: "Failed attempts" },
        String(observation.failures)
      ),
      React.createElement(
        FieldBox,
        { label: "Last status" },
        observation.lastStatus
      )
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      "Failure states are reported when the MCP process exits non-zero or returns JSON-RPC protocol error envelopes."
    )
  );
}

export function McpDetailView({
  server,
  runtime,
  applied,
  revision,
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
  // The observation is joined by name, not assumed: a server the Runtime has
  // never seen has no observation, and the page says so rather than showing an
  // empty verdict.
  const observation =
    runtime?.servers.find((entry) => entry.name === server.name) ?? null;
  const observationAvailable = runtime !== null;

  const targetOverrides =
    server.targetOverrides.length === 0
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
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
        className: gridRowClass(3, "gap-4"),
        "aria-label": "MCP state",
        "data-section": "mcp-overview"
      },
      React.createElement(
        "div",
        { className: NESTED_PANEL_CLASS },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Desired state"
        ),
        React.createElement(DesiredState, { enabled: server.enabled }),
        React.createElement(
          "p",
          { className: `mt-2 ${MUTED_META_CLASS}` },
          `Transport: ${server.transport.toUpperCase()}`
        )
      ),
      React.createElement(
        "div",
        { className: NESTED_PANEL_CLASS },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Runtime connection"
        ),
        React.createElement(McpConnectionBadge, { evidence: observation }),
        React.createElement(
          "p",
          { className: `mt-2 ${MUTED_META_CLASS}` },
          observation
            ? "The Runtime has observed this server; its own verdict and timings are on the Connection / Health tab."
            : "A canonical declaration does not prove that a server is connected or healthy."
        )
      ),
      React.createElement(
        "div",
        { className: NESTED_PANEL_CLASS },
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
        className: DETAIL_PANEL_CLASS,
        "aria-label": "Server configuration",
        "data-section": "mcp-configuration"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Server configuration"
      ),
      React.createElement(
        "dl",
        { className: gridRowClass(2, "gap-3") },
        React.createElement(
          FieldBox,
          {
            label: "Transport",
            valueClassName: "text-sm text-fg uppercase font-semibold"
          },
          server.transport
        ),
        server.command
          ? React.createElement(FieldBox, { label: "Command" }, server.command)
          : null,
        server.args && server.args.length > 0
          ? React.createElement(
              FieldBox,
              { label: "Arguments", className: "col-span-2" },
              server.args.join(" ")
            )
          : null,
        server.url
          ? React.createElement(FieldBox, { label: "Endpoint URL" }, server.url)
          : null,
        server.cwd
          ? React.createElement(
              FieldBox,
              { label: "Working directory" },
              server.cwd
            )
          : null,
        server.envKeys && server.envKeys.length > 0
          ? React.createElement(
              FieldBox,
              { label: "Environment keys (values withheld)" },
              server.envKeys.join(", ")
            )
          : null,
        server.defaultToolsApprovalMode
          ? React.createElement(
              FieldBox,
              {
                label: "Default tools approval mode",
                valueClassName: "text-sm text-fg"
              },
              server.defaultToolsApprovalMode
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
      ),
      React.createElement(
        "div",
        { className: "mt-4" },
        React.createElement(McpAppliedConfiguration, {
          applied,
          serverName: server.name
        })
      ),
      React.createElement(
        "div",
        { className: "mt-4" },
        React.createElement(McpDeclarationEditor, {
          name: server.name,
          target: applied?.target ?? "codexcli",
          revision,
          declared:
            applied?.declaredServers.find(
              (entry) => entry.name === server.name
            ) ?? null
        })
      )
    ),
    "connection-health": React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
        "aria-label": "Connection and health",
        "data-section": "mcp-connection-health"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Connection & Health"
      ),
      React.createElement(McpRuntimeEvidence, {
        evidence: observation,
        observationAvailable
      })
    ),
    tools: React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
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
        { className: `mb-3 ${MUTED_META_CLASS}` },
        "Partial projection of explicitly enumerated role MCP/plugin allowlist tools joined from the Tools capability catalog. Does not imply the remote server is connected or that these are its full live tool inventory."
      ),
      React.createElement(ConfiguredToolAllowlist, { configuredTools }),
      React.createElement(McpObservedTools, { evidence: observation })
    ),
    resources: React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
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
          { className: MUTED_META_CLASS },
          "Live server resource schemas, URIs, and read/preview capabilities require an active MCP session connection."
        )
      )
    ),
    prompts: React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
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
          { className: MUTED_META_CLASS },
          "Server prompt templates and arguments require an active MCP session connection."
        )
      )
    ),
    "role-access": React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
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
            { className: MUTED_BODY_CLASS },
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
        className: DETAIL_PANEL_CLASS,
        "aria-label": "Activity and telemetry",
        "data-section": "mcp-activity"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Activity & Telemetry"
      ),
      React.createElement(ObservedActivity, {
        observation,
        observationAvailable
      })
    ),
    "errors-logs": React.createElement(
      "section",
      {
        className: DETAIL_PANEL_CLASS,
        "aria-label": "Errors and logs",
        "data-section": "mcp-errors-logs"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Errors & Logs"
      ),
      React.createElement(ObservedFailures, {
        observation,
        observationAvailable
      })
    )
  };

  return React.createElement(
    PageBody,
    { feature: "mcp-detail", as: "article" },
    React.createElement(
      "header",
      {
        className: `flex flex-wrap items-start justify-between gap-4 ${DETAIL_PANEL_CLASS}`
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
          { className: `mt-2 ${MONO_META_CLASS}` },
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
      tabs: mcpDetailTabs(server.name),
      activeTabId
    }),
    panelsByTabId[activeTabId]
  );
}
