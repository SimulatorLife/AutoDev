import type {
  ControlApiModelRecord,
  ControlApiModelsResponse,
  ControlApiProviderRecord,
  ControlApiProvidersResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { ConsoleLink } from "../../components/navigation/ConsoleLink.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";
import {
  resolveActiveTabId,
  type TabDefinition,
  TabNav
} from "../../components/tabs/Tabs.ts";
import {
  ControlFailureNotice,
  ModelToggle,
  ProviderRoleToggle
} from "./EnablementToggle.ts";
import {
  modelPath,
  providerPath,
  PROVIDERS_PATH,
  providersPath
} from "./paths.ts";
import {
  CredentialBadge,
  ProviderHealthBadge,
  tierPriorityLabel
} from "./provider-status.ts";

const SECTION_PANEL_CLASS =
  "rounded-lg border border-border bg-surface p-5 shadow";
const SECTION_HEADING_CLASS =
  "text-sm font-semibold uppercase tracking-wider text-fg-muted";
const LINK_CLASS =
  "font-mono font-semibold text-fg underline-offset-4 hover:underline";
const NOT_OBSERVED_LABEL = "Not observed";

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
    ConsoleLink,
    {
      href: providerPath(provider),
      className: LINK_CLASS,
      "aria-label": `Open provider ${provider}`
    },
    provider
  );
}

function ModelLink({
  provider,
  model
}: {
  readonly provider: string;
  readonly model: string;
}): React.JSX.Element {
  return React.createElement(
    ConsoleLink,
    {
      href: modelPath(provider, model),
      className: "font-mono text-xs text-fg underline-offset-4 hover:underline",
      "aria-label": `Open model ${model}`
    },
    model
  );
}

function providerColumns(
  returnTo: string
): ColumnDef<ControlApiProviderRecord>[] {
  return [
    {
      id: "provider",
      header: "Provider",
      cell: (provider) =>
        React.createElement(ProviderLink, { provider: provider.id })
    },
    {
      id: "orchestrator",
      header: "Orchestrator",
      cell: (provider) =>
        React.createElement(ProviderRoleToggle, {
          provider: provider.id,
          role: "orchestrator",
          enablement: provider.roles.orchestrator,
          returnTo
        })
    },
    {
      id: "subagent",
      header: "Subagent",
      cell: (provider) =>
        React.createElement(ProviderRoleToggle, {
          provider: provider.id,
          role: "subagent",
          enablement: provider.roles.subagent,
          returnTo
        })
    },
    {
      id: "health",
      header: "Health",
      cell: (provider) =>
        React.createElement(ProviderHealthBadge, { health: provider.health })
    },
    {
      id: "credential",
      header: "Credential",
      cell: (provider) =>
        React.createElement(CredentialBadge, {
          credential: provider.credential
        })
    },
    {
      id: "models",
      header: "Models",
      wrap: true,
      cell: (provider) =>
        provider.models.length === 0
          ? React.createElement(
              "span",
              { className: "text-xs text-fg-muted" },
              "None configured"
            )
          : React.createElement(
              "ul",
              { className: "flex flex-col gap-1 list-none p-0 m-0" },
              ...uniqueModels(provider).map((model) =>
                React.createElement(
                  "li",
                  { key: model },
                  React.createElement(ModelLink, {
                    provider: provider.id,
                    model
                  })
                )
              )
            )
    },
    {
      id: "priority",
      header: "Priority",
      wrap: true,
      cell: (provider) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-fg-secondary" },
          tierPriorityLabel(provider.priorities)
        )
    }
  ];
}

function uniqueModels(provider: ControlApiProviderRecord): string[] {
  return [...new Set(provider.models.map(({ model }) => model))];
}

function modelColumns(returnTo: string): ColumnDef<ControlApiModelRecord>[] {
  return [
    {
      id: "model",
      header: "Model",
      cell: (model) =>
        React.createElement(
          "div",
          { className: "flex flex-col gap-0.5" },
          React.createElement(ModelLink, {
            provider: model.provider,
            model: model.id
          }),
          model.displayName === null
            ? null
            : React.createElement(
                "span",
                { className: "text-xs text-fg-muted" },
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
      wrap: true,
      cell: (model) =>
        React.createElement(
          "span",
          { className: "font-mono text-xs text-fg-secondary" },
          model.tiers.join(", ")
        )
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
    { className: SECTION_PANEL_CLASS, "data-section": "routing-priority" },
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
                      className: "text-fg-muted"
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
                  { className: "text-fg-muted" },
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
    { className: "flex flex-col gap-6", "data-tab-panel": "providers" },
    React.createElement(
      "div",
      { className: "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" },
      React.createElement(StatCard, {
        title: "Providers",
        value: records.length
      }),
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
      { className: SECTION_PANEL_CLASS, "data-section": "providers" },
      React.createElement(
        "h2",
        { className: `mb-3 ${SECTION_HEADING_CLASS}` },
        "Providers"
      ),
      DataTable({
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
        className:
          "rounded-lg border border-warning/40 bg-warning/10 p-5 text-sm text-fg-secondary"
      },
      `Models could not be loaded: ${models.message}`
    );
  }
  return React.createElement(
    "section",
    {
      className: SECTION_PANEL_CLASS,
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
    DataTable({
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
    "div",
    { className: "flex flex-col gap-6", "data-feature": "providers" },
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
