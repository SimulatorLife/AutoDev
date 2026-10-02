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
          ...server.targetOverrides.map(({ target, enabled }) =>
            React.createElement(
              "li",
              { key: target },
              React.createElement(StatusBadge, {
                status: CONFIGURED_STATUS,
                label: `${target}: ${enabled ? "enabled" : "disabled"}`
              })
            )
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
        "aria-label": "Target configuration"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Explicit target overrides"
      ),
      targetOverrides
    ),
    React.createElement(
      "section",
      {
        className: SECTION_PANEL_CLASS,
        "aria-label": "Role access"
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
        "data-mcp-configured-tools-section": "true"
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
        "aria-label": "Inspection and activity"
      },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Tools, resources, prompts, and activity"
      ),
      React.createElement(
        "p",
        { className: "text-sm text-slate-400" },
        "Not observed. Runtime probing and MCP inspection are not yet connected to the Control API."
      )
    )
  );
}
