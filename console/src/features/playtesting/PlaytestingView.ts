import type {
  ControlApiPlaytestingHumanValidationResponse,
  PlaytestBatch,
  PlaytestComparison,
  PlaytestEpisode,
  PlaytestFinding,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import { FilterBar } from "../../components/filters/FilterBar.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import {
  LIST_PANEL_CLASS,
  NESTED_PANEL_CLASS
} from "../../components/layout/Panel.ts";
import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import { EmptyState } from "../../components/status/EmptyState.ts";
import {
  NOT_OBSERVED_LABEL,
  NOT_OBSERVED_STATUS,
  StatusBadge,
  type StatusBadgeVariant
} from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable,
  type DataTableProps
} from "../../components/tables/DataTable.ts";
import { TabNav } from "../../components/tabs/Tabs.ts";
import { FIELD_CONTROL_CLASS } from "../../components/ui/field-classes.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { PlaytestComparisonDecisionForm } from "./PlaytestComparisonDecisionForm.ts";
import { executionStatusBadge, gameOutcomeBadge } from "./playtesting-episode-presentation.ts";
import {
  PLAYTESTING_FILTER_KEYS,
  PLAYTESTING_PAGE_SIZES,
  playtestingEpisodeHref,
  playtestingFilterHref,
  type PlaytestingFilterKey,
  playtestingPageHref,
  type PlaytestingScope,
  type PlaytestingView as PlaytestingViewTab,
  playtestingViewHref
} from "./playtesting-url.ts";

const VIEW_TABS = [
  { id: "overview", label: "Run" },
  { id: "sessions", label: "Sessions" },
  { id: "findings", label: "Findings" },
  { id: "compare", label: "Compare" }
] as const;

export interface PlaytestingOverviewData {
  readonly batches: readonly PlaytestBatch[];
  readonly batchCount: number;
  readonly episodeCount: number;
  readonly findingCount: number;
  readonly comparisonCount: number;
  readonly latestEpisodes: readonly PlaytestEpisode[];
}

export type PlaytestingHumanValidation =
  | { readonly kind: "not-collected"; readonly reason: string }
  | {
      readonly kind: "unavailable";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "available";
      readonly studyId: string;
      readonly data: ControlApiPlaytestingHumanValidationResponse;
    };

export type PlaytestingListData =
  | {
      readonly resource: "episodes";
      readonly rows: readonly PlaytestEpisode[];
      readonly total: number;
      readonly nextCursor: string | null;
    }
  | {
      readonly resource: "findings";
      readonly rows: readonly PlaytestFinding[];
      readonly total: number;
      readonly nextCursor: string | null;
    }
  | {
      readonly resource: "comparisons";
      readonly rows: readonly PlaytestComparison[];
      readonly total: number;
      readonly nextCursor: string | null;
      readonly ownerActionsAvailable?: boolean | undefined;
      readonly humanValidation?: PlaytestingHumanValidation | undefined;
    };

export interface PlaytestingViewProps {
  readonly scope: PlaytestingScope;
  readonly workspaces: readonly WorkspaceEntry[];
  readonly overview?: PlaytestingOverviewData | undefined;
  readonly currentBuildSha?: string | null | undefined;
  readonly list?: PlaytestingListData | undefined;
  readonly runDashboard?: React.ReactNode | undefined;
  readonly workspacePicker?: React.ReactNode | undefined;
  readonly sessionsWorkspace?: React.ReactNode | undefined;
}

function preserveForFilterForm(
  scope: PlaytestingScope,
  editable: readonly PlaytestingFilterKey[]
): readonly { readonly name: string; readonly value: string }[] {
  const preserved: { name: string; value: string }[] = [];
  if (scope.view !== "overview")
    preserved.push({ name: "view", value: scope.view });
  for (const key of PLAYTESTING_FILTER_KEYS) {
    if (editable.includes(key)) continue;
    const value = scope.filters[key];
    if (value) preserved.push({ name: key, value });
  }
  return preserved;
}

function textFilter(
  label: string,
  name: PlaytestingFilterKey,
  value: string | undefined
): React.JSX.Element {
  return React.createElement(
    "label",
    {
      className: "flex min-w-48 flex-col gap-1 text-xs text-fg-muted",
      key: name
    },
    label,
    React.createElement("input", {
      name,
      defaultValue: value,
      className: FIELD_CONTROL_CLASS,
      maxLength: 256,
      autoComplete: "off"
    })
  );
}

