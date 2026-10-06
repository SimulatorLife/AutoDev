import type {
  ExperienceEnvelope,
  MemoryInjectionUseCohortPage,
  MemoryRecord,
  MemorySessionOutcomeCohortPage,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { Button } from "../../components/forms/Button.ts";
import { SelectField } from "../../components/forms/SelectField.ts";
import { TabNav } from "../../components/tabs/Tabs.ts";
import { MemoryCohortsView } from "./MemoryCohortsView.ts";
import { MemoryExperiencesView } from "./MemoryExperiencesView.ts";
import {
  type MemoryRecordHistory,
  MemoryRecordsView
} from "./MemoryRecordsView.ts";

export type MemoryTab = "records" | "experiences" | "cohorts";

const NOT_OBSERVED_LABEL = "Not observed";

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
  occurredUntil
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
      React.createElement(
        "div",
        { className: "flex flex-wrap items-center gap-3" },
        // Workspace selector submits a bounded scope change through the
        // existing URL-driven Memory page. Retain filters and time range,
        // but intentionally clear selected record/experience detail on scope
        // change so a detail from another workspace is never reused.
        workspaces.length > 0
          ? React.createElement(
              "form",
              {
                method: "GET",
                action: "/memory",
                className: "flex items-center gap-2 text-xs",
                "data-memory-workspace-form": "true"
              },
              ...[
                ["tab", activeTab],
                ["query", query ?? ""],
                ["kind", kind ?? "all"],
                ["status", status ?? "all"],
                ["from", occurredFrom],
                ["until", occurredUntil]
              ].map(([name, value]) =>
                React.createElement("input", {
                  key: name,
                  type: "hidden",
                  name,
                  value
                })
              ),
              React.createElement(SelectField, {
                name: "workspaceId",
                label: "Workspace:",
                defaultValue: currentWorkspaceId,
                testId: "memory-workspace",
                options: workspaces.map((ws) => ({
                  value: ws.id,
                  label: ws.id
                }))
              }),
              React.createElement(
                Button,
                { type: "submit", testId: "memory-workspace-apply" },
                "Apply"
              )
            )
          : null
      )
    ),

    // Top stat cards
    React.createElement(
      "div",
      { className: "grid grid-cols-2 sm:grid-cols-4 gap-4" },
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
                className:
                  "rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning",
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
