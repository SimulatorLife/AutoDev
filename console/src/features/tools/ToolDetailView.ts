import type {
  ToolCatalogCoverage,
  ToolCatalogItem,
  ToolCatalogValidity,
  ToolUsageEvidence
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  CALLOUT_ACCENT_CLASS,
  CALLOUT_ERROR_CLASS,
  CALLOUT_WARNING_CLASS
} from "../../components/layout/Callout.ts";
import {
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import {
  FieldBox,
  gridRowClass
} from "../../components/panels/DetailGrid.ts";
import { EmptyState } from "../../components/status/EmptyState.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { Chip } from "../../components/tables/Chips.ts";
import {
  ACTION_LINK_CLASS,
  MONO_META_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { qualifiedToolName } from "./tool-identity.ts";

/**
 * Tools catalog detail view.
 *
 * The detail page is read-only. It surfaces source authority, role exposure,
 * availability, and the canonical edit surface so the operator can pivot to
 * the authoritative edit owner without the Tools catalog ever offering a
 * mutation affordance of its own.
 *
 * Historical use/error evidence comes from the dedicated read-only Usage
 * telemetry path. The Tools catalog itself never invents counts: when the
 * Usage path is unconfigured or returns no per-tool match, the view renders
 * the value as `Not observed` rather than zero.
 */

export interface ToolDetailViewProps {
  readonly tool: ToolCatalogItem;
  readonly coverage: ToolCatalogCoverage;
  readonly validity: ToolCatalogValidity;
  readonly usage: ToolUsageEvidence;
  readonly usageLink: string;
  readonly usageUnavailable: boolean;
}

const UNCONFIGURED_LABEL = "Not configured";

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

function availabilityBadge(
  availability: ToolCatalogItem["availability"]
): React.JSX.Element {
  switch (availability) {
    case "configured": {
      return React.createElement(StatusBadge, {
        status: "configured",
        label: "Configured"
      });
    }
    case "invalid": {
      return React.createElement(StatusBadge, {
        status: "invalid" as const,
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

function EditSurfaceLink({
  tool
}: {
  readonly tool: ToolCatalogItem;
}): React.JSX.Element {
  // Every branch below is a value in the same field column, and the column's
  // value treatment is `text-sm`. The links cannot take that treatment
  // directly -- they need the accent colour -- so the size is set once here
  // rather than repeated on each link. Without it a link inherits the body's
  // 16px and renders a head taller than the `Source` and `Server` values
  // directly above it in the same box.
  const link = (href: string, text: string): React.JSX.Element =>
    React.createElement(
      "a",
      { href, className: `font-mono ${ACTION_LINK_CLASS}` },
      text
    );

  const surface = tool.canonicalEditSurface;
  // An absent surface is an absence note rather than another value, so it
  // keeps the small muted treatment instead of the column's.
  const content =
    surface === undefined || surface === null
      ? React.createElement(
          "span",
          { className: MUTED_META_CLASS },
          "No canonical edit surface"
        )
      : surface.section === "mcps" && tool.server
        ? link(
            `/mcps/${encodeURIComponent(tool.server)}`,
            surface.label ?? `MCP ${tool.server}`
          )
        : surface.section === "agents"
          ? link("/agents", surface.label ?? "Provider role exposure")
          : link("/prompts", surface.label ?? "Prompt catalog");

  return React.createElement("span", { className: "text-sm" }, content);
}

function formatCount(value: number | null): string {
  return value === null
    ? NOT_OBSERVED_LABEL
    : new Intl.NumberFormat("en-US").format(value);
}

function usageSection(
  usage: ToolUsageEvidence,
  usageLink: string,
  usageUnavailable: boolean
): React.JSX.Element {
  // All three outcomes end with the same way through to the Usage telemetry
  // surface -- that is the one thing an operator can do about all of them -- so
  // the link is built once instead of being re-spelled per branch, where three
  // copies could drift and two of them would be wrong without anything saying so.
  const openUsage = React.createElement(
    "a",
    {
      href: usageLink,
      className: `text-xs ${ACTION_LINK_CLASS}`
    },
    "Open Usage →"
  );
  if (usageUnavailable) {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(StatusBadge, {
        status: "unavailable",
        label: "Usage telemetry unavailable"
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "The dedicated read-only Usage telemetry path returned an error; per-tool use/error evidence stays unobserved."
      ),
      openUsage
    );
  }
  if (!usage.observed) {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: "No recorded tool calls"
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "No calls were observed for this tool through the dedicated read-only Usage path; the count is not rendered as zero."
      ),
      openUsage
    );
  }
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3" },
    React.createElement(
      "dl",
      { className: "flex items-center gap-3" },
      React.createElement(
        FieldBox,
        { label: "Calls (24h)" },
        formatCount(usage.calls)
      ),
      React.createElement(
        FieldBox,
        { label: "Errors (24h)" },
        usage.errors === null ? NOT_OBSERVED_LABEL : formatCount(usage.errors)
      )
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      "Errors are reported only when the canonical Usage telemetry path exposes per-tool error counts. The Tools catalog never invents a value."
    ),
    openUsage
  );
}

function coverageBanner(
  coverage: ToolCatalogCoverage,
  validity: ToolCatalogValidity
): React.JSX.Element {
  const variant =
    validity === "invalid"
      ? "error"
      : coverage === "complete"
        ? "info"
        : "warning";
  const classes =
    variant === "error"
      ? CALLOUT_ERROR_CLASS
      : variant === "warning"
        ? CALLOUT_WARNING_CLASS
        : CALLOUT_ACCENT_CLASS;
  return React.createElement(
    "p",
    {
      className: classes,
      "data-tools-coverage": coverage,
      "data-tools-validity": validity
    },
    validity === "invalid"
      ? "The canonical RuleSync MCP source is invalid; this tool entry is rendered as Invalid until the source is repaired."
      : validity === NOT_OBSERVED_STATUS
        ? "The canonical RuleSync MCP source was not observed; tool entry metadata is partial."
        : coverage === "complete"
          ? "Composite catalog entry: source authority and role exposure are both observed."
          : "Partial catalog entry: only the execution-contract role projection is observed for this tool."
  );
}

function roleExposure(tool: ToolCatalogItem): React.JSX.Element {
  if (tool.exposedRoles.length === 0) {
    return React.createElement(
      "div",
      { className: "flex items-center gap-2" },
      React.createElement(StatusBadge, {
        status: NOT_OBSERVED_STATUS,
        label: UNCONFIGURED_LABEL
      }),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS },
        "No execution-contract role projection observed this tool; availability remains unobserved."
      )
    );
  }
  return React.createElement(
    "div",
    { className: "flex flex-wrap gap-1" },
    tool.exposedRoles.map((role) =>
      // `Chip` renders an anchor when handed an `href`, so this is a linkable
      // chip rather than a Tag with a hand-assembled shape: that is what it was
      // before, and the copy carried the link treatment minus
      // `hover:underline`, so these were the only chip links on the Console that
      // did not underline on hover. The chip titles itself from its own text,
      // which covers the same truncation the old explicit `title` did.
      React.createElement(Chip, {
        key: role,
        href: `/tools?role=${encodeURIComponent(role)}`,
        children: role
      })
    )
  );
}

export function ToolDetailView({
  tool,
  coverage,
  validity,
  usage,
  usageLink,
  usageUnavailable
}: ToolDetailViewProps): React.JSX.Element {
  // The detail page is the one place the wire name is the whole subject: it is
  // the page's identity and the thing the URL addresses, so it is shown in full
  // rather than elided the way the list cell does beside its Source column.
  const canonicalName = qualifiedToolName(tool);
  return React.createElement(
    PageBody,
    {
      feature: "tools-detail",
      attributes: {
        "data-tool-name": canonicalName,
        "data-tools-coverage": coverage,
        "data-tools-validity": validity
      }
    },
    React.createElement(Breadcrumbs, {
      items: [{ href: "/tools", label: "Tools" }, { label: canonicalName }]
    }),
    React.createElement(
      "header",
      { className: "flex flex-col gap-1" },
      React.createElement(EntityTitle, { mono: true }, canonicalName),
      React.createElement(
        "p",
        { className: MONO_META_CLASS },
        `${tool.source}${tool.server ? ` · ${tool.server}` : ""} · ${sourceAuthorityLabel(
          tool.sourceAuthority
        )}`
      )
    ),
    coverageBanner(coverage, validity),
    React.createElement(
      "div",
      {
        className: gridRowClass(2),
        "data-tools-detail-panels": "true"
      },
      React.createElement(
        "section",
        { className: DETAIL_PANEL_CLASS, "data-section": "tool-source-authority" },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Source authority"
        ),
        React.createElement(
          "dl",
          { className: "flex flex-col gap-3" },
          React.createElement(FieldBox, { label: "Source" }, tool.source),
          React.createElement(
            FieldBox,
            { label: "Server" },
            tool.server ?? UNCONFIGURED_LABEL
          ),
          React.createElement(
            FieldBox,
            { label: "Authority" },
            sourceAuthorityLabel(tool.sourceAuthority)
          ),
          React.createElement(
            FieldBox,
            { label: "Availability", valueClassName: null },
            availabilityBadge(tool.availability)
          ),
          React.createElement(
            FieldBox,
            { label: "Canonical edit surface", valueClassName: null },
            React.createElement(EditSurfaceLink, { tool })
          )
        )
      ),
      React.createElement(
        "section",
        { className: DETAIL_PANEL_CLASS, "data-section": "tool-role-exposure" },
        React.createElement(
          "h3",
          { className: SECTION_HEADING_CLASS },
          "Role exposure"
        ),
        roleExposure(tool)
      )
    ),
    React.createElement(
      "section",
      { className: DETAIL_PANEL_CLASS, "data-section": "tool-description" },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Description"
      ),
      tool.description
        ? React.createElement(
            "p",
            { className: "text-sm text-fg leading-relaxed" },
            tool.description
          )
        : React.createElement(EmptyState, {
            variant: "inline",
            message:
              "No description is shipped with this tool; the canonical authority did not surface one."
          })
    ),
    React.createElement(
      "section",
      { className: DETAIL_PANEL_CLASS, "data-section": "tool-historical-use" },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Historical use"
      ),
      usageSection(usage, usageLink, usageUnavailable)
    )
  );
}
