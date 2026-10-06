import type {
  ControlApiMemoryInjectionOutcomeJoin,
  ControlApiMemoryInjectionUseAssessment,
  ControlApiMemoryWhyResponse,
  ExperienceEnvelope,
  MemoryInjectionUseCohortPage,
  MemoryRecord,
  MemorySessionOutcomeCohortPage,
  MemoryStatus,
  MemoryStatusCounts,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { BarChart } from "../../components/charts/BarChart.ts";
import { FilterBar } from "../../components/filters/FilterBar.ts";
import { FilterNotice } from "../../components/filters/FilterNotice.ts";
import type { UnappliedFilter } from "../../components/filters/resolve-filter.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { PageBody } from "../../components/layout/PageBody.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { ControlFailureNotice } from "../../components/status/ControlFailureNotice.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { TabNav } from "../../components/tabs/Tabs.ts";
import {
  type MemoryListScope,
  memoryPageHref,
  type MemoryTab
} from "./memory-list-url.ts";
import { MemoryCohortsView } from "./MemoryCohortsView.ts";
import { MemoryExperiencesView } from "./MemoryExperiencesView.ts";
import {
  type MemoryRecordHistory,
  MemoryRecordsView
} from "./MemoryRecordsView.ts";

/**
 * Lifecycle statuses in an order a reader can act on, with the one-word labels
 * the status vocabulary is filtered by elsewhere on this page.
 *
 * The order is the argument rather than the vocabulary's: proposed is what a
 * curator still has work to do, active is the healthy middle, and the three
 * terminal states are what a reader is looking for when they ask whether memory
 * is any good. An alphabetical list would put `invalidated` between them.
 */
const MEMORY_STATUS_LABEL: Record<MemoryStatus, string> = {
  proposed: "Proposed",
  active: "Active",
  uncertain: "Uncertain",
  superseded: "Superseded",
  invalidated: "Invalidated"
};

const MEMORY_STATUS_ORDER: readonly MemoryStatus[] = [
  "proposed",
  "active",
  "uncertain",
  "superseded",
  "invalidated"
];

/**
 * A zero for every lifecycle status, for when the Runtime published no rollup.
 *
 * Never rendered as zero: the card above reads "Not observed" in that case. This
 * exists so the breakdown below can render without a null check in every cell,
 * and its zeros are the reason the card checks the rollup's presence separately
 * rather than reading a zero out of this object.
 */
function emptyRecordStatusCounts(): MemoryStatusCounts {
  return {
    proposed: 0,
    active: 0,
    superseded: 0,
    invalidated: 0,
    uncertain: 0
  };
}

export interface MemoryViewProps {
  /**
   * The address of the list this page is showing, and the single source for
   * every filter the page renders and every link it offers.
   *
   * This view used to take the tab, workspace, query, kind, status, and time
   * window as props of their own, beside the list the same call site had just
   * fetched with. Two descriptions of one list is one more thing to keep
   * agreeing: a caller could pass a `kind` the read never applied and the select
   * would have drawn it as the operator's choice. The scope replaced all of
   * them, so there is now exactly one.
   */
  readonly listScope: MemoryListScope;
  readonly records: readonly MemoryRecord[];
  readonly totalRecords: number;
  readonly experiences: readonly ExperienceEnvelope[];
  readonly totalExperiences: number | null;
  readonly sessionCohorts: MemorySessionOutcomeCohortPage | null;
  readonly useCohorts: MemoryInjectionUseCohortPage | null;
  readonly selectedRecord?: MemoryRecord | null | undefined;
  readonly selectedHistory?: MemoryRecordHistory | null | undefined;
  /**
   * The Runtime's eligibility-bounded explanation of the selected record, or
   * null when it was not read or could not be read.
   */
  readonly selectedWhy?: ControlApiMemoryWhyResponse | null | undefined;
  readonly selectedExperience?: ExperienceEnvelope | null | undefined;
  /**
   * What the runtime observed attaching packets, what a reporter separately
   * claimed about the task, and what a curator separately assessed of the
   * packets' use.
   *
   * Three lists, never one. Each is nullable for a different reason: null means
   * the read was not asked for or did not succeed, which the panel reports as
   * unavailable rather than as an absence of evidence.
   */
  readonly selectedOutcomes?:
    readonly ControlApiMemoryInjectionOutcomeJoin[] | null;
  readonly selectedOutcomeTotal?: number | null | undefined;
  readonly selectedUseAssessments?:
    readonly ControlApiMemoryInjectionUseAssessment[] | null;
  readonly selectedUseAssessmentTotal?: number | null | undefined;
  /** The cohort reads are scoped by repository as well as workspace. */
  readonly repositoryId: string;
  readonly workspaces: readonly WorkspaceEntry[];
  /** A mutation was redirected back with the shared could-not-confirm notice. */
  readonly controlFailed?: boolean | undefined;
  /**
   * Why the submission was refused, when the route observed a reason. Absent for
   * every mutation whose outcome the Console genuinely cannot know, which is
   * why the notice renders unchanged there.
   */
  readonly controlRefusal?: React.ComponentProps<
    typeof ControlFailureNotice
  >["refusal"];
  /**
   * Bounded URL filters this page could not honour, reported on whichever tab
   * rendered. `tab` chooses the surface and the `kind`/`status` selects are
   * preserved across tab links, so no filter can be named from a place that may
   * not render.
   */
  readonly unapplied?: readonly UnappliedFilter[] | undefined;
  /**
   * Lifecycle counts for the whole filtered collection.
   *
   * Null when the Runtime published none, which is a state the view renders
   * rather than resolves -- an absent rollup is not a collection with no active
   * claims.
   */
  readonly recordsStatusCounts?: MemoryStatusCounts | null | undefined;
}

export function MemoryView({
  listScope,
  records,
  totalRecords,
  experiences,
  totalExperiences,
  sessionCohorts,
  useCohorts,
  selectedRecord,
  selectedHistory,
  selectedWhy,
  selectedExperience,
  selectedOutcomes,
  selectedOutcomeTotal,
  selectedUseAssessments,
  selectedUseAssessmentTotal,
  repositoryId,
  workspaces,
  controlFailed,
  controlRefusal,
  unapplied,
  recordsStatusCounts
}: MemoryViewProps): React.JSX.Element {
  const activeTab = listScope.tab;
  // Counted over the collection the Runtime rolled up, not over the rows on this
  // page. `records` is the page the reader asked for; counting lifecycle states
  // off it reported at most `limit` claims beside a total of 1,204, which reads
  // as a share of it and is not one.
  const statusCounts = recordsStatusCounts ?? emptyRecordStatusCounts();
  const hasLifecycleRollup = recordsStatusCounts !== null;
  const activeRecordsCount = statusCounts.active;
  const totalObservedSessions = sessionCohorts?.sessionCount ?? null;

  const tabButtons: { readonly id: MemoryTab; readonly label: string }[] = [
    { id: "records", label: "Durable Records" },
    { id: "experiences", label: "Experiences" },
    { id: "cohorts", label: "Outcome Cohorts" }
  ];

  // Switching tab is a different list, so it returns to the first page rather
  // than carrying the previous tab's position -- the same rule the filter
  // controls follow, and for the same reason.
  const hrefForTab = (tabId: string): string =>
    memoryPageHref({ ...listScope, tab: tabId as MemoryTab }, 0);

  return React.createElement(
    PageBody,
    {
      feature: "memory",
      attributes: {
        "data-memory-experiences-observed":
          totalExperiences === null ? "false" : "true",
        "data-memory-session-cohorts-observed":
          sessionCohorts === null ? "false" : "true"
      }
    },
    // Scope controls. The resource title and its summary live in the shared
    // shell header, so this row carries controls only.
    React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      // Workspace selector submits a bounded scope change through the
      // existing URL-driven Memory page. Retain filters and time range,
      // but intentionally clear selected record/experience detail on scope
      // change so a detail from another workspace is never reused.
      workspaces.length > 0
        ? React.createElement(
            FilterBar,
            {
              label: "Memory scope filters",
              action: "/memory",
              // `offset` is deliberately absent. Changing the workspace scope
              // selects a different collection, so it starts at that
              // collection's first page; carrying the old position forward is
              // how a scope change lands on an empty table.
              preserved: [
                { name: "tab", value: activeTab },
                { name: "query", value: listScope.query ?? "" },
                { name: "kind", value: listScope.kind ?? "all" },
                { name: "status", value: listScope.status ?? "all" },
                { name: "from", value: listScope.from },
                { name: "until", value: listScope.until },
                { name: "limit", value: String(listScope.limit) }
              ],
              submitLabel: "Apply scope",
              submitTestId: "memory-workspace-apply",
              dataAttributes: { "data-memory-workspace-form": "true" }
            },
            React.createElement(SelectField, {
              name: "workspaceId",
              label: "Workspace:",
              defaultValue: listScope.workspaceId,
              testId: "memory-workspace",
              options: workspaces.map((ws) => ({
                value: ws.id,
                label: ws.id
              }))
            })
          )
        : null
    ),

    // Top stat cards
    React.createElement(
      StatGrid,
      { columns: 4 },
      React.createElement(StatCard, {
        title: "Durable Records",
        value: totalRecords,
        subtitle: `${records.length} in scope`
      }),
      React.createElement(StatCard, {
        // A collection-scoped count, published by the Runtime's own rollup.
        // While there was no such rollup this card counted the rows on the
        // page and said so in its subtitle; it now carries a number about the
        // whole filtered collection, and "not observed" is a state it can still
        // reach rather than a zero it has to invent.
        title: "Active Claims",
        value: hasLifecycleRollup
          ? activeRecordsCount.toLocaleString()
          : NOT_OBSERVED_LABEL,
        subtitle: hasLifecycleRollup
          ? "Verified & in service, all pages"
          : NOT_OBSERVED_LABEL
      }),
      React.createElement(StatCard, {
        title: "Experiences",
        value: totalExperiences ?? NOT_OBSERVED_LABEL,
        // Both headline and subtitle follow the same observed/unobserved
        // branch, so the card can never pair "Not observed" with a count.
        subtitle:
          totalExperiences === null
            ? NOT_OBSERVED_LABEL
            : `${experiences.length} in scope`
      }),
      React.createElement(StatCard, {
        title: "Cohort Sessions",
        value: totalObservedSessions ?? NOT_OBSERVED_LABEL,
        subtitle:
          totalObservedSessions === null ? NOT_OBSERVED_LABEL : "In window"
      })
    ),

    React.createElement(TabNav, {
      navLabel: "Memory sections",
      basePath: "/memory",
      tabs: tabButtons,
      activeTabId: activeTab,
      hrefFor: hrefForTab
    }),

    // Where everything we have written ended up. The stat card above answers
    // "how many are in service now"; this answers "and what happened to the rest",
    // which is the only durability signal that exists — governance is what
    // turns a pile of captured text into claims someone verified or rejected.
    hasLifecycleRollup && activeTab === "records"
      ? React.createElement(BarChart, {
          data: MEMORY_STATUS_ORDER.map((status) => ({
            label: MEMORY_STATUS_LABEL[status],
            value: statusCounts[status],
            valueText: statusCounts[status].toLocaleString()
          })),
          label: "Durable records by lifecycle status",
          notObservedMessage: NOT_OBSERVED_LABEL,
          emptyMessage:
            "No durable records were observed for this scope and time window.",
          barClass: "bg-chart-3",
          valueClass: "text-chart-3"
        })
      : null,

    controlFailed
      ? React.createElement(ControlFailureNotice, {
          refusal: controlRefusal
        })
      : null,

    // A bounded filter the URL named that this page does not accept is reported,
    // never resolved to a default and drawn as the reader's own choice:
    // `?tab=bogus` drew "Durable Records" as the current tab and said nothing.
    React.createElement(FilterNotice, { filters: unapplied ?? [] }),

    // Active tab body
    activeTab === "records"
      ? React.createElement(MemoryRecordsView, {
          records,
          total: totalRecords,
          selectedRecord,
          history: selectedHistory,
          why: selectedWhy,
          listScope
        })
      : activeTab === "experiences"
        ? totalExperiences === null
          ? React.createElement(
              "div",
              {
                role: "alert",
                className: CALLOUT_WARNING_CLASS,
                "data-status": "unavailable"
              },
              "Memory experiences are unavailable; no list or count is inferred."
            )
          : React.createElement(MemoryExperiencesView, {
              experiences,
              total: totalExperiences,
              selectedExperience,
              outcomes: selectedOutcomes,
              outcomeTotal: selectedOutcomeTotal,
              useAssessments: selectedUseAssessments,
              useAssessmentTotal: selectedUseAssessmentTotal,
              listScope
            })
        : activeTab === "cohorts"
          ? React.createElement(MemoryCohortsView, {
              sessionCohorts,
              useCohorts,
              currentWorkspaceId: listScope.workspaceId,
              repositoryId,
              occurredFrom: listScope.from,
              occurredUntil: listScope.until,
              listScope
            })
          : null
  );
}
