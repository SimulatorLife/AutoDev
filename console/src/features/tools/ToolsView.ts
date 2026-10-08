import type {
  ToolAvailability,
  ToolCatalogCoverage,
  ToolCatalogItem,
  ToolCatalogValidity,
  ToolSource
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { FilterNotice } from "../../components/filters/FilterNotice.ts";
import { resolveFilter } from "../../components/filters/resolve-filter.ts";
import {
  CALLOUT_ACCENT_CLASS,
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import { Chip, chipList } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  MONO_ID_LINK_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  ACCENT_TONE_CLASS,
  SUCCESS_TONE_CLASS
} from "../../components/ui/tones.ts";
import { qualifiedToolName, toolId } from "./tool-identity.ts";

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

export interface ToolsViewFilters {
  readonly source: string;
  readonly role: string;
}

export interface ToolsViewProps {
  readonly tools: readonly ToolCatalogItem[];
  readonly coverage: ToolCatalogCoverage;
  readonly validity: ToolCatalogValidity;
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
        status: NOT_OBSERVED_STATUS
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

/**
 * The compact accent link that names a tool's canonical edit surface.
 *
 * Mono because the label is usually an identifier -- an MCP server name, a
 * command, a prompt -- and an identifier that falls back to the body face reads
 * as a different kind of value from the tool names beside it.
 */
const EDIT_SURFACE_LINK_CLASS =
  // `block min-h-6` for WCAG 2.5.8, for the same two reasons as elsewhere: the
  // box was 14px against a 24px floor with the spacing exception unavailable,
  // and `min-height` would be inert on an inline box anyway, so the `block` is
  // part of the fix rather than cosmetic. It sits alone in its cell, so nothing
  // reflows around it.
  "block min-h-6 text-accent hover:underline font-mono text-xs";

/**
 * Where a tool's canonical source is edited, and what to call the link when the
 * catalog does not name the surface.
 *
 * The three sections differ only in these two values, so the link is one element
 * and the branch is a lookup, rather than three copies of the same anchor.
 */
function editSurfaceTarget(
  surface: NonNullable<ToolCatalogItem["canonicalEditSurface"]>
): { readonly href: string; readonly fallbackLabel: string } {
  if (surface.section === "mcps") {
    return {
      href: `/mcps/${encodeURIComponent(surface.identifier)}`,
      fallbackLabel: `MCP ${surface.identifier}`
    };
  }
  if (surface.section === "agents") {
    return { href: "/agents", fallbackLabel: "Provider role exposure" };
  }
  return { href: "/prompts", fallbackLabel: "Prompt catalog" };
}

function EditSurfaceLink({
  surface
}: {
  readonly surface: NonNullable<ToolCatalogItem["canonicalEditSurface"]>;
}): React.JSX.Element {
  const target = editSurfaceTarget(surface);
  return React.createElement(
    "a",
    { href: target.href, className: EDIT_SURFACE_LINK_CLASS },
    surface.label ?? target.fallbackLabel
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
  usageLink,
  filters
}: ToolsViewProps): React.JSX.Element {
  // A `source` outside the set is a request the page cannot honour, so it is
  // reported rather than quietly answered with the whole catalog: the "all"
  // chip used to render as selected for `?source=bogus`, which claimed the
  // reader had chosen a filter that was never applied.
  const resolvedSource = resolveFilter(filters.source, {
    name: "source",
    allowed: SOURCE_FILTERS,
    fallback: "all"
  });
  const requestedSource = isToolSource(resolvedSource.value)
    ? resolvedSource.value
    : null;
  const requestedRole = filters.role.trim();
  // `role` is free text, so every value is one this page accepts; an unmatched
  // role honestly matches nothing and says so in the table's empty message.
  const unappliedFilters =
    resolvedSource.unapplied === null ? [] : [resolvedSource.unapplied];

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
      // The cell stopped printing `mcp__<server>__` once Source took over
      // naming the server, so this column's widest content fell from 414px to
      // 238px and it had 282px of slack to give.
      weight: 270,
      cell: (tool) =>
        React.createElement(
          "div",
          { className: "min-w-0" },
          React.createElement(
            "a",
            {
              href: `/tools/${toolId(tool)}`,
              className: MONO_ID_LINK_CLASS,
              // The wire name, because that is what a row is identified by and
              // what the href addresses. The visible text is only the tool's
              // own name: the Source column directly beside it already reads
              // `mcp (codegraphcontext)`, and repeating `mcp__codegraphcontext__`
              // in the cell spent 20 of the column's 38 characters on a fact the
              // neighbour states. That left the longest name needing 413px in a
              // 317px box, cut by 96px, and the cut fell inside the one part
              // that distinguishes one row from another.
              title: qualifiedToolName(tool)
            },
            tool.name
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
      // Sized for the pill, not the header: `mcp (codegraphcontext)` measures
      // 195px with its own padding and border, and an MCP server name has no
      // length limit, so the column truncates. At 170 it granted 166px and cut
      // every one of those pills by 29px. The 30 it needs came off Tool, which
      // had it spare once the cell stopped repeating the server name.
      weight: 200,
      cell: (tool) =>
        React.createElement(
          "div",
          { className: "flex flex-col gap-1" },
          React.createElement(Tag, {
            className: `font-mono ${
              tool.source === "mcp"
                ? ACCENT_TONE_CLASS
                : tool.source === "native"
                  ? SUCCESS_TONE_CLASS
                  : "bg-chart-3/15 text-chart-3 border-chart-3/40"
            }`,
            dataAttributes: { "data-source": tool.source },
            // An MCP server name has no length limit, so below the width this
            // column is sized for the pill still truncates. `Tag` titles itself
            // from its own content, so the whole value is recoverable however
            // narrow the cell gets.
            children: tool.server
              ? `${tool.source} (${tool.server})`
              : tool.source
          }),
          React.createElement(
            "span",
            { className: MUTED_META_CLASS },
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
      // A short label with a space in it -- "Provider role exposure", "MCP
      // codegraphcontext" -- held to one line at 110 units it needed 191px for,
      // so all 25 rows were cut at every width including 1280, and a four-letter
      // header is invisible to a header-width check. Wrapping costs one extra
      // line on the widest value and shows the rest whole.
      align: "prose",
      weight: 130,
      cell: (tool) =>
        tool.canonicalEditSurface
          ? React.createElement(EditSurfaceLink, {
              surface: tool.canonicalEditSurface
            })
          : React.createElement(
              "span",
              { className: MUTED_META_CLASS },
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
    PageBody,
    {
      feature: "tools",
      attributes: {
        "data-tools-coverage": coverage,
        "data-tools-validity": validity,
        "data-tools-observed": validity === "valid" ? "true" : "false"
      }
    },
    React.createElement(
      StatGrid,
      { columns: 4 },
      React.createElement(StatCard, {
        title: "Composite catalog",
        // Counted from the entries themselves, like the three source counts
        // beside it. Reading the envelope's `totalTools` here made this row
        // contradict itself -- a composite total of 1 above native 0 + MCP 2 +
        // plugin 0 -- because one number was the Runtime's claim and the other
        // three were counted from what arrived.
        value: validity === "valid" ? tools.length : NOT_OBSERVED_LABEL
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
    React.createElement(FilterNotice, { filters: unappliedFilters }),
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
    React.createElement<DataTableProps<ToolCatalogItem>>(DataTable, {
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
