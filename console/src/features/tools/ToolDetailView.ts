import type {
  ToolCatalogCoverage,
  ToolCatalogItem,
  ToolCatalogValidity,
  ToolUsageEvidence
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";

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

const SECTION_PANEL_CLASS =
  "rounded-lg border border-border bg-surface p-6 shadow";
const FIELD_LABEL_CLASS = "text-fg-muted block mb-1";
const FIELD_VALUE_CLASS = "text-fg break-all font-mono";
const NOT_OBSERVED_STATUS = "not-observed" as const;
const NOT_OBSERVED_LABEL = "Not observed" as const;
const FG_MUTED_TEXT_CLASS = "text-xs text-fg-muted";
const UNCONFIGURED_LABEL = "Not configured";

function field(
  label: string,
  value: string | React.JSX.Element
): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "rounded border border-border bg-background/40 p-3" },
    React.createElement("span", { className: FIELD_LABEL_CLASS }, label),
    typeof value === "string"
      ? React.createElement("span", { className: FIELD_VALUE_CLASS }, value)
      : value
  );
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
        status: NOT_OBSERVED_STATUS,
        label: NOT_OBSERVED_LABEL
      });
    }
  }
}

function EditSurfaceLink({
  tool
}: {
  readonly tool: ToolCatalogItem;
}): React.JSX.Element {
  const surface = tool.canonicalEditSurface;
  if (!surface) {
    return React.createElement(
      "span",
      { className: FG_MUTED_TEXT_CLASS },
      "No canonical edit surface"
    );
  }
  if (surface.section === "mcps" && tool.server) {
    return React.createElement(
      "a",
      {
        href: `/mcps/${encodeURIComponent(tool.server)}`,
        className: "text-accent hover:underline font-mono"
      },
      surface.label ?? `MCP ${tool.server}`
    );
  }
  if (surface.section === "agents") {
    return React.createElement(
      "a",
      { href: "/agents", className: "text-accent hover:underline font-mono" },
      surface.label ?? "Provider role exposure"
    );
  }
  return React.createElement(
    "a",
    { href: "/prompts", className: "text-accent hover:underline font-mono" },
    surface.label ?? "Prompt catalog"
  );
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
        { className: FG_MUTED_TEXT_CLASS },
        "The dedicated read-only Usage telemetry path returned an error; per-tool use/error evidence stays unobserved."
      ),
      React.createElement(
        "a",
        {
          href: usageLink,
          className: "text-accent hover:underline text-xs"
        },
        "Open Usage →"
      )
    );
  }
  if (!usage.observed) {
    return React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(StatusBadge, {
        status: "not-observed",
        label: "No recorded tool calls"
      }),
      React.createElement(
        "p",
        { className: FG_MUTED_TEXT_CLASS },
        "No calls were observed for this tool through the dedicated read-only Usage path; the count is not rendered as zero."
      ),
      React.createElement(
        "a",
        {
          href: usageLink,
          className: "text-accent hover:underline text-xs"
        },
        "Open Usage →"
      )
    );
  }
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3" },
    React.createElement(
      "div",
      { className: "flex items-center gap-3" },
      field("Calls (24h)", formatCount(usage.calls)),
      field(
        "Errors (24h)",
        usage.errors === null ? NOT_OBSERVED_LABEL : formatCount(usage.errors)
      )
    ),
    React.createElement(
      "p",
      { className: FG_MUTED_TEXT_CLASS },
      "Errors are reported only when the canonical Usage telemetry path exposes per-tool error counts. The Tools catalog never invents a value."
    ),
    React.createElement(
      "a",
      {
        href: usageLink,
        className: "text-accent hover:underline text-xs"
      },
      "Open Usage →"
    )
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
      ? "rounded border border-error/70 bg-error/20 p-3 text-xs text-error"
      : variant === "warning"
        ? "rounded border border-warning/70 bg-warning/20 p-3 text-xs text-warning"
        : "rounded border border-accent/40 bg-accent/10 p-3 text-xs text-accent";
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
        status: "not-observed",
        label: UNCONFIGURED_LABEL
      }),
      React.createElement(
        "p",
        { className: FG_MUTED_TEXT_CLASS },
        "No execution-contract role projection observed this tool; availability remains unobserved."
      )
    );
  }
  return React.createElement(
    "div",
    { className: "flex flex-wrap gap-1" },
    tool.exposedRoles.map((role) =>
      React.createElement(
        "a",
        {
          key: role,
          href: `/tools?role=${encodeURIComponent(role)}`,
          className:
            "text-xs bg-surface-raised text-fg-secondary px-1.5 py-0.5 rounded border border-border-strong hover:text-accent"
        },
        role
      )
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
  const canonicalName = tool.server
    ? `mcp__${tool.server}__${tool.name}`
    : tool.name;
  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-6",
      "data-feature": "tools-detail",
      "data-tool-name": canonicalName,
      "data-tools-coverage": coverage,
      "data-tools-validity": validity
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
        { className: "text-xs text-fg-muted font-mono" },
        `${tool.source}${tool.server ? ` · ${tool.server}` : ""} · ${sourceAuthorityLabel(
          tool.sourceAuthority
        )}`
      )
    ),
    coverageBanner(coverage, validity),
    React.createElement(
      "div",
      {
        className: "grid grid-cols-1 md:grid-cols-2 gap-4",
        "data-tools-detail-panels": "true"
      },
      React.createElement(
        "section",
        { className: SECTION_PANEL_CLASS },
        React.createElement(
          "h2",
          { className: SECTION_HEADING_CLASS },
          "Source authority"
        ),
        React.createElement(
          "div",
          { className: "flex flex-col gap-3" },
          field("Source", tool.source),
          tool.server
            ? field("Server", tool.server)
            : field("Server", UNCONFIGURED_LABEL),
          field("Authority", sourceAuthorityLabel(tool.sourceAuthority)),
          field("Availability", availabilityBadge(tool.availability)),
          field(
            "Canonical edit surface",
            React.createElement(EditSurfaceLink, { tool })
          )
        )
      ),
      React.createElement(
        "section",
        { className: SECTION_PANEL_CLASS },
        React.createElement(
          "h2",
          { className: SECTION_HEADING_CLASS },
          "Role exposure"
        ),
        roleExposure(tool)
      )
    ),
    React.createElement(
      "section",
      { className: SECTION_PANEL_CLASS },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Description"
      ),
      tool.description
        ? React.createElement(
            "p",
            { className: "text-sm text-fg leading-relaxed" },
            tool.description
          )
        : React.createElement(
            "p",
            { className: "text-xs text-fg-muted italic" },
            "No description is shipped with this tool; the canonical authority did not surface one."
          )
    ),
    React.createElement(
      "section",
      { className: SECTION_PANEL_CLASS },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Historical use"
      ),
      usageSection(usage, usageLink, usageUnavailable)
    )
  );
}
