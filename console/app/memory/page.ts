import {
  type CanonicalNavSection,
  type ControlApiMemoryRecordsResponse,
  EXPERIENCE_OUTCOMES,
  MEMORY_INJECTION_RESULTS,
  MEMORY_KINDS,
  MEMORY_OUTCOME_REPORT_KINDS,
  MEMORY_SESSION_COHORT_ASSIGNED_MODES,
  MEMORY_STATUSES,
  MEMORY_USE_KINDS,
  type WorkspaceEntry
} from "@simulatorlife/autodev-core";
import React from "react";

import {
  resolveFilter,
  type UnappliedFilter
} from "../../src/components/filters/resolve-filter.ts";
import { CALLOUT_WARNING_CLASS } from "../../src/components/layout/Callout.ts";
import {
  type MemoryListScope,
  type MemoryTab,
  resolveMemoryPage
} from "../../src/features/memory/memory-list-url.ts";
import { MemoryView } from "../../src/features/memory/MemoryView.ts";
import {
  isControlFailure,
  readControlRefusal
} from "../../src/lib/control-failure.ts";
import {
  type ControlApiConfig,
  controlApiFailureCode,
  type ControlApiResult,
  fetchMemoryCohorts,
  fetchMemoryExperienceDetail,
  fetchMemoryExperienceOutcomes,
  fetchMemoryExperiences,
  fetchMemoryExperienceUseAssessments,
  fetchMemoryHistory,
  fetchMemoryRecord,
  fetchMemoryRecords,
  fetchMemoryStatus,
  fetchMemoryUseCohorts,
  fetchMemoryWhy,
  fetchWorkspaces
} from "../../src/lib/server/control-api.ts";
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
  /** Rows requested per page, resolved against the Runtime's accepted sizes. */
  readonly limit: number;
  /** Rows skipped before this page. Always a multiple of `limit`. */
  readonly offset: number;
  /** Cohort-tab filters, resolved against the Runtime's own value lists. */
  readonly memoryMode: string;
  readonly injectionResult: string;
  readonly reportKind: string;
  readonly outcomeKind: string;
  readonly useKind: string;
  /** Bounded filters the URL named that this page could not honour. */
  readonly unapplied: readonly UnappliedFilter[];
}

const MEMORY_TABS = ["records", "experiences", "cohorts"] as const;

function parseMemoryQueryParams(
  raw: Record<string, string | string[] | undefined>
): ParsedMemoryParams {
  const getParam = (key: string): string => {
    const val = raw[key];
    if (Array.isArray(val)) return val[0] ?? "";
    return val ?? "";
  };

  const unapplied: UnappliedFilter[] = [];
  const resolve = (key: string, allowed: readonly string[]): string => {
    const resolved = resolveFilter(getParam(key), {
      name: key,
      allowed,
      fallback: allowed[0] ?? ""
    });
    if (resolved.unapplied !== null) {
      unapplied.push(resolved.unapplied);
    }
    return resolved.value;
  };

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // The page position is resolved with the same bounded-filter contract as the
  // kind and status selects, so `?limit=9999` is named rather than forwarded to
  // a Runtime that answers a `TypeError` for it.
  const activeTabIsCohorts = (getParam("tab") || "records") === "cohorts";
  const pagePosition = resolveMemoryPage(getParam("limit"), getParam("offset"));
  unapplied.push(...pagePosition.unapplied);

  return {
    activeTab: resolve("tab", MEMORY_TABS) as MemoryTab,
    workspaceIdParam: getParam("workspaceId"),
    query: getParam("query"),
    // Resolved against Core's own value lists, so the filter the page applies and
    // the options the select renders cannot drift apart: `?kind=bogus` used to
    // reach the Runtime as `kind=bogus` while the control read "All Kinds".
    kind: resolve("kind", ["all", ...MEMORY_KINDS]),
    status: resolve("status", ["all", ...MEMORY_STATUSES]),
    recordId: getParam("recordId"),
    experienceId: getParam("experienceId"),
    occurredFrom: getParam("from") || thirtyDaysAgo.toISOString(),
    occurredUntil: getParam("until") || now.toISOString(),
    // Cohort filters, resolved against the Runtime's own value lists so the
    // select that renders and the read that runs cannot disagree. Each is
    // read only on the cohorts tab; elsewhere they are not part of this list,
    // so carrying them would name a filter nothing applies.
    memoryMode: activeTabIsCohorts
      ? resolve("memoryMode", ["all", ...MEMORY_SESSION_COHORT_ASSIGNED_MODES])
      : "all",
    injectionResult: activeTabIsCohorts
      ? resolve("injectionResult", ["all", ...MEMORY_INJECTION_RESULTS])
      : "all",
    reportKind: activeTabIsCohorts
      ? resolve("reportKind", ["all", ...MEMORY_OUTCOME_REPORT_KINDS])
      : "all",
    outcomeKind: activeTabIsCohorts
      ? resolve("outcomeKind", ["all", ...EXPERIENCE_OUTCOMES])
      : "all",
    useKind: activeTabIsCohorts
      ? resolve("useKind", ["all", ...MEMORY_USE_KINDS])
      : "all",
    ...pagePosition.page,
    // Reported on whichever tab rendered. `tab` chooses the surface, and the
    // `kind`/`status` selects are preserved across tab links, so neither can be
    // reported from a place that may not render -- and a rule that holds on only
    // one tab is a fourth thing to remember about how filters behave.
    unapplied
  };
}

