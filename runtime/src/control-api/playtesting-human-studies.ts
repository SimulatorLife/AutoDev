/** Authorized human-study import/withdrawal and suppression-aware aggregate reads. */
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  type ControlApiPlaytestingHumanConsentResponse,
  type ControlApiPlaytestingHumanImportResponse,
  type ControlApiPlaytestingHumanQuarantinesResponse,
  type ControlApiPlaytestingHumanStudyRegistrationResponse,
  type ControlApiPlaytestingHumanValidationResponse,
  type ControlApiPlaytestingHumanWithdrawalResponse,
  type HumanPlaytestStudy,
  type HumanStudyExportManifest,
  type HumanStudyImportValidators,
  type PlaytestEpisode,
  type PlaytestExperiment,
  parseHumanStudyExportRows,
  PLAYTESTS_HUMAN_INSTRUMENTS,
  PLAYTESTS_HUMAN_STUDY_SCHEMA
} from "@simulatorlife/autodev-core";
import { ConfigRepository } from "@simulatorlife/autodev-data";
import {
  getDefaultRestrictedHumanResponseRepository,
  hashHumanStudyPxiItemConstructMapping,
  PlaytestRepository,
  PlaytestSourceUnavailableError,
  type RestrictedHumanResponseRepository,
  RestrictedHumanStudyNotRegisteredError,
  RestrictedHumanStudyStorageError
} from "@simulatorlife/autodev-data/playtesting";
import { WorkspacePlaytestApprovalRepository } from "@simulatorlife/autodev-data/workspaces";
import { z } from "zod/v4";

import type { PlaytestingRunControlActor } from "./playtesting-run-control.ts";
import { errorBody, sendJson } from "../router/proxy.ts";
import { writeErrorLine } from "../shared/output.ts";
import { readControlApiJsonObject } from "./body.ts";

const HUMAN_PATH = "/control/playtesting/human-studies";
const MAX_HUMAN_IMPORT_BODY_BYTES = 12_000_000;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const DATE_PATTERN = /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u;
const WRITE_ACTIONS = new Set([
  "register_human_study",
  "record_human_consent",
  "import_human_responses",
  "withdraw_human_participant",
  "resolve_human_quarantine"
]);

const versionedBuildSchema = z.strictObject({
  id: z.string().min(40).max(64).regex(SHA_PATTERN),
  version: z.union([
    z.string().min(1).max(128),
    z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  ]),
  contentHash: z.string().regex(SHA256_PATTERN).optional()
});
const studyRegistrationSchema = z.strictObject({
  schema: z.literal(PLAYTESTS_HUMAN_STUDY_SCHEMA),
  studyId: z.string().min(1).max(128).regex(ENTITY_ID_PATTERN),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  benchmarkId: z.string().min(1).max(128).regex(ENTITY_ID_PATTERN),
  allowedBuilds: z.array(versionedBuildSchema).min(1).max(16),
  pxiItemConstructMappingHash: z.string().regex(SHA256_PATTERN).nullable(),
  instrument: z.enum([...PLAYTESTS_HUMAN_INSTRUMENTS]),
  instrumentVersion: z.string().min(1).max(128),
  instrumentHash: z.string().regex(SHA256_PATTERN),
  consentVersion: z.string().min(1).max(128),
  consentScope: z.string().min(1).max(256),
  responseWindowMs: z.number().int().min(1).max(31_536_000_000),
  minimumExposureMs: z.number().int().min(0).max(31_536_000_000),
  orderDesign: z.enum(["A/B", "AB/BA", "single-build"]),
  independentUnit: z.enum(["participant", "participant-pair"]),
  missingItemPolicy: z.enum(["null-construct", "item-wise"]),
  invitedCount: z.number().int().min(0).max(1_000_000),
  eligibleCount: z.number().int().min(0).max(1_000_000),
  respondedCount: z.number().int().min(0).max(1_000_000),
  withdrawnCount: z.number().int().min(0).max(1_000_000),
  createdAt: z.string().regex(DATE_PATTERN)
});
const exportItemSchema = z.strictObject({
  itemId: z.string().min(1).max(128),
  valueColumn: z.string().min(1).max(256),
  missingReasonColumn: z.string().min(1).max(256).optional()
});
const exportManifestSchema = z.strictObject({
  studyIdColumn: z.string().min(1).max(256),
  responseIdColumn: z.string().min(1).max(256),
  revisionColumn: z.string().min(1).max(256),
  supersedesColumn: z.string().min(1).max(256),
  participantIdColumn: z.string().min(1).max(256),
  consentVersionColumn: z.string().min(1).max(256),
  consentScopeColumn: z.string().min(1).max(256),
  instrumentColumn: z.string().min(1).max(256),
  instrumentVersionColumn: z.string().min(1).max(256),
  instrumentHashColumn: z.string().min(1).max(256),
  workspaceIdColumn: z.string().min(1).max(256),
  buildIdColumn: z.string().min(1).max(256),
  buildVersionColumn: z.string().min(1).max(256),
  buildHashColumn: z.string().min(1).max(256),
  episodeIdColumn: z.string().min(1).max(256),
  exposureStartedAtColumn: z.string().min(1).max(256),
  exposureEndedAtColumn: z.string().min(1).max(256),
  orderColumn: z.string().min(1).max(256),
  submittedAtColumn: z.string().min(1).max(256),
  completionStatusColumn: z.string().min(1).max(256),
  nativeScale: z
    .strictObject({
      minimum: z.number().finite(),
      maximum: z.number().finite(),
      unit: z.string().min(1).max(128)
    })
    .optional(),
  pxiItemConstructMapping: z
    .strictObject({
      instrumentHash: z.string().regex(SHA256_PATTERN),
      items: z
        .array(
          z.strictObject({
            itemId: z.string().min(1).max(128),
            constructId: z.string().min(1).max(32)
          })
        )
        .max(256)
    })
    .optional(),
  items: z.array(exportItemSchema).min(1).max(256)
});
const importBodySchema = z.strictObject({
  format: z.enum(["csv", "json"]),
  manifest: exportManifestSchema,
  exportText: z.string().max(2_000_000)
});
const consentBodySchema = z.strictObject({
  participantId: z.string().min(1).max(256),
  consentVersion: z.string().min(1).max(128),
  consentScope: z.string().min(1).max(256)
});
const withdrawalBodySchema = z.strictObject({
  participantId: z.string().min(1).max(256)
});
const quarantineResolutionSchema = z.strictObject({
  responseIdToKeep: z.string().min(1).max(256)
});

