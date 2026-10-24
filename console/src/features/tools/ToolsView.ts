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
  FilterBar,
  FilterSearchField
} from "../../components/filters/FilterBar.ts";
import { FilterNotice } from "../../components/filters/FilterNotice.ts";
import {
  resolveFilter,
  type UnappliedFilter
} from "../../components/filters/resolve-filter.ts";
import {
  CALLOUT_ACCENT_CLASS,
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { Tag } from "../../components/status/Tag.ts";
import { CHIP_CLASS, chipList } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  ACTION_LINK_CLASS,
  ENTITY_LINK_CLASS,
  MONO_ID_LINK_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import {
  ACCENT_TONE_CLASS,
  SUCCESS_TONE_CLASS
} from "../../components/ui/tones.ts";
import { qualifiedToolName, toolId } from "./tool-identity.ts";
import {
  filterTools,
  isToolSource,
  toolDetailHref,
  TOOLS_LIST_PATH,
  type ToolsListFilters,
  toolsRoleHref,
  toolsSourceHref
} from "./tools-list-url.ts";

/**
 * Tools catalog list view.
 *
 * Tools is a composite read model that joins RuleSync MCP declarations and
 * the execution-contract role projection. It does not introduce a second
 * configuration authority; every entry keeps its canonical edit surface so
 * the operator can pivot to MCPs or Agents without the catalog ever owning
 * an edit affordance.
 *
 * The list is URL-filtered by `?source=`, `?role=` and `?q=`. Filters update
 * the query string only and never the server state. Source authority and
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
  /**
   * The free-text query the list is narrowed by.
   *
   * Optional, because a caller that does not narrow by text says so by leaving
   * it out rather than by passing an empty string, and the page is the only
   * caller that knows which of the two it meant.
   */
  readonly query?: string | undefined;
}

export interface ToolsViewProps {
  readonly tools: readonly ToolCatalogItem[];
  readonly coverage: ToolCatalogCoverage;
  readonly validity: ToolCatalogValidity;
  readonly usageLink: string;
  readonly filters: ToolsViewFilters;
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
  `block min-h-6 font-mono text-xs ${ACTION_LINK_CLASS}`;

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
  surface,
  toolName
}: {
  readonly surface: NonNullable<ToolCatalogItem["canonicalEditSurface"]>;
  readonly toolName: string;
}): React.JSX.Element {
  const target = editSurfaceTarget(surface);
  const label = surface.label ?? target.fallbackLabel;
  return React.createElement(
    NavigationLink,
    {
      href: target.href,
      className: EDIT_SURFACE_LINK_CLASS,
      // The name has to say which tool the link belongs to. Every tool an MCP
      // server serves repeated the same server name, so a links list showed
      // "MCP playwright" once per tool that used it.
      "aria-label": `Edit ${label} for ${toolName}`,
      title: `Edit ${label} for ${toolName}`,
      dataAttributes: { "data-edit-surface": surface.section }
    },
    label
  );
}

/**
 * What an empty tool table has to say.
 *
 * Five different facts end with an empty table: the source is not observed, a
 * filter excluded everything, the catalogue is genuinely empty, one of the two
 * sources behind the composite catalogue was not observed, and the catalogue
 * itself could not be determined. Only the caller knows which one it is
 * rendering, and the operator needs to know too -- "no tool entries match the
 * active filters" when nothing was filtered claims a filter did the emptying,
 * and there was no filter.
 */
function toolEmptyMessage(
  validity: ToolCatalogValidity,
  coverage: ToolCatalogCoverage,
  narrowed: boolean
): string {
  if (validity !== "valid") {
    return "The Tools catalog source is not observed.";
  }
  if (narrowed) {
    return "No tool entries found matching the current criteria.";
  }
  if (coverage === "complete") {
    return "No tool entries are configured.";
  }
  if (coverage === "partial") {
    return "No tool entries were observed in the composite catalog.";
  }
  return "The tool catalog could not be determined from any authoritative source.";
}

/**
 * The list's state, resolved once.
 *
 * The source is validated here rather than by the page, because a source the
 * catalogue cannot honour is a fact the catalogue has to report, and the
 * catalogue is what renders the report.
 */
