import type {
  ControlApiMemoryCohortsResponse,
  ControlApiMemoryExperiencesResponse,
  ControlApiMemoryRecordsResponse,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import type { MemoryTab } from "../../src/features/memory/memory-scope.ts";
import type { MemorySummaryCounts } from "../../src/features/memory/MemorySummary.ts";
import { MemorySummaryStream } from "../../src/features/memory/MemorySummaryStream.ts";
import {
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
import { ResourceUnavailable } from "../_console.ts";

export const dynamic = "force-dynamic";

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

interface MemoryWorkspaceScope {
  readonly workspaces: readonly WorkspaceEntry[];
  readonly currentWorkspaceId: string;
}

type MemoryWorkspaceScopeResult =
  | { readonly kind: "ok"; readonly scope: MemoryWorkspaceScope }
  | {
      readonly kind: "unavailable";
      readonly title: string;
      readonly code: string;
      readonly message: string;
    };

/**
 * Resolves the URL scope exclusively against the canonical workspace source.
 * Nothing is read from Memory until the scope is known to be configured, so
 * no default workspace is ever substituted and an unknown scope is never
 * queried.
 */
async function resolveMemoryWorkspaceScope(
  config: ControlApiConfig,
  requestedWorkspaceId: string
): Promise<MemoryWorkspaceScopeResult> {
  const result = await fetchWorkspaces(config);
  if (result.kind !== "ok") {
    return {
      kind: "unavailable",
      title: "Workspace configuration could not be loaded",
      code: controlApiFailureCode(result),
      message: result.message
    };
  }

  if (result.data.catalogStatus === "invalid") {
    return {
      kind: "unavailable",
      title: "Workspace configuration is invalid",
      code: "autodev_workspace_catalog_invalid",
      message:
        "The workspace source could not be validated; no Memory scope is inferred."
    };
  }
  if (result.data.catalogStatus === "unavailable") {
    return {
      kind: "unavailable",
      title: "Workspace configuration is unavailable",
      code: "autodev_workspace_catalog_unavailable",
      message:
        "The workspace source is missing or unreadable; no Memory scope is inferred."
    };
  }

  const workspaces = result.data.workspaces;
  if (workspaces.length === 0) {
    return {
      kind: "unavailable",
      title: "No canonical workspace is configured",
      code: "autodev_workspace_catalog_empty",
      message:
        "Memory requires a configured workspace scope; no default workspace is substituted."
    };
  }

  const currentWorkspaceId = requestedWorkspaceId || workspaces[0]!.id;
  if (!workspaces.some((workspace) => workspace.id === currentWorkspaceId)) {
    return {
      kind: "unavailable",
      title: "Requested Memory workspace is not configured",
      code: "autodev_memory_workspace_unknown",
      message:
        "Select a workspace from the canonical workspace catalog; the requested scope was not queried."
    };
  }

  return { kind: "ok", scope: { workspaces, currentWorkspaceId } };
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
          hint: "You can still access the temporary external Memory UI."
        }
      : {})
  });
}

type FailedRead = Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>;

function renderTabUnavailableState(
  title: string,
  result: FailedRead
): React.JSX.Element {
  const isUnavailable =
    result.kind !== "unreachable" &&
    result.code === "autodev_memory_unavailable";
  return React.createElement(ResourceUnavailable, {
    title: isUnavailable ? "Memory storage is not configured" : title,
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
      readonly title: string;
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
    return {
      kind: "failed",
      tab: "records",
      title: "Memory records could not be loaded",
      result: records
    };
  }
  // A selected record is shown with its history or not at all; a failed
  // detail read is reported rather than rendered as an unselected list.
  if (selected && selected.kind !== "ok") {
    return {
      kind: "failed",
      tab: "records",
      title: "Selected memory record could not be loaded",
      result: selected
    };
  }
  if (history && history.kind !== "ok") {
    return {
      kind: "failed",
      tab: "records",
      title: "Memory record history could not be loaded",
      result: history
    };
  }
  return {
    kind: "ok",
    content: {
      tab: "records",
      records: records.data.items,
      totalRecords: records.data.totalCount,
      selectedRecord: selected?.data.memory ?? null,
      selectedHistory: history?.data ?? null
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
    return {
      kind: "failed",
      tab: "experiences",
      title: "Memory experiences could not be loaded",
      result: experiences
    };
  }
  if (selected && selected.kind !== "ok") {
    return {
      kind: "failed",
      tab: "experiences",
      title: "Selected memory experience could not be loaded",
      result: selected
    };
  }
  return {
    kind: "ok",
    content: {
      tab: "experiences",
      experiences: experiences.data.items,
      totalExperiences: experiences.data.totalCount,
      selectedExperience: selected?.data.experience ?? null
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
    return {
      kind: "failed",
      tab: "cohorts",
      title: "Memory outcome cohorts could not be loaded",
      result: sessionCohorts
    };
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

  const workspaceScope = await resolveMemoryWorkspaceScope(
    config,
    params.workspaceIdParam
  );
  if (workspaceScope.kind !== "ok") {
    return React.createElement(ResourceUnavailable, {
      title: workspaceScope.title,
      code: workspaceScope.code,
      message: workspaceScope.message
    });
  }
  const { workspaces, currentWorkspaceId } = workspaceScope.scope;

  // Started before the tab's reads and deliberately not awaited: the summary
  // streams to the client after the page renders.
  const summaryCounts = loadSummaryCounts(config, currentWorkspaceId, params);
  const tabLoad = await TAB_LOADERS[params.activeTab](
    params,
    currentWorkspaceId,
    config
  );
  return React.createElement(MemoryView, {
    // A failed tab read is reported in the tab body, so the tabs, scope
    // selector, and summary stay available for moving to a working view.
    content:
      tabLoad.kind === "ok"
        ? tabLoad.content
        : {
            tab: tabLoad.tab,
            unavailable: renderTabUnavailableState(
              tabLoad.title,
              tabLoad.result
            )
          },
    summary: React.createElement(MemorySummaryStream, {
      counts: summaryCounts
    }),
    scope: {
      workspaceId: currentWorkspaceId,
      query: params.query,
      kind: params.kind,
      status: params.status,
      occurredFrom: params.occurredFrom,
      occurredUntil: params.occurredUntil
    },
    repositoryId: currentWorkspaceId,
    workspaces,
    portalHref: portal?.href ?? null
  });
}
