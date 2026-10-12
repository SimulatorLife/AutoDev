/** Restricted, consented import for the separate paired A/B preference outcome. */
import type {
  HumanPlaytestStudy,
  PlaytestHumanPreferencePlan
} from "./artifacts.ts";
import { assertHumanStudyPreferencePlan } from "./human-preference.ts";
import {
  type HumanStudyImportValidators,
  type HumanStudyRawRow
} from "./human-study-import.ts";
import type {
  PlaytestPreferenceAnswer,
  PlaytestVersionedRef
} from "./types.ts";

const MAX_ROWS = 10_000;
const MAX_COLUMNS = 256;
const MAX_FIELD_CHARACTERS = 16_384;
const RESPONSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d{0,8}$/u;

export interface HumanStudyPreferenceExportManifest {
  readonly studyIdColumn: string;
  readonly responseIdColumn: string;
  readonly revisionColumn: string;
  readonly supersedesColumn: string;
  readonly participantIdColumn: string;
  readonly consentVersionColumn: string;
  readonly consentScopeColumn: string;
  readonly workspaceIdColumn: string;
  readonly episodeAColumn: string;
  readonly exposureAStartedAtColumn: string;
  readonly exposureAEndedAtColumn: string;
  readonly episodeBColumn: string;
  readonly exposureBStartedAtColumn: string;
  readonly exposureBEndedAtColumn: string;
  readonly orderColumn: string;
  readonly submittedAtColumn: string;
  readonly answerColumn: string;
}

/** Restricted data row; pseudonymous identity never appears in summaries. */
export interface HumanStudyPreferenceResponse {
  readonly studyId: string;
  readonly responseId: string;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly pseudonymousParticipantId: string;
  readonly consentVersion: string;
  readonly consentScope: string;
  readonly questionVersion: string;
  readonly questionHash: string;
  readonly buildA: PlaytestVersionedRef;
  readonly buildB: PlaytestVersionedRef;
  readonly episodeA: string;
  readonly exposureAStartedAt: string;
  readonly exposureAEndedAt: string;
  readonly episodeB: string;
  readonly exposureBStartedAt: string;
  readonly exposureBEndedAt: string;
  readonly order: "A-first" | "B-first";
  readonly submittedAt: string;
  readonly answer: PlaytestPreferenceAnswer | null;
  readonly withdrawn: boolean;
}

export interface HumanStudyPreferenceExposures {
  readonly episodeA: string;
  readonly exposureAStartedAt: string;
  readonly exposureAEndedAt: string;
  readonly episodeB: string;
  readonly exposureBStartedAt: string;
  readonly exposureBEndedAt: string;
  readonly order: "A-first" | "B-first";
}

export interface HumanStudyPreferenceImportValidators extends Pick<
  HumanStudyImportValidators,
  | "isApprovedStudy"
  | "isWorkspaceAllowed"
  | "isBuildAllowed"
  | "isValidEpisodeLink"
  | "isConsentValid"
  | "isParticipantWithdrawn"
  | "isExposureSufficient"
  | "isWithinResponseWindow"
> {
  readonly isTrustedPreferenceQuestion: (
    study: HumanPlaytestStudy,
    plan: PlaytestHumanPreferencePlan
  ) => boolean;
  /** Must prove both episode links are completed exposures for this participant. */
  readonly isPreferencePairComplete: (
    study: HumanPlaytestStudy,
    participantId: string,
    plan: PlaytestHumanPreferencePlan,
    exposures: HumanStudyPreferenceExposures
  ) => boolean;
}

export type HumanStudyPreferenceImportRejectionReason =
  | "malformed-row"
  | "unapproved-study"
  | "untrusted-question"
  | "wrong-workspace"
  | "wrong-build"
  | "invalid-episode-link"
  | "incomplete-preference-pair"
  | "invalid-exposure"
  | "wrong-timing"
  | "consent-mismatch"
  | "withdrawn-participant"
  | "response-id-conflict"
  | "invalid-amendment";

export interface HumanStudyPreferenceImportRejection {
  readonly rowIndex: number;
  readonly studyId: string | null;
  readonly responseId: string | null;
  readonly reason: HumanStudyPreferenceImportRejectionReason;
  readonly detail: string;
}