function selectFilter(
  label: string,
  name: PlaytestingFilterKey,
  value: string | undefined,
  values: readonly string[]
): React.JSX.Element {
  return React.createElement(SelectField, {
    name,
    label,
    defaultValue: value ?? "",
    options: [
      { value: "", label: "All" },
      ...values.map((option) => ({ value: option, label: option }))
    ],
    className: "min-w-40",
    key: name
  });
}

function filterFields(
  scope: PlaytestingScope,
  workspaces: readonly WorkspaceEntry[]
): {
  readonly editable: readonly PlaytestingFilterKey[];
  readonly children: React.ReactNode[];
} {
  const children: React.ReactNode[] = [
    React.createElement(SelectField, {
      name: "workspaceId",
      label: "Workspace",
      defaultValue: scope.workspaceId ?? "",
      options: [
        { value: "", label: "Select workspace" },
        ...workspaces.map((workspace) => ({
          value: workspace.id,
          label: workspace.id + (workspace.enabled ? "" : " · disabled")
        }))
      ],
      className: "min-w-56",
      key: "workspaceId"
    })
  ];
  const editable: PlaytestingFilterKey[] = [];
  if (scope.view === "sessions") {
    editable.push(
      "buildSha",
      "scenario",
      "policy",
      "cohort",
      "status",
      "gameOutcome"
    );
    children.push(
      textFilter("Build SHA", "buildSha", scope.filters.buildSha),
      textFilter("Scenario", "scenario", scope.filters.scenario),
      textFilter("Policy", "policy", scope.filters.policy),
      textFilter("Cohort", "cohort", scope.filters.cohort),
      selectFilter("Execution status", "status", scope.filters.status, [
        "assigned",
        "started",
        "completed",
        "crashed",
        "infrastructure-failed",
        "cancelled",
        "budget-truncated"
      ]),
      selectFilter("Game outcome", "gameOutcome", scope.filters.gameOutcome, [
        "win",
        "loss",
        "dnf",
        "other",
        "unknown"
      ])
    );
  } else if (scope.view === "findings") {
    editable.push("severity", "status", "verificationStage", "evidenceStatus");
    children.push(
      selectFilter("Severity", "severity", scope.filters.severity, [
        "catastrophic",
        "major",
        "minor",
        "informational"
      ]),
      selectFilter("Finding status", "status", scope.filters.status, [
        "open",
        "fixed",
        "regressed",
        "withdrawn",
        "stale"
      ]),
      selectFilter(
        "Verification",
        "verificationStage",
        scope.filters.verificationStage,
        [
          "not-yet-validated",
          "fixed-on-reproduced-case",
          "sustained-improvement",
          "regressed-elsewhere",
          "insufficient-evidence"
        ]
      ),
      selectFilter("Evidence", "evidenceStatus", scope.filters.evidenceStatus, [
        "verified",
        "corroborated",
        "hypothesis",
        "not observed"
      ])
    );
  } else if (scope.view === "compare") {
    editable.push("benchmarkId", "experimentId", "decision");
    children.push(
      textFilter("Benchmark", "benchmarkId", scope.filters.benchmarkId),
      textFilter("Experiment", "experimentId", scope.filters.experimentId),
      selectFilter("Decision", "decision", scope.filters.decision, [
        "eligible-for-owner-promotion",
        "hold-regression",
        "hold-inconclusive",
        "hold-not-comparable",
        "owner-decided",
        "denied"
      ])
    );
  }
  children.push(
    React.createElement(SelectField, {
      name: "limit",
      label: "Rows per page",
      defaultValue: String(scope.limit),
      options: PLAYTESTING_PAGE_SIZES.map((size) => ({
        value: String(size),
        label: String(size)
      })),
      className: "min-w-32",
      key: "limit"
    })
  );
  return { editable, children };
}

function sectionHeading(id: string, title: string): React.JSX.Element {
  return React.createElement(
    "h2",
    { id, className: SECTION_HEADING_CLASS },
    title
  );
}

function PageSummary({
  total,
  visible,
  noun,
  nextCursor,
  scope
}: {
  readonly total: number;
  readonly visible: number;
  readonly noun: string;
  readonly nextCursor: string | null;
  readonly scope: PlaytestingScope;
}): React.JSX.Element {
  return React.createElement(
    "div",
    {
      className: "mt-4 flex flex-wrap items-center justify-between gap-3",
      "aria-live": "polite"
    },
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      `${visible} shown · ${total} matching ${noun}`
    ),
    nextCursor
      ? React.createElement(
          NavigationLink,
          {
            href: playtestingPageHref(scope, nextCursor),
            className: "text-sm font-medium text-accent hover:underline",
            dataAttributes: { "data-playtesting-next-page": "true" }
          },
          "Next page"
        )
      : null
  );
}