interface ToolsListState {
  /** The source to apply, or `null` when every source is shown. */
  readonly source: ToolSource | null;
  readonly role: string;
  readonly query: string;
  /** The one description of the narrowing, shared by every link on the page. */
  readonly listFilters: ToolsListFilters;
  /** The filters this page was asked for and could not apply. */
  readonly unapplied: readonly UnappliedFilter[];
  /** Whether the list is narrower than the catalogue. */
  readonly narrowed: boolean;
}

function resolveToolsListState(filters: ToolsViewFilters): ToolsListState {
  const resolvedSource = resolveFilter(filters.source, {
    name: "source",
    allowed: SOURCE_FILTERS,
    fallback: "all"
  });
  const source = isToolSource(resolvedSource.value) ? resolvedSource.value : null;
  const role = filters.role.trim();
  const query = (filters.query ?? "").trim();
  return {
    source,
    role,
    query,
    listFilters: { source: source ?? "all", role, query },
    // `role` is free text, so every value is one this page accepts; an
    // unmatched role honestly matches nothing and says so in the table's
    // empty message.
    unapplied: resolvedSource.unapplied === null ? [] : [resolvedSource.unapplied],
    // A filter that is active but happens to keep every entry still counts as
    // narrowed: the operator asked a question, and the count answers it.
    narrowed: source !== null || role !== "" || query !== ""
  };
}

/**
 * What the section says about the entries it is about.
 *
 * The count itself belongs to the filter bar, which is where the narrowing
 * happened; what is left here is the fact the table cannot state by itself --
 * how many of the entries on screen are unobserved rather than measured.
 */
function availabilityNote(
  validity: ToolCatalogValidity,
  unobservedCount: number
): string | null {
  if (validity !== "valid") {
    return "Catalog not observed; no tools available.";
  }
  if (unobservedCount === 0) return null;
  return `${unobservedCount} ${
    unobservedCount === 1 ? "entry" : "entries"
  } rendered as ${NOT_OBSERVED_LABEL}`;
}