export interface HumanStudyPreferenceDuplicateQuarantine {
  readonly studyId: string;
  readonly participantId: string;
  readonly buildAId: string;
  readonly buildBId: string;
  readonly responseIds: readonly string[];
  readonly reason: "duplicate-participant-pair-preference";
}

export interface HumanStudyPreferenceImportOutcome {
  readonly accepted: readonly HumanStudyPreferenceResponse[];
  readonly unchanged: readonly HumanStudyPreferenceResponse[];
  readonly superseded: readonly string[];
  readonly rejected: readonly HumanStudyPreferenceImportRejection[];
  readonly quarantined: readonly HumanStudyPreferenceDuplicateQuarantine[];
  readonly quarantinedResponses: readonly HumanStudyPreferenceResponse[];
}

interface RowFields {
  readonly studyId: string;
  readonly responseId: string;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly participantId: string;
  readonly consentVersion: string;
  readonly consentScope: string;
  readonly workspaceId: string;
  readonly episodeA: string;
  readonly exposureAStartedAt: string;
  readonly exposureAEndedAt: string;
  readonly episodeB: string;
  readonly exposureBStartedAt: string;
  readonly exposureBEndedAt: string;
  readonly order: "A-first" | "B-first";
  readonly submittedAt: string;
  readonly answer: PlaytestPreferenceAnswer | null;
}

interface Candidate {
  readonly rowIndex: number;
  readonly response: HumanStudyPreferenceResponse;
}

function manifestColumns(
  manifest: HumanStudyPreferenceExportManifest
): readonly string[] {
  const columns = Object.values(manifest);
  if (
    columns.length !== 17 ||
    columns.length > MAX_COLUMNS ||
    columns.some(
      (column) => typeof column !== "string" || column.trim().length === 0
    ) ||
    new Set(columns).size !== columns.length
  ) {
    throw new TypeError(
      "Preference manifest columns must be exactly the named, non-empty fields."
    );
  }
  return columns;
}

function rowMatchesManifest(
  row: HumanStudyRawRow,
  columns: readonly string[]
): boolean {
  const keys = Object.keys(row);
  return (
    keys.length === columns.length &&
    keys.every((key) => columns.includes(key)) &&
    Object.values(row).every(
      (value) =>
        typeof value === "string" && value.length <= MAX_FIELD_CHARACTERS
    )
  );
}

function readAnswer(value: string): PlaytestPreferenceAnswer | null {
  if (value === "") return null;
  if (
    value === "A" ||
    value === "B" ||
    value === "tie" ||
    value === "unable-to-judge"
  ) {
    return value;
  }
  throw new TypeError("Preference answer is outside its closed vocabulary.");
}

function readRow(
  row: HumanStudyRawRow,
  manifest: HumanStudyPreferenceExportManifest
): RowFields {
  const read = (column: string): string => row[column] ?? "";
  const revision = read(manifest.revisionColumn);
  const order = read(manifest.orderColumn);
  if (!POSITIVE_INTEGER_PATTERN.test(revision)) {
    throw new TypeError("Preference revision must be a positive integer.");
  }
  if (order !== "A-first" && order !== "B-first") {
    throw new TypeError("Preference order must be A-first or B-first.");
  }
  const supersedes = read(manifest.supersedesColumn);
  if (supersedes && !RESPONSE_ID_PATTERN.test(supersedes)) {
    throw new TypeError("Preference supersedes ID is invalid.");
  }
  return {
    studyId: read(manifest.studyIdColumn),
    responseId: read(manifest.responseIdColumn),
    revision: Number(revision),
    supersedes: supersedes || null,
    participantId: read(manifest.participantIdColumn),
    consentVersion: read(manifest.consentVersionColumn),
    consentScope: read(manifest.consentScopeColumn),
    workspaceId: read(manifest.workspaceIdColumn),
    episodeA: read(manifest.episodeAColumn),
    exposureAStartedAt: read(manifest.exposureAStartedAtColumn),
    exposureAEndedAt: read(manifest.exposureAEndedAtColumn),
    episodeB: read(manifest.episodeBColumn),
    exposureBStartedAt: read(manifest.exposureBStartedAtColumn),
    exposureBEndedAt: read(manifest.exposureBEndedAtColumn),
    order,
    submittedAt: read(manifest.submittedAtColumn),
    answer: readAnswer(read(manifest.answerColumn))
  };
}

