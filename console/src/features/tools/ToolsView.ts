import type {
  ToolAvailability,
  ToolCatalogCoverage,
  ToolCatalogItem,
  ToolCatalogValidity,
  ToolSource
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import {
  CALLOUT_ACCENT_CLASS,
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { Chip, chipList } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";
import { toolId } from "./tool-identity.ts";

/**
 * Tools catalog list view.
 *
 * Tools is a composite read model that joins RuleSync MCP declarations and
 * the execution-contract role projection. It does not introduce a second
 * configuration authority; every entry keeps its canonical edit surface so
 * the operator can pivot to MCPs or Agents without the catalog ever owning
 * an edit affordance.
 *
 * The list is URL-filtered by `?source=` and `?role=`. Filters update the
 * query string only and never the server state. Source authority and
 * availability render through the StatusBadge vocabulary; missing evidence
 * stays explicit instead of becoming a default zero or ready.
 */

const SOURCE_VALUES: readonly ToolSource[] = ["native", "mcp", "plugin"];
const SOURCE_FILTERS: readonly (ToolSource | "all")[] = [
  "all",
  ...SOURCE_VALUES
];
const COLLATOR = new Intl.Collator();
const NOT_OBSERVED_STATUS = "not-observed" as const;
const NOT_OBSERVED_LABEL = "Not observed" as const;

export interface ToolsViewFilters {
  readonly source: string;
  readonly role: string;
}

export interface ToolsViewProps {
  readonly tools: readonly ToolCatalogItem[];
  readonly coverage: ToolCatalogCoverage;
  readonly validity: ToolCatalogValidity;
  readonly totalTools: number | null;
  readonly usageLink: string;
  readonly filters: ToolsViewFilters;
}

function isToolSource(value: string): value is ToolSource {
  return value === "native" || value === "mcp" || value === "plugin";
}

function availabilityBadge(availability: ToolAvailability): React.JSX.Element {
  switch (availability) {
    case "configured": {
      return React.createElement(StatusBadge, {
        status: "configured",
        label: "Configured"
      });
    }
    case "invalid": {
      return React.createElement(StatusBadge, {
        status: "invalid",
        label: "Invalid"
      });
    }
    default: {
      return React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: NOT_OBSERVED_LABEL
      });
    }
  }
}

function sourceAuthorityLabel(
  authority: ToolCatalogItem["sourceAuthority"]
): string {
  switch (authority) {
    case "rulesync-mcp": {
      return "RuleSync MCP";
    }
    case "rulesync-plugin": {
      return "RuleSync plugin";
    }
    case "execution-contract": {
      return "Execution contract";
    }
    case "codex-native": {
      return "Codex native";
    }
    default: {
      return authority;
    }
  }
}

function coverageBanner(
  coverage: ToolCatalogCoverage,
  validity: ToolCatalogValidity
): string {
  if (validity === "invalid") {
    return "The canonical RuleSync MCP source is invalid; the tool catalog is unavailable until the source is repaired.";
  }
  if (validity === NOT_OBSERVED_STATUS) {
    return "The canonical RuleSync MCP source was not observed; the tool catalog is not yet available.";
  }
  switch (coverage) {
    case "complete": {
      return "Composite catalog: RuleSync MCP declarations and the execution-contract role projection are both observed.";
    }
    case "partial": {
      return "Partial catalog: the execution-contract role projection is observed, but no RuleSync MCP declarations were available to join.";
    }
    case "unavailable": {
      return "The tool catalog is currently unavailable; no authoritative source rendered a complete entry.";
    }
    default: {
      return "The tool catalog could not be determined from any authoritative source.";
    }
  }
}

function coverageBannerVariant(
  coverage: ToolCatalogCoverage,
  validity: ToolCatalogValidity
): "info" | "warning" | "error" {
  if (validity === "invalid") return "error";
  if (coverage === "complete") return "info";
  return "warning";
}

function coverageBannerClasses(variant: "info" | "warning" | "error"): string {
  if (variant === "error") {
    return CALLOUT_ERROR_CLASS;
  }
  if (variant === "warning") {
    return CALLOUT_WARNING_CLASS;
  }
  return CALLOUT_ACCENT_CLASS;
}

