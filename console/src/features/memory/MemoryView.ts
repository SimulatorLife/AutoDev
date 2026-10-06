import type {
  ExperienceEnvelope,
  MemoryInjectionUseCohortPage,
  MemoryRecord,
  MemorySessionOutcomeCohortPage,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
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
  readonly selectedExperience?: ExperienceEnvelope | null | undefined;
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
  selectedExperience,
  repositoryId,
  workspaces,
  controlFailed,
  controlRefusal,
  unapplied
}: MemoryViewProps): React.JSX.Element {
  const activeTab = listScope.tab;
  const activeRecordsCount = records.filter(
    (r) => r.status === "active"
  ).length;
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
        // Counted over the rows on this page, not over the collection, because
        // the Runtime returns an active-status total nowhere in this response.
        // The neighbouring cards publish a total in the headline and qualify
        // the page count in the subtitle; this one has only a page count, so it
        // says so rather than reading beside "1,204" as a share of it. With a
        // 25-row page it would otherwise report at most 25.
        title: "Active Claims",
        value: activeRecordsCount,
        subtitle: "Verified & in service on this page"
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
              listScope
            })
        : activeTab === "cohorts"
          ? React.createElement(MemoryCohortsView, {
              sessionCohorts,
              useCohorts,
              currentWorkspaceId: listScope.workspaceId,
              repositoryId,
              occurredFrom: listScope.from,
              occurredUntil: listScope.until
            })
          : null
  );
}
