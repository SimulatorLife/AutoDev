import type { CanonicalNavSection } from "@simulatorlife/autodev-core";
import React from "react";

import {
  type MemoryTab,
  MemoryView
} from "../../src/features/memory/MemoryView.ts";
import {
  controlApiFailureCode,
  fetchMemoryCohorts,
  fetchMemoryExperienceDetail,
  fetchMemoryExperiences,
  fetchMemoryHistory,
  fetchMemoryRecord,
  fetchMemoryRecords,
  fetchWorkspaces
} from "../../src/lib/server/control-api.ts";
import { readMemoryPortalConfig } from "../../src/lib/server/memory-portal.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.tsx";

export const dynamic = "force-dynamic";

const SECTION: CanonicalNavSection = "Memory";

interface PageProps {
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}

interface ParsedMemoryParams {
  readonly activeTab: MemoryTab;
  readonly workspaceIdParam: string;
  readonly query: string;
  readonly kind: string;
  readonly status: string;
  readonly recordId: string;
  readonly experienceId: string;
  readonly occurredFrom: string;
  readonly occurredUntil: string;
}

function parseMemoryQueryParams(
  raw: Record<string, string | string[] | undefined>
): ParsedMemoryParams {
  const getParam = (key: string): string => {
    const val = raw[key];
    if (Array.isArray(val)) return val[0] ?? "";
    return val ?? "";
  };

  const tabParam = getParam("tab");
  const activeTab: MemoryTab =
    tabParam === "experiences" ||
    tabParam === "cohorts" ||
    tabParam === "portal"
      ? tabParam
      : "records";

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  return {
    activeTab,
    workspaceIdParam: getParam("workspaceId"),
    query: getParam("query"),
    kind: getParam("kind") || "all",
    status: getParam("status") || "all",
    recordId: getParam("recordId"),
    experienceId: getParam("experienceId"),
    occurredFrom: getParam("from") || thirtyDaysAgo.toISOString(),
    occurredUntil: getParam("until") || now.toISOString()
  };
}

export default async function MemoryPage(
  props: PageProps
): Promise<React.JSX.Element> {
  const { config } = readNodeContext("/memory");
  const portal = readMemoryPortalConfig();

  const rawParams = props.searchParams ? await props.searchParams : {};
  const {
    activeTab,
    workspaceIdParam,
    query,
    kind,
    status,
    recordId,
    experienceId,
    occurredFrom,
    occurredUntil
  } = parseMemoryQueryParams(rawParams);

  if (!config) {
    return React.createElement(
      ConsolePageShell,
      { section: SECTION },
      React.createElement(ResourceUnavailable, {
        title: "Control API credential is not configured",
        code: "autodev_control_api_disabled",
        message:
          "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read governed memory.",
        ...(portal
          ? {
              hint: "You can still access the external OpenLIT memory operator UI."
            }
          : {})
      })
    );
  }

  // Load workspaces to populate workspace dropdown
  const workspacesResult = await fetchWorkspaces(config);
  const workspaces =
    workspacesResult.kind === "ok" &&
    workspacesResult.data.catalogStatus === "valid"
      ? workspacesResult.data.workspaces
      : [];
  const currentWorkspaceId =
    workspaceIdParam || workspaces[0]?.id || "SimulatorLife/AutoDev";

  // Fetch records
  const recordsResult = await fetchMemoryRecords(
    {
      workspaceId: currentWorkspaceId,
      ...(query ? { query } : {}),
      ...(kind === "all" ? {} : { kind }),
      ...(status === "all" ? {} : { status })
    },
    config
  );

  if (recordsResult.kind !== "ok") {
    const isUnavailable =
      recordsResult.kind !== "unreachable" &&
      recordsResult.code === "autodev_memory_unavailable";
    return React.createElement(
      ConsolePageShell,
      { section: SECTION },
      React.createElement(
        "div",
        { className: "flex flex-col gap-6" },
        React.createElement(ResourceUnavailable, {
          title: isUnavailable
            ? "Memory storage is not configured"
            : "Memory records could not be loaded",
          code: controlApiFailureCode(recordsResult),
          message: recordsResult.message,
          ...(isUnavailable
            ? {
                hint: "Configure AUTODEV_MEMORY_DATABASE_URL in the AutoDev runtime environment to enable PostgreSQL / pgvector memory persistence."
              }
            : {})
        })
      )
    );
  }

  // Fetch optional selected record detail and history
  const selectedRecordResult = recordId
    ? await fetchMemoryRecord(recordId, currentWorkspaceId, config)
    : null;
  const historyResult = recordId
    ? await fetchMemoryHistory(recordId, currentWorkspaceId, config)
    : null;

  // Fetch experiences
  const experiencesResult = await fetchMemoryExperiences(
    {
      workspaceId: currentWorkspaceId,
      ...(query ? { query } : {}),
      includeTaskHistory: true
    },
    config
  );

  // Fetch optional selected experience detail
  const selectedExperienceResult = experienceId
    ? await fetchMemoryExperienceDetail(
        experienceId,
        currentWorkspaceId,
        config
      )
    : null;

  // Fetch cohorts
  const cohortsResult = await fetchMemoryCohorts(
    {
      workspaceId: currentWorkspaceId,
      repositoryId: currentWorkspaceId,
      occurredFrom,
      occurredUntil
    },
    config
  );

  const records = recordsResult.data.items;
  const totalRecords = recordsResult.data.totalCount;
  const experiences =
    experiencesResult.kind === "ok" ? experiencesResult.data.items : [];
  const totalExperiences =
    experiencesResult.kind === "ok" ? experiencesResult.data.totalCount : 0;
  const sessionCohorts =
    cohortsResult.kind === "ok" ? cohortsResult.data : null;

  return React.createElement(
    ConsolePageShell,
    {
      section: SECTION,
      counts: {
        Memory: records.length
      }
    },
    React.createElement(MemoryView, {
      activeTab,
      records,
      totalRecords,
      experiences,
      totalExperiences,
      sessionCohorts,
      selectedRecord:
        selectedRecordResult?.kind === "ok"
          ? selectedRecordResult.data.memory
          : null,
      selectedHistory: historyResult?.kind === "ok" ? historyResult.data : null,
      selectedExperience:
        selectedExperienceResult?.kind === "ok"
          ? selectedExperienceResult.data.experience
          : null,
      currentWorkspaceId,
      repositoryId: currentWorkspaceId,
      workspaces,
      query,
      kind,
      status,
      occurredFrom,
      occurredUntil,
      portalHref: portal?.href ?? null
    })
  );
}