function overview(
  data: PlaytestingOverviewData,
  scope: PlaytestingScope,
  currentBuildSha: string | null
): React.JSX.Element {
  const latest = data.batches[0];
  const recentEpisodes = data.latestEpisodes.slice(0, 4);
  const coverage = latest?.coverageManifest ?? null;
  const coverageDetails =
    coverage === null
      ? null
      : React.createElement(
          "details",
          {
            className: `${LIST_PANEL_CLASS} group`,
            "data-coverage-manifest": coverage.contentHash
          },
          React.createElement(
            "summary",
            { className: "cursor-pointer text-sm font-semibold" },
            "Measurement coverage",
            React.createElement(
              "span",
              { className: `ml-2 ${MUTED_META_CLASS}` },
              `${String(coverage.observedEpisodes)} of ${String(coverage.assignedEpisodes)} assignments recorded · ${String(coverage.cells.filter((cell) => cell.status === "covered").length)} metric cells meet their declared thresholds`
            )
          ),
          React.createElement(
            "div",
            { className: "mt-4 flex flex-col gap-3" },
            ...coverage.cells.map((cell) => {
              const badge: { status: StatusBadgeVariant; label: string } =
                cell.status === "covered"
                  ? { status: "valid", label: "Covered" }
                  : cell.status === "not-assigned"
                    ? { status: NOT_OBSERVED_STATUS, label: "Not assigned" }
                    : cell.status === "unsupported" ||
                        cell.status === "unsupported-modality"
                      ? { status: "unavailable", label: "Unsupported" }
                      : cell.status === "partial"
                        ? { status: "unavailable", label: "Partial" }
                        : { status: "unavailable", label: "Insufficient" };
              return React.createElement(
                "div",
                {
                  key: `${cell.coverageMetricId}:${cell.phaseId ?? "whole-episode"}:${cell.scenarioFamily}:${cell.cohort}:${cell.policy}:${cell.modality}`,
                  className: "flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3",
                  "data-coverage-cell": cell.coverageMetricId
                },
                React.createElement(
                  "div",
                  { className: "min-w-0 flex-1" },
                  React.createElement(
                    "p",
                    { className: "font-medium" },
                    `${cell.coverageMetricId} · ${cell.phaseId ?? "whole episode"}`
                  ),
                  React.createElement(
                    "p",
                    { className: MUTED_META_CLASS },
                    `${cell.scenarioFamily} · ${cell.cohort} · ${cell.policy} · ${cell.modality} · ${String(cell.observedOpportunities)}/${String(cell.requiredOpportunities)} opportunities · ${cell.observedIndependentUnits === null ? "independent-unit count not observed" : `${String(cell.observedIndependentUnits)}/${String(cell.requiredIndependentUnits)} independent ${cell.analysisUnit}`}`
                  ),
                  cell.unsupportedReason === null
                    ? null
                    : React.createElement(
                        "p",
                        { className: MUTED_META_CLASS },
                        `Unsupported: ${cell.unsupportedReason}`
                      )
                ),
                React.createElement(StatusBadge, {
                  status: badge.status,
                  label: badge.label,
                  title:
                    cell.missingReasons.length > 0
                      ? cell.missingReasons.join(", ")
                      : undefined
                })
              );
            })
          )
        );

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section",
      {
        className: LIST_PANEL_CLASS,
        "aria-labelledby": "playtesting-latest-run-heading",
        "data-testid": "playtesting-latest-run"
      },
      React.createElement(
        "div",
        { className: "flex flex-wrap items-start justify-between gap-3" },
        React.createElement(
          "div",
          { className: "min-w-0" },
          React.createElement(
            "h2",
            { id: "playtesting-latest-run-heading", className: SECTION_HEADING_CLASS },
            "Latest result"
          ),
          latest
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "div",
                  { className: "flex flex-wrap items-center gap-2" },
                  React.createElement(StatusBadge, {
                    status:
                      latest.status === "completed"
                        ? "valid"
                        : latest.status === "running" || latest.status === "queued"
                          ? "pending"
                          : "unavailable",
                    label: latest.status
                  }),
                  React.createElement(
                    "span",
                    { className: "text-sm" },
                    `${String(latest.counts.completed)} of ${String(latest.counts.assigned)} assignments completed`
                  )
                ),
                React.createElement(
                  "p",
                  { className: MUTED_META_CLASS },
                  `Build ${latest.buildSha.slice(0, 12)} · ${latest.measurementVersion} · ${latest.batchId}`
                ),
                currentBuildSha !== null && latest.buildSha !== currentBuildSha
                  ? React.createElement(
                      "p",
                      { className: MUTED_META_CLASS },
                      "This result is from an earlier commit than the build currently available to run. Its evidence remains tied to the SHA shown here."
                    )
                  : null,
                React.createElement(
                  "p",
                  { className: MUTED_META_CLASS },
                  "Execution records describe whether assignments ran; game outcomes are shown separately on each session."
                )
              )
            : React.createElement(
                "p",
                { className: MUTED_BODY_CLASS },
                "No playtest runs are recorded yet. Start with the recommended bounded assignment above."
              )
        ),
        React.createElement(
          NavigationLink,
          {
            href: playtestingViewHref(scope, "sessions"),
            className: "text-sm font-medium text-accent hover:underline",
            dataAttributes: { "data-playtesting-browse-sessions": "true" }
          },
          "Browse all sessions"
        )
      ),
      latest
        ? React.createElement(
            NavigationLink,
            {
              href: playtestingFilterHref(scope, {
                view: "sessions",
                batchId: latest.batchId
              }),
              className: "mt-3 inline-flex text-sm font-medium text-accent hover:underline",
              dataAttributes: { "data-playtesting-latest-batch-sessions": latest.batchId }
            },
            "Open sessions from this run"
          )
        : null
    ),
    React.createElement(
      "section",
      { className: "flex flex-col gap-3", "aria-labelledby": "playtesting-recent-sessions-heading" },
      React.createElement(
        "div",
        { className: "flex flex-wrap items-center justify-between gap-3" },
        React.createElement(
          "h2",
          { id: "playtesting-recent-sessions-heading", className: SECTION_HEADING_CLASS },
          "Recent sessions"
        ),
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          `${String(data.episodeCount)} recorded across ${String(data.batchCount)} batches`
        )
      ),
      recentEpisodes.length === 0
        ? React.createElement(EmptyState, {
            variant: "inline",
            message:
              data.episodeCount === 0
                ? "No sessions have been persisted yet. A run can still be active or may finish without a session; check the live run status above."
                : "Recent sessions were not observed in this response. Browse the Sessions view to inspect the archive."
          })
        : React.createElement(
            "ul",
            { className: "grid gap-2", "aria-label": "Recent playtest sessions" },
            ...recentEpisodes.map((episode) =>
              React.createElement(
                "li",
                {
                  key: episode.episodeId,
                  className: "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3"
                },
                React.createElement(
                  "div",
                  { className: "min-w-0 flex-1" },
                  React.createElement(
                    "div",
                    { className: "flex flex-wrap items-center gap-2" },
                    React.createElement(
                      "span",
                      { className: "font-medium" },
                      episode.identity.scenarioId
                    ),
                    executionStatusBadge(episode.status),
                    gameOutcomeBadge(episode.outcome)
                  ),
                  React.createElement(
                    "p",
                    { className: MUTED_META_CLASS },
                    `${episode.identity.policyId} · ${episode.policyCohort} · ${String(episode.stepCount)} steps · build ${episode.identity.buildSha.slice(0, 12)}`
                  )
                ),
                React.createElement(
                  NavigationLink,
                  {
                    href: playtestingEpisodeHref(scope, episode.episodeId, null),
                    className: "text-sm font-medium text-accent hover:underline",
                    dataAttributes: { "data-playtest-episode-link": episode.episodeId }
                  },
                  "Inspect result"
                )
              )
            )
          )
    ),
    coverageDetails
  );
}

