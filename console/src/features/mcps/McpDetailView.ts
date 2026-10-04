import type {
  McpServerResource,
  ToolCatalogItem
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatusBadge } from "../../components/status/StatusBadge.ts";

const SECTION_HEADING_CLASS =
  "mb-3 text-xs uppercase tracking-wider text-slate-400";
const SECTION_PANEL_CLASS =
  "rounded-lg border border-slate-800 bg-slate-900 p-6 shadow";
const CONFIGURED_STATUS = "configured" as const;
const NOT_OBSERVED_STATUS = "not-observed" as const;

export interface McpDetailViewProps {
  readonly server: McpServerResource;
  readonly sourceValidity: boolean;
  /**
   * Partial projection of explicitly enumerated role MCP/plugin allowlist
   * tools joined from the Tools capability catalog. These entries describe
   * what is configured to be exposed -- they are NOT a live server-discovered
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
        className: "flex flex-col gap-2"
      },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: "Unknown"
      }),
      React.createElement(
        "p",
        { className: "text-xs text-slate-500" },
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
        className: "flex flex-col gap-2"
      },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: "No allowlist entries enumerated"
      }),
      React.createElement(
        "p",
        { className: "text-xs text-slate-500" },
        "No tool entries were enumerated for this MCP in the partial Tools projection. This does not establish that the server has no tools; its live inventory remains unknown."
      )
    );
  }

  return React.createElement(
    "ul",
    {
      className: "flex flex-col gap-2",
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
            "rounded border border-slate-800 bg-slate-950/40 p-3 font-mono text-xs"
        },
        React.createElement(
          "div",
          { className: "flex flex-wrap items-center gap-2" },
          React.createElement(
            "span",
            { className: "font-semibold text-slate-100" },
            tool.name
          ),
          React.createElement(
            "span",
            {
              className: "text-[10px] uppercase tracking-wider text-slate-500"
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
                    "text-[10px] uppercase tracking-wider text-slate-500"
                },
                "No configured role exposure"
              )
            : tool.exposedRoles.map((role) =>
                React.createElement(
                  "span",
                  {
                    key: role,
                    className:
                      "text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded border border-slate-700"
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
  configuredTools
}: McpDetailViewProps): React.JSX.Element {
  const targetOverrides =
    server.targetOverrides.length === 0
      ? React.createElement(
          "p",
          { className: "text-sm text-slate-400" },
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

  return React.createElement(
    "article",
    { className: "flex flex-col gap-6", "data-feature": "mcp-detail" },
    React.createElement(
      "header",
      {
        className:
          "flex flex-wrap items-start justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900 p-6 shadow"
      },
      React.createElement(
        "div",
        null,
        React.createElement(
          "a",
          {
            href: "/mcps",
            className: "text-xs text-emerald-300 hover:underline"
          },
          "← MCP servers"
        ),
        React.createElement(
          "p",
          {
            className:
              "mb-1 mt-3 text-xs uppercase tracking-wider text-slate-400"
          },
          "Model Context Protocol server"
        ),
        React.createElement(
          "h2",
          { className: "text-2xl font-bold text-slate-100 font-mono" },
          server.name
        ),
        React.createElement(
          "p",
          { className: "mt-2 font-mono text-xs text-slate-400" },
          ".rulesync/mcp.jsonc"
        )
      ),
      React.createElement(StatusBadge, {
        status: server.declared ? CONFIGURED_STATUS : "invalid",
        label: server.declared ? "Canonical declaration" : "Missing declaration"
      })
    ),
    React.createElement(
      "section",
      {
        className: "grid gap-4 md:grid-cols-3",
        "aria-label": "MCP state"
      },
      React.createElement(
        "div",
        { className: "rounded-lg border border-slate-800 bg-slate-900 p-5" },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Desired state"
        ),
        React.createElement(DesiredState, { enabled: server.enabled }),
        React.createElement(
          "p",
          { className: "mt-2 text-xs text-slate-500" },
          `Transport: ${server.transport.toUpperCase()}`
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-slate-800 bg-slate-900 p-5" },
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
          { className: "mt-2 text-xs text-slate-500" },
          "A canonical declaration does not prove that a server is connected or healthy."
        )
      ),
      React.createElement(
        "div",
        { className: "rounded-lg border border-slate-800 bg-slate-900 p-5" },
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
    React.createElement(
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
          { className: "rounded border border-slate-800 bg-slate-950/40 p-3" },
          React.createElement(
            "span",
            { className: "text-slate-400 block mb-1" },
            "Transport"
          ),
          React.createElement(
            "span",
            { className: "text-slate-200 uppercase font-semibold" },
            server.transport
          )
        ),
        server.command
          ? React.createElement(
              "div",
              {
                className: "rounded border border-slate-800 bg-slate-950/40 p-3"
              },
              React.createElement(
                "span",
                { className: "text-slate-400 block mb-1" },
                "Command"
              ),
              React.createElement(
                "span",
                { className: "text-slate-200 break-all" },
                server.command
              )
            )
          : null,
        server.args && server.args.length > 0
          ? React.createElement(
              "div",
              {
                className:
                  "col-span-2 rounded border border-slate-800 bg-slate-950/40 p-3"
              },
              React.createElement(
                "span",
                { className: "text-slate-400 block mb-1" },
                "Arguments"
              ),
              React.createElement(
                "span",
                { className: "text-slate-200 break-all" },
                server.args.join(" ")
              )
            )
          : null,
        server.url
          ? React.createElement(
              "div",
              {
                className: "rounded border border-slate-800 bg-slate-950/40 p-3"
              },
              React.createElement(
                "span",
                { className: "text-slate-400 block mb-1" },
                "Endpoint URL"
              ),
              React.createElement(
                "span",
                { className: "text-slate-200 break-all" },
                server.url
              )
            )
          : null,
        server.cwd
          ? React.createElement(
              "div",
              {
                className: "rounded border border-slate-800 bg-slate-950/40 p-3"
              },
              React.createElement(
                "span",
                { className: "text-slate-400 block mb-1" },
                "Working directory"
              ),
              React.createElement(
                "span",
                { className: "text-slate-200 break-all" },
                server.cwd
              )
            )
          : null,
        server.envKeys && server.envKeys.length > 0
          ? React.createElement(
              "div",
              {
                className: "rounded border border-slate-800 bg-slate-950/40 p-3"
              },
              React.createElement(
                "span",
                { className: "text-slate-400 block mb-1" },
                "Environment keys (values withheld)"
              ),
              React.createElement(
                "span",
                { className: "text-slate-200" },
                server.envKeys.join(", ")
              )
            )
          : null,
        server.defaultToolsApprovalMode
          ? React.createElement(
              "div",
              {
                className: "rounded border border-slate-800 bg-slate-950/40 p-3"
              },
              React.createElement(
                "span",
                { className: "text-slate-400 block mb-1" },
                "Default tools approval mode"
              ),
              React.createElement(
                "span",
                { className: "text-slate-200" },
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
          { className: "mb-2 text-xs font-semibold text-slate-400" },
          "Target overrides"
        ),
        targetOverrides
      )
    ),
    React.createElement(
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
        { className: "flex flex-col gap-2" },
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Probe status: Not observed"
        }),
        React.createElement(
          "p",
          { className: "text-xs text-slate-400" },
          "Ping round trip and process health are unprobed in the static configuration. Connection requires an active runtime session."
        )
      )
    ),
    React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-label": "Role access",
        "data-section": "mcp-role-access"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Role access"
      ),
      server.roles.length === 0
        ? React.createElement(
            "p",
            { className: "text-sm text-slate-400" },
            "No role exposure is present in the current runtime projection."
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
    React.createElement(
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
        { className: "mb-3 text-xs text-slate-500" },
        "Partial projection of explicitly enumerated role MCP/plugin allowlist tools joined from the Tools capability catalog. Does not imply the remote server is connected or that these are its full live tool inventory."
      ),
      React.createElement(ConfiguredToolAllowlist, { configuredTools })
    ),
    React.createElement(
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
        { className: "flex flex-col gap-2" },
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Resources inventory: Not observed"
        }),
        React.createElement(
          "p",
          { className: "text-xs text-slate-400" },
          "Live server resource schemas, URIs, and read/preview capabilities require an active MCP session connection."
        )
      )
    ),
    React.createElement(
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
        { className: "flex flex-col gap-2" },
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Prompts inventory: Not observed"
        }),
        React.createElement(
          "p",
          { className: "text-xs text-slate-400" },
          "Server prompt templates and arguments require an active MCP session connection."
        )
      )
    ),
    React.createElement(
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
        { className: "flex flex-col gap-2" },
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Activity: Not observed"
        }),
        React.createElement(
          "p",
          { className: "text-xs text-slate-400" },
          "Tools, resources, prompts, and activity round-trips are observed by the Codex-tools MCP shim span. No telemetry traces observed for this server."
        )
      )
    ),
    React.createElement(
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
        { className: "flex flex-col gap-2" },
        React.createElement(StatusBadge, {
          status: NOT_OBSERVED_STATUS,
          label: "Error logs: Not observed"
        }),
        React.createElement(
          "p",
          { className: "text-xs text-slate-400" },
          "No errors observed. Failure states are reported when the MCP process exits non-zero or returns JSON-RPC protocol error envelopes."
        )
      )
    )
  );
}
