import type {
  ControlApiMemoryRecordsResponse,
  ControlApiWorkspacesResponse,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  type MemoryTab,
  MemoryView
} from "../../src/features/memory/MemoryView.ts";
import {
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

function renderRecordsUnavailableState(
  recordsResult: Exclude<
    ControlApiResult<ControlApiMemoryRecordsResponse>,
    { readonly kind: "ok" }
  >
): React.JSX.Element {
  const isUnavailable =
    recordsResult.kind !== "unreachable" &&
    recordsResult.code === "autodev_memory_unavailable";
  return React.createElement(ResourceUnavailable, {
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
  });
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
  // workspaceId, so the catalog normally loads in parallel with the scoped
  // memory reads instead of serially ahead of them.
  const workspacesRequest = fetchWorkspaces(config);
  const currentWorkspaceId =
    params.workspaceIdParam ||
    workspacesFromResult(await workspacesRequest)[0]?.id ||
    DEFAULT_WORKSPACE_ID;

  const [
    workspacesResult,
    recordsResult,
    selectedRecordResult,
    historyResult,
    experiencesResult,
    selectedExperienceResult,
    cohortsResult,
    useCohortsResult
  ] = await Promise.all([
    workspacesRequest,
    fetchMemoryRecords(
      {
        workspaceId: currentWorkspaceId,
        ...(params.query ? { query: params.query } : {}),
        ...(params.kind === "all" ? {} : { kind: params.kind }),
        ...(params.status === "all" ? {} : { status: params.status })
      },
      config
    ),
    params.recordId
      ? fetchMemoryRecord(params.recordId, currentWorkspaceId, config)
      : Promise.resolve(null),
    params.recordId
      ? fetchMemoryHistory(params.recordId, currentWorkspaceId, config)
      : Promise.resolve(null),
    fetchMemoryExperiences(
      {
        workspaceId: currentWorkspaceId,
        ...(params.query ? { query: params.query } : {}),
        includeTaskHistory: true
      },
      config
    ),
    params.experienceId
      ? fetchMemoryExperienceDetail(
          params.experienceId,
          currentWorkspaceId,
          config
        )
      : Promise.resolve(null),
    fetchMemoryCohorts(
      {
        workspaceId: currentWorkspaceId,
        repositoryId: currentWorkspaceId,
        occurredFrom: params.occurredFrom,
        occurredUntil: params.occurredUntil
      },
      config
    ),
    params.activeTab === "cohorts"
      ? fetchMemoryUseCohorts(
          {
            workspaceId: currentWorkspaceId,
            repositoryId: currentWorkspaceId,
            occurredFrom: params.occurredFrom,
            occurredUntil: params.occurredUntil
          },
          config
        )
      : Promise.resolve(null)
  ]);

  if (recordsResult.kind !== "ok") {
    return renderRecordsUnavailableState(recordsResult);
  }

  const totalRecords = recordsResult.data.totalCount;
  const experiences =
    experiencesResult.kind === "ok" ? experiencesResult.data.items : [];
  const totalExperiences =
    experiencesResult.kind === "ok" ? experiencesResult.data.totalCount : 0;
  const sessionCohorts =
    cohortsResult.kind === "ok" ? cohortsResult.data : null;
  const useCohorts =
    useCohortsResult?.kind === "ok" ? useCohortsResult.data : null;

  return React.createElement(MemoryView, {
    activeTab: params.activeTab,
    records: recordsResult.data.items,
    totalRecords,
    experiences,
    totalExperiences,
    sessionCohorts,
    useCohorts,
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
    workspaces: workspacesFromResult(workspacesResult),
    query: params.query,
    kind: params.kind,
    status: params.status,
    occurredFrom: params.occurredFrom,
    occurredUntil: params.occurredUntil,
    portalHref: portal?.href ?? null
  });
}
