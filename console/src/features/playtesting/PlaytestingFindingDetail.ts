/**
 * The detail panel a finding opens.
 *
 * A finding is a claim about the game that outlives the session it was
 * observed in: it carries an identity that is stable across builds, the
 * workflow state it has reached, how often it has been seen, and the evidence
 * that points at the exact place it was seen. The list row can hold a title and
 * a status; it cannot hold that. So the row opens this panel, and the panel
 * answers the questions a reader actually has about a finding: how well is it
 * supported, how often has it happened, where is the evidence, and what is it
 * being tracked as.
 *
 * The panel is a disclosure under the list, reached by a link that carries the
 * finding's id in the URL, so it is shareable and Back closes it rather than
 * losing it.
 */

import type { PlaytestFinding } from "@simulatorlife/autodev-core";
import React from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { DetailDrawer } from "../../components/panels/DetailDrawer.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import {
  evidenceKindLabel,
  evidenceStatusLabel,
  findingSeverityLabel,
  findingStatusLabel,
  verificationStageLabel
} from "./playtesting-labels.ts";
import {
  PLAYTESTING_FINDING_DETAIL_ANCHOR_ID,
  playtestingEpisodeHref,
  playtestingFindingCloseHref,
  type PlaytestingScope
} from "./playtesting-url.ts";

/** The stack a drawer's sections are laid out in. */
const SECTION_STACK_CLASS = "flex flex-col gap-2";

/**
 * The tone a severity is shown with.
 *
 * Severity is the cost of the claim if it is true, so it is read as an
 * observation about the game rather than as a state of the record: a
 * catastrophic finding is an error tone, an informational one is not a
 * statement about the record's health.
 */
function findingSeverityVariant(
  severity: PlaytestFinding["severity"]
): StatusBadgeVariant {
  switch (severity) {
    case "catastrophic": {
      return "invalid";
    }
    case "major": {
      return "error";
    }
    case "minor": {
      return "unavailable";
    }
    case "informational": {
      return "configured";
    }
    default: {
      return NOT_OBSERVED_STATUS;
    }
  }
}

/**
 * How well the evidence supports the claim.
 *
 * A verified claim and a hypothesis are different facts about the same
 * subject, and reading one as the other is the mistake the whole distinction
 * exists to prevent. So the evidence status gets a tone of its own rather
 * than sharing one with the workflow status.
 */
function evidenceStatusVariant(
  status: PlaytestFinding["evidenceStatus"]
): StatusBadgeVariant {
  switch (status) {
    case "verified": {
      return "valid";
    }
    case "corroborated": {
      return "ready";
    }
    case "hypothesis": {
      return "pending";
    }
    case "not observed": {
      return NOT_OBSERVED_STATUS;
    }
    default: {
      return NOT_OBSERVED_STATUS;
    }
  }
}

/**
 * How much of the run the finding touched.
 *
 * The two numbers are read together: an affected count on its own says
 * nothing about scale, and an eligible count on its own says nothing about
 * whether the claim was ever seen. A count that was never measured reads as
 * the Console's one word for missing evidence rather than as a zero.
 */
function exposureLabel(
  affected: number | null,
  eligible: number | null
): string {
  if (affected === null || eligible === null) return NOT_OBSERVED_LABEL;
  return `${String(affected)} of ${String(eligible)}`;
}

/** The cohorts the finding was seen in; an empty list means none were recorded. */
function cohortLabel(cohorts: readonly string[]): string {
  return cohorts.length === 0 ? NOT_OBSERVED_LABEL : cohorts.join(", ");
}

/** One evidence locator, read as what it points at rather than as a record id. */
function evidenceRefLabel(ref: {
  readonly kind: string;
  readonly id: string;
  readonly step?: number | undefined;
}): string {
  const step = ref.step === undefined ? "" : ` · step ${String(ref.step)}`;
  return `${evidenceKindLabel(ref.kind)} · ${ref.id}${step}`;
}

/** Whether an evidence locator points at a session that can be opened. */
function isEpisodeRef(ref: { readonly kind: string }): boolean {
  return ref.kind === "episode";
}

export interface PlaytestingFindingDetailProps {
  readonly finding: PlaytestFinding;
  readonly scope: PlaytestingScope;
}