export type PlaytestingHumanStudyRepository = Pick<
  PlaytestRepository,
  | "getLatestHumanStudy"
  | "getLatestBenchmark"
  | "listExperiments"
  | "getEpisodesByIds"
  | "insertHumanStudy"
>;

export interface PlaytestingHumanStudyControlApiOptions {
  readonly repository?: PlaytestingHumanStudyRepository;
  readonly responses?: RestrictedHumanResponseRepository;
  readonly workspaceApprovals?: WorkspacePlaytestApprovalRepository;
  readonly readWorkspaceCatalog?: () => ReturnType<
    ConfigRepository["readWorkspaceCatalog"]
  >;
  readonly repositoryRoot?: string;
  readonly audit?: (event: {
    readonly actor: string;
    readonly action: string;
    readonly workspaceId: string;
    readonly outcome: "ok" | "denied" | "error";
    readonly changes: Readonly<Record<string, unknown>> | null;
    readonly reason?: string;
  }) => void;
}

type HumanStudyAction =
  | "register"
  | "consents"
  | "import"
  | "withdrawals"
  | "validation"
  | "quarantines"
  | "resolve-quarantine";
interface HumanStudyRoute {
  readonly studyId: string | null;
  readonly action: HumanStudyAction;
}
interface WorkspaceQuery {
  readonly workspaceId: string;
  readonly params: URLSearchParams;
}

function repositoryFor(
  options: PlaytestingHumanStudyControlApiOptions
): PlaytestingHumanStudyRepository {
  return options.repository ?? new PlaytestRepository();
}
function responsesFor(
  options: PlaytestingHumanStudyControlApiOptions
): RestrictedHumanResponseRepository {
  return options.responses ?? getDefaultRestrictedHumanResponseRepository();
}
function approvalsFor(
  options: PlaytestingHumanStudyControlApiOptions
): WorkspacePlaytestApprovalRepository {
  return (
    options.workspaceApprovals ?? new WorkspacePlaytestApprovalRepository()
  );
}
function catalogFor(options: PlaytestingHumanStudyControlApiOptions) {
  return (
    options.readWorkspaceCatalog ??
    (() => new ConfigRepository(options.repositoryRoot).readWorkspaceCatalog())
  )();
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(
    response,
    status,
    errorBody(message, "autodev_control_playtesting_human_error", { code }),
    { "cache-control": "no-store" }
  );
}

