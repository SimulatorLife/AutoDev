import type {
  ControlApiModelRecord,
  ControlApiProviderHealth,
  ControlApiProviderRecord,
  ControlApiProvidersResponse
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  ENTITY_EYEBROW_CLASS,
  EntityTitle,
  SECTION_HEADING_CLASS
} from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { DETAIL_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import { ControlFailureNotice } from "../../components/status/ControlFailureNotice.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import {
  ENTITY_LINK_CLASS,
  MONO_VALUE_CLASS,
  MUTED_BODY_CLASS,
  MUTED_META_CLASS,
  MUTED_TEXT_CLASS
} from "../../components/ui/text-classes.ts";
import { ModelToggle } from "./ModelToggle.ts";
import { modelPath, providerPath, PROVIDERS_PATH } from "./paths.ts";
import { CredentialBadge, ProviderHealthBadge } from "./provider-status.ts";
import { ProviderRoleControls } from "./ProviderRoleControls.ts";

export interface ProviderDetailViewProps {
  readonly provider: ControlApiProviderRecord;
  readonly tiers: ControlApiProvidersResponse["tiers"];
  readonly orchestratorTier: string;
  /** This provider's models, or `null` when the Models collection is unavailable. */
  readonly models: readonly ControlApiModelRecord[] | null;
  readonly controlFailed?: boolean | undefined;
}

/**
 * The provider detail page's role panel.
 *
 * It shows the same four-role controls as the Providers row, because the
 * target state's contextual-controls rule requires an item's controls on its
 * row *and* in its detail view. Reusing `ProviderRoleControls` rather than
 * re-describing the roles here is what keeps the two surfaces from drifting
 * apart -- they used to, when each listed its own set of roles.
 */
function RolesPanel({
  provider,
  returnTo
}: {
  readonly provider: ControlApiProviderRecord;
  readonly returnTo: string;
}): React.JSX.Element {
  return React.createElement(
    "section",
    { className: DETAIL_PANEL_CLASS, "data-section": "provider-roles" },
    React.createElement("h3", { className: SECTION_HEADING_CLASS }, "Roles"),
    React.createElement(
      "p",
      { className: "mb-3 " + MUTED_META_CLASS },
      "Selecting a priority or model applies immediately. Values refresh from the Runtime after submission."
    ),
    React.createElement(ProviderRoleControls, { provider, returnTo })
  );
}

