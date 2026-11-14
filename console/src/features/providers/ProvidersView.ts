import {
  ANTIGRAVITY_PROVIDERS,
  type ControlApiLiveAgentCounts,
  type ControlApiModelsResponse,
  type ControlApiProviderRecord,
  type ControlApiProvidersResponse,
  type ControlApiRuntimeResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import {
  PAGE_SECTION_STACK_CLASS,
  PageBody
} from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { LiveCountRefresh } from "../../components/navigation/LiveCountRefresh.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import {
  ControlFailureNotice,
  type ControlFailureNoticeProps
} from "../../components/status/ControlFailureNotice.ts";
import {
  countValue,
  scopedCount
} from "../../components/status/observed-count.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { Chip, chipList } from "../../components/tables/Chips.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  resolveActiveTabId,
  type TabDefinition,
  TabNav
} from "../../components/tabs/Tabs.ts";
import { instantLabel } from "../../components/ui/instant.ts";
import {
  ENTITY_LINK_CLASS,
  MONO_ID_CLASS,
  MONO_ID_LINK_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { liveAgentCount, liveAgentRoleBreakdown } from "../live-agent-count.ts";
import { ModelToggle } from "./ModelToggle.ts";
import {
  modelPath,
  providerPath,
  PROVIDERS_PATH,
  providersPath
} from "./paths.ts";
import {
  CLI_VERSIONS_NOT_OBSERVED,
  type ProviderCliVersionState,
  providerCliVersionView
} from "./provider-cli-version.ts";
import {
  providerDiscoverySummaries,
  type ProviderModelDiscoveryState,
  providerModelDiscoveryView,
  type ProviderModelRow,
  providerModelRows,
  type UnsupportedProviderModel,
  unsupportedProviderModels
} from "./provider-model-discovery.ts";
import {
  ProviderStatusBadge,
  resolveProviderStatus
} from "./provider-status.ts";
import { ProviderCliVersionText } from "./ProviderCliVersion.ts";
import { ProviderExternalLinks } from "./ProviderExternalLinks.ts";
import { ProviderLimitsControls } from "./ProviderLimitsControls.ts";
import {
  ProviderModelAvailabilityBadge,
  ProviderModelDiscoveryBadge
} from "./ProviderModelAvailabilityBadge.ts";
import { ProviderResetDialog } from "./ProviderResetDialog.ts";
import { ProviderRoleControls } from "./ProviderRoleControls.ts";

export function ProvidersHeaderActions({
  returnTo
}: {
  readonly returnTo: string;
}): React.JSX.Element {
  return React.createElement(
    "div",
    {
      role: "group",
      "aria-label": "Provider configuration actions",
      className: "flex min-w-0 flex-wrap items-start justify-end gap-3"
    },
    React.createElement(ProviderResetDialog, { returnTo })
  );
}

export const PROVIDERS_VIEW_TABS: readonly TabDefinition[] = [
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" }
];

/** The Models data the view renders, or why it is missing. */
export type ProvidersModelsState =
  | { readonly status: "available"; readonly data: ControlApiModelsResponse }
  | { readonly status: "unavailable"; readonly message: string };

export interface ProvidersViewProps {
  readonly providers: ControlApiProvidersResponse;
  readonly models: ProvidersModelsState;
  readonly modelDiscovery: ProviderModelDiscoveryState;
  /**
   * The versions of the CLIs the Runtime found on this machine.
   *
   * Optional because a caller without them is a caller that has not read
   * them: the rows then say the version was not observed, which is the
   * truth, rather than inventing a version for the provider.
   */
  readonly cliVersions?: ProviderCliVersionState | undefined;
  readonly runtime?: ControlApiRuntimeResponse | undefined;
  /** Raw `?tab=` value; unknown values fall back to the Providers tab. */
  readonly activeTab?: string | undefined;
  readonly controlFailed?: boolean | undefined;
  readonly controlRefusal?: ControlFailureNoticeProps["refusal"];
}

/**
 * The provider id as the providers table's row identifier.
 *
 * It wraps at its hyphens instead of truncating. The Antigravity providers
 * share the 11-character `antigravity-` prefix, so a truncated id reads
 * `antigravit…` on all three rows and the row names nothing; wrapped,
 * `antigravity-claude-gpt` keeps the column's width and names its row.
 */
const WRAPPING_PROVIDER_ID_LINK_CLASS = `${MONO_ID_CLASS} block min-h-6 ${ENTITY_LINK_CLASS}`;

function ProviderLink({
  provider,
  context,
  wrap = false
}: {
  readonly provider: string;
  /** Wrap the id at its hyphens rather than truncating it. */
  readonly wrap?: boolean;
  /**
   * What distinguishes this link from another link to the same provider.
   *
   * A provider appears on this page more than once: once in the providers
   * table, and once for every capability tier it holds a routing slot in. The
   * visible text is the provider's name in every one of those places, so the
   * accessible name has to carry the slot -- otherwise a links list, which is
   * how a screen reader user scans the page, showed "Open provider claude"
   * three times with nothing to tell the entries apart.
   */
  readonly context?: string | undefined;
}): React.JSX.Element {
  return React.createElement(
    NavigationLink,
    {
      href: providerPath(provider),
      className: wrap ? WRAPPING_PROVIDER_ID_LINK_CLASS : MONO_ID_LINK_CLASS,
      title: provider,
      "aria-label":
        context === undefined
          ? `Open provider ${provider}`
          : `Open provider ${provider}, ${context}`
    },
    provider
  );
}

/**
 * The Providers configuration columns, including live provider counts.
 *
 * Role Enablement, Health, Credential, Available Models and Tier Priority are
 * gone: their facts are either folded into the single Status verdict or
 * reachable from the row's own controls. The column order is the contract's,
 * not a layout preference.
 */
function providerColumns(
  returnTo: string,
  liveAgents: ControlApiLiveAgentCounts | null | undefined,
  modelDiscovery: ProviderModelDiscoveryState,
  cliVersions: ProviderCliVersionState,
  quota: ReadonlyMap<string, readonly ProviderQuotaWindowBar[]>
): ColumnDef<ControlApiProviderRecord>[] {
  return [
    {
      id: "provider",
      header: "Provider",
      // The provider id is the row's primary identifier. Its full declared
      // share is preserved by DataTable; narrow viewports scroll the table.
      //
      // The provider id and its two external links stack in this cell, and the
      // widest of them measures 98px, so 130 is that with the cell's own 32px
      // of padding.
      // 132 is the widest line in the cell -- the provider's own id and its
      // two links -- with the cell's own 32px of inset.
      weight: 132,
      align: "tokens",
      cell: (provider) =>
        React.createElement(
          "div",
          { className: "flex flex-col gap-1" },
          React.createElement(ProviderLink, {
            provider: provider.id,
            wrap: true
          }),
          // The CLI version rides under the provider's name: it is the
          // provider's own fact, it is small, and the eye asking "which
          // version is this provider on" is already looking there.
          React.createElement(ProviderCliVersionText, {
            view: providerCliVersionView(cliVersions, provider.id)
          }),
          React.createElement(ProviderExternalLinks, {
            provider: provider.id,
            links: provider.links
          }),
          // Usage is the provider's own fact, shown display-only beneath it.
          React.createElement(ProviderQuotaCell, {
            providerId: provider.id,
            windows: quota.get(provider.id) ?? []
          })
        )
    },
    {
      id: "status",
      header: "Status",
      // Sized against the verdict the column has to show in full, and against
      // the re-check control that rides inside the badge.
      //
      // Measured at 1440 with the control on every row: "Not observed" is
      // 130px as a badge, which with the cell's own 32px of inset is 162, and
      // 168 holds it. "Ready" (88px) and "Disabled" (102px) fit inside it as
      // well.
      //
      // A longer verdict does not fit, and did not fit before the control was
      // on every row either: "Unavailable (probe_unavailable)" measures 237px
      // with the control and 219px without it. A column sized for it bought
      // nothing and took 50px from the five columns that have to be read, so
      // the badge ellipsizes instead and keeps the whole verdict on its hover
      // title. The control is `shrink-0`, so it stays whole and visible at the
      // badge's right-hand end however far the word is cut.
      weight: 168,
      cell: (provider) =>
        React.createElement(ProviderStatusBadge, {
          provider,
          returnTo: providersPath()
        })
    },
    {
      id: "activeAgents",
      header: "Active Agents",
      // The header needs 106px on one line, and the cell adds 32px of shared
      // inset, so 138px is the floor. At 118 the header wrapped to two lines,
      // which made this table's header row 15px taller than every other table
      // in the Console -- the one header whose own width was too small for its
      // own name, which the shared table contract forbids. The margin over
      // the floor matches the other columns', so a system font with different
      // metrics does not put the header back on two lines.
      weight: 139,
      cellTitle: (provider) =>
        liveAgentRoleBreakdown(liveAgents, "byProviderRole", provider.id),
      cell: (provider) =>
        React.createElement(
          "span",
          {
            className: "text-xs text-fg-secondary tabular-nums",
            "data-live-agent-provider": provider.id
          },
          liveAgentCount(liveAgents, "byProvider", provider.id)
        )
    },
    {
      id: "roles",
      header: "Roles",
      // The label alone does not say what the controls per role mean, and a
      // `Disabled` priority that dims its selectors is not self-evident
      // from the row. The contract asks for a help affordance on this header.
      headerHelp:
        "Each fixed role takes a priority (P1, P2, P3 or Disabled), a model, and optional reasoning effort. Changing any selection submits the complete role assignment immediately; refreshed values are Runtime-confirmed. Disabled dims selectors but keeps chosen values.",
      // The label and three selects use a 496px aligned grid; the table cell adds
      // 32px of shared inset. The 528px budget keeps fields aligned.
      //
      // This is the one column that cannot be narrowed: the four roles share
      // one aligned grid, so the width is the width of the configuration and
      // not a share of the table.
      weight: 528,
      align: "tokens",
      cell: (provider) =>
        React.createElement(ProviderRoleControls, {
          provider,
          subagentLayout: "hierarchical",
          modelDiscovery,
          returnTo
        })
    },
    {
      id: "agentLimits",
      header: "Agent Limits",
      headerHelp:
        "Provider-wide concurrent-agent limits. Unlimited has no ceiling; disabling the provider turns it off entirely while preserving its priorities, models and limits.",
      // Both stepper labels sit above their button groups, so the 184px budget
      // leaves room for controls and lets the optional disabled caption wrap.
      //
      // 151 holds the widest of the two groups -- the button row measures 101px
      // -- and the header, whose label and help marker together need 149px.
      weight: 151,
      align: "tokens",
      cell: (provider) =>
        React.createElement(ProviderLimitsControls, { provider, returnTo })
    }
  ];
}

/**
 * The Models tab's columns. This tab keeps its own model catalog, per-tier
 * mapping, and enable/disable control: the Providers table folded those facts
 * into Status and the row's own controls, but a model is still an item with its
 * own lifecycle, so it keeps a list of its own.
 */
function modelColumns(
  returnTo: string,
  liveAgents: ControlApiLiveAgentCounts | null | undefined
): ColumnDef<ProviderModelRow>[] {
  return [
    {
      id: "model",
      header: "Model",
      weight: 288,
      cell: (model) => {
        return React.createElement(
          "div",
          { className: "flex flex-col gap-0.5" },
          model.enablement === null
            ? React.createElement(
                "span",
                {
                  className: "w-fit font-mono text-fg",
                  "data-model-id": model.id,
                  title: model.id
                },
                model.id
              )
            : React.createElement(
                Chip,
                {
                  href: modelPath(model.provider, model.id),
                  label: `Open model ${model.id}`,
                  className: "w-fit font-mono text-fg"
                },
                model.id
              ),
          model.displayName === null
            ? null
            : React.createElement(
                "span",
                { className: MUTED_META_CLASS },
                model.displayName
              )
        );
      }
    },
    {
      id: "provider",
      header: "Provider",
      cell: (model) =>
        React.createElement(ProviderLink, { provider: model.provider })
    },
    {
      id: "activeAgents",
      header: "Active Agents",
      weight: 112,
      cellTitle: (model) =>
        liveAgentRoleBreakdown(
          liveAgents,
          "byModelRole",
          `${model.provider}/${model.id}`
        ),
      cell: (model) =>
        React.createElement(
          "span",
          {
            className: "text-xs text-fg-secondary tabular-nums",
            "data-live-agent-model": model.id
          },
          liveAgentCount(liveAgents, "byModel", `${model.provider}/${model.id}`)
        )
    },
    {
      id: "tiers",
      header: "Tiers",
      align: "tokens",
      cell: (model) =>
        chipList({
          items: model.tiers,
          emptyLabel: "Not mapped to a tier",
          testId: "model-tiers",
          renderItem: (tier) =>
            React.createElement(Chip, { className: "font-mono" }, tier)
        })
    },
    {
      id: "availability",
      header: "Availability",
      // "Availability" is one long word, and a column's weight has to be
      // large enough for its own header. The workspaces table declares the
      // same header at the same weight, and the acceptance measures it
      // fitting at 390px there.
      weight: 160,
      cell: (model) =>
        React.createElement(ProviderModelAvailabilityBadge, {
          availability: model.availability
        })
    },
    {
      id: "enabled",
      header: "Enabled",
      cell: (model) =>
        React.createElement(ModelToggle, {
          model: model.id,
          enablement: model.enablement ?? undefined,
          returnTo
        })
    }
  ];
}

function RoutingPriorityPanel({
  providers
}: {
  readonly providers: ControlApiProvidersResponse;
}): React.JSX.Element {
  return React.createElement(
    "section",
    { className: LIST_PANEL_CLASS, "data-section": "routing-priority" },
    React.createElement(
      "div",
      { className: "mb-3" },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Routing priority"
      ),
      React.createElement(
        "p",
        { className: `mt-1 ${MUTED_META_CLASS}` },
        "Ordered fallback groups per capability tier from the routing configuration. Providers in one group share load; later groups serve only when earlier ones cannot."
      )
    ),
    React.createElement(
      "dl",
      { className: "flex flex-col gap-2" },
      ...providers.tiers.map(({ tier, groups }) =>
        React.createElement(
          "div",
          {
            key: tier,
            className: "flex flex-wrap items-baseline gap-x-3 gap-y-1",
            "data-tier": tier
          },
          React.createElement(
            "dt",
            { className: "w-32 font-mono text-xs text-fg" },
            tier === providers.orchestratorTier ? `${tier} (root)` : tier
          ),
          React.createElement(
            "dd",
            { className: "flex flex-wrap items-center gap-2 text-xs" },
            ...groups.flatMap((group, index) => [
              index === 0
                ? null
                : React.createElement(
                    "span",
                    {
                      key: `arrow-${index}`,
                      "aria-hidden": "true",
                      className: MUTED_TEXT_CLASS
                    },
                    "→"
                  ),
              React.createElement(
                "span",
                {
                  key: `group-${index}`,
                  className:
                    "inline-flex flex-wrap items-center gap-1 rounded border border-border px-2 py-0.5"
                },
                React.createElement(
                  "span",
                  { className: MUTED_TEXT_CLASS },
                  `P${index + 1}`
                ),
                ...group.map((provider) =>
                  React.createElement(ProviderLink, {
                    key: provider,
                    provider,
                    context: `${tier} tier, priority ${index + 1}`
                  })
                )
              )
            ])
          )
        )
      )
    )
  );
}

