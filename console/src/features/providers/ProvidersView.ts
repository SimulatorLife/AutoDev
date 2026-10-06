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
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { ModelToggle, ProviderRoleToggle } from "./EnablementToggle.ts";
import {
  modelPath,
  providerPath,
  PROVIDERS_PATH,
  providersPath
} from "./paths.ts";
import { CredentialBadge, ProviderHealthBadge } from "./provider-status.ts";

const LINK_CLASS =
  "font-mono font-semibold text-fg underline-offset-4 hover:underline";

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
      className: LINK_CLASS,
      "aria-label": `Open provider ${provider}`
    },
    provider
  );
}

function providerColumns(
  returnTo: string
): ColumnDef<ControlApiProviderRecord>[] {
  return [
    {
      id: "provider",
      header: "Provider",
      // The provider id is the row's primary identifier, so this column is
      // sized to never truncate it (longest observed id renders ~92px).
      weight: 124,
      cell: (provider) =>
        React.createElement(ProviderLink, { provider: provider.id })
    },
    {
      // One column for both roles rather than two near-identical columns: the
      // enablement control is the same for each, and a single column keeps
      // room for the model and tier chips that actually need width.
      id: "roles",
      header: "Role enablement",
      weight: 183,
      align: "tokens",
      // Each row is a flex line holding a fixed 80px role label and a
      // `whitespace-nowrap` toggle badge, so it has a minimum intrinsic width
      // that no amount of wrapping inside the cell can reduce. `flex-wrap` on
      // the line itself is what keeps that minimum honest: when the column
      // cannot afford it, the badge drops to a second line instead of
      // painting over the Health column beside it.
      cell: (provider) =>
        React.createElement(
          "ul",
          {
            className: "flex flex-col list-none gap-1.5 p-0 m-0",
            "data-provider-roles": provider.id
          },
          ...(
            [
              ["orchestrator", "Orchestrator"],
              ["subagent", "Subagent"]
            ] as const
          ).map(([role, label]) =>
            React.createElement(
              "li",
              {
                key: role,
                className: "flex min-w-0 flex-wrap items-center gap-2"
              },
              React.createElement(
                "span",
                // A fixed literal in a `w-20` box. `truncate` here was
                // inherited from the row layout it no longer belongs to and
                // could never fire; keeping it invited the reader to assume
                // the label had a recovery path it did not need.
                { className: "w-20 shrink-0 text-xs text-fg-muted" },
                label
              ),
              React.createElement(ProviderRoleToggle, {
                provider: provider.id,
                role,
                enablement: provider.roles[role],
                returnTo
              })
            )
          )
        )
    },
    {
      id: "health",
      header: "Health",
      // The widest health badge ("Configured", plus its status dot) measures
      // 68px, so this column carried ~28px of dead width. That slack is what
      // lets Tier priority pack two chips per line below.
      weight: 100,
      cell: (provider) =>
        React.createElement(ProviderHealthBadge, { health: provider.health })
    },
    {
      id: "credential",
      header: "Credential",
      // A missing-credential badge names a long environment variable and is
      // expected to truncate; the untruncated name stays on its hover title.
      weight: 156,
      cell: (provider) =>
        React.createElement(CredentialBadge, {
          credential: provider.credential
        })
    },
    {
      id: "models",
      header: "Models",
      align: "tokens",
      // Longest observed model chip is 184px, so this column cannot go below
      // ~216px of cell width without truncating a model name.
      weight: 213,
      cell: (provider) =>
        chipList({
          items: uniqueModels(provider),
          emptyLabel: "None configured",
          testId: "provider-models",
          renderItem: (model) =>
            React.createElement(
              Chip,
              {
                href: modelPath(provider.id, model),
                label: `Open model ${model} on ${provider.id}`,
                className: "font-mono"
              },
              model
            )
        })
    },
    {
      id: "priority",
      header: "Tier priority",
      align: "tokens",
      // Load-bearing width. Chips wrap correctly, but the column was too narrow
      // for any adjacent pair to fit (widest pair `browser-tester P1` +
      // `default P1` needs ~200px of content width against 149px available), so
      // four tiers stacked one per line and forced 125px rows. At ~201px the
      // same chips pack two per line. Re-check this weight after editing any
      // tier-name width or the table's own padding.
      weight: 223,
      cell: (provider) => TierPriorityList({ provider })
    }
  ];
}

/**
 * One chip per capability tier, labelled with its fallback group. A provider
 * can sit in several tiers at different depths, so the chip carries both facts
 * rather than a single run-on string. The list reuses `chipList` so the wrapping
 * behaviour that keeps these chips inline is the shared one, not a second copy.
 */
function TierPriorityList({
  provider
}: {
  readonly provider: ControlApiProviderRecord;
}): React.JSX.Element {
  return chipList({
    items: provider.priorities,
    renderKey: ({ tier }) => tier,
    emptyLabel: "Not in any tier",
    testId: `provider-tier-${provider.id}`,
    renderItem: ({ tier, group }) =>
      React.createElement(
        Chip,
        { className: "gap-1", label: `${tier}: priority group ${group}` },
        React.createElement("span", { className: MUTED_TEXT_CLASS }, tier),
        React.createElement("span", { className: "font-mono" }, `P${group}`)
      )
  });
}

function uniqueModels(provider: ControlApiProviderRecord): string[] {
  return [...new Set(provider.models.map(({ model }) => model))];
}

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
        title: "Orchestrator enabled",
        value: records.filter((p) => p.roles.orchestrator.enabled).length
      }),
      React.createElement(StatCard, {
        title: "Subagent enabled",
        value: records.filter((p) => p.roles.subagent.enabled).length
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