function EditSurfaceLink({
  surface,
  tool
}: {
  readonly surface: NonNullable<ToolCatalogItem["canonicalEditSurface"]>;
  readonly tool: ToolCatalogItem;
}): React.JSX.Element {
  if (surface.section === "mcps" && tool.server) {
    return React.createElement(
      "a",
      {
        href: `/mcps/${encodeURIComponent(tool.server)}`,
        className: "text-accent hover:underline font-mono text-xs"
      },
      surface.label ?? `MCP ${tool.server}`
    );
  }
  if (surface.section === "agents") {
    return React.createElement(
      "a",
      {
        href: "/agents",
        className: "text-accent hover:underline font-mono text-xs"
      },
      surface.label ?? "Provider role exposure"
    );
  }
  return React.createElement(
    "a",
    {
      href: "/prompts",
      className: "text-accent hover:underline font-mono text-xs"
    },
    surface.label ?? "Prompt catalog"
  );
}

function sourceFilterHref(
  filters: ToolsViewFilters,
  source: ToolSource | "all"
): string {
  const params = new URLSearchParams();
  if (source !== "all") params.set("source", source);
  if (filters.role) params.set("role", filters.role);
  const query = params.toString();
  return query ? `/tools?${query}` : "/tools";
}

function roleFilterHref(filters: ToolsViewFilters, role: string): string {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  if (role) params.set("role", role);
  const query = params.toString();
  return query ? `/tools?${query}` : "/tools";
}