type QuotaAxiSnapshot = NonNullable<ControlApiProvidersResponse["quotaAxi"]>;
type QuotaAxiProvider = QuotaAxiSnapshot["providers"][number];
type QuotaAxiWindow = QuotaAxiProvider["windows"][number];

interface ProviderQuotaWindowBar {
  readonly key: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly resetText: string | null;
  readonly resetTitle: string | null;
}

/** Clamps a reported percentage into 0-100 for bar geometry and ARIA only. */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function resolveQuotaWindowPercents(window: QuotaAxiWindow): {
  readonly remainingPercent: number;
  readonly usedPercent: number;
} | null {
  const rawRemaining =
    typeof window.percentRemaining === "number" &&
    Number.isFinite(window.percentRemaining)
      ? clampPercent(window.percentRemaining)
      : undefined;
  const rawUsed =
    typeof window.percentUsed === "number" &&
    Number.isFinite(window.percentUsed)
      ? clampPercent(window.percentUsed)
      : undefined;
  if (rawRemaining === undefined && rawUsed === undefined) return null;
  const remainingPercent = rawRemaining ?? clampPercent(100 - rawUsed!);
  const usedPercent = rawUsed ?? clampPercent(100 - remainingPercent);
  return { remainingPercent, usedPercent };
}

