import type {
  CanonicalNavSection,
  ControlApiMemoryRecordsResponse,
  WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  type MemoryTab,
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
  fetchWorkspaces
} from "../../src/lib/server/control-api.ts";
import {
  type MemoryPortalConfig,
  readMemoryPortalConfig
} from "../../src/lib/server/memory-portal.ts";
import {
  ConsolePageShell,
  readNodeContext,
  ResourceUnavailable
} from "../_console.ts";

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

function renderNoControlApiShell(
  portal: MemoryPortalConfig | null
): React.JSX.Element {
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
            hint: "You can still access the temporary external Memory UI."
          }
        : {})
    })
  );
}

function renderMemoryUnavailable(
  title: string,
  code: string,
  message: string
): React.JSX.Element {
  return React.createElement(
    ConsolePageShell,
    { section: SECTION },
    React.createElement(ResourceUnavailable, { title, code, message })
  );
}

function renderMemorySourceUnavailable(
  title: string,
  result: Exclude<ControlApiResult<unknown>, { readonly kind: "ok" }>
): React.JSX.Element {
  return renderMemoryUnavailable(
    title,
    controlApiFailureCode(result),
    result.message
  );
}

type MemoryControlApiFailure = Exclude<
  ControlApiResult<unknown>,
  { readonly kind: "ok" }
>;

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

type MemoryExperiencesResult = Awaited<
  ReturnType<typeof fetchMemoryExperiences>
>;
type MemoryExperienceDetailResult = Awaited<
  ReturnType<typeof fetchMemoryExperienceDetail>
>;
type MemoryRecordDetailResult = Awaited<ReturnType<typeof fetchMemoryRecord>>;
type MemoryHistoryResult = Awaited<ReturnType<typeof fetchMemoryHistory>>;
type MemoryRecordsResult = Awaited<ReturnType<typeof fetchMemoryRecords>>;
type MemoryCohortsResult = Awaited<ReturnType<typeof fetchMemoryCohorts>>;
type MemoryUseCohortsResult = Awaited<ReturnType<typeof fetchMemoryUseCohorts>>;
type MemoryRecordsFailure = Exclude<
  MemoryRecordsResult,
  { readonly kind: "ok" }
>;

interface MemoryReadResults {
  readonly experiences: MemoryExperiencesResult;
  readonly selectedExperience: MemoryExperienceDetailResult | null;
  readonly selectedRecord: MemoryRecordDetailResult | null;
  readonly history: MemoryHistoryResult | null;
}

interface MemoryPageReadData extends MemoryReadResults {
  readonly records: ControlApiMemoryRecordsResponse;
  readonly cohorts: MemoryCohortsResult;
  readonly useCohorts: MemoryUseCohortsResult | null;
}

type MemoryPageReadResult =
  | {
      readonly kind: "records-unavailable";
      readonly result: MemoryRecordsFailure;
    }
  | { readonly kind: "ok"; readonly data: MemoryPageReadData };

interface MemoryReadFailure {
  readonly title: string;
  readonly result: MemoryControlApiFailure;
}

function missingDetailFailure(message: string): MemoryControlApiFailure {
  return { kind: "unreachable", message };
}

function activeMemoryReadFailure(
  params: ParsedMemoryParams,
  results: MemoryReadResults
): MemoryReadFailure | null {
  if (params.activeTab === "experiences") {
    if (results.experiences.kind !== "ok") {
      return {
        title: "Memory experiences could not be loaded",
        result: results.experiences
      };
    }
    if (params.experienceId && results.selectedExperience?.kind !== "ok") {
      return {
        title: "Selected memory experience could not be loaded",
        result:
          results.selectedExperience ??
          missingDetailFailure(
            "The selected experience response was not observed."
          )
      };
    }
  }

  if (params.activeTab === "records" && params.recordId) {
    if (results.selectedRecord?.kind !== "ok") {
      return {
        title: "Selected memory record could not be loaded",
        result:
          results.selectedRecord ??
          missingDetailFailure("The selected record response was not observed.")
      };
    }
    if (results.history?.kind !== "ok") {
      return {
        title: "Memory record history could not be loaded",
        result:
          results.history ??
          missingDetailFailure("The record history response was not observed.")
      };
    }
  }

  return null;
}