function ModelsPanel({
  provider,
  models,
  returnTo
}: {
  readonly provider: ControlApiProviderRecord;
  readonly models: readonly ControlApiModelRecord[] | null;
  readonly returnTo: string;
}): React.JSX.Element {
  const heading = React.createElement(
    "h3",
    { className: SECTION_HEADING_CLASS },
    "Models"
  );
  if (models === null) {
    return React.createElement(
      "section",
      { className: DETAIL_PANEL_CLASS, "data-section": "provider-models" },
      heading,
      React.createElement(
        "p",
        {
          className: "mb-3 text-xs text-warning",
          "data-status": "unavailable"
        },
        "Model enablement could not be loaded; configured tier models are shown without controls."
      ),
      React.createElement(
        "ul",
        {
          className: "flex flex-col gap-1 font-mono text-xs text-fg-secondary"
        },
        ...provider.models.map(({ tier, model }) =>
          React.createElement("li", { key: tier }, `${tier}: ${model}`)
        )
      )
    );
  }
  const columns: ColumnDef<ControlApiModelRecord>[] = [
    {
      id: "model",
      header: "Model",
      cell: (model) =>
        React.createElement(
          "a",
          {
            href: modelPath(provider.id, model.id),
            className: `font-mono text-xs text-fg ${ENTITY_LINK_CLASS}`,
            "aria-label": `Open model ${model.id}`
          },
          model.id
        )
    },
    {
      id: "tiers",
      header: "Tiers",
      cell: (model) =>
        React.createElement(
          "span",
          { className: MONO_VALUE_CLASS },
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
  return React.createElement(
    "section",
    { className: DETAIL_PANEL_CLASS, "data-section": "provider-models" },
    heading,
    React.createElement<DataTableProps<ControlApiModelRecord>>(DataTable, {
      data: models,
      columns,
      keyExtractor: (model: ControlApiModelRecord) => model.id,
      emptyMessage: "No models are configured for this provider."
    })
  );
}

function RoutingPanel({
  provider,
  tiers,
  orchestratorTier
}: {
  readonly provider: ControlApiProviderRecord;
  readonly tiers: ControlApiProvidersResponse["tiers"];
  readonly orchestratorTier: string;
}): React.JSX.Element {
  const served = tiers.flatMap(({ tier, groups }) => {
    const index = groups.findIndex((group) => group.includes(provider.id));
    if (index === -1) return [];
    return [{ tier, group: index + 1, peers: groups[index] ?? [] }];
  });
  return React.createElement(
    "section",
    { className: DETAIL_PANEL_CLASS, "data-section": "provider-routing" },
    React.createElement("h3", { className: SECTION_HEADING_CLASS }, "Routing"),
    served.length === 0
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          "This provider is not in any tier's priority groups."
        )
      : React.createElement(
          "ul",
          { className: "flex flex-col gap-2 list-none p-0 m-0" },
          ...served.map(({ tier, group, peers }) =>
            React.createElement(
              "li",
              {
                key: tier,
                className: "flex flex-wrap items-baseline gap-2 text-xs",
                "data-tier": tier
              },
              React.createElement(
                "span",
                { className: "w-32 font-mono text-fg" },
                tier === orchestratorTier ? `${tier} (root)` : tier
              ),
              React.createElement(
                "span",
                { className: "font-mono text-fg-secondary" },
                `P${group}`
              ),
              peers.length > 1
                ? React.createElement(
                    "span",
                    { className: MUTED_TEXT_CLASS },
                    "shared with ",
                    ...peers
                      .filter((peer) => peer !== provider.id)
                      .flatMap((peer, index) => [
                        index === 0 ? null : ", ",
                        React.createElement(
                          "a",
                          {
                            key: peer,
                            href: providerPath(peer),
                            className: `font-mono text-fg ${ENTITY_LINK_CLASS}`
                          },
                          peer
                        )
                      ])
                  )
                : null
            )
          )
        ),
    provider.orchestratorReasoningEffort === null
      ? null
      : React.createElement(
          "p",
          { className: "mt-3 text-xs text-fg-muted" },
          "Orchestrator reasoning effort: ",
          React.createElement(
            "span",
            { className: "font-mono text-fg" },
            provider.orchestratorReasoningEffort
          )
        )
  );
}

function RoutePanel({
  provider
}: {
  readonly provider: ControlApiProviderRecord;
}): React.JSX.Element {
  return React.createElement(
    "section",
    { className: DETAIL_PANEL_CLASS, "data-section": "provider-route" },
    React.createElement(
      "h3",
      { className: SECTION_HEADING_CLASS },
      "Route & credential"
    ),
    React.createElement(
      DetailGrid,
      { columns: 2 },
      React.createElement(
        DetailValue,
        { label: "Base URL" },
        provider.route?.baseUrl ?? NOT_OBSERVED_LABEL
      ),
      React.createElement(
        DetailValue,
        { label: "Model pattern" },
        provider.route?.pattern ?? NOT_OBSERVED_LABEL
      ),
      React.createElement(
        DetailValue,
        { label: "Health URL" },
        // `== null` on purpose, and deliberately not `=== null`: the v2 contract
        // types `route` as nullable, but a payload that omits the key arrives as
        // `undefined`, which is not `null`. A strict check falls through to
        // `.healthUrl` and throws. Nothing in the contract requires `route`, so
        // absent and explicitly-null have to render the same way here.
        provider.route == null
          ? NOT_OBSERVED_LABEL
          : (provider.route.healthUrl ?? "None configured")
      ),
      React.createElement(
        DetailValue,
        { label: "Credential" },
        React.createElement(CredentialBadge, {
          credential: provider.credential
        })
      )
    )
  );
}

function formatTimestamp(value: string | null): React.ReactNode {
  return value === null
    ? "None observed"
    : React.createElement("time", { dateTime: value }, value);
}

function HealthPanel({
  health
}: {
  readonly health: ControlApiProviderHealth | null;
}): React.JSX.Element {
  const heading = React.createElement(
    "h3",
    { className: SECTION_HEADING_CLASS },
    "Live health"
  );
  if (health === null) {
    return React.createElement(
      "section",
      { className: DETAIL_PANEL_CLASS, "data-section": "provider-health" },
      heading,
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, "data-status": "not-observed" },
        "The router has not reported live evidence for this provider."
      )
    );
  }
  const cooldown = health.cooldown;
  return React.createElement(
    "section",
    { className: DETAIL_PANEL_CLASS, "data-section": "provider-health" },
    heading,
    React.createElement(
      DetailGrid,
      { columns: 4 },
      React.createElement(
        DetailValue,
        { label: "State" },
        React.createElement(ProviderHealthBadge, { health })
      ),
      React.createElement(
        DetailValue,
        { label: "Cooldown until" },
        cooldown === null ? "None" : formatTimestamp(cooldown.until)
      ),
      React.createElement(
        DetailValue,
        { label: "Cooldown kind" },
        cooldown === null ? "None" : cooldown.kind
      ),
      React.createElement(
        DetailValue,
        { label: "Last-resort eligible" },
        cooldown === null ? "Yes" : cooldown.lastResortEligible ? "Yes" : "No"
      ),
      React.createElement(
        DetailValue,
        { label: "In-flight requests" },
        health.inFlightRequests
      ),
      React.createElement(
        DetailValue,
        { label: "Active agents" },
        health.activeAgents
      ),
      React.createElement(
        DetailValue,
        { label: "Failure streak" },
        health.failureStreak
      ),
      React.createElement(
        DetailValue,
        { label: "Probe failure streak" },
        health.probeFailureStreak
      ),
      React.createElement(DetailValue, { label: "Attempts" }, health.attempts),
      React.createElement(
        DetailValue,
        { label: "Successes" },
        health.successes
      ),
      React.createElement(DetailValue, { label: "Failures" }, health.failures),
      React.createElement(
        DetailValue,
        { label: "Last success" },
        formatTimestamp(health.lastSuccessAt)
      ),
      React.createElement(
        DetailValue,
        { label: "Last failure" },
        health.lastFailure === null
          ? "None observed"
          : React.createElement(
              "span",
              { className: "flex flex-col gap-0.5" },
              formatTimestamp(health.lastFailure.at),
              React.createElement(
                "span",
                { className: MUTED_META_CLASS },
                [
                  health.lastFailure.failureClass ?? "unclassified",
                  health.lastFailure.status === null
                    ? null
                    : `HTTP ${health.lastFailure.status}`
                ]
                  .filter(Boolean)
                  .join(" · ")
              )
            )
      )
    )
  );
}