function findingsTable(
  rows: readonly PlaytestFinding[],
  total: number,
  scope: PlaytestingScope,
  nextCursor: string | null
): React.JSX.Element {
  const columns: readonly ColumnDef<PlaytestFinding>[] = [
    {
      id: "finding",
      header: "Finding",
      weight: 260,
      align: "prose",
      clampLines: 2,
      cell: (finding) =>
        React.createElement(
          "div",
          {
            id: `finding-${finding.findingId}`,
            tabIndex: -1,
            "data-finding-row": finding.findingId
          },
          React.createElement(
            "p",
            { className: "font-medium text-fg" },
            finding.title
          ),
          React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            finding.findingId
          )
        )
    },
    {
      id: "severity",
      header: "Severity",
      weight: 100,
      cell: (finding) => finding.severity
    },
    {
      id: "status",
      header: "Status",
      weight: 100,
      cell: (finding) => finding.status
    },
    {
      id: "evidence",
      header: "Evidence",
      weight: 160,
      cell: (finding) => finding.evidenceStatus
    },
    {
      id: "exposure",
      header: "Episodes affected",
      weight: 150,
      cell: (finding) =>
        finding.affectedEpisodes === null ||
        finding.totalEligibleEpisodes === null
          ? "Not observed"
          : `${finding.affectedEpisodes} / ${finding.totalEligibleEpisodes}`
    },
    {
      id: "witness",
      header: "Witness",
      weight: 120,
      cell: (finding) => {
        const episode = finding.evidenceRefs.find(
          (ref) => ref.kind === "episode"
        );
        if (!episode)
          return React.createElement(StatusBadge, {
            status: NOT_OBSERVED_STATUS,
            label: NOT_OBSERVED_LABEL
          });
        return React.createElement(
          NavigationLink,
          {
            href: playtestingEpisodeHref(
              scope,
              episode.id,
              episode.step ?? null,
              finding.findingId
            ),
            className: "text-accent hover:underline",
            dataAttributes: { "data-finding-witness": finding.findingId }
          },
          "Open witness"
        );
      }
    }
  ];
  return React.createElement(
    "section",
    {
      className: LIST_PANEL_CLASS,
      "aria-labelledby": "playtesting-findings-heading"
    },
    sectionHeading("playtesting-findings-heading", "Findings"),
    React.createElement<DataTableProps<PlaytestFinding>>(DataTable, {
      data: rows,
      columns,
      keyExtractor: (finding) => `${finding.findingId}:${finding.version}`,
      emptyMessage:
        total === 0
          ? "No findings are recorded for this workspace and filter set. A session win or loss is not itself a finding; findings require a separate evidence-based investigation."
          : "No findings appear on this page; check the active cursor and filters."
    }),
    React.createElement(PageSummary, {
      total,
      visible: rows.length,
      noun: "findings",
      nextCursor,
      scope
    })
  );
}