async function fetchMemoryPageData(
  params: ParsedMemoryParams,
  workspaceId: string,
  config: ControlApiConfig
): Promise<MemoryPageReadResult> {
  const recordsResult = await fetchMemoryRecords(
    {
      workspaceId,
      ...(params.query ? { query: params.query } : {}),
      ...(params.kind === "all" ? {} : { kind: params.kind }),
      ...(params.status === "all" ? {} : { status: params.status })
    },
    config
  );
  if (recordsResult.kind !== "ok") {
    return { kind: "records-unavailable", result: recordsResult };
  }

  const [
    selectedRecord,
    history,
    experiences,
    selectedExperience,
    cohorts,
    useCohorts
  ] = await Promise.all([
    params.activeTab === "records" && params.recordId
      ? fetchMemoryRecord(params.recordId, workspaceId, config)
      : Promise.resolve(null),
    params.activeTab === "records" && params.recordId
      ? fetchMemoryHistory(params.recordId, workspaceId, config)
      : Promise.resolve(null),
    fetchMemoryExperiences(
      {
        workspaceId,
        ...(params.query ? { query: params.query } : {}),
        includeTaskHistory: true
      },
      config
    ),
    params.activeTab === "experiences" && params.experienceId
      ? fetchMemoryExperienceDetail(params.experienceId, workspaceId, config)
      : Promise.resolve(null),
    fetchMemoryCohorts(
      {
        workspaceId,
        repositoryId: workspaceId,
        occurredFrom: params.occurredFrom,
        occurredUntil: params.occurredUntil
      },
      config
    ),
    params.activeTab === "cohorts"
      ? fetchMemoryUseCohorts(
          {
            workspaceId,
            repositoryId: workspaceId,
            occurredFrom: params.occurredFrom,
            occurredUntil: params.occurredUntil
          },
          config
        )
      : Promise.resolve(null)
  ]);

  return {
    kind: "ok",
    data: {
      records: recordsResult.data,
      selectedRecord,
      history,
      experiences,
      selectedExperience,
      cohorts,
      useCohorts
    }
  };
}

function renderRecordsUnavailableShell(
  recordsResult: Exclude<
    ControlApiResult<ControlApiMemoryRecordsResponse>,
    { readonly kind: "ok" }
  >
): React.JSX.Element {
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

export default async function MemoryPage(
  props: PageProps
): Promise<React.JSX.Element> {
  const { config } = readNodeContext("/memory");
  const portal = readMemoryPortalConfig();

  const rawParams = props.searchParams ? await props.searchParams : {};
  const params = parseMemoryQueryParams(rawParams);

  if (!config) return renderNoControlApiShell(portal);

  // Resolve the URL scope exclusively against the canonical workspace source.
  const workspaceScope = await resolveMemoryWorkspaceScope(
    config,
    params.workspaceIdParam
  );
  if (workspaceScope.kind !== "ok") {
    return renderMemoryUnavailable(
      workspaceScope.title,
      workspaceScope.code,
      workspaceScope.message
    );
  }
  const { workspaces, currentWorkspaceId } = workspaceScope.scope;

  const pageResult = await fetchMemoryPageData(
    params,
    currentWorkspaceId,
    config
  );
  if (pageResult.kind === "records-unavailable") {
    return renderRecordsUnavailableShell(pageResult.result);
  }

  const data = pageResult.data;
  const activeReadFailure = activeMemoryReadFailure(params, data);
  if (activeReadFailure) {
    return renderMemorySourceUnavailable(
      activeReadFailure.title,
      activeReadFailure.result
    );
  }

  const totalRecords = data.records.total;
  const experiences =
    data.experiences.kind === "ok" ? data.experiences.data.items : [];
  // `null` means the source could not be observed; `0` is a real observed
  // empty result. Keeping the two distinct is what stops the summary row from
  // claiming "0 in scope" underneath a "Not observed" headline.
  const totalExperiences =
    data.experiences.kind === "ok" ? data.experiences.data.total : null;
  const sessionCohorts = data.cohorts.kind === "ok" ? data.cohorts.data : null;
  const useCohorts =
    data.useCohorts?.kind === "ok" ? data.useCohorts.data : null;

  return React.createElement(
    ConsolePageShell,
    {
      section: SECTION,
      counts: {
        Memory: data.records.items.length
      }
    },
    React.createElement(MemoryView, {
      activeTab: params.activeTab,
      records: data.records.items,
      totalRecords,
      experiences,
      totalExperiences,
      sessionCohorts,
      useCohorts,
      selectedRecord:
        data.selectedRecord?.kind === "ok"
          ? data.selectedRecord.data.memory
          : null,
      selectedHistory: data.history?.kind === "ok" ? data.history.data : null,
      selectedExperience:
        data.selectedExperience?.kind === "ok"
          ? data.selectedExperience.data.experience
          : null,
      currentWorkspaceId,
      repositoryId: currentWorkspaceId,
      workspaces,
      query: params.query,
      kind: params.kind,
      status: params.status,
      occurredFrom: params.occurredFrom,
      occurredUntil: params.occurredUntil,
      portalHref: portal?.href ?? null
    })
  );
}
