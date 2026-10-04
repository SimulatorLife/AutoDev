import type {
  ExperienceEnvelope,
  MemoryInjectionUseCohortPage,
  MemoryRecord,
  MemorySessionOutcomeCohortPage,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import { StatCard } from "../../components/cards/StatCard.ts";
import { TabNav } from "../../components/tabs/Tabs.ts";
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
            { className: "text-2xl font-bold tracking-tight text-fg" },
            "Memory"
          ),
          React.createElement(
            "p",
            { className: "text-sm text-fg-muted mt-1" },
            "Governed AutoDev memory operator surface: durable claims, raw experiences, lifecycle governance, and bounded outcome cohorts."
          )
        ),
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
              React.createElement(
                "label",
                { htmlFor: "memory-workspace", className: "text-fg-muted" },
                "Workspace:"
              ),
              React.createElement(
                "select",
                {
                  id: "memory-workspace",
                  name: "workspaceId",
                  defaultValue: currentWorkspaceId,
                  className:
                    "px-3 py-1.5 rounded bg-input border border-border-strong text-xs font-mono text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                },
                workspaces.map((ws) =>
                  React.createElement(
                    "option",
                    { key: ws.id, value: ws.id },
                    ws.id
                  )
                )
              ),
              React.createElement(
                "button",
                {
                  type: "submit",
                  className:
                    "rounded border border-border-strong bg-surface-raised px-2 py-1.5 text-xs font-medium text-fg hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                },
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
        value: totalExperiences,
        subtitle: `${experiences.length} in scope`
      }),
      React.createElement(StatCard, {
        title: "Cohort Sessions",
        value: totalObservedSessions,
        subtitle: "In window"
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
                        "p-4 rounded bg-surface border border-border text-sm text-fg-muted"
                    },
                    "External OpenLIT UI URL is not configured."
                  )
            )
  );
}