function routeFor(pathname: string): HumanStudyRoute | null {
  if (pathname === HUMAN_PATH + "/register") {
    return { studyId: null, action: "register" };
  }
  if (!pathname.startsWith(HUMAN_PATH + "/")) return null;
  const parts = pathname.slice(HUMAN_PATH.length + 1).split("/");
  if (parts.length < 2 || !parts[0]) return null;
  let studyId: string;
  try {
    studyId = decodeURIComponent(parts[0]);
  } catch {
    return null;
  }
  if (!ENTITY_ID_PATTERN.test(studyId)) return null;
  if (parts.length === 2) {
    const action = parts[1];
    if (
      action === "consents" ||
      action === "import" ||
      action === "withdrawals" ||
      action === "validation" ||
      action === "quarantines"
    ) {
      return { studyId, action };
    }
  }
  if (
    parts.length === 3 &&
    parts[1] === "quarantines" &&
    parts[2] === "resolve"
  ) {
    return { studyId, action: "resolve-quarantine" };
  }
  return null;
}

function workspaceQuery(
  request: IncomingMessage,
  pathname: string,
  permitted: readonly string[],
  response: ServerResponse
): WorkspaceQuery | null {
  const params = new URL(request.url ?? pathname, "http://127.0.0.1")
    .searchParams;
  for (const key of params.keys()) {
    if (!permitted.includes(key)) {
      sendError(
        response,
        400,
        "autodev_control_playtesting_invalid_request",
        "Human-study query parameters are invalid."
      );
      return null;
    }
  }
  for (const key of permitted) {
    const values = params.getAll(key);
    if (values.length > 1) {
      sendError(
        response,
        400,
        "autodev_control_playtesting_invalid_request",
        "Human-study query parameters are duplicated."
      );
      return null;
    }
    const value = values[0];
    if (
      value !== undefined &&
      (value.length === 0 || value.length > 256 || hasControls(value))
    ) {
      sendError(
        response,
        400,
        "autodev_control_playtesting_invalid_request",
        "Human-study query parameters are invalid."
      );
      return null;
    }
  }
  const workspaceId = params.get("workspaceId") ?? "";
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_request",
      "A valid workspaceId is required."
    );
    return null;
  }
  return { workspaceId, params };
}

function hasControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function catalogWorkspace(
  workspaceId: string,
  options: PlaytestingHumanStudyControlApiOptions,
  response: ServerResponse,
  requireEnabled: boolean
): boolean {
  let catalog: ReturnType<ConfigRepository["readWorkspaceCatalog"]>;
  try {
    catalog = catalogFor(options);
  } catch {
    sendError(
      response,
      503,
      "autodev_control_playtesting_workspace_catalog_unavailable",
      "The canonical workspace catalog is unavailable."
    );
    return false;
  }
  if (catalog.status !== "valid") {
    sendError(
      response,
      503,
      "autodev_control_playtesting_workspace_catalog_unavailable",
      "The canonical workspace catalog is unavailable."
    );
    return false;
  }
  const workspace = catalog.workspaces.find(
    (entry) => entry.id === workspaceId
  );
  if (!workspace) {
    sendError(
      response,
      404,
      "autodev_control_playtesting_workspace_not_found",
      "The requested workspace is not registered."
    );
    return false;
  }
  if (requireEnabled && !workspace.enabled) {
    sendError(
      response,
      403,
      "autodev_control_playtesting_workspace_disabled",
      "The workspace is disabled for Playtesting operations."
    );
    return false;
  }
  return true;
}

function humanStudyApproval(
  workspaceId: string,
  options: PlaytestingHumanStudyControlApiOptions,
  response: ServerResponse
): boolean {
  try {
    const approval = approvalsFor(options).read(workspaceId);
    if (
      !approval ||
      approval.revokedAt !== null ||
      !approval.humanStudyAllowed
    ) {
      sendError(
        response,
        403,
        "autodev_control_playtesting_human_study_not_approved",
        "The workspace has no active human-study approval."
      );
      return false;
    }
    return true;
  } catch {
    sendError(
      response,
      503,
      "autodev_control_playtesting_human_study_approval_unavailable",
      "Human-study approval state is unavailable."
    );
    return false;
  }
}

function audit(
  options: PlaytestingHumanStudyControlApiOptions,
  actor: PlaytestingRunControlActor,
  action: string,
  workspaceId: string,
  outcome: "ok" | "denied" | "error",
  changes: Readonly<Record<string, unknown>> | null,
  reason?: string
): void {
  if (!WRITE_ACTIONS.has(action)) return;
  options.audit?.({
    actor: actor.actor,
    action,
    workspaceId,
    outcome,
    changes,
    ...(reason === undefined ? {} : { reason })
  });
}

function operatorRequired(
  actor: PlaytestingRunControlActor,
  response: ServerResponse
): boolean {
  if (actor.role === "operator") return true;
  sendError(
    response,
    403,
    "autodev_control_playtesting_operator_required",
    "Human-study management requires an authorized operator."
  );
  return false;
}