function humanValidationSuppressionBadge(
  state: "suppressed" | "partially-suppressed" | "unsuppressed"
): React.JSX.Element {
  return React.createElement(StatusBadge, {
    status: state === "unsuppressed" ? "valid" : "unavailable",
    label:
      state === "suppressed"
        ? "Suppressed"
        : state === "partially-suppressed"
          ? "Partially suppressed"
          : "Unsuppressed"
  });
}

function humanValidationCell(cell: {
  readonly id: string;
  readonly name: string;
  readonly state: "suppressed" | "partially-suppressed" | "unsuppressed";
  readonly mean: number | null;
  readonly respondents: number | null;
  readonly missing: number | null;
  readonly unit: string;
}): React.JSX.Element {
  return React.createElement(
    "li",
    {
      className: NESTED_PANEL_CLASS,
      key: cell.id,
      "data-human-cell": cell.id,
      "data-suppression-state": cell.state
    },
    React.createElement("strong", null, cell.name),
    cell.state === "suppressed" || cell.mean === null
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          cell.state === "suppressed"
            ? "Suppressed to protect small cells"
            : "Not observed"
        )
      : React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          `Native mean ${String(cell.mean)} ${cell.unit} · n=${String(cell.respondents)} · missing=${String(cell.missing)}`
        )
  );
}