export function ToolsView({
  tools,
  coverage,
  validity,
  usageLink,
  filters
}: ToolsViewProps): React.JSX.Element {
  const state = resolveToolsListState(filters);
  const {
    source: requestedSource,
    role: requestedRole,
    query: requestedQuery,
    listFilters,
    unapplied: unappliedFilters,
    narrowed
  } = state;

  const filtered = filterTools(tools, listFilters);

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
  // Counted over the entries on screen, not over the catalogue: the note sits
  // beside the table, so it has to describe the table. It used to count the
  // whole catalogue and then sit next to a narrowed count, so the two numbers
  // on the line were about different sets.
  const unobservedCount = filtered.filter(
    (tool) => tool.availability === NOT_OBSERVED_STATUS
  ).length;
  const note = availabilityNote(validity, unobservedCount);

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
            NavigationLink,
            {
              // The list's state travels with the entry, so the detail page's
              // breadcrumb returns the operator to the list they came from
              // rather than to the whole catalogue.
              href: toolDetailHref(listFilters, toolId(tool)),
              className: MONO_ID_LINK_CLASS,
              // The wire name, because that is what a row is identified by and
              // what the href addresses. The visible text is only the tool's
              // own name: the Source column directly beside it already reads
              // `mcp (codegraphcontext)`, and repeating `mcp__codegraphcontext__`
              // in the cell spent 20 of the column's 38 characters on a fact the
              // neighbour states. That left the longest name needing 413px in a
              // 317px box, cut by 96px, and the cut fell inside the one part
              // that distinguishes one row from another.
              title: qualifiedToolName(tool),
              dataAttributes: { "data-tool-detail-link": toolId(tool) }
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
            renderItem: (role) => {
              // The name has to say which tool the chip belongs to. Every tool
              // that exposes a role repeated the same filter link, so a links
              // list showed "Filter tools exposed to smart" once per tool.
              const label = `Filter tools exposed to ${role} for ${tool.name}`;
              return React.createElement(
                NavigationLink,
                {
                  href: toolsRoleHref(listFilters, role),
                  className: `${CHIP_CLASS} min-h-6 ${ENTITY_LINK_CLASS}`,
                  "aria-label": label,
                  title: label,
                  dataAttributes: { "data-role-chip": role }
                },
                role
              );
            }
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
              surface: tool.canonicalEditSurface,
              toolName: tool.name
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
      FilterBar,
      {
        label: "Tool filters",
        action: TOOLS_LIST_PATH,
        // The form rebuilds the query string from its own controls, so the
        // facets the operator already chose have to be carried through it: a
        // search submitted from a list narrowed to one source must not widen
        // the list back to the whole catalogue behind the operator's back.
        preserved: [
          ...(requestedSource === null
            ? []
            : [{ name: "source", value: requestedSource }]),
          ...(requestedRole === ""
            ? []
            : [{ name: "role", value: requestedRole }])
        ],
        submitTestId: "tools-filter",
        // The count of what is in view belongs to the filter that narrowed it,
        // and only when something was narrowed: an unfiltered catalogue
        // reporting "56 of 56" says nothing the stat row above it does not
        // already say.
        summary: narrowed
          ? `Showing ${filtered.length} of ${tools.length} tool entries`
          : undefined,
        dataAttributes: { "data-feature-filter": "tools" }
      },
      React.createElement(FilterSearchField, {
        name: "q",
        defaultValue: requestedQuery,
        label: "Search tools",
        placeholder: "Search tools…",
        testId: "tools-search"
      })
    ),
    React.createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-4" },
      React.createElement(
        "div",
        {
          className:
            "flex flex-wrap items-center gap-1.5 bg-surface border border-border p-1 rounded-lg"
        },
        SOURCE_FILTERS.map((src) =>
          React.createElement(
            NavigationLink,
            {
              key: src,
              href: toolsSourceHref(listFilters, src),
              dataAttributes: { "data-source-filter": src },
              className: `px-3 py-1 rounded text-xs font-medium capitalize transition-colors ${
                requestedSource === src || (src === "all" && !requestedSource)
                  ? "bg-surface-raised text-accent"
                  : `${MUTED_TEXT_CLASS} hover:text-fg`
              }`,
              // The selected chip is otherwise distinguishable only by its
              // background, which is no way to read a selection aloud.
              ...(requestedSource === src || (src === "all" && !requestedSource)
                ? { "aria-current": "true" }
                : {})
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
                "flex flex-wrap items-center gap-1.5 bg-surface border border-border p-1 rounded-lg"
            },
            React.createElement(
              "span",
              { className: `px-2 ${MUTED_META_CLASS}` },
              "Role:"
            ),
            React.createElement(
              NavigationLink,
              {
                href: toolsRoleHref(listFilters, ""),
                dataAttributes: { "data-role-filter": "all" },
                className: `px-3 py-1 rounded text-xs font-medium transition-colors ${
                  requestedRole
                    ? `${MUTED_TEXT_CLASS} hover:text-fg`
                    : "bg-surface-raised text-accent"
                }`,
                // The selected chip is otherwise distinguishable only by its
                // background, which is no way to read a selection aloud.
                ...(requestedRole ? {} : { "aria-current": "true" })
              },
              "All"
            ),
            sortedRoles.map((role) =>
              React.createElement(
                NavigationLink,
                {
                  key: role,
                  href: toolsRoleHref(listFilters, role),
                  dataAttributes: { "data-role-filter": role },
                  className: `px-3 py-1 rounded text-xs font-medium transition-colors ${
                    requestedRole === role
                      ? "bg-surface-raised text-accent"
                      : `${MUTED_TEXT_CLASS} hover:text-fg`
                  }`,
                  // The selected chip is otherwise distinguishable only by its
                  // background, which is no way to read a selection aloud.
                  ...(requestedRole === role ? { "aria-current": "true" } : {})
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
      "section",
      { className: "flex flex-col gap-3" },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        // Every other catalog page names the section its table belongs to --
        // "Configured Agents", "Agent Skills", "Available Prompts & Commands",
        // "Evaluation history". This page was the only one whose table arrived
        // with no heading at all, so the operator scanning the page by its
        // outline found nothing between the page title and the table.
        "Tool catalog"
      ),
      React.createElement(
        "div",
        {
          className: `flex items-center gap-4 ${
            note === null ? "justify-end" : "justify-between"
          } ${MUTED_META_CLASS}`
        },
        note === null ? null : React.createElement("span", null, note),
        React.createElement(
          NavigationLink,
          {
            href: usageLink,
            className: ACTION_LINK_CLASS,
            dataAttributes: { "data-tools-usage-link": "true" }
          },
          "View tool-call usage →"
        )
      ),
      React.createElement<DataTableProps<ToolCatalogItem>>(DataTable, {
        data: filtered,
        columns,
        keyExtractor: (tool) => toolId(tool),
        emptyMessage: toolEmptyMessage(validity, coverage, narrowed)
      })
    )
  );
}