async function ensureStudyAvailable(
  workspaceId: string,
  studyId: string,
  options: PlaytestingHumanStudyControlApiOptions,
  response: ServerResponse
): Promise<HumanPlaytestStudy | null> {
  const study = await repositoryFor(options).getLatestHumanStudy(
    workspaceId,
    studyId
  );
  if (!study || study.workspaceId !== workspaceId || !study.approved) {
    sendError(
      response,
      404,
      "autodev_control_playtesting_human_study_not_found",
      "The approved human study was not found in this workspace."
    );
    return null;
  }
  return study;
}

function sameStudy(
  left: HumanPlaytestStudy,
  right: HumanPlaytestStudy
): boolean {
  const stable = (study: HumanPlaytestStudy) =>
    JSON.stringify(
      Object.keys(study)
        .sort()
        .map((key) => [key, study[key as keyof HumanPlaytestStudy]])
    );
  return stable(left) === stable(right);
}

function acceptedExperimentBuildIds(
  rows: readonly PlaytestExperiment[]
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const experiment of rows) {
    if (
      !["approved", "completed", "analyzed", "owner-decided"].includes(
        experiment.state
      )
    )
      continue;
    ids.add(experiment.baseline.id);
    ids.add(experiment.treatment.id);
  }
  return ids;
}

async function registerStudy(
  request: IncomingMessage,
  response: ServerResponse,
  actor: PlaytestingRunControlActor,
  options: PlaytestingHumanStudyControlApiOptions
): Promise<void> {
  if (!operatorRequired(actor, response)) return;
  const parsedBody = await readControlApiJsonObject(request);
  if (!parsedBody.ok) {
    sendError(response, parsedBody.status, parsedBody.code, parsedBody.message);
    return;
  }
  const parsed = z
    .strictObject({ study: studyRegistrationSchema })
    .safeParse(parsedBody.body);
  if (!parsed.success) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_study",
      "The approved human-study manifest is invalid."
    );
    return;
  }
  const input = parsed.data.study;
  if (
    input.eligibleCount > input.invitedCount ||
    input.respondedCount > input.eligibleCount ||
    input.withdrawnCount > input.invitedCount
  ) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_study",
      "Human-study counts are inconsistent."
    );
    return;
  }
  if (
    (input.instrument === "PXI") !==
    (input.pxiItemConstructMappingHash !== null)
  ) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_study",
      "Full-PXI studies require an approved mapping hash; other instruments must not provide one."
    );
    return;
  }
  if (
    !catalogWorkspace(input.workspaceId, options, response, true) ||
    !humanStudyApproval(input.workspaceId, options, response)
  )
    return;
  try {
    const repo = repositoryFor(options);
    const benchmark = await repo.getLatestBenchmark(
      input.workspaceId,
      input.benchmarkId
    );
    if (!benchmark) {
      sendError(
        response,
        400,
        "autodev_control_playtesting_human_benchmark_missing",
        "The approved benchmark for this human study does not exist."
      );
      return;
    }
    const experimentPage = await repo.listExperiments(
      { workspaceId: input.workspaceId, benchmarkId: input.benchmarkId },
      { limit: 500 }
    );
    const permittedBuilds = new Set([
      benchmark.referenceBuildSha,
      ...acceptedExperimentBuildIds(experimentPage.rows)
    ]);
    if (
      !input.allowedBuilds.some(
        (build) => build.id === benchmark.referenceBuildSha
      ) ||
      input.allowedBuilds.some((build) => !permittedBuilds.has(build.id)) ||
      (input.orderDesign === "single-build" &&
        input.allowedBuilds.length !== 1) ||
      (input.orderDesign !== "single-build" && input.allowedBuilds.length !== 2)
    ) {
      sendError(
        response,
        400,
        "autodev_control_playtesting_invalid_study_builds",
        "Study builds must be the benchmark reference and, for paired designs, one approved experiment treatment."
      );
      return;
    }
    const study: HumanPlaytestStudy = {
      ...input,
      allowedBuilds: input.allowedBuilds.map(
        ({ id, version, contentHash }) => ({
          id,
          version,
          ...(contentHash === undefined ? {} : { contentHash })
        })
      ),
      approved: true,
      approvedBy: actor.actor
    };
    const prior = await repo.getLatestHumanStudy(
      study.workspaceId,
      study.studyId
    );
    if (prior && !sameStudy(prior, study)) {
      sendError(
        response,
        409,
        "autodev_control_playtesting_human_study_immutable",
        "Study metadata is immutable; register a new studyId for changed consent, instrument, or build scope."
      );
      return;
    }
    responsesFor(options).registerStudy(study);
    if (!prior) await repo.insertHumanStudy(study);
    const body: ControlApiPlaytestingHumanStudyRegistrationResponse = {
      schema: "autodev-control-playtesting-human-study-registration-v1",
      workspaceId: study.workspaceId,
      studyId: study.studyId,
      benchmarkId: study.benchmarkId,
      approved: true,
      idempotent: prior !== null
    };
    audit(options, actor, "register_human_study", study.workspaceId, "ok", {
      studyId: study.studyId,
      benchmarkId: study.benchmarkId,
      instrument: study.instrument,
      version: study.version
    });
    sendJson(response, prior ? 200 : 201, body, {
      "cache-control": "no-store"
    });
  } catch (error) {
    respondHumanError(
      response,
      error,
      options,
      actor,
      "register_human_study",
      input.workspaceId
    );
  }
}

