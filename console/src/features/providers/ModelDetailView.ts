import {
  type ControlApiModelRecord,
  type ControlApiProviderRecord,
  PROVIDER_ROLES
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
import { ConvergenceBadge } from "../../components/status/ConvergenceBadge.ts";
import {
  NOT_OBSERVED_LABEL,
  StatusBadge
} from "../../components/status/StatusBadge.ts";
import { ModelToggle } from "./EnablementToggle.ts";
import { modelPath, providerPath, PROVIDERS_PATH } from "./paths.ts";

export interface ModelDetailViewProps {
  readonly model: ControlApiModelRecord;
  /** The owning provider's record, or `null` when Providers is unavailable. */
  readonly provider: ControlApiProviderRecord | null;
  readonly controlFailed?: boolean | undefined;
}

/** Read-only provider role state; the provider's own toggles live on its pages. */
function ProviderRoleState({
  provider
}: {
  readonly provider: ControlApiProviderRecord | null;
}): React.JSX.Element {
  if (provider === null) {
    return React.createElement(StatusBadge, {
      status: "not-observed",
      label: NOT_OBSERVED_LABEL
    });
  }
  return React.createElement(
    "span",
    { className: "flex flex-wrap gap-2" },
    ...PROVIDER_ROLES.map((role) => {
      const assignment = provider.roles[role];
      const disabled = assignment.priority === "disabled";
      return React.createElement(StatusBadge, {
        key: role,
        status: disabled ? "unavailable" : "valid",
        label: `${role}: ${disabled ? "Disabled" : `P${assignment.priority}`}`
      });
    })
  );
}

export function ModelDetailView({
  model,
  provider,
  controlFailed
}: ModelDetailViewProps): React.JSX.Element {
  return React.createElement(
    PageBody,
    { feature: "model-detail" },
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
              { label: model.provider, href: providerPath(model.provider) },
              { label: model.id }
            ]
          }),
          React.createElement(
            "p",
            {
              className: ENTITY_EYEBROW_CLASS
            },
            "Model"
          ),
          React.createElement(EntityTitle, undefined, model.id),
          model.displayName === null
            ? null
            : React.createElement(
                "p",
                { className: "mt-1 text-sm text-fg-muted" },
                model.displayName
              )
        ),
        React.createElement(
          "a",
          {
            href: `/usage?model=${encodeURIComponent(model.id)}`,
            className: "text-xs text-accent underline underline-offset-2"
          },
          "View usage"
        )
      )
    ),
    controlFailed ? React.createElement(ControlFailureNotice) : null,
    React.createElement(
      "section",
      { className: DETAIL_PANEL_CLASS, "data-section": "model-enablement" },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Enablement"
      ),
      React.createElement(ModelToggle, {
        model: model.id,
        enablement: model.enablement,
        returnTo: modelPath(model.provider, model.id)
      }),
      // Desired-vs-actual state for the toggle above, kept separate from the
      // toggle itself so "the model is enabled" and "we have observed that
      // enablement converge" stay two independently evidenced statements.
      React.createElement(
        DetailGrid,
        { columns: 2, className: "mt-4" },
        React.createElement(
          DetailValue,
          { label: "Convergence" },
          React.createElement(ConvergenceBadge, {
            convergence: model.enablement.convergence.convergence,
            explanation: model.enablement.convergence.explanation,
            desiredGeneration: model.enablement.convergence.desiredGeneration,
            observedGeneration: model.enablement.convergence.observedGeneration,
            lastError: model.enablement.convergence.lastError
          })
        )
      ),
      React.createElement(
        "p",
        { className: "mt-3 text-xs text-fg-muted" },
        "A disabled model is skipped for every tier listed below; requests that name it directly are rejected."
      )
    ),
    React.createElement(
      "section",
      { className: DETAIL_PANEL_CLASS, "data-section": "model-routing" },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Routing"
      ),
      React.createElement(
        DetailGrid,
        { columns: 2 },
        React.createElement(
          DetailValue,
          { label: "Provider" },
          React.createElement(
            "a",
            {
              href: providerPath(model.provider),
              className: "text-fg underline-offset-4 hover:underline"
            },
            model.provider
          )
        ),
        React.createElement(
          DetailValue,
          { label: "Tiers" },
          model.tiers.join(", ")
        ),
        React.createElement(
          DetailValue,
          { label: "Provider roles" },
          React.createElement(ProviderRoleState, { provider })
        )
      )
    )
  );
}