function parseDate(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function validateOrderAndExposure(
  study: HumanPlaytestStudy,
  row: RowFields,
  validators: HumanStudyPreferenceImportValidators
): "invalid-exposure" | "wrong-timing" | null {
  const aStart = parseDate(row.exposureAStartedAt);
  const aEnd = parseDate(row.exposureAEndedAt);
  const bStart = parseDate(row.exposureBStartedAt);
  const bEnd = parseDate(row.exposureBEndedAt);
  if (
    aStart === null ||
    aEnd === null ||
    bStart === null ||
    bEnd === null ||
    aEnd < aStart ||
    bEnd < bStart ||
    aEnd - aStart < study.minimumExposureMs ||
    bEnd - bStart < study.minimumExposureMs
  ) {
    return "invalid-exposure";
  }
  const ordered = row.order === "A-first" ? aEnd <= bStart : bEnd <= aStart;
  if (!ordered) return "invalid-exposure";
  if (
    !validators.isExposureSufficient(
      study,
      row.exposureAStartedAt,
      row.exposureAEndedAt
    ) ||
    !validators.isExposureSufficient(
      study,
      row.exposureBStartedAt,
      row.exposureBEndedAt
    )
  ) {
    return "invalid-exposure";
  }
  const submittedAt = parseDate(row.submittedAt);
  const latestEnd = Math.max(aEnd, bEnd);
  if (submittedAt === null || submittedAt < latestEnd) return "wrong-timing";
  return validators.isWithinResponseWindow(
    study,
    new Date(latestEnd).toISOString(),
    row.submittedAt
  )
    ? null
    : "wrong-timing";
}

function rejection(
  rowIndex: number,
  fields: Partial<RowFields>,
  reason: HumanStudyPreferenceImportRejectionReason,
  detail: string
): HumanStudyPreferenceImportRejection {
  return {
    rowIndex,
    studyId: fields.studyId ?? null,
    responseId: fields.responseId ?? null,
    reason,
    detail
  };
}

function matchesRow(
  study: HumanPlaytestStudy,
  fields: RowFields,
  validators: HumanStudyPreferenceImportValidators
): HumanStudyPreferenceImportRejectionReason | null {
  const plan = study.preferencePlan!;
  if (
    !fields.studyId ||
    !RESPONSE_ID_PATTERN.test(fields.responseId) ||
    !fields.participantId ||
    !fields.consentVersion ||
    !fields.consentScope ||
    !fields.workspaceId ||
    !fields.episodeA ||
    !fields.episodeB ||
    !fields.exposureAStartedAt ||
    !fields.exposureAEndedAt ||
    !fields.exposureBStartedAt ||
    !fields.exposureBEndedAt ||
    !fields.submittedAt
  ) {
    return "malformed-row";
  }
  if (fields.studyId !== study.studyId) return "malformed-row";
  if (
    fields.workspaceId !== study.workspaceId ||
    !validators.isWorkspaceAllowed(study, fields.workspaceId)
  ) {
    return "wrong-workspace";
  }
  if (
    !validators.isConsentValid(
      study,
      fields.participantId,
      fields.consentVersion,
      fields.consentScope
    )
  ) {
    return "consent-mismatch";
  }
  if (validators.isParticipantWithdrawn(study, fields.participantId)) {
    return "withdrawn-participant";
  }
  if (
    !validators.isBuildAllowed(study, plan.buildA) ||
    !validators.isBuildAllowed(study, plan.buildB)
  ) {
    return "wrong-build";
  }
  if (fields.episodeA === fields.episodeB) return "invalid-episode-link";
  if (
    !validators.isValidEpisodeLink(study, fields.episodeA, plan.buildA) ||
    !validators.isValidEpisodeLink(study, fields.episodeB, plan.buildB)
  ) {
    return "invalid-episode-link";
  }
  if (
    !validators.isPreferencePairComplete(study, fields.participantId, plan, {
      episodeA: fields.episodeA,
      exposureAStartedAt: fields.exposureAStartedAt,
      exposureAEndedAt: fields.exposureAEndedAt,
      episodeB: fields.episodeB,
      exposureBStartedAt: fields.exposureBStartedAt,
      exposureBEndedAt: fields.exposureBEndedAt,
      order: fields.order
    })
  ) {
    return "incomplete-preference-pair";
  }
  const timingFailure = validateOrderAndExposure(study, fields, validators);
  if (timingFailure !== null) return timingFailure;
  return null;
}

function toResponse(
  study: HumanPlaytestStudy,
  fields: RowFields
): HumanStudyPreferenceResponse {
  const plan = study.preferencePlan!;
  return {
    studyId: study.studyId,
    responseId: fields.responseId,
    revision: fields.revision,
    supersedes: fields.supersedes,
    pseudonymousParticipantId: fields.participantId,
    consentVersion: fields.consentVersion,
    consentScope: fields.consentScope,
    questionVersion: plan.questionVersion,
    questionHash: plan.questionHash,
    buildA: plan.buildA,
    buildB: plan.buildB,
    episodeA: fields.episodeA,
    exposureAStartedAt: fields.exposureAStartedAt,
    exposureAEndedAt: fields.exposureAEndedAt,
    episodeB: fields.episodeB,
    exposureBStartedAt: fields.exposureBStartedAt,
    exposureBEndedAt: fields.exposureBEndedAt,
    order: fields.order,
    submittedAt: fields.submittedAt,
    answer: fields.answer,
    withdrawn: false
  };
}

function responseSignature(response: HumanStudyPreferenceResponse): string {
  return JSON.stringify({ ...response, withdrawn: false });
}

type CandidateParseResult =
  | { readonly kind: "candidate"; readonly candidate: Candidate }
  | {
      readonly kind: "unchanged";
      readonly response: HumanStudyPreferenceResponse;
    }
  | {
      readonly kind: "rejected";
      readonly rejection: HumanStudyPreferenceImportRejection;
    };

function parseCandidate(
  row: HumanStudyRawRow,
  rowIndex: number,
  study: HumanPlaytestStudy,
  manifest: HumanStudyPreferenceExportManifest,
  columns: readonly string[],
  validators: HumanStudyPreferenceImportValidators,
  responseIdCounts: ReadonlyMap<string, number>,
  existingById: ReadonlyMap<string, HumanStudyPreferenceResponse>
): CandidateParseResult {
  let fields: Partial<RowFields> = {};
  try {
    const rawResponseId = row[manifest.responseIdColumn];
    if (
      typeof rawResponseId === "string" &&
      (responseIdCounts.get(rawResponseId) ?? 0) > 1
    ) {
      return {
        kind: "rejected",
        rejection: rejection(
          rowIndex,
          {
            responseId: rawResponseId,
            ...(typeof row[manifest.studyIdColumn] === "string"
              ? { studyId: row[manifest.studyIdColumn]! }
              : {})
          },
          "response-id-conflict",
          "Preference response ID is duplicated in the import."
        )
      };
    }
    if (!rowMatchesManifest(row, columns)) {
      throw new TypeError("Preference row does not match its exact manifest.");
    }
    const parsed = readRow(row, manifest);
    fields = parsed;
    if (parsed.studyId !== study.studyId) {
      throw new TypeError("Preference row references another study.");
    }
    const reason = matchesRow(study, parsed, validators);
    if (reason !== null) {
      return {
        kind: "rejected",
        rejection: rejection(
          rowIndex,
          parsed,
          reason,
          "Preference row failed its study, exposure, or consent check."
        )
      };
    }
    const response = toResponse(study, parsed);
    const prior = existingById.get(parsed.responseId);
    if (prior !== undefined) {
      return responseSignature(prior) === responseSignature(response)
        ? { kind: "unchanged", response: prior }
        : {
            kind: "rejected",
            rejection: rejection(
              rowIndex,
              parsed,
              "response-id-conflict",
              "Preference response ID already names different content."
            )
          };
    }
    return {
      kind: "candidate",
      candidate: { rowIndex, response }
    };
  } catch (error) {
    return {
      kind: "rejected",
      rejection: rejection(
        rowIndex,
        fields,
        "malformed-row",
        error instanceof Error ? error.message : "Preference row is malformed."
      )
    };
  }
}

interface AmendmentCandidates {
  readonly accepted: readonly Candidate[];
}

function isCurrentAmendment(
  candidate: Candidate,
  prior: HumanStudyPreferenceResponse | undefined,
  supersededIds: ReadonlySet<string>
): prior is HumanStudyPreferenceResponse {
  const { response } = candidate;
  return (
    prior !== undefined &&
    !prior.withdrawn &&
    !supersededIds.has(prior.responseId) &&
    prior.pseudonymousParticipantId === response.pseudonymousParticipantId &&
    prior.revision + 1 === response.revision &&
    prior.questionVersion === response.questionVersion &&
    prior.questionHash === response.questionHash &&
    prior.consentVersion === response.consentVersion &&
    prior.consentScope === response.consentScope &&
    prior.episodeA === response.episodeA &&
    prior.exposureAStartedAt === response.exposureAStartedAt &&
    prior.exposureAEndedAt === response.exposureAEndedAt &&
    prior.episodeB === response.episodeB &&
    prior.exposureBStartedAt === response.exposureBStartedAt &&
    prior.exposureBEndedAt === response.exposureBEndedAt &&
    prior.order === response.order &&
    sameVersionedBuild(prior.buildA, response.buildA) &&
    sameVersionedBuild(prior.buildB, response.buildB)
  );
}

function sameVersionedBuild(
  left: PlaytestVersionedRef,
  right: PlaytestVersionedRef
): boolean {
  return (
    left.id === right.id &&
    String(left.version) === String(right.version) &&
    (left.contentHash ?? null) === (right.contentHash ?? null)
  );
}

function resolveAmendments(
  candidates: readonly Candidate[],
  existingById: ReadonlyMap<string, HumanStudyPreferenceResponse>,
  alreadySupersededIds: ReadonlySet<string>,
  rejected: HumanStudyPreferenceImportRejection[]
): AmendmentCandidates {
  const accepted: Candidate[] = [];
  for (const candidate of candidates) {
    const priorId = candidate.response.supersedes;
    if (priorId === null) {
      accepted.push(candidate);
      continue;
    }
    const prior = existingById.get(priorId);
    if (!isCurrentAmendment(candidate, prior, alreadySupersededIds)) {
      rejected.push(
        rejection(
          candidate.rowIndex,
          candidate.response,
          "invalid-amendment",
          "Amendment must supersede the current same-participant response at revision +1."
        )
      );
      continue;
    }
    accepted.push(candidate);
  }
  return { accepted };
}

interface CandidatePartition {
  readonly accepted: readonly HumanStudyPreferenceResponse[];
  readonly quarantined: readonly HumanStudyPreferenceDuplicateQuarantine[];
  readonly quarantinedResponses: readonly HumanStudyPreferenceResponse[];
}

function partitionParticipantCandidates(
  study: HumanPlaytestStudy,
  candidates: readonly Candidate[],
  existing: readonly HumanStudyPreferenceResponse[],
  alreadySupersededIds: ReadonlySet<string>
): CandidatePartition {
  const activeExisting = existing.filter(
    (response) =>
      !response.withdrawn && !alreadySupersededIds.has(response.responseId)
  );
  const existingByParticipant = new Map<string, HumanStudyPreferenceResponse>();
  for (const response of activeExisting) {
    if (existingByParticipant.has(response.pseudonymousParticipantId)) {
      throw new TypeError(
        "Existing preference responses contain duplicate active participants."
      );
    }
    existingByParticipant.set(response.pseudonymousParticipantId, response);
  }
  const participantsWithExisting = new Set(existingByParticipant.keys());
  if (participantsWithExisting.size !== activeExisting.length) {
    throw new TypeError(
      "Existing preference responses contain duplicate active participants."
    );
  }

  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const participantId = candidate.response.pseudonymousParticipantId;
    const group = grouped.get(participantId) ?? [];
    group.push(candidate);
    grouped.set(participantId, group);
  }
  const quarantined: HumanStudyPreferenceDuplicateQuarantine[] = [];
  const quarantinedResponses: HumanStudyPreferenceResponse[] = [];
  const accepted: HumanStudyPreferenceResponse[] = [];
  for (const [participantId, group] of grouped) {
    const amendment = group.some((entry) => entry.response.supersedes !== null);
    if (
      group.length > 1 ||
      (participantsWithExisting.has(participantId) && !amendment)
    ) {
      quarantined.push({
        studyId: study.studyId,
        participantId,
        buildAId: study.preferencePlan!.buildA.id,
        buildBId: study.preferencePlan!.buildB.id,
        responseIds: [
          ...(existingByParticipant.has(participantId)
            ? [existingByParticipant.get(participantId)!.responseId]
            : []),
          ...group.map((entry) => entry.response.responseId)
        ],
        reason: "duplicate-participant-pair-preference"
      });
      quarantinedResponses.push(...group.map((entry) => entry.response));
      continue;
    }
    accepted.push(...group.map((entry) => entry.response));
  }
  return { accepted, quarantined, quarantinedResponses };
}

