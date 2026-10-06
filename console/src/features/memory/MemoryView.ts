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
import { SelectField } from "../../components/forms/SelectField.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { StatGrid } from "../../components/panels/DetailGrid.ts";
import { ControlFailureNotice } from "../../components/status/ControlFailureNotice.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { TabNav } from "../../components/tabs/Tabs.ts";
import { MemoryCohortsView } from "./MemoryCohortsView.ts";
import { MemoryExperiencesView } from "./MemoryExperiencesView.ts";
import {
  type MemoryRecordHistory,
  MemoryRecordsView
} from "./MemoryRecordsView.ts";

export type MemoryTab = "records" | "experiences" | "cohorts";

export interface MemoryViewProps {
  readonly activeTab: MemoryTab;
  readonly records: readonly MemoryRecord[];
  readonly totalRecords: number;
  readonly experiences: readonly ExperienceEnvelope[];
  readonly totalExperiences: number | null;
  readonly sessionCohorts: MemorySessionOutcomeCohortPage | null;
  readonly useCohorts: MemoryInjectionUseCohortPage | null;
  readonly selectedRecord?: MemoryRecord | null | undefined;
  readonly selectedHistory?: MemoryRecordHistory | null | undefined;
  readonly selectedExperience?: ExperienceEnvelope | null | undefined;
  readonly currentWorkspaceId: string;
  readonly repositoryId: string;
  readonly workspaces: readonly WorkspaceEntry[];
  readonly query?: string | undefined;
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly occurredFrom: string;
  readonly occurredUntil: string;
  /** A mutation was redirected back with the shared could-not-confirm notice. */
  readonly controlFailed?: boolean | undefined;
}

export function MemoryView({
  activeTab,
  records,
  totalRecords,
  experiences,
  totalExperiences,
  sessionCohorts,
  useCohorts,
  selectedRecord,
  selectedHistory,
  selectedExperience,
  currentWorkspaceId,
  repositoryId,
  workspaces,
  query,
  kind,
  status,
  occurredFrom,
  occurredUntil,
  controlFailed
}: MemoryViewProps): React.JSX.Element {
  const activeRecordsCount = records.filter(
    (r) => r.status === "active"
  ).length;
  const totalObservedSessions = sessionCohorts?.sessionCount ?? null;

  const tabButtons: { readonly id: MemoryTab; readonly label: string }[] = [
    { id: "records", label: "Durable Records" },
    { id: "experiences", label: "Experiences" },
    { id: "cohorts", label: "Outcome Cohorts" }
  ];

  const hrefForTab = (tabId: string): string => {
    const params = new URLSearchParams({
      tab: tabId,
      workspaceId: currentWorkspaceId,
      from: occurredFrom,
      until: occurredUntil
    });
    if (query) params.set("query", query);
    if (kind && kind !== "all") params.set("kind", kind);
    if (status && status !== "all") params.set("status", status);
    return "/memory?" + params.toString();
  };

  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-8",
      "data-feature": "memory",
      "data-memory-experiences-observed":
        totalExperiences === null ? "false" : "true",
      "data-memory-session-cohorts-observed":
        sessionCohorts === null ? "false" : "true"
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
              preserved: [
                { name: "tab", value: activeTab },
                { name: "query", value: query ?? "" },
                { name: "kind", value: kind ?? "all" },
                { name: "status", value: status ?? "all" },
                { name: "from", value: occurredFrom },
                { name: "until", value: occurredUntil }
              ],
              submitLabel: "Apply scope",
              submitTestId: "memory-workspace-apply",
              dataAttributes: { "data-memory-workspace-form": "true" }
            },
            React.createElement(SelectField, {
              name: "workspaceId",
              label: "Workspace:",
              defaultValue: currentWorkspaceId,
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
        title: "Active Claims",
        value: activeRecordsCount,
        subtitle: "Verified & in service"
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

    controlFailed ? React.createElement(ControlFailureNotice) : null,

    // Active tab body
    activeTab === "records"
      ? React.createElement(MemoryRecordsView, {
          records,
          total: totalRecords,
          selectedRecord,
          history: selectedHistory,
          currentWorkspaceId,
          currentQuery: query,
          currentKind: kind,
          currentStatus: status
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
              currentWorkspaceId,
              currentQuery: query
            })
        : activeTab === "cohorts"
          ? React.createElement(MemoryCohortsView, {
              sessionCohorts,
              useCohorts,
              currentWorkspaceId,
              repositoryId,
              occurredFrom,
              occurredUntil
            })
          : null
  );
}