function validatorsForImport(
  study: HumanPlaytestStudy,
  options: PlaytestingHumanStudyControlApiOptions,
  episodes: ReadonlyMap<string, PlaytestEpisode>
): HumanStudyImportValidators {
  const allowedBuilds = new Set(
    study.allowedBuilds.map((build) =>
      JSON.stringify([
        build.id,
        String(build.version),
        build.contentHash ?? null
      ])
    )
  );
  return {
    isApprovedStudy: (candidate) =>
      candidate.approved && sameStudy(candidate, study),
    isWorkspaceAllowed: (_candidate, workspaceId) =>
      workspaceId === study.workspaceId,
    isBuildAllowed: (_candidate, build) =>
      allowedBuilds.has(
        JSON.stringify([
          build.id,
          String(build.version),
          build.contentHash ?? null
        ])
      ),
    isTrustedInstrumentVersion: (_candidate, instrument, version, hash) =>
      instrument === study.instrument &&
      version === study.instrumentVersion &&
      hash === study.instrumentHash,
    isTrustedPxiItemConstructMapping: (_candidate, mapping) =>
      study.pxiItemConstructMappingHash ===
      hashHumanStudyPxiItemConstructMapping(mapping),
    isValidEpisodeLink: (_candidate, episodeId, build) => {
      const episode = episodes.get(episodeId);
      return (
        !!episode &&
        episode.identity.workspaceId === study.workspaceId &&
        episode.identity.buildSha === build.id
      );
    },
    isConsentValid: (_candidate, participantId, version, scope) => {
      const consent = responsesFor(options).getConsent(
        study.studyId,
        participantId
      );
      return (
        consent?.consentVersion === version && consent.consentScope === scope
      );
    },
    isParticipantWithdrawn: (_candidate, participantId) =>
      responsesFor(options).isParticipantWithdrawn(
        study.studyId,
        participantId
      ),
    isExposureSufficient: (_candidate, startedAt, endedAt) => {
      const start = Date.parse(startedAt);
      const end = Date.parse(endedAt);
      return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end - start >= study.minimumExposureMs
      );
    },
    isWithinResponseWindow: (_candidate, endedAt, submittedAt) => {
      const end = Date.parse(endedAt);
      const submitted = Date.parse(submittedAt);
      return (
        Number.isFinite(end) &&
        Number.isFinite(submitted) &&
        submitted >= end &&
        submitted - end <= study.responseWindowMs
      );
    }
  };
}

