import type {
  ControlApiLiveAgentCounts,
  ControlApiModelsResponse,
  ControlApiProviderRecord,
  ControlApiProvidersResponse,
  ControlApiRuntimeResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { Button } from "../../components/forms/Button.ts";
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
  NOT_OBSERVED_LABEL,
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
import {
  MONO_ID_LINK_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { liveAgentCount } from "../live-agent-count.ts";
import { ModelToggle } from "./ModelToggle.ts";
import {
  modelPath,
  providerPath,
  PROVIDERS_PATH,
  providersPath
} from "./paths.ts";
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
import { ProviderExternalLinks } from "./ProviderExternalLinks.ts";
import { ProviderLimitsControls } from "./ProviderLimitsControls.ts";
import {
  ProviderModelAvailabilityBadge,
  ProviderModelDiscoveryBadge
} from "./ProviderModelAvailabilityBadge.ts";
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
    React.createElement(
      "form",
      {
        action: "/api/providers/reset",
        method: "post",
        className: "flex min-w-0 flex-wrap items-center gap-2",
        "data-provider-reset-form": "true"
      },
      React.createElement("input", {
        type: "hidden",
        name: "returnTo",
        value: returnTo
      }),
      React.createElement(
        "label",
        {
          className:
            "flex min-w-0 max-w-full items-start gap-2 text-xs text-fg-secondary",
          htmlFor: "confirm-provider-reset"
        },
        React.createElement("input", {
          id: "confirm-provider-reset",
          type: "checkbox",
          name: "confirm",
          value: "true",
          required: true,
          className:
            "mt-0.5 size-4 shrink-0 rounded border border-border-strong bg-input accent-accent",
          "data-provider-reset-confirm": "true"
        }),
        React.createElement(
          "span",
          null,
          "Confirm clearing role overrides, disabled models, and provider limits"
        )
      ),
      React.createElement(
        Button,
        {
          type: "submit",
          variant: "secondary",
          testId: "provider-reset"
        },
        "Reset to defaults"
      )
    ),
    React.createElement(
      "div",
      { className: "flex min-w-0 flex-col items-end gap-1" },
      React.createElement(
        Button,
        {
          disabled: true,
          variant: "secondary",
          title:
            "Adding a provider requires a Runtime adapter that is not currently available.",
          dataAttributes: {
            "aria-describedby": "provider-add-disabled-reason"
          },
          testId: "provider-add"
        },
        "Add provider"
      ),
      React.createElement(
        "span",
        {
          id: "provider-add-disabled-reason",
          className: "max-w-48 text-right text-micro text-fg-muted"
        },
        "Add a Runtime adapter before configuring another provider."
      )
    )
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
  readonly runtime?: ControlApiRuntimeResponse | undefined;
  /** Raw `?tab=` value; unknown values fall back to the Providers tab. */
  readonly activeTab?: string | undefined;
  readonly controlFailed?: boolean | undefined;
  readonly controlRefusal?: ControlFailureNoticeProps["refusal"];
}

function ProviderLink({
  provider
}: {
  readonly provider: string;
}): React.JSX.Element {
  return React.createElement(
    NavigationLink,
    {
      href: providerPath(provider),
      className: MONO_ID_LINK_CLASS,
      title: provider,
      "aria-label": `Open provider ${provider}`
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
  modelDiscovery: ProviderModelDiscoveryState
): ColumnDef<ControlApiProviderRecord>[] {
  return [
    {
      id: "provider",
      header: "Provider",
      // The provider id is the row's primary identifier. Its full declared
      // share is preserved by DataTable; narrow viewports scroll the table.
      weight: 130,
      align: "tokens",
      cell: (provider) =>
        React.createElement(
          "div",
          { className: "flex flex-col gap-1" },
          React.createElement(ProviderLink, { provider: provider.id }),
          React.createElement(ProviderExternalLinks, {
            provider: provider.id,
            links: provider.links
          })
        )
    },
    {
      id: "status",
      header: "Status",
      // Sized against the widest pill the column can produce, which is a named
      // environment variable ("Missing LITELLM_API_KEY"), not the word Ready.
      weight: 210,
      cell: (provider) => React.createElement(ProviderStatusBadge, { provider })
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
      weight: 146,
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
      weight: 528,
      align: "tokens",
      cell: (provider) =>
        React.createElement(ProviderRoleControls, {
          provider,
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
      weight: 184,
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
      cell: (model) =>
        React.createElement(
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
        )
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
                  React.createElement(ProviderLink, { key: provider, provider })
                )
              )
            ])
          )
        )
      )
    )
  );
}

function ProvidersTab({
  providers,
  runtime,
  modelDiscovery
}: {
  readonly providers: ControlApiProvidersResponse;
  readonly runtime: ControlApiRuntimeResponse | undefined;
  readonly modelDiscovery: ProviderModelDiscoveryState;
}): React.JSX.Element {
  const records = providers.providers;
  const healthObserved = records.every((provider) => provider.health !== null);
  // Ready is the one count worth leading with, and it is computed from the same
  // `resolveProviderStatus` the column uses, so the summary can never disagree
  // with the rows beneath it.
  const readyCount = records.filter(
    (provider) => resolveProviderStatus(provider).label === "Ready"
  ).length;
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
        value: readyCount,
        subtitle: `of ${records.length} providers`
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
      { className: LIST_PANEL_CLASS, "data-section": "providers" },
      React.createElement(
        "h2",
        { className: `mb-3 ${SECTION_HEADING_CLASS}` },
        "Providers"
      ),
      React.createElement<DataTableProps<ControlApiProviderRecord>>(DataTable, {
        data: records,
        columns: providerColumns(
          providersPath("providers"),
          runtime?.liveAgents,
          modelDiscovery
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
        { className: `mb-3 ${SECTION_HEADING_CLASS}` },
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
        className: LIST_PANEL_CLASS,
        "data-section": "models"
      },
      React.createElement(
        "h2",
        { className: `mb-3 ${SECTION_HEADING_CLASS}` },
        "Models"
      ),
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
            className: LIST_PANEL_CLASS,
            "data-section": "unsupported-models"
          },
          React.createElement(
            "h2",
            { className: `mb-3 ${SECTION_HEADING_CLASS}` },
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
      ? React.createElement(ModelsTab, { models, modelDiscovery, runtime })
      : React.createElement(ProvidersTab, {
          providers,
          modelDiscovery,
          runtime
        })
  );
}