function isModelWindow(window: QuotaAxiWindow): boolean {
  const kind: string = (window.kind ?? "").trim().toLowerCase();
  const id = (window.id ?? "").trim().toLowerCase();
  return kind === "model" || id.startsWith("model:");
}

function agyWindowMatchesProvider(
  window: QuotaAxiWindow,
  providerId: string
): boolean {
  const id = (window.id ?? "").trim().toLowerCase();
  if (id.startsWith("gemini_argon") || id.includes("argon")) {
    return providerId === "antigravity-argon";
  }
  if (id.startsWith("gemini_") || id.startsWith("model:gemini")) {
    return providerId === "antigravity-gemini";
  }
  if (
    id.startsWith("claude_gpt") ||
    id.startsWith("claude") ||
    id.startsWith("gpt") ||
    id.startsWith("model:claude") ||
    id.startsWith("model:gpt")
  ) {
    return providerId === "antigravity-claude-gpt";
  }
  return true;
}

const GEMINI_ARGON_PREFIX_RE = /^gemini\s+argon\s+/iu;
const GEMINI_PREFIX_RE = /^gemini\s+/iu;
const CLAUDE_GPT_PREFIX_RE = /^claude\/gpt\s+/iu;

function shortQuotaWindowLabel(window: QuotaAxiWindow): string {
  const id = (window.id ?? "").trim().toLowerCase();
  const rawLabel = (window.label ?? "").trim();
  const lowerLabel = rawLabel.toLowerCase();
  const kind: string = (window.kind ?? "").trim().toLowerCase();
  if (
    id === "5h" ||
    id === "five_hour" ||
    id === "session" ||
    id.endsWith("_5h") ||
    id.endsWith(":5h") ||
    lowerLabel.includes("5h") ||
    lowerLabel.includes("5-hour") ||
    lowerLabel.includes("5 hour") ||
    kind === "rolling"
  ) {
    return "5h";
  }
  if (
    id === "weekly" ||
    id === "7d" ||
    id === "seven_day" ||
    id.endsWith("_weekly") ||
    id.endsWith(":7d") ||
    lowerLabel.includes("weekly") ||
    lowerLabel.includes("7d") ||
    lowerLabel.includes("7-day") ||
    lowerLabel.includes("7 day") ||
    kind === "weekly"
  ) {
    return "7d";
  }
  if (
    id === "daily" ||
    id === "24h" ||
    id.endsWith("_daily") ||
    id.endsWith(":24h") ||
    lowerLabel.includes("daily") ||
    lowerLabel.includes("24h") ||
    kind === "daily"
  ) {
    return "24h";
  }
  if (
    id === "monthly" ||
    lowerLabel === "monthly" ||
    (kind === "monthly" &&
      (lowerLabel.length === 0 || lowerLabel === "monthly"))
  ) {
    return "Monthly";
  }
  const base = rawLabel || window.id || window.kind || "Quota";
  const stripped = base
    .replace(GEMINI_ARGON_PREFIX_RE, "")
    .replace(GEMINI_PREFIX_RE, "")
    .replace(CLAUDE_GPT_PREFIX_RE, "")
    .trim();
  return stripped.length > 0 ? stripped : base.trim();
}