async function importStudyResponses(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  studyId: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingHumanStudyControlApiOptions
): Promise<void> {
  if (!operatorRequired(actor, response)) return;
  const query = workspaceQuery(request, pathname, ["workspaceId"], response);
  if (!query || !catalogWorkspace(query.workspaceId, options, response, true))
    return;
  if (!humanStudyApproval(query.workspaceId, options, response)) return;
  const study = await ensureStudyAvailable(
    query.workspaceId,
    studyId,
    options,
    response
  );
  if (!study) return;
  const parsedBody = await readControlApiJsonObject(
    request,
    MAX_HUMAN_IMPORT_BODY_BYTES
  );
  if (!parsedBody.ok) {
    sendError(response, parsedBody.status, parsedBody.code, parsedBody.message);
    return;
  }
  const parsed = importBodySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_human_export",
      "The authorized human-study export or explicit item mapping is invalid."
    );
    return;
  }
  try {
    const responseStore = responsesFor(options);
    responseStore.registerStudy(study);
    const rows = parseHumanStudyExportRows(
      parsed.data.exportText,
      parsed.data.format
    );
    const episodeIds = [
      ...new Set(
        rows
          .map((row) => row[parsed.data.manifest.episodeIdColumn] ?? "")
          .filter((id) => id.length > 0)
      )
    ];
    const episodes = new Map<string, PlaytestEpisode>();
    const repo = repositoryFor(options);
    for (let start = 0; start < episodeIds.length; start += 200) {
      const selected = await repo.getEpisodesByIds(
        query.workspaceId,
        episodeIds.slice(start, start + 200)
      );
      for (const episode of selected) episodes.set(episode.episodeId, episode);
    }
    const validators = validatorsForImport(study, options, episodes);
    const report = responseStore.importRows(
      studyId,
      rows,
      parsed.data.manifest as HumanStudyExportManifest,
      validators
    );
    const rejectedByReason: Record<string, number> = {};
    for (const rejection of report.rejected) {
      rejectedByReason[rejection.reason] =
        (rejectedByReason[rejection.reason] ?? 0) + 1;
    }
    const body: ControlApiPlaytestingHumanImportResponse = {
      schema: "autodev-control-playtesting-human-import-v1",
      workspaceId: query.workspaceId,
      studyId,
      revision: report.revision,
      acceptedCount: report.acceptedCount,
      unchangedCount: report.unchangedCount,
      rejectedCount: report.rejected.length,
      rejectedByReason,
      quarantinedCount: report.quarantined.length,
      retainedParticipants: report.retainedParticipants
    };
    audit(options, actor, "import_human_responses", query.workspaceId, "ok", {
      studyId,
      acceptedCount: report.acceptedCount,
      unchangedCount: report.unchangedCount,
      rejectedCount: report.rejected.length,
      quarantinedCount: report.quarantined.length
    });
    sendJson(response, 200, body, { "cache-control": "no-store" });
  } catch (error) {
    respondHumanError(
      response,
      error,
      options,
      actor,
      "import_human_responses",
      query.workspaceId
    );
  }
}

async function consentParticipant(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  studyId: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingHumanStudyControlApiOptions
): Promise<void> {
  if (!operatorRequired(actor, response)) return;
  const query = workspaceQuery(request, pathname, ["workspaceId"], response);
  if (!query || !catalogWorkspace(query.workspaceId, options, response, true))
    return;
  if (!humanStudyApproval(query.workspaceId, options, response)) return;
  const study = await ensureStudyAvailable(
    query.workspaceId,
    studyId,
    options,
    response
  );
  if (!study) return;
  const parsedBody = await readControlApiJsonObject(request);
  if (!parsedBody.ok) {
    sendError(response, parsedBody.status, parsedBody.code, parsedBody.message);
    return;
  }
  const parsed = consentBodySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_consent",
      "The human-study consent record is invalid."
    );
    return;
  }
  try {
    const responseStore = responsesFor(options);
    responseStore.registerStudy(study);
    responseStore.recordConsent(
      studyId,
      parsed.data.participantId,
      parsed.data.consentVersion,
      parsed.data.consentScope
    );
    const body: ControlApiPlaytestingHumanConsentResponse = {
      schema: "autodev-control-playtesting-human-consent-v1",
      workspaceId: query.workspaceId,
      studyId,
      recorded: true
    };
    audit(options, actor, "record_human_consent", query.workspaceId, "ok", {
      studyId
    });
    sendJson(response, 201, body, { "cache-control": "no-store" });
  } catch (error) {
    respondHumanError(
      response,
      error,
      options,
      actor,
      "record_human_consent",
      query.workspaceId
    );
  }
}

async function withdrawParticipant(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  studyId: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingHumanStudyControlApiOptions
): Promise<void> {
  if (!operatorRequired(actor, response)) return;
  const query = workspaceQuery(request, pathname, ["workspaceId"], response);
  if (!query || !catalogWorkspace(query.workspaceId, options, response, false))
    return;
  const study = await ensureStudyAvailable(
    query.workspaceId,
    studyId,
    options,
    response
  );
  if (!study) return;
  const parsedBody = await readControlApiJsonObject(request);
  if (!parsedBody.ok) {
    sendError(response, parsedBody.status, parsedBody.code, parsedBody.message);
    return;
  }
  const parsed = withdrawalBodySchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_withdrawal",
      "The human-study withdrawal request is invalid."
    );
    return;
  }
  try {
    const responseStore = responsesFor(options);
    responseStore.registerStudy(study);
    const report = responseStore.withdrawParticipant(
      studyId,
      parsed.data.participantId
    );
    const body: ControlApiPlaytestingHumanWithdrawalResponse = {
      schema: "autodev-control-playtesting-human-withdrawal-v1",
      workspaceId: query.workspaceId,
      studyId,
      revision: report.revision,
      retainedParticipants: report.retainedParticipants
    };
    audit(
      options,
      actor,
      "withdraw_human_participant",
      query.workspaceId,
      "ok",
      { studyId, revision: report.revision }
    );
    sendJson(response, 200, body, { "cache-control": "no-store" });
  } catch (error) {
    respondHumanError(
      response,
      error,
      options,
      actor,
      "withdraw_human_participant",
      query.workspaceId
    );
  }
}

