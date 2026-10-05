import type {
  ControlApiMemoryCohortsResponse,
  ControlApiMemoryExperiencesResponse,
  ControlApiMemoryRecordsResponse,
  ControlApiWorkspacesResponse,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import type { MemorySummaryCounts } from "../../src/features/memory/MemorySummary.ts";
import { MemorySummaryStream } from "../../src/features/memory/MemorySummaryStream.ts";
import {
  type MemoryTab,
  type MemoryTabContent,
  MemoryView
} from "../../src/features/memory/MemoryView.ts";
import {
  type ControlApiConfig,
  controlApiFailureCode,
  type ControlApiResult,
  fetchMemoryCohorts,
  fetchMemoryExperienceDetail,
  fetchMemoryExperiences,
  fetchMemoryHistory,
  fetchMemoryRecord,
  fetchMemoryRecords,
  fetchMemoryUseCohorts,
  fetchWorkspaces,
  readControlApiConfig
} from "../../src/lib/server/control-api.ts";
import {
  type MemoryPortalConfig,
  readMemoryPortalConfig
} from "../../src/lib/server/memory-portal.ts";
import { ResourceUnavailable } from "../_console.tsx";

export const dynamic = "force-dynamic";

const DEFAULT_WORKSPACE_ID = "SimulatorLife/AutoDev";

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

function workspacesFromResult(
  result: ControlApiResult<ControlApiWorkspacesResponse>
): readonly WorkspaceEntry[] {
  return result.kind === "ok" && result.data.catalogStatus === "valid"
    ? result.data.workspaces
    : [];
}

function renderNoControlApiState(
  portal: MemoryPortalConfig | null
): React.JSX.Element {
  return React.createElement(ResourceUnavailable, {
    title: "Control API credential is not configured",
    code: "autodev_control_api_disabled",
    message:
      "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read governed memory.",
    ...(portal
      ? {
          hint: "You can still access the external OpenLIT memory operator UI."
        }
      : {})
  });
}

type FailedRead = Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>;

const TAB_SUBJECT: Readonly<Record<Exclude<MemoryTab, "portal">, string>> = {
  records: "Memory records",
  experiences: "Memory experiences",
  cohorts: "Memory outcome cohorts"
};

function renderTabUnavailableState(
  tab: Exclude<MemoryTab, "portal">,
  result: FailedRead
): React.JSX.Element {
  const isUnavailable =
    result.kind !== "unreachable" &&
    result.code === "autodev_memory_unavailable";
  return React.createElement(ResourceUnavailable, {
    title: isUnavailable
      ? "Memory storage is not configured"
      : `${TAB_SUBJECT[tab]} could not be loaded`,
    code: controlApiFailureCode(result),
    message: result.message,
    ...(isUnavailable
      ? {
          hint: "Configure AUTODEV_MEMORY_DATABASE_URL in the AutoDev runtime environment to enable PostgreSQL / pgvector memory persistence."
        }
      : {})
  });
}

// Reads shared by the active tab and the streamed summary. React's
// request-scoped `cache` issues each read once per render even though both
// consumers request it, so the summary never duplicates the tab's reads.
const readRecords = React.cache(
  (
    config: ControlApiConfig,
    workspaceId: string,
    query: string,
    kind: string,
    status: string
  ): Promise<ControlApiResult<ControlApiMemoryRecordsResponse>> =>
    fetchMemoryRecords(
      {
        workspaceId,
        ...(query ? { query } : {}),
        ...(kind === "all" ? {} : { kind }),
        ...(status === "all" ? {} : { status })
      },
      config
    )
);

const readExperiences = React.cache(
  (
    config: ControlApiConfig,
    workspaceId: string,
    query: string
  ): Promise<ControlApiResult<ControlApiMemoryExperiencesResponse>> =>
    fetchMemoryExperiences(
      {
        workspaceId,
        ...(query ? { query } : {}),
        includeTaskHistory: true
      },
      config
    )
);

const readSessionCohorts = React.cache(
  (
    config: ControlApiConfig,
    workspaceId: string,
    occurredFrom: string,
    occurredUntil: string
  ): Promise<ControlApiResult<ControlApiMemoryCohortsResponse>> =>
    fetchMemoryCohorts(
      {
        workspaceId,
        repositoryId: workspaceId,
        occurredFrom,
        occurredUntil
      },
      config
    )
);

type TabLoad =
  | { readonly kind: "ok"; readonly content: MemoryTabContent }
  | {
      readonly kind: "failed";
      readonly tab: Exclude<MemoryTab, "portal">;
      readonly result: FailedRead;
    };

type TabLoader = (
  params: ParsedMemoryParams,
  workspaceId: string,
  config: ControlApiConfig
) => Promise<TabLoad>;

async function loadRecordsTab(
  params: ParsedMemoryParams,
  workspaceId: string,
  config: ControlApiConfig
): Promise<TabLoad> {
  const [records, selected, history] = await Promise.all([
    readRecords(config, workspaceId, params.query, params.kind, params.status),
    params.recordId
      ? fetchMemoryRecord(params.recordId, workspaceId, config)
      : null,
    params.recordId
      ? fetchMemoryHistory(params.recordId, workspaceId, config)
      : null
  ]);
  if (records.kind !== "ok") {
    return { kind: "failed", tab: "records", result: records };
  }
  return {
    kind: "ok",
    content: {
      tab: "records",
      records: records.data.items,
      totalRecords: records.data.totalCount,
      selectedRecord: selected?.kind === "ok" ? selected.data.memory : null,
      selectedHistory: history?.kind === "ok" ? history.data : null
    }
  };
}

async function loadExperiencesTab(
  params: ParsedMemoryParams,
  workspaceId: string,
  config: ControlApiConfig
): Promise<TabLoad> {
  const [experiences, selected] = await Promise.all([
    readExperiences(config, workspaceId, params.query),
    params.experienceId
      ? fetchMemoryExperienceDetail(params.experienceId, workspaceId, config)
      : null
  ]);
  if (experiences.kind !== "ok") {
    return { kind: "failed", tab: "experiences", result: experiences };
  }
  return {
    kind: "ok",
    content: {
      tab: "experiences",
      experiences: experiences.data.items,
      totalExperiences: experiences.data.totalCount,
      selectedExperience:
        selected?.kind === "ok" ? selected.data.experience : null
    }
  };
}

async function loadCohortsTab(
  params: ParsedMemoryParams,
  workspaceId: string,
  config: ControlApiConfig
): Promise<TabLoad> {
  const [sessionCohorts, useCohorts] = await Promise.all([
    readSessionCohorts(
      config,
      workspaceId,
      params.occurredFrom,
      params.occurredUntil
    ),
    fetchMemoryUseCohorts(
      {
        workspaceId,
        repositoryId: workspaceId,
        occurredFrom: params.occurredFrom,
        occurredUntil: params.occurredUntil
      },
      config
    )
  ]);
  if (sessionCohorts.kind !== "ok") {
    return { kind: "failed", tab: "cohorts", result: sessionCohorts };
  }
  return {
    kind: "ok",
    content: {
      tab: "cohorts",
      sessionCohorts: sessionCohorts.data,
      useCohorts: useCohorts.kind === "ok" ? useCohorts.data : null
    }
  };
}

/** Loads only what the active tab renders. */
const TAB_LOADERS: Readonly<Record<MemoryTab, TabLoader>> = {
  records: loadRecordsTab,
  experiences: loadExperiencesTab,
  cohorts: loadCohortsTab,
  portal: () => Promise.resolve({ kind: "ok", content: { tab: "portal" } })
};

/**
 * Scope-wide summary counts. The page starts these reads together with the
 * active tab's reads and streams the result after the page, so the tab never
 * waits on them; reads the tab also needs are shared through the
 * request-scoped cache.
 */
async function loadSummaryCounts(
  config: ControlApiConfig,
  workspaceId: string,
  params: ParsedMemoryParams
): Promise<MemorySummaryCounts> {
  const [records, experiences, sessionCohorts] = await Promise.all([
    readRecords(config, workspaceId, params.query, params.kind, params.status),
    readExperiences(config, workspaceId, params.query),
    readSessionCohorts(
      config,
      workspaceId,
      params.occurredFrom,
      params.occurredUntil
    )
  ]);
  return {
    records:
      records.kind === "ok"
        ? {
            total: records.data.totalCount,
            inScope: records.data.items.length,
            active: records.data.items.filter(
              (record) => record.status === "active"
            ).length
          }
        : null,
    experiences:
      experiences.kind === "ok"
        ? {
            total: experiences.data.totalCount,
            inScope: experiences.data.items.length
          }
        : null,
    cohortSessions:
      sessionCohorts.kind === "ok" ? sessionCohorts.data.sessionCount : null
  };
}

export default async function MemoryPage(
  props: PageProps
): Promise<React.JSX.Element> {
  const config = readControlApiConfig();
  const portal = readMemoryPortalConfig();

  const rawParams = props.searchParams ? await props.searchParams : {};
  const params = parseMemoryQueryParams(rawParams);

  if (!config) return renderNoControlApiState(portal);

  // The workspace catalog populates the selector and only decides the scope
  // when the URL names none. Tab, filter, and selection links always carry
  // workspaceId, so the catalog normally loads in parallel with the active
  // tab's reads instead of serially ahead of them.
  const workspacesRequest = fetchWorkspaces(config);
  const currentWorkspaceId =
    params.workspaceIdParam ||
    workspacesFromResult(await workspacesRequest)[0]?.id ||
    DEFAULT_WORKSPACE_ID;

  // Started before the tab's reads and deliberately not awaited: the summary
  // streams to the client after the page renders.
  const summaryCounts = loadSummaryCounts(config, currentWorkspaceId, params);
  const [workspacesResult, tabLoad] = await Promise.all([
    workspacesRequest,
    TAB_LOADERS[params.activeTab](params, currentWorkspaceId, config)
  ]);
  if (tabLoad.kind === "failed") {
    return renderTabUnavailableState(tabLoad.tab, tabLoad.result);
  }

  return React.createElement(MemoryView, {
    content: tabLoad.content,
    summary: React.createElement(MemorySummaryStream, {
      counts: summaryCounts
    }),
    currentWorkspaceId,
    repositoryId: currentWorkspaceId,
    workspaces: workspacesFromResult(workspacesResult),
    query: params.query,
    kind: params.kind,
    status: params.status,
    occurredFrom: params.occurredFrom,
    occurredUntil: params.occurredUntil,
    portalHref: portal?.href ?? null
  });
}