function humanPreferenceContent(
  preference: ControlApiPlaytestingHumanValidationResponse["preference"]
): React.ReactNode[] {
  if (preference === null) {
    return [
      React.createElement(StatusBadge, {
        key: "preference-status",
        status: NOT_OBSERVED_STATUS,
        label: "Preference not collected"
      })
    ];
  }
  const content: React.ReactNode[] = [
    React.createElement(
      "h4",
      { className: "font-medium text-fg", key: "preference-heading" },
      "Paired-build preference (separate from PXI)"
    ),
    humanValidationSuppressionBadge(preference.suppressionState),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS, key: "preference-plan" },
      `Analysis plan ${preference.analysisPlanRef}`
    )
  ];
  if (preference.counts === null) {
    content.push(
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "preference-suppressed" },
        "Preference counts are suppressed to protect small participant or answer cells."
      )
    );
  } else {
    const counts = preference.counts;
    content.push(
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "preference-counts" },
        `Eligible completed pairs ${counts.eligibleParticipants} · A ${counts.preferA} · B ${counts.preferB} · ties ${counts.ties} · unable ${counts.unableToJudge} · missing ${counts.missing}`
      )
    );
  }
  const decisionLabels = {
    "supports-b-preference":
      "Evidence supports a preference for build B beyond the registered margin",
    "supports-a-preference":
      "Evidence supports a preference for build A beyond the registered margin",
    "no-material-preference":
      "No material A/B preference was detected within the registered margin",
    inconclusive:
      "Inconclusive under the registered participant, exclusion and interval gates"
  } as const;
  content.push(
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS, key: "preference-decision" },
      decisionLabels[preference.decision]
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS, key: "preference-limits" },
      `Incomplete exposure pairs: ${preference.incompleteExposurePairs === null ? "suppressed" : String(preference.incompleteExposurePairs)}`
    )
  );
  if (preference.interval === null) {
    content.push(
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "preference-no-interval" },
        "No qualified external preference interval is available; no preference claim is made."
      )
    );
  } else {
    const probability = preference.counts
      ? preference.counts.preferB /
        (preference.counts.preferA + preference.counts.preferB)
      : null;
    content.push(
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "preference-interval" },
        `Pr(B preferred | decisive response) = ${probability === null ? "not observed" : probability.toFixed(3)} · ${(preference.interval.confidenceLevel * 100).toFixed(0)}% exact interval [${preference.interval.lower.toFixed(3)}, ${preference.interval.upper.toFixed(3)}] · ${preference.interval.libraryVersion}`
      )
    );
  }

  if (preference.reasons.length > 0) {
    content.push(
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "preference-reasons" },
        "Decision limits: " +
          preference.reasons
            .map((reason) => reason.replaceAll("-", " "))
            .join("; ")
      )
    );
  }
  return content;
}

function humanValidationSummaryContent(
  state: Extract<PlaytestingHumanValidation, { readonly kind: "available" }>
): React.ReactNode[] {
  const { data } = state;
  const summary = data.summary;
  const content: React.ReactNode[] = [
    React.createElement(
      "p",
      { className: MUTED_META_CLASS, key: "source" },
      `Study ${state.studyId} · ${summary?.instrument ?? "Human study"} · build ${data.buildSha}`
    )
  ];
  if (summary === null) {
    content.push(
      React.createElement(StatusBadge, {
        key: "status",
        status: NOT_OBSERVED_STATUS,
        label: "No instrument responses"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "none" },
        "No retained PXI/project-authored instrument responses are available for this build."
      ),
      ...humanPreferenceContent(data.preference)
    );
    return content;
  }

  content.push(
    humanValidationSuppressionBadge(summary.suppressionState),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS, key: "participants" },
      summary.retainedParticipants === null
        ? "Retained participant count suppressed"
        : `${summary.retainedParticipants} retained participants · ${summary.measurementVersion}`
    )
  );
  const cells = [
    ...summary.items.map((item) => ({
      id: `item:${item.itemId}`,
      name: item.itemId,
      state: item.suppressionState,
      mean: item.mean,
      respondents: item.respondentCount,
      missing: item.missingCount,
      unit: item.unit
    })),
    ...summary.constructs.map((item) => ({
      id: `construct:${item.constructId}`,
      name: item.constructId,
      state: item.suppressionState,
      mean: item.mean,
      respondents: item.respondentCount,
      missing: item.missingCount,
      unit: item.unit
    }))
  ];
  content.push(
    cells.length === 0
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS, key: "empty" },
          "No instrument items are configured for this study."
        )
      : React.createElement(
          "ul",
          {
            className: "grid gap-2 md:grid-cols-2",
            key: "cells",
            "aria-label": "Human-reported native-scale outcomes"
          },
          ...cells.map(humanValidationCell)
        )
  );
  if (summary.pairedDifferences.length > 0) {
    content.push(
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "paired" },
        "Paired build differences: " +
          summary.pairedDifferences
            .map((difference) =>
              difference.suppressionState === "suppressed"
                ? `${difference.itemId}: suppressed`
                : `${difference.itemId}: ${String(difference.meanDifference)} (n=${String(difference.pairedParticipants)})`
            )
            .join(" · ")
      )
    );
  }
  content.push(...humanPreferenceContent(data.preference));
  return content;
}