/**
 * Imports preference responses separately from PXI/PXI item rows. The export
 * must cite both exact, completed exposures; no outcome is inferred from a
 * single-build response or an unobserved pair.
 */
export function importHumanStudyPreferenceResponses(
  study: HumanPlaytestStudy,
  rows: readonly HumanStudyRawRow[],
  manifest: HumanStudyPreferenceExportManifest,
  validators: HumanStudyPreferenceImportValidators,
  existing: readonly HumanStudyPreferenceResponse[] = []
): HumanStudyPreferenceImportOutcome {
  if (!study.approved || !validators.isApprovedStudy(study)) {
    return rejectedAll(
      rows,
      manifest,
      "unapproved-study",
      "Study is not approved."
    );
  }
  if (!study.preferencePlan) {
    throw new TypeError("Human study has no approved preference plan.");
  }
  assertHumanStudyPreferencePlan(study);
  if (!validators.isTrustedPreferenceQuestion(study, study.preferencePlan)) {
    return rejectedAll(
      rows,
      manifest,
      "untrusted-question",
      "Preference question hash/version is not approved."
    );
  }
  const columns = manifestColumns(manifest);
  if (rows.length > MAX_ROWS) {
    throw new TypeError("Preference export exceeds the row limit.");
  }
  if (existing.some((entry) => entry.studyId !== study.studyId)) {
    throw new TypeError(
      "Existing preference responses belong to another study."
    );
  }
  const existingById = new Map(
    existing.map((entry) => [entry.responseId, entry])
  );
  if (existingById.size !== existing.length) {
    throw new TypeError("Existing preference response IDs must be unique.");
  }
  const existingSupersededIds = new Set(
    existing.flatMap((entry) => (entry.supersedes ? [entry.supersedes] : []))
  );
  const rejected: HumanStudyPreferenceImportRejection[] = [];
  const unchanged: HumanStudyPreferenceResponse[] = [];
  const candidates: Candidate[] = [];
  const responseIdCounts = new Map<string, number>();
  for (const row of rows) {
    const responseId = row[manifest.responseIdColumn];
    if (typeof responseId === "string" && responseId.length > 0) {
      responseIdCounts.set(
        responseId,
        (responseIdCounts.get(responseId) ?? 0) + 1
      );
    }
  }

  for (const [rowIndex, row] of rows.entries()) {
    const result = parseCandidate(
      row,
      rowIndex,
      study,
      manifest,
      columns,
      validators,
      responseIdCounts,
      existingById
    );
    if (result.kind === "candidate") candidates.push(result.candidate);
    else if (result.kind === "unchanged") unchanged.push(result.response);
    else rejected.push(result.rejection);
  }

  const amendmentCandidates = resolveAmendments(
    candidates,
    existingById,
    existingSupersededIds,
    rejected
  );
  const partition = partitionParticipantCandidates(
    study,
    amendmentCandidates.accepted,
    existing,
    existingSupersededIds
  );

  return {
    accepted: partition.accepted,
    unchanged,
    superseded: partition.accepted.flatMap((response) =>
      response.supersedes ? [response.supersedes] : []
    ),
    rejected,
    quarantined: partition.quarantined,
    quarantinedResponses: partition.quarantinedResponses
  };
}

function rejectedAll(
  rows: readonly HumanStudyRawRow[],
  manifest: HumanStudyPreferenceExportManifest,
  reason: HumanStudyPreferenceImportRejectionReason,
  detail: string
): HumanStudyPreferenceImportOutcome {
  return {
    accepted: [],
    unchanged: [],
    superseded: [],
    rejected: rows.map((row, rowIndex) => ({
      rowIndex,
      studyId: row[manifest.studyIdColumn] ?? null,
      responseId: row[manifest.responseIdColumn] ?? null,
      reason,
      detail
    })),
    quarantined: [],
    quarantinedResponses: []
  };
}