export function PlaytestingFindingDetail({
  finding,
  scope
}: PlaytestingFindingDetailProps): React.JSX.Element {
  const identity = finding.identity;
  const signature = identity.failureSignature;
  return React.createElement(
    DetailDrawer,
    {
      title: finding.title,
      titleMono: false,
      badges: React.createElement(
        "span",
        { className: "flex flex-wrap items-center gap-2" },
        React.createElement(StatusBadge, {
          status: findingSeverityVariant(finding.severity),
          label: findingSeverityLabel(finding.severity)
        }),
        React.createElement(StatusBadge, {
          status: evidenceStatusVariant(finding.evidenceStatus),
          label: evidenceStatusLabel(finding.evidenceStatus)
        })
      ),
      subtitle: `${finding.findingId} · version ${String(finding.version)}`,
      closeHref: playtestingFindingCloseHref(scope),
      closeLabel: "Close finding detail",
      anchorId: PLAYTESTING_FINDING_DETAIL_ANCHOR_ID,
      dataAttributes: { "data-finding-detail": finding.findingId }
    },
    React.createElement(
      DetailGrid,
      { columns: 4 },
      React.createElement(DetailValue, {
        label: "Severity",
        children: findingSeverityLabel(finding.severity)
      }),
      React.createElement(DetailValue, {
        label: "Status",
        children: findingStatusLabel(finding.status)
      }),
      React.createElement(DetailValue, {
        label: "Evidence",
        children: evidenceStatusLabel(finding.evidenceStatus)
      }),
      React.createElement(DetailValue, {
        label: "Verification",
        children: verificationStageLabel(finding.verificationStage)
      })
    ),
    React.createElement(
      DetailGrid,
      { columns: 4, className: "mt-4" },
      React.createElement(DetailValue, {
        label: "Episodes affected",
        children: exposureLabel(
          finding.affectedEpisodes,
          finding.totalEligibleEpisodes
        )
      }),
      React.createElement(DetailValue, {
        label: "Opportunities affected",
        children: exposureLabel(
          finding.affectedOpportunities,
          finding.totalEligibleOpportunities
        )
      }),
      React.createElement(DetailValue, {
        label: "Cohorts affected",
        children: cohortLabel(finding.affectedCohorts)
      }),
      React.createElement(DetailValue, {
        label: "Last verified build",
        children:
          finding.lastVerifiedBuild === null
            ? NOT_OBSERVED_LABEL
            : finding.lastVerifiedBuild
      })
    ),
    React.createElement(
      "div",
      { className: `${SECTION_STACK_CLASS} mt-4` },
      React.createElement(
        "h3",
        {
          className: SECTION_HEADING_CLASS
        },
        "What was observed"
      ),
      React.createElement(
        "p",
        { className: `text-sm leading-relaxed ${MUTED_BODY_CLASS}` },
        finding.description.length > 0
          ? finding.description
          : "This finding carries no written description."
      )
    ),
    React.createElement(
      "div",
      { className: `${SECTION_STACK_CLASS} mt-4` },
      React.createElement(
        "h3",
        {
          className: SECTION_HEADING_CLASS
        },
        `Evidence cited (${String(finding.evidenceRefs.length)})`
      ),
      finding.evidenceRefs.length === 0
        ? React.createElement(
            "p",
            { className: `text-sm ${MUTED_META_CLASS}` },
            "This finding cites no evidence."
          )
        : React.createElement(
            "ul",
            { className: "flex flex-col gap-1 text-sm text-fg-secondary" },
            finding.evidenceRefs.map((ref) =>
              React.createElement(
                "li",
                {
                  key: `${ref.kind}-${ref.id}-${String(ref.step ?? "")}`,
                  "data-finding-evidence": `${ref.kind}-${ref.id}`
                },
                isEpisodeRef(ref)
                  ? React.createElement(
                      NavigationLink,
                      {
                        href: playtestingEpisodeHref(
                          scope,
                          ref.id,
                          ref.step ?? null,
                          finding.findingId
                        ),
                        className: "text-accent hover:underline",
                        dataAttributes: {
                          "data-finding-evidence-link": finding.findingId
                        }
                      },
                      evidenceRefLabel(ref)
                    )
                  : evidenceRefLabel(ref)
              )
            )
          )
    ),
    React.createElement(
      "div",
      { className: `${SECTION_STACK_CLASS} mt-4` },
      React.createElement(
        "h3",
        {
          className: SECTION_HEADING_CLASS
        },
        "How this finding is tracked"
      ),
      React.createElement(
        "p",
        { className: `text-sm ${MUTED_META_CLASS}` },
        "The identity below is what makes this the same finding in another build or another run. It is derived from the game and the failure itself, never from the session that happened to observe it."
      ),
      React.createElement(
        DetailGrid,
        { columns: 3, className: "mt-2" },
        React.createElement(DetailValue, {
          label: "Mechanic key",
          children: identity.mechanicKey
        }),
        React.createElement(DetailValue, {
          label: "Scenario family",
          children: identity.scope.scenarioFamily
        }),
        React.createElement(DetailValue, {
          label: "Phase",
          children:
            identity.scope.phase === null
              ? NOT_OBSERVED_LABEL
              : identity.scope.phase
        }),
        React.createElement(DetailValue, {
          label: "Action",
          children:
            signature.action === null ? NOT_OBSERVED_LABEL : signature.action
        }),
        React.createElement(DetailValue, {
          label: "Witness",
          children: signature.witness
        }),
        React.createElement(DetailValue, {
          label: "Fingerprint",
          children: finding.fingerprint
        })
      )
    )
  );
}