function renderNoControlApiShell(): React.JSX.Element {
  return React.createElement(
    ConsolePageShell,
    { section: SECTION },
    React.createElement(ResourceUnavailable, {
      title: "Control API credential is not configured",
      code: "autodev_control_api_disabled",
      message:
        "Set AUTODEV_CONTROL_API_TOKEN in the Next.js server environment to read governed memory."
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
type MemoryOutcomesResult = Awaited<
  ReturnType<typeof fetchMemoryExperienceOutcomes>
>;
type MemoryWhyResult = Awaited<ReturnType<typeof fetchMemoryWhy>>;
type MemoryUseAssessmentsResult = Awaited<
  ReturnType<typeof fetchMemoryExperienceUseAssessments>
>;
type MemoryRecordsFailure = Exclude<
  MemoryRecordsResult,
  { readonly kind: "ok" }
>;
type MemoryStatusResult = Awaited<ReturnType<typeof fetchMemoryStatus>>;

interface MemoryReadResults {
  readonly experiences: MemoryExperiencesResult;
  readonly selectedExperience: MemoryExperienceDetailResult | null;
  readonly selectedRecord: MemoryRecordDetailResult | null;
  readonly history: MemoryHistoryResult | null;
  readonly why: MemoryWhyResult | null;
  /**
   * The selected experience's evidence classes, each nullable because an
   * absent read is "not asked for" and a failed one is "not observed" -- two
   * different states the view must not merge.
   */
  readonly outcomes: MemoryOutcomesResult | null;
  readonly useAssessments: MemoryUseAssessmentsResult | null;
}

interface MemoryPageReadData extends MemoryReadResults {
  readonly records: ControlApiMemoryRecordsResponse;
  readonly cohorts: MemoryCohortsResult;
  readonly useCohorts: MemoryUseCohortsResult | null;
  readonly status: MemoryStatusResult;
}

type MemoryPageReadResult =
  | {
      readonly kind: "records-unavailable";
      readonly result: MemoryRecordsFailure;
      /**
       * Carried onto the failure path, and read there for the reason the failure
       * happened. Every memory read answers `autodev_memory_unavailable` when
       * storage was never configured and `autodev_memory_operation_failed` when
       * it is configured and not answering -- two different problems with two
       * different fixes, and the page used to name only the first.
       */
      readonly status: MemoryStatusResult;
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
  // Read before the records, and independently of it. This is the read that has
  // to work when the read below does not, so folding it in after would leave it
  // unreachable in the one case it exists for.
  const status = await fetchMemoryStatus(config);
  const recordsResult = await fetchMemoryRecords(
    {
      workspaceId,
      ...(params.query ? { query: params.query } : {}),
      ...(params.kind === "all" ? {} : { kind: params.kind }),
      ...(params.status === "all" ? {} : { status: params.status }),
      // The window this page resolved and every filter bar has been carrying
      // since it was added. Records and experiences read `occurred_at` bounds
      // from the Runtime; before this they accepted the filter, preserved it
      // across every navigation, and then ignored it -- the page reported a
      // bounded filter as applied on two of its three tabs.
      occurredFrom: params.occurredFrom,
      occurredUntil: params.occurredUntil,
      // The paged reads ask for the page the URL names. Without these the
      // Runtime applied its own default of 50 and the Console reported a
      // `total` it had no way to walk past.
      limit: params.limit,
      offset: params.offset
    },
    config
  );
  if (recordsResult.kind !== "ok") {
    return { kind: "records-unavailable", result: recordsResult, status };
  }

  const [
    selectedRecord,
    history,
    why,
    experiences,
    selectedExperience,
    cohorts,
    useCohorts,
    outcomes,
    useAssessments
  ] = await Promise.all([
    params.activeTab === "records" && params.recordId
      ? fetchMemoryRecord(params.recordId, workspaceId, config)
      : Promise.resolve(null),
    params.activeTab === "records" && params.recordId
      ? fetchMemoryHistory(params.recordId, workspaceId, config)
      : Promise.resolve(null),
    // The Runtime's eligibility-bounded explanation, read with the detail: it
    // reports which cited experiences this reader can still resolve, which is
    // not the same answer as the citation list on the record itself.
    params.activeTab === "records" && params.recordId
      ? fetchMemoryWhy(params.recordId, workspaceId, config)
      : Promise.resolve(null),
    fetchMemoryExperiences(
      {
        workspaceId,
        ...(params.query ? { query: params.query } : {}),
        includeTaskHistory: true,
        occurredFrom: params.occurredFrom,
        occurredUntil: params.occurredUntil,
        limit: params.limit,
        offset: params.offset
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
        occurredUntil: params.occurredUntil,
        // Forwarded only when the URL actually named one, so an unfiltered
        // cohort read stays unfiltered rather than carrying an empty array the
        // Runtime would have to interpret.
        ...(params.memoryMode === "all"
          ? {}
          : { memoryModes: [params.memoryMode] }),
        ...(params.injectionResult === "all"
          ? {}
          : { injectionResults: [params.injectionResult] }),
        ...(params.reportKind === "all"
          ? {}
          : { reportKinds: [params.reportKind] }),
        ...(params.outcomeKind === "all"
          ? {}
          : { outcomeKinds: [params.outcomeKind] })
      },
      config
    ),
    params.activeTab === "cohorts"
      ? fetchMemoryUseCohorts(
          {
            workspaceId,
            repositoryId: workspaceId,
            occurredFrom: params.occurredFrom,
            occurredUntil: params.occurredUntil,
            // The same three assignable modes both cohort reads accept.
            ...(params.memoryMode === "all"
              ? {}
              : { memoryModes: [params.memoryMode] }),
            ...(params.useKind === "all" ? {} : { useKinds: [params.useKind] })
          },
          config
        )
      : Promise.resolve(null),
    // The evidence classes for the selected experience. Read together with the
    // detail, and deliberately never merged into it: one is what the runtime
    // observed, the others are what a reporter or curator separately claimed.
    params.activeTab === "experiences" && params.experienceId
      ? fetchMemoryExperienceOutcomes(params.experienceId, workspaceId, config)
      : Promise.resolve(null),
    params.activeTab === "experiences" && params.experienceId
      ? fetchMemoryExperienceUseAssessments(
          params.experienceId,
          workspaceId,
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
      why,
      experiences,
      selectedExperience,
      cohorts,
      useCohorts,
      outcomes,
      useAssessments,
      status
    }
  };
}

/**
 * What the page can say about memory storage, given what it observed.
 *
 * The failed read is not evidence of *why* it failed. It answers `503` for both
 * "nobody configured a database" and "the database is not answering", and those
 * send the reader to two different places, so the reason is read from the status
 * read rather than inferred from the failure. When that read itself did not
 * succeed, the page says so instead of falling back to the guess it replaced --
 * a guess that is right most of the time is exactly what makes a wrong one
 * expensive.
 */
function memoryStorageNotice(
  status: MemoryStatusResult
): {
  readonly title: string;
  readonly hint?: string;
} {
  if (status.kind !== "ok") {
    return {
      title: "Memory records could not be loaded",
      hint: "Storage status was not observed, so whether memory is configured could not be confirmed."
    };
  }
  if (status.data.storage.state === "not_configured") {
    return {
      title: "Memory storage is not configured",
      hint: "Configure AUTODEV_MEMORY_DATABASE_URL in the AutoDev runtime environment to enable PostgreSQL / pgvector memory persistence."
    };
  }
  if (status.data.storage.state === "unreachable") {
    return {
      title: "Memory storage is unreachable",
      hint: `Durable memory is configured but the database did not answer within ${status.data.storage.probeTimeoutMs}ms. The records read may be failing for this reason rather than on their own terms.`
    };
  }
  return {
    title: "Memory records could not be loaded",
    hint: "Durable memory storage answered, so this read failed on its own terms rather than because the store is down."
  };
}

/**
 * The connection state, said only when it is something to act on.
 *
 * A storage banner on every healthy page load is chrome: it trains the operator
 * to read past the place that matters. So this renders only for the two states
 * that are wrong on their own -- a store that is not answering, and a store that
 * is answering with no embedding provider configured. The second is the one no
 * read failure ever names: records capture fine, and then cannot be retrieved
 * with, which looks exactly like memory that does not work.
 */
function memoryStorageCallout(
  status: MemoryStatusResult
): React.JSX.Element | null {
  if (status.kind !== "ok") return null;
  const storage = status.data.storage;
  if (storage.state === "unreachable") {
    return React.createElement(
      "div",
      { role: "status", className: `${CALLOUT_WARNING_CLASS} mb-4` },
      `Durable memory is configured but its database did not answer within ${storage.probeTimeoutMs}ms. Reads that succeed from here are not evidence that memory is working.`
    );
  }
  if (storage.embeddings === "not_configured") {
    return React.createElement(
      "div",
      { role: "status", className: `${CALLOUT_WARNING_CLASS} mb-4` },
      "Durable memory is connected with no embedding provider configured, so stored memories cannot be retrieved by meaning. Configure an embedding provider to make retrieval work."
    );
  }
  return null;
}

function renderRecordsUnavailableShell(
  recordsResult: Exclude<
    ControlApiResult<ControlApiMemoryRecordsResponse>,
    { readonly kind: "ok" }
  >,
  status: MemoryStatusResult
): React.JSX.Element {
  const notice = memoryStorageNotice(status);
  return React.createElement(
    ConsolePageShell,
    { section: SECTION },
    React.createElement(
      "div",
      { className: "flex flex-col gap-6" },
      React.createElement(ResourceUnavailable, {
        title: notice.title,
        code: controlApiFailureCode(recordsResult),
        message: recordsResult.message,
        ...(notice.hint ? { hint: notice.hint } : {})
      })
    )
  );
}

export default async function MemoryPage(
  props: PageProps
): Promise<React.JSX.Element> {
  const { config } = readNodeContext("/memory");

  const rawParams = props.searchParams ? await props.searchParams : {};
  const params = parseMemoryQueryParams(rawParams);

  if (!config) return renderNoControlApiShell();

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
    return renderRecordsUnavailableShell(pageResult.result, pageResult.status);
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

  // One description of the list this page is showing, handed to the views so
  // every link beneath it is built from the same facts the read used.
  const listScope: MemoryListScope = {
    tab: params.activeTab,
    workspaceId: currentWorkspaceId,
    ...(params.query ? { query: params.query } : {}),
    ...(params.kind === "all" ? {} : { kind: params.kind }),
    ...(params.status === "all" ? {} : { status: params.status }),
    from: params.occurredFrom,
    until: params.occurredUntil,
    limit: params.limit,
    offset: params.offset,
    memoryMode: params.memoryMode,
    injectionResult: params.injectionResult,
    reportKind: params.reportKind,
    outcomeKind: params.outcomeKind,
    useKind: params.useKind
  };

  const storageCallout = memoryStorageCallout(data.status);

  return React.createElement(
    ConsolePageShell,
    {
      section: SECTION,
      description:
        "Governed durable claims, raw experiences, lifecycle governance, and bounded outcome cohorts.",
      counts: {
        Memory: data.records.items.length
      }
    },
    storageCallout,
    React.createElement(MemoryView, {
      listScope,
      records: data.records.items,
      totalRecords,
      recordsStatusCounts: data.records.statusCounts,
      experiences,
      totalExperiences,
      sessionCohorts,
      useCohorts,
      selectedRecord:
        data.selectedRecord?.kind === "ok"
          ? data.selectedRecord.data.memory
          : null,
      selectedHistory: data.history?.kind === "ok" ? data.history.data : null,
      // Read above, and worth saying why it reaches the drawer: without it the
      // Runtime's eligibility-bounded explanation was fetched on every drawer
      // open and then dropped, so the provenance panel never said which cited
      // experiences this reader could resolve. `null` is a read that did not
      // succeed, which the panel renders as silence rather than as a claim.
      selectedWhy: data.why?.kind === "ok" ? data.why.data : null,
      selectedExperience:
        data.selectedExperience?.kind === "ok"
          ? data.selectedExperience.data.experience
          : null,
      selectedOutcomes:
        data.outcomes?.kind === "ok" ? data.outcomes.data.items : null,
      selectedOutcomeTotal:
        data.outcomes?.kind === "ok" ? data.outcomes.data.total : null,
      selectedUseAssessments:
        data.useAssessments?.kind === "ok"
          ? data.useAssessments.data.items
          : null,
      selectedUseAssessmentTotal:
        data.useAssessments?.kind === "ok"
          ? data.useAssessments.data.total
          : null,
      repositoryId: currentWorkspaceId,
      workspaces,
      unapplied: params.unapplied,
      controlFailed: isControlFailure(rawParams.control),
      controlRefusal: readControlRefusal(rawParams.refusal)
    })
  );
}