function humanValidationContent(
  state: PlaytestingHumanValidation | undefined
): React.ReactNode[] {
  if (!state || state.kind === "not-collected") {
    return [
      React.createElement(StatusBadge, {
        key: "status",
        status: NOT_OBSERVED_STATUS,
        label: "Not collected"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "reason" },
        state?.reason ??
          "No approved human study is linked to this comparison; model and human outcomes are not inferred from each other."
      )
    ];
  }
  if (state.kind === "unavailable") {
    return [
      React.createElement(StatusBadge, {
        key: "status",
        status: "unavailable",
        label: "Unavailable"
      }),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS, key: "message" },
        state.message
      ),
      React.createElement(
        "p",
        { className: MUTED_META_CLASS, key: "code" },
        state.code
      )
    ];
  }
  return humanValidationSummaryContent(state);
}

function humanValidationPanel(
  state: PlaytestingHumanValidation | undefined
): React.JSX.Element {
  return React.createElement(
    "section",
    {
      className: LIST_PANEL_CLASS,
      "aria-labelledby": "playtesting-human-validation-heading",
      "data-human-validation": state?.kind ?? "not-collected"
    },
    sectionHeading("playtesting-human-validation-heading", "Human validation"),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "Consent-scoped human instrument results remain on their native scale. They are not model scores, and suppressed cells are never reconstructed."
    ),
    ...humanValidationContent(state)
  );
}

function comparisonsTable(
  rows: readonly PlaytestComparison[],
  total: number,
  scope: PlaytestingScope,
  nextCursor: string | null,
  humanValidation: PlaytestingHumanValidation | undefined,
  ownerActionsAvailable: boolean
): React.JSX.Element {
  const columns: readonly ColumnDef<PlaytestComparison>[] = [
    {
      id: "comparison",
      header: "Comparison",
      weight: 180,
      align: "tokens",
      cell: (row) => row.comparisonId
    },
    {
      id: "benchmark",
      header: "Benchmark",
      weight: 160,
      align: "tokens",
      cell: (row) => row.benchmarkId
    },
    {
      id: "decision",
      header: "Decision",
      weight: 220,
      align: "prose",
      cell: (row) => row.decision
    },
    {
      id: "owner-disposition",
      header: "Owner decision",
      weight: 240,
      align: "prose",
      cell: (row) =>
        scope.workspaceId === null
          ? React.createElement(StatusBadge, {
              status: NOT_OBSERVED_STATUS,
              label: "No owner decision recorded"
            })
          : React.createElement(PlaytestComparisonDecisionForm, {
              workspaceId: scope.workspaceId,
              comparison: row,
              enabled: ownerActionsAvailable
            })
    },
    {
      id: "metrics",
      header: "Per-metric conclusions",
      weight: 300,
      align: "prose",
      cell: (row) =>
        row.metrics.length === 0
          ? React.createElement(StatusBadge, {
              status: NOT_OBSERVED_STATUS,
              label: NOT_OBSERVED_LABEL
            })
          : React.createElement(
              "ul",
              { className: "list-disc pl-5" },
              ...row.metrics
                .slice(0, 4)
                .map((metric) =>
                  React.createElement(
                    "li",
                    { key: `${metric.metricId}:${metric.metricVersion}` },
                    `${metric.metricId}: ${metric.classification}`
                  )
                )
            )
    },
    {
      id: "human",
      header: "Human preference",
      weight: 150,
      cell: (row) =>
        row.humanPreference.answer === "not-collected"
          ? React.createElement(StatusBadge, {
              status: NOT_OBSERVED_STATUS,
              label: "Not collected"
            })
          : row.humanPreference.answer
    }
  ];
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section",
      {
        className: LIST_PANEL_CLASS,
        "aria-labelledby": "playtesting-comparisons-heading"
      },
      sectionHeading("playtesting-comparisons-heading", "Comparisons"),
      React.createElement<DataTableProps<PlaytestComparison>>(DataTable, {
        data: rows,
        columns,
        keyExtractor: (row) => `${row.comparisonId}:${row.version}`,
        emptyMessage:
          total === 0
            ? "No comparisons are recorded for these filters."
            : "No comparisons appear on this page; check the active cursor and filters."
      }),
      React.createElement(PageSummary, {
        total,
        visible: rows.length,
        noun: "comparisons",
        nextCursor,
        scope
      })
    ),
    humanValidationPanel(humanValidation)
  );
}

