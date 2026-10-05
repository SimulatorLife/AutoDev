import type {
  ExperienceEnvelope,
  MemoryInjectionUseCohortPage,
  MemoryRecord,
  MemorySessionOutcomeCohortPage,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  ConsoleForm,
  type ConsoleFormProps
} from "../../components/navigation/ConsoleForm.ts";
import { TabNav } from "../../components/tabs/Tabs.ts";
import {
  memoryHref,
  memoryScopeHiddenInputs,
  type MemoryTab,
  type MemoryUrlScope
} from "./memory-scope.ts";
import { MemoryCohortsView } from "./MemoryCohortsView.ts";
import { MemoryExperiencesView } from "./MemoryExperiencesView.ts";
import { MemoryPortalCard } from "./MemoryPortalCard.ts";
import {
  type MemoryRecordHistory,
  MemoryRecordsView
} from "./MemoryRecordsView.ts";

/**
 * Data for the active tab only. Each tab loads just what it renders, so a
 * tab switch never waits on another tab's reads.
 */
export type MemoryTabContent =
  | {
      readonly tab: "records";
      readonly records: readonly MemoryRecord[];
      readonly totalRecords: number;
      readonly selectedRecord?: MemoryRecord | null | undefined;
      readonly selectedHistory?: MemoryRecordHistory | null | undefined;
    }
  | {
      readonly tab: "experiences";
      readonly experiences: readonly ExperienceEnvelope[];
      readonly totalExperiences: number;
      readonly selectedExperience?: ExperienceEnvelope | null | undefined;
    }
  | {
      readonly tab: "cohorts";
      readonly sessionCohorts: MemorySessionOutcomeCohortPage | null;
      readonly useCohorts: MemoryInjectionUseCohortPage | null;
    }
  | { readonly tab: "portal" }
  | {
      /** The active tab's own read failed; the view keeps tabs and scope. */
      readonly tab: Exclude<MemoryTab, "portal">;
      readonly unavailable: React.ReactNode;
    };

export interface MemoryViewProps {
  readonly content: MemoryTabContent;
  /**
   * Scope-wide summary cards. The page streams them separately (see
   * `MemorySummaryStream`) so the active tab never waits on summary reads.
   */
  readonly summary: React.ReactNode;
  readonly scope: MemoryUrlScope;
  readonly repositoryId: string;
  readonly workspaces: readonly WorkspaceEntry[];
  readonly portalHref?: string | null | undefined;
}

export function MemoryView({
  content,
  summary,
  scope,
  repositoryId,
  workspaces,
  portalHref
}: MemoryViewProps): React.JSX.Element {
  const activeTab = content.tab;
  const tabButtons: { readonly id: MemoryTab; readonly label: string }[] = [
    { id: "records", label: "Durable Records" },
    { id: "experiences", label: "Experiences" },
    { id: "cohorts", label: "Outcome Cohorts" },
    { id: "portal", label: "External Memory UI" }
  ];

  const hrefForTab = (tabId: string): string =>
    memoryHref(scope, tabId as MemoryTab);

  const workspaceFormProps: ConsoleFormProps = {
    defaultsKey: memoryHref(scope, activeTab),
    action: "/memory",
    className: "flex items-center gap-2 text-xs",
    "data-memory-workspace-form": "true"
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
              ConsoleForm,
              workspaceFormProps,
              ...memoryScopeHiddenInputs(scope, activeTab, ["workspaceId"]),
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
                  defaultValue: scope.workspaceId,
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

    summary,

    React.createElement(TabNav, {
      navLabel: "Memory sections",
      basePath: "/memory",
      tabs: tabButtons,
      activeTabId: activeTab,
      hrefFor: hrefForTab
    }),

    // Active tab body
    "unavailable" in content
      ? content.unavailable
      : content.tab === "records"
        ? React.createElement(MemoryRecordsView, {
            records: content.records,
            totalCount: content.totalRecords,
            selectedRecord: content.selectedRecord,
            history: content.selectedHistory,
            scope
          })
        : content.tab === "experiences"
          ? React.createElement(MemoryExperiencesView, {
              experiences: content.experiences,
              totalCount: content.totalExperiences,
              selectedExperience: content.selectedExperience,
              scope
            })
          : content.tab === "cohorts"
            ? React.createElement(MemoryCohortsView, {
                sessionCohorts: content.sessionCohorts,
                useCohorts: content.useCohorts,
                currentWorkspaceId: scope.workspaceId,
                repositoryId,
                occurredFrom: scope.occurredFrom,
                occurredUntil: scope.occurredUntil
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
                      "External Memory UI URL is not configured."
                    )
              )
  );
}
