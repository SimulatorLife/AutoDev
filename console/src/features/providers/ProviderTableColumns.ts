import {
  type ControlApiLiveAgentCounts,
  type ControlApiProviderRecord
} from "@simulatorlife/autodev-core";
import { type ColumnDef } from "@tanstack/react-table";
import React from "react";

import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { Chip, chipList } from "../../components/tables/Chips.ts";
import {
  ENTITY_LINK_CLASS,
  MONO_ID_CLASS,
  MONO_ID_LINK_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { liveAgentCount, liveAgentRoleBreakdown } from "../live-agent-count.ts";
import { ModelToggle } from "./ModelToggle.ts";
import { modelPath, providerPath, providersPath } from "./paths.ts";
import {
  type ProviderCliVersionState,
  providerCliVersionView
} from "./provider-cli-version.ts";
import {
  type ProviderModelDiscoveryState,
  type ProviderModelRow
} from "./provider-model-discovery.ts";
import { ProviderStatusBadge } from "./provider-status.ts";
import { ProviderCliVersionText } from "./ProviderCliVersion.ts";
import { ProviderExternalLinks } from "./ProviderExternalLinks.ts";
import { ProviderLimitsControls } from "./ProviderLimitsControls.ts";
import { ProviderModelAvailabilityBadge } from "./ProviderModelAvailabilityBadge.ts";
import {
  ProviderQuotaCell,
  type ProviderQuotaWindowBar
} from "./ProviderQuota.ts";
import { ProviderRoleControls } from "./ProviderRoleControls.ts";

/**
 * The provider id as the providers table's row identifier.
 *
 * It wraps at its hyphens instead of truncating. The Antigravity providers
 * share the 11-character `antigravity-` prefix, so a truncated id reads
 * `antigravit…` on all three rows and the row names nothing; wrapped,
 * `antigravity-claude-gpt` keeps the column's width and names its row.
 */
const WRAPPING_PROVIDER_ID_LINK_CLASS = `${MONO_ID_CLASS} block min-h-6 ${ENTITY_LINK_CLASS}`;

export function ProviderLink({
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
export function providerColumns(
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
      cell: ({ row: { original: provider } }) =>
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
        ),
      meta: {
        // The provider id is the row's primary identifier. Its full declared
        // share is preserved by DataTable; narrow viewports scroll the table.
        //
        // The provider id and its two external links stack in this cell, and the
        // widest of them measures 98px, so 130 is that with the cell's own 32px
        // of padding.
        // 132 is the widest line in the cell -- the provider's own id and its
        // two links -- with the cell's own 32px of inset.
        weight: 132,
        align: "tokens"
      }
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row: { original: provider } }) =>
        React.createElement(ProviderStatusBadge, {
          provider,
          returnTo: providersPath()
        }),
      meta: {
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
        weight: 168
      }
    },
    {
      id: "activeAgents",
      header: "Active Agents",
      cell: ({ row: { original: provider } }) =>
        React.createElement(
          "span",
          {
            className: "text-xs text-fg-secondary tabular-nums",
            "data-live-agent-provider": provider.id
          },
          liveAgentCount(liveAgents, "byProvider", provider.id)
        ),
      meta: {
        // The header needs 106px on one line, and the cell adds 32px of shared
        // inset, so 138px is the floor. At 118 the header wrapped to two lines,
        // which made this table's header row 15px taller than every other table
        // in the Console -- the one header whose own width was too small for its
        // own name, which the shared table contract forbids. The margin over
        // the floor matches the other columns', so a system font with different
        // metrics does not put the header back on two lines.
        weight: 139,
        cellTitle: (provider) =>
          liveAgentRoleBreakdown(liveAgents, "byProviderRole", provider.id)
      }
    },
    {
      id: "roles",
      header: "Roles",
      cell: ({ row: { original: provider } }) =>
        React.createElement(ProviderRoleControls, {
          provider,
          subagentLayout: "hierarchical",
          modelDiscovery,
          returnTo
        }),
      meta: {
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
        align: "tokens"
      }
    },
    {
      id: "agentLimits",
      header: "Agent Limits",
      cell: ({ row: { original: provider } }) =>
        React.createElement(ProviderLimitsControls, { provider, returnTo }),
      meta: {
        headerHelp:
          "Provider-wide concurrent-agent limits. Unlimited has no ceiling; disabling the provider turns it off entirely while preserving its priorities, models and limits.",
        // Both stepper labels sit above their button groups, so the 184px budget
        // leaves room for controls and lets the optional disabled caption wrap.
        //
        // 151 holds the widest of the two groups -- the button row measures 101px
        // -- and the header, whose label and help marker together need 149px.
        weight: 151,
        align: "tokens"
      }
    }
  ];
}

/**
 * The Models tab's columns. This tab keeps its own model catalog, per-tier
 * mapping, and enable/disable control: the Providers table folded those facts
 * into Status and the row's own controls, but a model is still an item with its
 * own lifecycle, so it keeps a list of its own.
 */
export function modelColumns(
  returnTo: string,
  liveAgents: ControlApiLiveAgentCounts | null | undefined
): ColumnDef<ProviderModelRow>[] {
  return [
    {
      id: "model",
      header: "Model",
      cell: ({ row: { original: model } }) => {
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
      },
      meta: {
        weight: 288
      }
    },
    {
      id: "provider",
      header: "Provider",
      cell: ({ row: { original: model } }) =>
        React.createElement(ProviderLink, { provider: model.provider })
    },
    {
      id: "activeAgents",
      header: "Active Agents",
      cell: ({ row: { original: model } }) =>
        React.createElement(
          "span",
          {
            className: "text-xs text-fg-secondary tabular-nums",
            "data-live-agent-model": model.id
          },
          liveAgentCount(liveAgents, "byModel", `${model.provider}/${model.id}`)
        ),
      meta: {
        weight: 112,
        cellTitle: (model) =>
          liveAgentRoleBreakdown(
            liveAgents,
            "byModelRole",
            `${model.provider}/${model.id}`
          )
      }
    },
    {
      id: "tiers",
      header: "Tiers",
      cell: ({ row: { original: model } }) =>
        chipList({
          items: model.tiers,
          emptyLabel: "Not mapped to a tier",
          testId: "model-tiers",
          renderItem: (tier) =>
            React.createElement(Chip, { className: "font-mono" }, tier)
        }),
      meta: {
        align: "tokens"
      }
    },
    {
      id: "availability",
      header: "Availability",
      cell: ({ row: { original: model } }) =>
        React.createElement(ProviderModelAvailabilityBadge, {
          availability: model.availability
        }),
      meta: {
        // "Availability" is one long word, and a column's weight has to be
        // large enough for its own header. The workspaces table declares the
        // same header at the same weight, and the acceptance measures it
        // fitting at 390px there.
        weight: 160
      }
    },
    {
      id: "enabled",
      header: "Enabled",
      cell: ({ row: { original: model } }) =>
        React.createElement(ModelToggle, {
          model: model.id,
          enablement: model.enablement ?? undefined,
          returnTo
        })
    }
  ];
}