async function humanValidationSummary(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  studyId: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingHumanStudyControlApiOptions
): Promise<void> {
  const query = workspaceQuery(
    request,
    pathname,
    ["workspaceId", "buildSha", "aBuildSha", "bBuildSha"],
    response
  );
  if (!query || !catalogWorkspace(query.workspaceId, options, response, false))
    return;
  const study = await ensureStudyAvailable(
    query.workspaceId,
    studyId,
    options,
    response
  );
  if (!study) return;
  const buildSha = query.params.get("buildSha") ?? "";
  if (
    !SHA_PATTERN.test(buildSha) ||
    !study.allowedBuilds.some((build) => build.id === buildSha)
  ) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_human_build",
      "The requested build is not part of the approved human study."
    );
    return;
  }
  const a = query.params.get("aBuildSha");
  const b = query.params.get("bBuildSha");
  let pairedArmBuildIds: { readonly a: string; readonly b: string } | undefined;
  if (
    (a === null) !== (b === null) ||
    (a !== null &&
      b !== null &&
      (!SHA_PATTERN.test(a) ||
        !SHA_PATTERN.test(b) ||
        !study.allowedBuilds.some((build) => build.id === a) ||
        !study.allowedBuilds.some((build) => build.id === b)))
  ) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_human_pair",
      "The paired-build request is invalid."
    );
    return;
  }
  if (a !== null && b !== null) pairedArmBuildIds = { a, b };
  try {
    const responseStore = responsesFor(options);
    const summary = responseStore.getHumanValidationSummary(studyId, buildSha, {
      ...(pairedArmBuildIds ? { pairedArmBuildIds } : {})
    });
    const pairedDifferences = pairedArmBuildIds
      ? responseStore.getPairedDifferenceSummaries(studyId, pairedArmBuildIds)
      : [];
    const body: ControlApiPlaytestingHumanValidationResponse = {
      schema: "autodev-control-playtesting-human-validation-v1",
      workspaceId: query.workspaceId,
      studyId,
      buildSha,
      summary: summary
        ? {
            revision: summary.revision,
            benchmarkId: summary.benchmarkId,
            instrument: summary.instrument,
            measurementVersion: summary.measurementVersion,
            suppressionState: summary.suppressionState,
            retainedParticipants: summary.retainedParticipants,
            items: summary.items,
            constructs: summary.constructs,
            pairedDifferences
          }
        : null
    };
    sendJson(response, 200, body, { "cache-control": "no-store" });
  } catch (error) {
    respondHumanError(
      response,
      error,
      options,
      actor,
      undefined,
      query.workspaceId
    );
  }
}

async function humanQuarantines(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  studyId: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingHumanStudyControlApiOptions
): Promise<void> {
  if (!operatorRequired(actor, response)) return;
  const query = workspaceQuery(request, pathname, ["workspaceId"], response);
  if (!query || !catalogWorkspace(query.workspaceId, options, response, false))
    return;
  const study = await ensureStudyAvailable(
    query.workspaceId,
    studyId,
    options,
    response
  );
  if (!study) return;
  try {
    const responseStore = responsesFor(options);
    responseStore.registerStudy(study);
    const body: ControlApiPlaytestingHumanQuarantinesResponse = {
      schema: "autodev-control-playtesting-human-quarantines-v1",
      workspaceId: query.workspaceId,
      studyId,
      quarantines: responseStore.listQuarantine(studyId).map((entry) => ({
        responseIds: entry.responseIds,
        instrument: entry.instrument,
        reason: entry.reason
      }))
    };
    sendJson(response, 200, body, { "cache-control": "no-store" });
  } catch (error) {
    respondHumanError(
      response,
      error,
      options,
      actor,
      undefined,
      query.workspaceId
    );
  }
}

