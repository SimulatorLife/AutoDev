import {
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
import {
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  resolveActiveTabId,
  type TabDefinition,
  TabNav
} from "../../components/tabs/Tabs.ts";
import {
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { liveAgentCount, liveAgentRoleBreakdown } from "../live-agent-count.ts";
import { PROVIDERS_PATH, providersPath } from "./paths.ts";
import {
  CLI_VERSIONS_NOT_OBSERVED,
  type ProviderCliVersionState
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
import { resolveProviderStatus } from "./provider-status.ts";
import { ProviderModelDiscoveryBadge } from "./ProviderModelAvailabilityBadge.ts";
import { providerQuotaView } from "./ProviderQuota.ts";
import { ProviderResetDialog } from "./ProviderResetDialog.ts";
import {
  modelColumns,
  providerColumns,
  ProviderLink
} from "./ProviderTableColumns.ts";

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
  const versions = cliVersions ?? CLI_VERSIONS_NOT_OBSERVED;
  const quota = providerQuotaView(providers.quotaAxi);
  const quotaExhaustion = quota.exhaustion;
  const healthObserved = records.every((provider) => provider.health !== null);
  // Ready is the one count worth leading with, and it is computed from the same
  // `resolveProviderStatus` the column uses, so the summary can never disagree
  // with the rows beneath it.
  //
  // A provider with neither Runtime health nor an authoritative quota verdict
  // reads "Not observed" in its row. Quota exhaustion is itself observed
  // evidence for the scoped UI verdict, so the count remains based on the same
  // projection as the Status column.
  const readiness = scopedCount(
    records,
    (provider) =>
      resolveProviderStatus(provider, quotaExhaustion.get(provider.id)).tone !==
      NOT_OBSERVED_STATUS,
    (provider) =>
      resolveProviderStatus(provider, quotaExhaustion.get(provider.id))
        .verdict === "ready"
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
          quota
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
                  cell: ({ row: { original: model } }) =>
                    React.createElement(
                      "span",
                      {
                        className: "font-mono text-fg",
                        "data-unsupported-model": model.id,
                        title: model.id
                      },
                      model.id
                    ),
                  meta: {
                    align: "tokens"
                  }
                },
                {
                  id: "provider",
                  header: "Provider",
                  cell: ({ row: { original: model } }) =>
                    React.createElement(ProviderLink, {
                      provider: model.provider
                    })
                },
                {
                  id: "discovery",
                  header: "Discovery",
                  cell: ({ row: { original: model } }) =>
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
                  cell: ({ row: { original: model } }) =>
                    liveAgentCount(
                      runtime?.liveAgents,
                      "byModel",
                      `${model.provider}/${model.id}`
                    ),
                  meta: {
                    cellTitle: (model) =>
                      liveAgentRoleBreakdown(
                        runtime?.liveAgents,
                        "byModelRole",
                        `${model.provider}/${model.id}`
                      )
                  }
                },
                {
                  id: "reason",
                  header: "Routeability",
                  cell: ({ row: { original: model } }) => model.reason,
                  meta: {
                    align: "prose"
                  }
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