export function ToolsView({
  tools,
  coverage,
  validity,
  totalTools,
  usageLink,
  filters
}: ToolsViewProps): React.JSX.Element {
  const requestedSource = isToolSource(filters.source) ? filters.source : null;
  const requestedRole = filters.role.trim();

  const filtered = tools.filter((tool) => {
    if (requestedSource && tool.source !== requestedSource) return false;
    if (requestedRole && !tool.exposedRoles.includes(requestedRole))
      return false;
    return true;
  });

  const sourceCounts: Record<ToolSource, number> = {
    native: 0,
    mcp: 0,
    plugin: 0
  };
  const roles = new Set<string>();
  for (const tool of tools) {
    sourceCounts[tool.source] += 1;
    for (const role of tool.exposedRoles) roles.add(role);
  }
  const sortedRoles = Array.from(roles).sort(COLLATOR.compare);
  const unobservedCount = tools.filter(
    (tool) => tool.availability === NOT_OBSERVED_STATUS
  ).length;

  const variant = coverageBannerVariant(coverage, validity);

  const columns: ColumnDef<ToolCatalogItem>[] = [
    {
      id: "name",
      header: "Tool",
      align: "tokens",
      weight: 300,
      cell: (tool) =>
        React.createElement(
          "div",
          { className: "min-w-0" },
          React.createElement(
            "a",
            {
              href: `/tools/${toolId(tool)}`,
              className:
                "block truncate font-semibold text-fg font-mono hover:text-accent",
              title: toolId(tool)
            },
            tool.server ? `mcp__${tool.server}__${tool.name}` : tool.name
          ),
          tool.description
            ? React.createElement(
                "p",
                {
                  className:
                    "mt-0.5 line-clamp-2 break-words text-xs text-fg-muted"
                },
                tool.description
              )
            : null
        )
    },
    {
      id: "source",
      header: "Source",
      weight: 170,
      cell: (tool) =>
        React.createElement(
          "div",
          { className: "flex flex-col gap-1" },
          React.createElement(
            "span",
            {
              className: `text-xs px-2 py-0.5 rounded font-mono border w-fit ${
                tool.source === "mcp"
                  ? "bg-accent/15 text-accent border-accent/40"
                  : tool.source === "native"
                    ? "bg-success/15 text-success border-success/40"
                    : "bg-chart-3/15 text-chart-3 border-chart-3/40"
              }`,
              "data-source": tool.source
            },
            tool.server ? `${tool.source} (${tool.server})` : tool.source
          ),
          React.createElement(
            "span",
            { className: "text-xs text-fg-muted" },
            sourceAuthorityLabel(tool.sourceAuthority)
          )
        )
    },
    {
      id: "roles",
      header: "Exposed Roles",
      align: "tokens",
      weight: 170,
      cell: (tool) =>
        React.createElement(
          "div",
          { "data-roles-observed": String(tool.exposedRoles.length > 0) },
          chipList({
            items: tool.exposedRoles,
            emptyLabel: "No roles assigned",
            testId: "tool-roles",
            renderItem: (role) =>
              React.createElement(
                Chip,
                {
                  href: roleFilterHref(filters, role),
                  label: `Filter tools exposed to ${role}`
                },
                role
              )
          })
        )
    },
    {
      id: "edit",
      header: "Edit",
      weight: 110,
      cell: (tool) =>
        tool.canonicalEditSurface
          ? React.createElement(EditSurfaceLink, {
              surface: tool.canonicalEditSurface,
              tool
            })
          : React.createElement(
              "span",
              { className: "text-xs text-fg-muted" },
              "Not cataloged"
            )
    },
    {
      id: "availability",
      header: "Availability",
      weight: 190,
      cell: (tool) => availabilityBadge(tool.availability)
    }
  ];

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "tools",
      "data-tools-coverage": coverage,
      "data-tools-validity": validity,
      "data-tools-observed": validity === "valid" ? "true" : "false"
    },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 md:grid-cols-4 gap-4" },
      React.createElement(StatCard, {
        title: "Composite catalog",
        value:
          validity === "valid" && totalTools !== null
            ? totalTools
            : NOT_OBSERVED_LABEL
      }),
      React.createElement(StatCard, {
        title: "Native entries",
        value: validity === "valid" ? sourceCounts.native : NOT_OBSERVED_LABEL
      }),
      React.createElement(StatCard, {
        title: "MCP entries",
        value: validity === "valid" ? sourceCounts.mcp : NOT_OBSERVED_LABEL
      }),
      React.createElement(StatCard, {
        title: "Plugin entries",
        value: validity === "valid" ? sourceCounts.plugin : NOT_OBSERVED_LABEL
      })
    ),
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-4" },
      React.createElement(
        "div",
        {
          className:
            "flex items-center gap-1.5 bg-surface border border-border p-1 rounded-lg"
        },
        SOURCE_FILTERS.map((src) =>
          React.createElement(
            "a",
            {
              key: src,
              href: sourceFilterHref(filters, src),
              "data-source-filter": src,
              className: `px-3 py-1 rounded text-xs font-medium capitalize transition-colors ${
                requestedSource === src || (src === "all" && !requestedSource)
                  ? "bg-surface-raised text-accent"
                  : "text-fg-muted hover:text-fg"
              }`
            },
            src
          )
        )
      ),
      sortedRoles.length > 0
        ? React.createElement(
            "div",
            {
              className:
                "flex items-center gap-1.5 bg-surface border border-border p-1 rounded-lg"
            },
            React.createElement(
              "span",
              { className: "text-xs text-fg-muted px-2" },
              "Role:"
            ),
            React.createElement(
              "a",
              {
                href: roleFilterHref(filters, ""),
                "data-role-filter": "all",
                className: `px-3 py-1 rounded text-xs font-medium transition-colors ${
                  requestedRole
                    ? "text-fg-muted hover:text-fg"
                    : "bg-surface-raised text-accent"
                }`
              },
              "All"
            ),
            sortedRoles.map((role) =>
              React.createElement(
                "a",
                {
                  key: role,
                  href: roleFilterHref(filters, role),
                  "data-role-filter": role,
                  className: `px-3 py-1 rounded text-xs font-medium transition-colors ${
                    requestedRole === role
                      ? "bg-surface-raised text-accent"
                      : "text-fg-muted hover:text-fg"
                  }`
                },
                role
              )
            )
          )
        : null
    ),
    React.createElement(
      "p",
      { className: coverageBannerClasses(variant) },
      coverageBanner(coverage, validity)
    ),
    React.createElement(
      "div",
      { className: "flex items-center justify-between text-xs text-fg-muted" },
      React.createElement(
        "span",
        null,
        validity === "valid"
          ? `Showing ${filtered.length} of ${tools.length} tool entries${
              unobservedCount > 0
                ? ` (${unobservedCount} rendered as ${NOT_OBSERVED_LABEL})`
                : ""
            }`
          : "Catalog not observed; no tools available."
      ),
      React.createElement(
        "a",
        {
          href: usageLink,
          className: "text-accent hover:underline"
        },
        "View tool-call usage →"
      )
    ),
    DataTable({
      data: filtered,
      columns,
      keyExtractor: (tool) => toolId(tool),
      emptyMessage:
        validity === "valid"
          ? coverage === "complete"
            ? "No tool entries match the active filters."
            : "No tool entries were observed in the composite catalog."
          : "The Tools catalog source is not observed."
    })
  );
}
