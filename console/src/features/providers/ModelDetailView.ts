import type {
  ControlApiModelRecord,
  ControlApiProviderRecord
} from "@simulatorlife/autodev-core";
import React from "react";

import { Breadcrumbs } from "../../components/navigation/Breadcrumbs.ts";
import { StatusBadge } from "../../components/status/StatusBadge.ts";
import { ControlFailureNotice, ModelToggle } from "./EnablementToggle.ts";
import { modelPath, providerPath, PROVIDERS_PATH } from "./paths.ts";

const SECTION_PANEL_CLASS =
  "rounded-lg border border-border bg-surface p-6 shadow";
const SECTION_HEADING_CLASS =
  "mb-3 text-sm font-semibold uppercase tracking-wider text-fg-secondary";

export interface ModelDetailViewProps {
  readonly model: ControlApiModelRecord;
  /** The owning provider's record, or `null` when Providers is unavailable. */
  readonly provider: ControlApiProviderRecord | null;
  readonly controlFailed?: boolean | undefined;
}

function DetailValue({
  label,
  children
}: {
  readonly label: string;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "flex flex-col gap-1" },
    React.createElement(
      "dt",
      { className: "text-xs uppercase tracking-wider text-fg-muted" },
      label
    ),
    React.createElement(
      "dd",
      { className: "font-mono text-sm text-fg break-all" },
      children
    )
  );
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
      label: "Not observed"
    });
  }
  return React.createElement(
    "span",
    { className: "flex flex-wrap gap-2" },
    ...(["orchestrator", "subagent"] as const).map((role) =>
      React.createElement(StatusBadge, {
        key: role,
        status: provider.roles[role].enabled ? "valid" : "unavailable",
        label: `${role}: ${provider.roles[role].enabled ? "enabled" : "disabled"}`
      })
    )
  );
}

export function ModelDetailView({
  model,
  provider,
  controlFailed
}: ModelDetailViewProps): React.JSX.Element {
  return React.createElement(
    "div",
    { className: "flex flex-col gap-6", "data-feature": "model-detail" },
    React.createElement(
      "section",
      { className: SECTION_PANEL_CLASS },
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
              className:
                "mb-1 mt-3 text-xs uppercase tracking-wider text-fg-muted"
            },
            "Model"
          ),
          React.createElement(
            "h2",
            { className: "text-2xl font-bold text-fg" },
            model.id
          ),
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
      { className: SECTION_PANEL_CLASS, "data-section": "model-enablement" },
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
      React.createElement(
        "p",
        { className: "mt-3 text-xs text-fg-muted" },
        "A disabled model is skipped for every tier listed below; requests that name it directly are rejected."
      )
    ),
    React.createElement(
      "section",
      { className: SECTION_PANEL_CLASS, "data-section": "model-routing" },
      React.createElement(
        "h3",
        { className: SECTION_HEADING_CLASS },
        "Routing"
      ),
      React.createElement(
        "dl",
        { className: "grid grid-cols-1 gap-4 sm:grid-cols-2" },
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
