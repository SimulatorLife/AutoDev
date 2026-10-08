import type {
  ControlApiModelRecord,
  ControlApiModelsResponse,
  ControlApiProviderRecord,
  ControlApiProvidersResponse
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
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { ControlFailureNotice } from "../../components/status/ControlFailureNotice.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
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
import { ModelToggle } from "./ModelToggle.ts";
import {
  modelPath,
  providerPath,
  PROVIDERS_PATH,
  providersPath
} from "./paths.ts";
import {
  ProviderStatusBadge,
  resolveProviderStatus
} from "./provider-status.ts";
import { ProviderLimitsControls } from "./ProviderLimitsControls.ts";
import { ProviderRoleControls } from "./ProviderRoleControls.ts";

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
  /** Raw `?tab=` value; unknown values fall back to the Providers tab. */
  readonly activeTab?: string | undefined;
  readonly controlFailed?: boolean | undefined;
}

function ProviderLink({
  provider
}: {
  readonly provider: string;
}): React.JSX.Element {
  return React.createElement(
    "a",
    {
      href: providerPath(provider),
      className: MONO_ID_LINK_CLASS,
      "aria-label": `Open provider ${provider}`
    },
    provider
  );
}

/**
 * The four columns of the Providers configuration table.
 *
 * Role Enablement, Health, Credential, Available Models and Tier Priority are
 * gone: their facts are either folded into the single Status verdict or
 * reachable from the row's own controls. The column order is the contract's,
 * not a layout preference.
 */
function providerColumns(
  returnTo: string
): ColumnDef<ControlApiProviderRecord>[] {
  return [
    {
      id: "provider",
      header: "Provider",
      // The provider id is the row's primary identifier. Its full declared
      // share is preserved by DataTable; narrow viewports scroll the table.
      weight: 130,
      cell: (provider) =>
        React.createElement(ProviderLink, { provider: provider.id })
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
      id: "roles",
      header: "Roles",
      // The label alone does not say what the two controls per role mean, and a
      // `Disabled` priority that dims its model selector is not self-evident
      // from the row. The contract asks for a help affordance on this header.
      headerHelp:
        "Each fixed role takes a priority (P1, P2, P3 or Disabled) and a model. Changing either selection submits the complete role assignment immediately; refreshed values are Runtime-confirmed. Disabled dims its model selector but keeps the chosen model.",
      // The label and two selects use a 416px aligned grid; the table cell adds
      // 32px of shared inset. The 448px budget keeps fields aligned.
      weight: 448,
      align: "tokens",
      cell: (provider) =>
        React.createElement(ProviderRoleControls, {
          provider,
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
function modelColumns(returnTo: string): ColumnDef<ControlApiModelRecord>[] {
  return [
    {
      id: "model",
      header: "Model",
      weight: 288,
      cell: (model) =>
        React.createElement(
          "div",
          { className: "flex flex-col gap-0.5" },
          React.createElement(
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
      id: "enabled",
      header: "Enabled",
      cell: (model) =>
        React.createElement(ModelToggle, {
          model: model.id,
          enablement: model.enablement,
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
        { className: "mt-1 text-xs text-fg-muted" },
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
  providers
}: {
  readonly providers: ControlApiProvidersResponse;
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
      { columns: 3 },
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
        columns: providerColumns(providersPath("providers")),
        keyExtractor: (provider: ControlApiProviderRecord) => provider.id,
        emptyMessage: "No providers are configured."
      })
    ),
    React.createElement(RoutingPriorityPanel, { providers })
  );
}

function ModelsTab({
  models
}: {
  readonly models: ProvidersModelsState;
}): React.JSX.Element {
  if (models.status === "unavailable") {
    return React.createElement(
      "div",
      {
        role: "alert",
        "data-tab-panel": "models",
        "data-status": "unavailable",
        className: CALLOUT_WARNING_CLASS
      },
      `Models could not be loaded: ${models.message}`
    );
  }
  return React.createElement(
    "section",
    {
      className: LIST_PANEL_CLASS,
      "data-tab-panel": "models",
      "data-section": "models"
    },
    React.createElement(
      "div",
      { className: "mb-3" },
      React.createElement("h2", { className: SECTION_HEADING_CLASS }, "Models"),
      React.createElement(
        "p",
        { className: "mt-1 text-xs text-fg-muted" },
        `Every model the routing configuration (${models.data.source}) maps a provider tier to. A disabled model is skipped for every tier it serves.`
      )
    ),
    React.createElement<DataTableProps<ControlApiModelRecord>>(DataTable, {
      data: models.data.models,
      columns: modelColumns(providersPath("models")),
      keyExtractor: (model: ControlApiModelRecord) => model.id,
      emptyMessage: "No models are configured."
    })
  );
}

export function ProvidersView({
  providers,
  models,
  activeTab,
  controlFailed
}: ProvidersViewProps): React.JSX.Element {
  const tab = resolveActiveTabId(PROVIDERS_VIEW_TABS, activeTab, "providers");
  return React.createElement(
    PageBody,
    { feature: "providers" },
    React.createElement(TabNav, {
      navLabel: "Providers views",
      basePath: PROVIDERS_PATH,
      tabs: PROVIDERS_VIEW_TABS,
      activeTabId: tab
    }),
    controlFailed ? React.createElement(ControlFailureNotice) : null,
    tab === "models"
      ? React.createElement(ModelsTab, { models })
      : React.createElement(ProvidersTab, { providers })
  );
}