function activeList(
  data: PlaytestingListData,
  scope: PlaytestingScope,
  sessionsWorkspace: React.ReactNode
): React.JSX.Element {
  if (data.resource === "episodes") {
    return sessionsWorkspace
      ? React.createElement(React.Fragment, null, sessionsWorkspace)
      : React.createElement(EmptyState, {
          message: "The session workspace could not be loaded."
        });
  }
  if (data.resource === "findings") {
    return findingsTable(data.rows, data.total, scope, data.nextCursor);
  }
  return comparisonsTable(
    data.rows,
    data.total,
    scope,
    data.nextCursor,
    data.humanValidation,
    data.ownerActionsAvailable ?? false
  );
}

function workspaceControls(
  scope: PlaytestingScope,
  workspaces: readonly WorkspaceEntry[],
  workspacePicker: React.ReactNode,
  fields: ReturnType<typeof filterFields>
): React.ReactNode {
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === scope.workspaceId
  );
  if (scope.view === "overview") {
    return React.createElement(
      "div",
      {
        className:
          "flex flex-wrap items-end justify-between gap-3 rounded-lg border border-border bg-surface p-4"
      },
      workspacePicker,
      scope.workspaceId
        ? React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            `${scope.workspaceId}${selectedWorkspace?.enabled === false ? " · disabled; history is read-only" : ""}`
          )
        : React.createElement(
            "p",
            { className: MUTED_META_CLASS },
            "Choose the game workspace whose committed build you want to test."
          )
    );
  }
  return React.createElement(
    "details",
    { className: "rounded-lg border border-border bg-surface p-4" },
    React.createElement(
      "summary",
      { className: "cursor-pointer text-sm font-medium" },
      "Filters and page size",
      scope.workspaceId
        ? React.createElement(
            "span",
            { className: `ml-2 ${MUTED_META_CLASS}` },
            scope.workspaceId
          )
        : null
    ),
    React.createElement(
      "div",
      { className: "mt-4" },
      React.createElement(FilterBar, {
        label: "Playtesting filters",
        action: "/playtesting",
        preserved: preserveForFilterForm(scope, fields.editable),
        summary: scope.workspaceId
          ? `Workspace: ${scope.workspaceId}${selectedWorkspace?.enabled === false ? " · disabled; history is read-only" : ""}`
          : "Choose a workspace to read playtest data.",
        children: React.createElement(React.Fragment, null, ...fields.children)
      })
    )
  );
}

function invalidQueryNotice(scope: PlaytestingScope): React.ReactNode {
  return scope.invalidQuery
    ? React.createElement(
        "p",
        { className: "text-sm text-warning", role: "status" },
        "Some URL parameters were duplicated or invalid; unsupported values were not applied."
      )
    : null;
}

function viewContent(
  scope: PlaytestingScope,
  overviewData: PlaytestingOverviewData | undefined,
  list: PlaytestingListData | undefined,
  sessionsWorkspace: React.ReactNode,
  currentBuildSha: string | null
): React.ReactNode {
  if (scope.view === "overview" && overviewData) {
    return overview(overviewData, scope, currentBuildSha);
  }
  if (list) return activeList(list, scope, sessionsWorkspace);
  return React.createElement(EmptyState, {
    message: scope.workspaceId
      ? "The selected Playtesting view has no loaded result page."
      : "Choose a workspace to start a run or read its playtest history."
  });
}

export function PlaytestingView({
  scope,
  workspaces,
  overview: overviewData,
  currentBuildSha = null,
  list,
  runDashboard,
  workspacePicker,
  sessionsWorkspace
}: PlaytestingViewProps): React.JSX.Element {
  const fields = filterFields(scope, workspaces);
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === scope.workspaceId
  );
  return React.createElement(
    PageBody,
    {
      feature: "playtesting",
      attributes: {
        "data-view": scope.view,
        "data-workspace": scope.workspaceId ?? "",
        "data-workspace-enabled": selectedWorkspace?.enabled ? "true" : "false"
      }
    },
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      "Start a bounded playtest, follow its server-confirmed status, then inspect recorded sessions. Execution, game outcomes, replay integrity, and analyst hypotheses are distinct."
    ),
    React.createElement(TabNav, {
      navLabel: "Playtesting views",
      basePath: "/playtesting",
      tabs: VIEW_TABS,
      activeTabId: scope.view,
      hrefFor: (view) => playtestingViewHref(scope, view as PlaytestingViewTab)
    }),
    workspaceControls(scope, workspaces, workspacePicker, fields),
    invalidQueryNotice(scope),
    scope.workspaceId ? runDashboard : null,
    viewContent(scope, overviewData, list, sessionsWorkspace, currentBuildSha)
  );
}