function formatQuotaResetRemaining(
  resetsAt: string | null | undefined,
  nowMs: number
): string | null {
  if (!resetsAt) return null;
  const parsed = Date.parse(resetsAt);
  if (!Number.isFinite(parsed)) return null;
  const remainingMs = parsed - nowMs;
  if (remainingMs <= 0) return "resetting";
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes > 0 ? `in ${totalHours}h ${minutes}m` : `in ${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
}

function resolveQuotaWindowReset(
  window: QuotaAxiWindow,
  nowMs: number
): {
  readonly resetText: string | null;
  readonly resetTitle: string | null;
} {
  const relative = formatQuotaResetRemaining(window.resetsAt, nowMs);
  if (relative !== null) {
    const formattedInstant = instantLabel(window.resetsAt);
    return {
      resetText: relative,
      resetTitle:
        formattedInstant.length > 0
          ? `${relative} (${formattedInstant})`
          : relative
    };
  }
  if (
    typeof window.resetText === "string" &&
    window.resetText.trim().length > 0
  ) {
    const fallback = window.resetText.trim();
    return { resetText: fallback, resetTitle: fallback };
  }
  return { resetText: null, resetTitle: null };
}

function quotaBarsForProviderEntry(
  entry: QuotaAxiProvider,
  providerId: string,
  nowMs: number
): ProviderQuotaWindowBar[] {
  const routeWindows = entry.windows.filter(
    (window) =>
      window.shareOf === undefined &&
      (entry.provider !== "agy" || agyWindowMatchesProvider(window, providerId))
  );
  const hasAggregate = routeWindows.some((window) => !isModelWindow(window));
  const selectedWindows = hasAggregate
    ? routeWindows.filter((window) => !isModelWindow(window))
    : routeWindows;
  const accountKey = entry.accountKey ?? "default";
  const bars: ProviderQuotaWindowBar[] = [];
  for (const [index, window] of selectedWindows.entries()) {
    const percents = resolveQuotaWindowPercents(window);
    if (percents === null) continue;
    const reset = resolveQuotaWindowReset(window, nowMs);
    bars.push({
      key: `${entry.provider}:${accountKey}:${window.id}:${index}`,
      label: shortQuotaWindowLabel(window),
      remainingPercent: percents.remainingPercent,
      usedPercent: percents.usedPercent,
      resetText: reset.resetText,
      resetTitle: reset.resetTitle
    });
  }
  return bars;
}

/** Extracts compact per-provider remaining-usage bars from the quota-axi snapshot. */
function quotaByProvider(
  report: QuotaAxiSnapshot | null,
  nowMs: number
): ReadonlyMap<string, readonly ProviderQuotaWindowBar[]> {
  const grouped = new Map<string, ProviderQuotaWindowBar[]>();
  for (const entry of report?.providers ?? []) {
    // quota-axi reports the one shared Antigravity service as `agy`, while
    // AutoDev exposes its model families as separate provider rows.
    const providerRows =
      entry.provider === "agy" ? ANTIGRAVITY_PROVIDERS : [entry.provider];
    for (const providerId of providerRows) {
      const bars = quotaBarsForProviderEntry(entry, providerId, nowMs);
      if (bars.length === 0) continue;
      const existing = grouped.get(providerId);
      if (existing === undefined) grouped.set(providerId, bars);
      else existing.push(...bars);
    }
  }
  return grouped;
}

function ProviderQuotaCell({
  providerId,
  windows
}: {
  readonly providerId: string;
  readonly windows: readonly ProviderQuotaWindowBar[];
}): React.JSX.Element | null {
  if (windows.length === 0) return null;
  return React.createElement(
    "div",
    {
      className: "mt-1 flex w-36 max-w-full flex-col gap-1",
      "data-provider-quota": providerId
    },
    ...windows.map((window) => {
      const isExhausted =
        window.usedPercent >= 100 || window.remainingPercent <= 0;
      const isWarning =
        !isExhausted &&
        (window.usedPercent > 95 || window.remainingPercent < 5);
      const remainingRounded = Math.round(window.remainingPercent);
      const remainingLabel = `${remainingRounded}%`;
      const summaryText = `${window.label} ${remainingLabel}`;
      const barColorClass = isExhausted
        ? "bg-error"
        : isWarning
          ? "bg-warning"
          : "bg-accent";
      const textColorClass = isExhausted
        ? "text-error"
        : isWarning
          ? "text-warning"
          : "text-fg-secondary";
      const barWidth = isExhausted
        ? 100
        : Math.max(0, Math.min(100, remainingRounded));
      return React.createElement(
        "div",
        { key: window.key, className: "flex flex-col gap-0.5" },
        React.createElement(
          "div",
          {
            className:
              "flex flex-wrap items-baseline justify-between gap-x-1.5 gap-y-0 font-mono text-micro leading-tight"
          },
          React.createElement(
            "span",
            {
              className: `max-w-full truncate ${textColorClass}`,
              title: summaryText
            },
            summaryText
          ),
          window.resetText === null
            ? null
            : React.createElement(
                "span",
                {
                  className: "max-w-full truncate text-fg-muted",
                  title: window.resetTitle ?? window.resetText
                },
                window.resetText
              )
        ),
        React.createElement(
          "div",
          {
            className:
              "h-1 w-full overflow-hidden rounded-full bg-surface-raised",
            role: "progressbar",
            "aria-label": `${providerId} ${window.label} remaining usage`,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": remainingRounded
          },
          React.createElement("div", {
            className: `h-full rounded-full ${barColorClass}`,
            style: { width: `${barWidth}%` }
          })
        )
      );
    })
  );
}

function ProvidersTab({
  providers,
  runtime,
  modelDiscovery,
  cliVersions
}: {
  readonly providers: ControlApiProvidersResponse;
  readonly runtime: ControlApiRuntimeResponse | undefined;
  readonly modelDiscovery: ProviderModelDiscoveryState;
  readonly cliVersions?: ProviderCliVersionState | undefined;
}): React.JSX.Element {
  const records = providers.providers;
  const nowMs = Date.now();
  const versions = cliVersions ?? CLI_VERSIONS_NOT_OBSERVED;
  const healthObserved = records.every((provider) => provider.health !== null);
  // Ready is the one count worth leading with, and it is computed from the same
  // `resolveProviderStatus` the column uses, so the summary can never disagree
  // with the rows beneath it.
  //
  // A provider whose health was never observed reads "Not observed" in its own
  // row, so it is not a provider that was judged and found unready: nobody
  // looked. Counting it as unready would print a readiness the Runtime never
  // measured, so the count is a number only when every provider's verdict was
  // observed.
  const readiness = scopedCount(
    records,
    (provider) => resolveProviderStatus(provider).tone !== NOT_OBSERVED_STATUS,
    (provider) => resolveProviderStatus(provider).label === "Ready"
  );
  return React.createElement(
    "div",
    {
      className: PAGE_SECTION_STACK_CLASS,
      "data-tab-panel": "providers"
    },
    React.createElement(
      StatGrid,
      { columns: 4 },
      React.createElement(StatCard, {
        title: "Ready",
        value: countValue(readiness),
        subtitle: readiness.observed
          ? `of ${records.length} providers`
          : "Provider readiness was not observed"
      }),
      React.createElement(StatCard, {
        title: "Disabled",
        value: records.filter((provider) => provider.disabled).length,
        subtitle: "Configuration preserved"
      }),
      React.createElement(StatCard, {
        title: "Cooling down",
        value:
          records.length > 0 && healthObserved
            ? records.filter((p) => p.health?.cooldown).length
            : NOT_OBSERVED_LABEL,
        subtitle: healthObserved ? "Live router evidence" : "No router evidence"
      }),
      React.createElement(StatCard, {
        title: "Active Agent Instances",
        value:
          runtime?.liveAgents === undefined || runtime.liveAgents === null
            ? NOT_OBSERVED_LABEL
            : runtime.liveAgents.count,
        subtitle:
          runtime?.liveAgents === undefined || runtime.liveAgents === null
            ? "No live activity source"
            : "Runtime live sessions and subagents"
      })
    ),
    React.createElement(
      "section",
      { "data-section": "providers" },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        // "Configured" is the word every other list page uses for the resource
        // the operator owns -- "Configured Agents", "Configured Workspaces",
        // "Configured Lifecycle Hooks". The bare "Providers" repeated the
        // page's own `h1`, so the heading outline added a level that carried no
        // information.
        "Configured Providers"
      ),
      React.createElement<DataTableProps<ControlApiProviderRecord>>(DataTable, {
        data: records,
        columns: providerColumns(
          providersPath("providers"),
          runtime?.liveAgents,
          modelDiscovery,
          versions,
          quotaByProvider(providers.quotaAxi, nowMs)
        ),
        keyExtractor: (provider: ControlApiProviderRecord) => provider.id,
        emptyMessage: "No providers are configured."
      })
    ),
    React.createElement(RoutingPriorityPanel, { providers })
  );
}

function ModelsTab({
  models,
  modelDiscovery,
  runtime
}: {
  readonly models: ProvidersModelsState;
  readonly modelDiscovery: ProviderModelDiscoveryState;
  readonly runtime: ControlApiRuntimeResponse | undefined;
}): React.JSX.Element {
  const modelRows = providerModelRows(
    models.status === "available" ? models.data.models : null,
    modelDiscovery
  );
  const unsupportedModels = unsupportedProviderModels(modelDiscovery);
  const summaries = providerDiscoverySummaries(modelDiscovery);
  return React.createElement(
    "div",
    {
      className: PAGE_SECTION_STACK_CLASS,
      "data-tab-panel": "models"
    },
    models.status === "unavailable"
      ? React.createElement(
          "p",
          {
            role: "alert",
            className: CALLOUT_WARNING_CLASS,
            "data-model-routing-state": "unavailable"
          },
          `Runtime model routing state could not be loaded: ${models.message}`
        )
      : null,
    modelDiscovery.status === "unavailable"
      ? React.createElement(
          "p",
          {
            role: "alert",
            className: CALLOUT_WARNING_CLASS,
            "data-model-discovery-state": "unavailable"
          },
          `Provider model availability could not be read: ${modelDiscovery.message}`
        )
      : null,
    React.createElement(
      "section",
      {
        className: LIST_PANEL_CLASS,
        "data-section": "provider-model-discovery"
      },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Provider model availability"
      ),
      summaries.length === 0
        ? React.createElement(
            "p",
            { className: MUTED_TEXT_CLASS, "data-status": "not-observed" },
            modelDiscovery.status === "available"
              ? "Runtime has not reported provider model-discovery entries."
              : "Provider availability is not observed."
          )
        : React.createElement(
            "ul",
            {
              className: "flex flex-col gap-2 list-none p-0 m-0",
              "data-provider-model-discovery-list": "true"
            },
            ...summaries.map((summary) => {
              const discovery = providerModelDiscoveryView(
                modelDiscovery,
                summary.provider
              );
              return React.createElement(
                "li",
                {
                  key: summary.provider,
                  className: "flex flex-wrap items-center gap-2",
                  "data-provider-discovery": summary.provider,
                  "data-discovery-status": summary.status
                },
                React.createElement(ProviderLink, {
                  provider: summary.provider
                }),
                React.createElement(ProviderModelDiscoveryBadge, {
                  discovery
                }),
                summary.reason === null
                  ? null
                  : React.createElement(
                      "span",
                      { className: MUTED_META_CLASS },
                      summary.reason
                    )
              );
            })
          )
    ),
    React.createElement(
      "section",
      {
        "data-section": "models"
      },
      React.createElement("h2", { className: SECTION_HEADING_CLASS }, "Models"),
      React.createElement(
        "p",
        { className: `mb-3 ${MUTED_META_CLASS}` },
        models.status === "available"
          ? `Provider-reported availability is shown separately from routing assignments (${models.data.source}). A disabled model is skipped for every tier it serves.`
          : "Provider-reported model availability is shown separately from Runtime routing state."
      ),
      React.createElement<DataTableProps<ProviderModelRow>>(DataTable, {
        data: modelRows,
        columns: modelColumns(providersPath("models"), runtime?.liveAgents),
        keyExtractor: (model: ProviderModelRow) =>
          `${model.provider}/${model.id}`,
        emptyMessage:
          "No routeable or configured provider models were reported by the available sources."
      })
    ),
    unsupportedModels.length === 0
      ? null
      : React.createElement(
          "section",
          {
            "data-section": "unsupported-models"
          },
          React.createElement(
            "h2",
            { className: SECTION_HEADING_CLASS },
            "Discovered but not routeable"
          ),
          React.createElement<DataTableProps<UnsupportedProviderModel>>(
            DataTable,
            {
              data: unsupportedModels,
              columns: [
                {
                  id: "model",
                  header: "Model",
                  align: "tokens",
                  cell: (model) =>
                    React.createElement(
                      "span",
                      {
                        className: "font-mono text-fg",
                        "data-unsupported-model": model.id,
                        title: model.id
                      },
                      model.id
                    )
                },
                {
                  id: "provider",
                  header: "Provider",
                  cell: (model) =>
                    React.createElement(ProviderLink, {
                      provider: model.provider
                    })
                },
                {
                  id: "discovery",
                  header: "Discovery",
                  cell: (model) =>
                    React.createElement(StatusBadge, {
                      status:
                        model.discoveryStatus === "observed"
                          ? "valid"
                          : "unavailable",
                      label:
                        model.discoveryStatus === "observed"
                          ? "Observed"
                          : "Stale"
                    })
                },
                {
                  id: "activeAgents",
                  header: "Active Agents",
                  cellTitle: (model) =>
                    liveAgentRoleBreakdown(
                      runtime?.liveAgents,
                      "byModelRole",
                      `${model.provider}/${model.id}`
                    ),
                  cell: (model) =>
                    liveAgentCount(
                      runtime?.liveAgents,
                      "byModel",
                      `${model.provider}/${model.id}`
                    )
                },
                {
                  id: "reason",
                  header: "Routeability",
                  align: "prose",
                  cell: (model) => model.reason
                }
              ],
              keyExtractor: (model: UnsupportedProviderModel) =>
                `${model.provider}/${model.id}`,
              emptyMessage: "No unsupported provider models were reported."
            }
          )
        )
  );
}

export function ProvidersView({
  providers,
  models,
  modelDiscovery,
  cliVersions,
  runtime,
  activeTab,
  controlFailed,
  controlRefusal
}: ProvidersViewProps): React.JSX.Element {
  const tab = resolveActiveTabId(PROVIDERS_VIEW_TABS, activeTab, "providers");
  return React.createElement(
    PageBody,
    { feature: "providers" },
    React.createElement(LiveCountRefresh),
    React.createElement(TabNav, {
      navLabel: "Providers views",
      basePath: PROVIDERS_PATH,
      tabs: PROVIDERS_VIEW_TABS,
      activeTabId: tab
    }),
    controlFailed
      ? React.createElement(ControlFailureNotice, { refusal: controlRefusal })
      : null,
    tab === "models"
      ? React.createElement(ModelsTab, {
          models,
          modelDiscovery,
          runtime
        })
      : React.createElement(ProvidersTab, {
          providers,
          modelDiscovery,
          cliVersions,
          runtime
        })
  );
}
