import type {
  ExperienceEnvelope,
  MemoryInjectionUseCohortPage,
  MemoryRecord,
  MemorySessionOutcomeCohortPage,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { MemoryCohortsView } from "./MemoryCohortsView.ts";
import { MemoryExperiencesView } from "./MemoryExperiencesView.ts";
import { MemoryPortalCard } from "./MemoryPortalCard.ts";
import {
  type MemoryRecordHistory,
  MemoryRecordsView
} from "./MemoryRecordsView.ts";

export type MemoryTab = "records" | "experiences" | "cohorts" | "portal";

export interface MemoryViewProps {
  readonly activeTab: MemoryTab;
  readonly records: readonly MemoryRecord[];
  readonly totalRecords: number;
  readonly experiences: readonly ExperienceEnvelope[];
  readonly totalExperiences: number;
  readonly sessionCohorts?: MemorySessionOutcomeCohortPage | null | undefined;
  readonly useCohorts?: MemoryInjectionUseCohortPage | null | undefined;
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
  readonly portalHref?: string | null | undefined;
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
  portalHref
}: MemoryViewProps): React.JSX.Element {
  const activeRecordsCount = records.filter(
    (r) => r.status === "active"
  ).length;
  const totalObservedSessions = sessionCohorts?.sessionCount ?? 0;

  const tabButtons: { readonly id: MemoryTab; readonly label: string }[] = [
    { id: "records", label: "Durable Records" },
    { id: "experiences", label: "Experiences" },
    { id: "cohorts", label: "Outcome Cohorts" },
    { id: "portal", label: "OpenLIT Portal" }
  ];

  return React.createElement(
    "div",
    { className: "flex flex-col gap-8", "data-feature": "memory" },
    // Header
    React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(
        "div",
        { className: "flex flex-wrap items-center justify-between gap-4" },
        React.createElement(
          "div",
          null,
          React.createElement(
            "h1",
            { className: "text-2xl font-bold tracking-tight text-slate-100" },
            "Memory"
          ),
          React.createElement(
            "p",
            { className: "text-sm text-slate-400 mt-1" },
            "Governed AutoDev memory operator surface: durable claims, raw experiences, lifecycle governance, and bounded outcome cohorts."
          )
        ),
        // Workspace selector
        workspaces.length > 0
          ? React.createElement(
              "div",
              { className: "flex items-center gap-2 text-xs" },
              React.createElement(
                "span",
                { className: "text-slate-400" },
                "Workspace:"
              ),
              React.createElement(
                "select",
                {
                  defaultValue: currentWorkspaceId,
                  className:
                    "px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-500"
                },
                workspaces.map((ws) =>
                  React.createElement(
                    "option",
                    { key: ws.id, value: ws.id },
                    ws.id
                  )
                )
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
        value: totalExperiences,
        subtitle: `${experiences.length} in scope`
      }),
      React.createElement(StatCard, {
        title: "Cohort Sessions",
        value: totalObservedSessions,
        subtitle: "In window"
      })
    ),

    // Tab bar
    React.createElement(
      "div",
      { className: "flex border-b border-slate-800 gap-1" },
      tabButtons.map((tab) => {
        const isActive = activeTab === tab.id;
        return React.createElement(
          "a",
          {
            key: tab.id,
            href: `?tab=${tab.id}&workspaceId=${encodeURIComponent(currentWorkspaceId)}`,
            className: `px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              isActive
                ? "border-cyan-400 text-cyan-300 bg-slate-900/40"
                : "border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700"
            }`,
            "data-memory-tab": tab.id
          },
          tab.label
        );
      })
    ),

    // Active tab body
    activeTab === "records"
      ? React.createElement(MemoryRecordsView, {
          records,
          totalCount: totalRecords,
          selectedRecord,
          history: selectedHistory,
          currentWorkspaceId,
          currentQuery: query,
          currentKind: kind,
          currentStatus: status
        })
      : activeTab === "experiences"
        ? React.createElement(MemoryExperiencesView, {
            experiences,
            totalCount: totalExperiences,
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
          : React.createElement(
              "div",
              { className: "flex flex-col gap-4 max-w-xl" },
              portalHref
                ? React.createElement(MemoryPortalCard, { href: portalHref })
                : React.createElement(
                    "div",
                    {
                      className:
                        "p-4 rounded bg-slate-900 border border-slate-800 text-sm text-slate-400"
                    },
                    "External OpenLIT UI URL is not configured."
                  )
            )
  );
}