async function resolveHumanQuarantine(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  studyId: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingHumanStudyControlApiOptions
): Promise<void> {
  if (!operatorRequired(actor, response)) return;
  const query = workspaceQuery(request, pathname, ["workspaceId"], response);
  if (!query || !catalogWorkspace(query.workspaceId, options, response, false))
    return;
  const study = await ensureStudyAvailable(
    query.workspaceId,
    studyId,
    options,
    response
  );
  if (!study) return;
  const parsedBody = await readControlApiJsonObject(request);
  if (!parsedBody.ok) {
    sendError(response, parsedBody.status, parsedBody.code, parsedBody.message);
    return;
  }
  const parsed = quarantineResolutionSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    sendError(
      response,
      400,
      "autodev_control_playtesting_invalid_quarantine_resolution",
      "The duplicate-resolution request is invalid."
    );
    return;
  }
  try {
    const responseStore = responsesFor(options);
    responseStore.registerStudy(study);
    responseStore.resolveQuarantine(studyId, parsed.data.responseIdToKeep);
    audit(options, actor, "resolve_human_quarantine", query.workspaceId, "ok", {
      studyId
    });
    sendJson(
      response,
      200,
      {
        schema: "autodev-control-playtesting-human-quarantine-resolution-v1",
        workspaceId: query.workspaceId,
        studyId,
        resolved: true
      },
      { "cache-control": "no-store" }
    );
  } catch (error) {
    respondHumanError(
      response,
      error,
      options,
      actor,
      "resolve_human_quarantine",
      query.workspaceId
    );
  }
}

function respondHumanError(
  response: ServerResponse,
  error: unknown,
  options: PlaytestingHumanStudyControlApiOptions,
  actor: PlaytestingRunControlActor,
  action: string | undefined,
  workspaceId: string
): void {
  if (error instanceof RestrictedHumanStudyNotRegisteredError) {
    sendError(
      response,
      404,
      "autodev_control_playtesting_human_study_not_found",
      "The approved human study was not found."
    );
    return;
  }
  if (
    error instanceof RestrictedHumanStudyStorageError ||
    error instanceof PlaytestSourceUnavailableError
  ) {
    audit(
      options,
      actor,
      action ?? "",
      workspaceId,
      "error",
      null,
      "source_unavailable"
    );
    sendError(
      response,
      503,
      "autodev_control_playtesting_human_source_unavailable",
      "Restricted human-study storage or Playtest Data is unavailable."
    );
    return;
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    audit(
      options,
      actor,
      action ?? "",
      workspaceId,
      "denied",
      null,
      "invalid_request"
    );
    sendError(
      response,
      400,
      "autodev_control_playtesting_human_invalid_request",
      "The human-study operation was rejected by its consent, instrument, build, or episode-link contract."
    );
    return;
  }
  writeErrorLine("control-playtesting-human: internal operation failure.");
  audit(
    options,
    actor,
    action ?? "",
    workspaceId,
    "error",
    null,
    "internal_error"
  );
  sendError(
    response,
    500,
    "autodev_control_playtesting_human_internal_error",
    "The human-study operation failed."
  );
}

/** Authorized study management and import; only suppression-aware aggregates leave Data. */
export async function handlePlaytestingHumanStudyControlApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: PlaytestingRunControlActor,
  options: PlaytestingHumanStudyControlApiOptions
): Promise<boolean> {
  const route = routeFor(pathname);
  if (!route) return false;
  const method = request.method ?? "GET";
  if (route.action === "register" && method === "POST") {
    await registerStudy(request, response, actor, options);
  } else if (
    route.studyId &&
    route.action === "consents" &&
    method === "POST"
  ) {
    await consentParticipant(
      request,
      response,
      pathname,
      route.studyId,
      actor,
      options
    );
  } else if (route.studyId && route.action === "import" && method === "POST") {
    await importStudyResponses(
      request,
      response,
      pathname,
      route.studyId,
      actor,
      options
    );
  } else if (
    route.studyId &&
    route.action === "withdrawals" &&
    method === "POST"
  ) {
    await withdrawParticipant(
      request,
      response,
      pathname,
      route.studyId,
      actor,
      options
    );
  } else if (
    route.studyId &&
    route.action === "validation" &&
    method === "GET"
  ) {
    await humanValidationSummary(
      request,
      response,
      pathname,
      route.studyId,
      actor,
      options
    );
  } else if (
    route.studyId &&
    route.action === "quarantines" &&
    method === "GET"
  ) {
    await humanQuarantines(
      request,
      response,
      pathname,
      route.studyId,
      actor,
      options
    );
  } else if (
    route.studyId &&
    route.action === "resolve-quarantine" &&
    method === "POST"
  ) {
    await resolveHumanQuarantine(
      request,
      response,
      pathname,
      route.studyId,
      actor,
      options
    );
  } else {
    response.setHeader(
      "allow",
      route.action === "validation" || route.action === "quarantines"
        ? "GET"
        : "POST"
    );
    sendError(
      response,
      405,
      "autodev_control_playtesting_method_not_allowed",
      "The human-study route does not support this method."
    );
  }
  return true;
}