export function ProviderDetailView({
  provider,
  tiers,
  orchestratorTier,
  models,
  controlFailed
}: ProviderDetailViewProps): React.JSX.Element {
  const returnTo = providerPath(provider.id);
  return React.createElement(
    PageBody,
    { feature: "provider-detail" },
    React.createElement(
      "section",
      { className: DETAIL_PANEL_CLASS },
      React.createElement(
        "div",
        { className: "flex flex-wrap items-start justify-between gap-4" },
        React.createElement(
          "div",
          null,
          React.createElement(Breadcrumbs, {
            items: [
              { label: "Providers", href: PROVIDERS_PATH },
              { label: provider.id }
            ]
          }),
          React.createElement(
            "p",
            {
              className: ENTITY_EYEBROW_CLASS
            },
            "Model provider"
          ),
          React.createElement(EntityTitle, undefined, provider.id)
        ),
        React.createElement(
          "div",
          { className: "flex flex-col items-end gap-2" },
          React.createElement(ProviderHealthBadge, { health: provider.health }),
          React.createElement(
            "a",
            {
              href: `/usage?provider=${encodeURIComponent(provider.id)}`,
              className: "text-xs text-accent underline underline-offset-2"
            },
            "View usage"
          )
        )
      )
    ),
    controlFailed ? React.createElement(ControlFailureNotice) : null,
    React.createElement(RolesPanel, { provider, returnTo }),
    React.createElement(ModelsPanel, { provider, models, returnTo }),
    React.createElement(RoutingPanel, { provider, tiers, orchestratorTier }),
    React.createElement(RoutePanel, { provider }),
    React.createElement(HealthPanel, { health: provider.health })
  );
}
