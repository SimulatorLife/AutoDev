import assert from "node:assert/strict";
import test from "node:test";

import type { HumanPlaytestStudy } from "../src/playtesting/artifacts.ts";
import {
  type HumanStudyPreferenceExportManifest,
  type HumanStudyPreferenceImportValidators,
  type HumanStudyPreferenceResponse,
  importHumanStudyPreferenceResponses
} from "../src/playtesting/human-preference-import.ts";
import {
  type HumanStudyRawRow,
  parseHumanStudyExportRows
} from "../src/playtesting/human-study-import.ts";
import { PLAYTESTS_HUMAN_STUDY_SCHEMA } from "../src/playtesting/types.ts";

const HASH_A = "b".repeat(64);
const HASH_B = "c".repeat(64);

function makeStudy(
  overrides: Partial<HumanPlaytestStudy> = {}
): HumanPlaytestStudy {
  return {
    schema: PLAYTESTS_HUMAN_STUDY_SCHEMA,
    studyId: "study-pref-1",
    version: 1,
    workspaceId: "workspace-1",
    benchmarkId: "benchmark-1",
    allowedBuilds: [
      { id: "build-A", version: "1", contentHash: HASH_A },
      { id: "build-B", version: "1", contentHash: HASH_B }
    ],
    preferencePlan: {
      analysisPlanRef: "pref-plan-v1",
      questionVersion: "question-v1",
      questionHash: "a".repeat(64),
      buildA: { id: "build-A", version: "1", contentHash: HASH_A },
      buildB: { id: "build-B", version: "1", contentHash: HASH_B },
      maximumExclusionRate: 0.25,
      practicalMargin: 0.05,
      minimumIndependentParticipants: 5,
      interval: {
        method: "scipy-binomial-exact",
        libraryVersion: "scipy-1.17.0/numpy-2.3.5/statsmodels-0.14.6",
        confidenceLevel: 0.95,
        resamples: null,
        seed: null
      }
    },
    pxiItemConstructMappingHash: null,
    instrument: "miniPXI",
    instrumentVersion: "miniPXI-v1",
    instrumentHash: "miniPXI-hash",
    consentVersion: "consent-v1",
    consentScope: "study-only",
    approved: true,
    approvedBy: "operator-1",
    responseWindowMs: 24 * 60 * 60 * 1000,
    minimumExposureMs: 60_000,
    orderDesign: "AB/BA",
    independentUnit: "participant",
    missingItemPolicy: "null-construct",
    invitedCount: 10,
    eligibleCount: 10,
    respondedCount: 9,
    withdrawnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

const manifest: HumanStudyPreferenceExportManifest = {
  studyIdColumn: "studyId",
  responseIdColumn: "responseId",
  revisionColumn: "revision",
  supersedesColumn: "supersedes",
  participantIdColumn: "participantId",
  consentVersionColumn: "consentVersion",
  consentScopeColumn: "consentScope",
  workspaceIdColumn: "workspaceId",
  episodeAColumn: "episodeA",
  exposureAStartedAtColumn: "startA",
  exposureAEndedAtColumn: "endA",
  episodeBColumn: "episodeB",
  exposureBStartedAtColumn: "startB",
  exposureBEndedAtColumn: "endB",
  orderColumn: "order",
  submittedAtColumn: "submittedAt",
  answerColumn: "answer"
};

function makeRow(
  participantId: string,
  answer: string,
  overrides: Partial<HumanStudyRawRow> = {}
): HumanStudyRawRow {
  return {
    studyId: "study-pref-1",
    responseId: "response-" + participantId,
    revision: "1",
    supersedes: "",
    participantId,
    consentVersion: "consent-v1",
    consentScope: "study-only",
    workspaceId: "workspace-1",
    episodeA: "episode-A-" + participantId,
    startA: "2026-02-01T10:00:00.000Z",
    endA: "2026-02-01T10:10:00.000Z",
    episodeB: "episode-B-" + participantId,
    startB: "2026-02-01T10:20:00.000Z",
    endB: "2026-02-01T10:30:00.000Z",
    order: "A-first",
    submittedAt: "2026-02-01T10:35:00.000Z",
    answer,
    ...overrides
  };
}

function validators(
  overrides: Partial<HumanStudyPreferenceImportValidators> = {}
): HumanStudyPreferenceImportValidators {
  return {
    isApprovedStudy: (study) => study.approved,
    isTrustedPreferenceQuestion: (_study, plan) =>
      plan.questionHash === "a".repeat(64),
    isWorkspaceAllowed: () => true,
    isBuildAllowed: () => true,
    isValidEpisodeLink: () => true,
    isPreferencePairComplete: () => true,
    isConsentValid: () => true,
    isParticipantWithdrawn: () => false,
    isExposureSufficient: () => true,
    isWithinResponseWindow: () => true,
    ...overrides
  };
}

function imported(
  rows: readonly HumanStudyRawRow[],
  options: {
    readonly study?: HumanPlaytestStudy;
    readonly validators?: Partial<HumanStudyPreferenceImportValidators>;
    readonly existing?: readonly HumanStudyPreferenceResponse[];
  } = {}
) {
  return importHumanStudyPreferenceResponses(
    options.study ?? makeStudy(),
    rows,
    manifest,
    validators(options.validators),
    options.existing
  );
}

test("paired preference import preserves A/B/tie/unable/missing as a distinct response", () => {
  const rows = [
    makeRow("p1", "B"),
    makeRow("p2", "A", {
      order: "B-first",
      startB: "2026-02-01T09:00:00.000Z",
      endB: "2026-02-01T09:10:00.000Z",
      startA: "2026-02-01T09:20:00.000Z",
      endA: "2026-02-01T09:30:00.000Z",
      submittedAt: "2026-02-01T09:35:00.000Z"
    }),
    makeRow("p3", "tie"),
    makeRow("p4", "unable-to-judge"),
    makeRow("p5", "")
  ];
  const result = imported(rows);
  assert.equal(result.accepted.length, 5);
  assert.deepEqual(
    result.accepted.map((response) => response.answer),
    ["B", "A", "tie", "unable-to-judge", null]
  );
  assert.equal(result.accepted[0]!.buildA.contentHash, HASH_A);
  assert.equal(result.accepted[0]!.buildB.contentHash, HASH_B);
  assert.equal(result.accepted[0]!.episodeA, "episode-A-p1");
  assert.equal(result.accepted[0]!.episodeB, "episode-B-p1");
  assert.equal("nativeValue" in result.accepted[0]!, false);
});

test("preference import requires an approved frozen question and exact completed build pair", () => {
  assert.equal(
    imported([makeRow("p1", "B")], {
      study: makeStudy({ approved: false })
    }).rejected[0]!.reason,
    "unapproved-study"
  );
  assert.equal(
    imported([makeRow("p1", "B")], {
      validators: { isTrustedPreferenceQuestion: () => false }
    }).rejected[0]!.reason,
    "untrusted-question"
  );
  assert.equal(
    imported([makeRow("p1", "B")], {
      validators: { isPreferencePairComplete: () => false }
    }).rejected[0]!.reason,
    "incomplete-preference-pair"
  );
  assert.throws(
    () =>
      imported([makeRow("p1", "B")], {
        study: (() => {
          const { preferencePlan: _preferencePlan, ...withoutPlan } =
            makeStudy();
          return withoutPlan;
        })()
      }),
    /no approved preference plan/
  );
});

test("preference import verifies consent before probing exposure links", () => {
  let pairLookups = 0;
  const result = imported([makeRow("p1", "B")], {
    validators: {
      isConsentValid: () => false,
      isPreferencePairComplete: () => {
        pairLookups += 1;
        return true;
      }
    }
  });
  assert.equal(result.rejected[0]!.reason, "consent-mismatch");
  assert.equal(pairLookups, 0);
});

test("counterbalanced order, exposure sufficiency, and post-second-exposure timing are enforced", () => {
  assert.equal(
    imported([
      makeRow("p1", "B", {
        order: "A-first",
        startB: "2026-02-01T09:00:00.000Z"
      })
    ]).rejected[0]!.reason,
    "invalid-exposure"
  );
  assert.equal(
    imported([makeRow("p1", "B")], {
      validators: { isExposureSufficient: () => false }
    }).rejected[0]!.reason,
    "invalid-exposure"
  );
  assert.equal(
    imported([makeRow("p1", "B")], {
      validators: { isWithinResponseWindow: () => false }
    }).rejected[0]!.reason,
    "wrong-timing"
  );
});

test("preference import enforces idempotency, revisioned amendments, and duplicate quarantine", () => {
  const first = imported([makeRow("p1", "A")]).accepted[0]!;
  assert.equal(
    imported([makeRow("p1", "A")], { existing: [first] }).unchanged.length,
    1
  );
  const amendment = makeRow("p1", "B", {
    responseId: "response-p1-revision-2",
    revision: "2",
    supersedes: first.responseId
  });
  const revised = imported([amendment], { existing: [first] });
  assert.deepEqual(revised.superseded, [first.responseId]);
  assert.equal(revised.accepted[0]!.answer, "B");
  assert.equal(
    imported([
      makeRow("p1", "A"),
      makeRow("p1", "B", { responseId: "response-p1-other" })
    ]).quarantined.length,
    1
  );
  const duplicateAmendments = imported(
    [
      makeRow("p1", "B", {
        responseId: "amendment-one",
        revision: "2",
        supersedes: first.responseId
      }),
      makeRow("p1", "A", {
        responseId: "amendment-two",
        revision: "2",
        supersedes: first.responseId
      })
    ],
    { existing: [first] }
  );
  assert.equal(duplicateAmendments.accepted.length, 0);
  assert.deepEqual(duplicateAmendments.superseded, []);
  assert.equal(duplicateAmendments.quarantined.length, 1);
  const existingAlternative = { ...first, responseId: "other-response" };
  const duplicate = imported([makeRow("p1", "B")], {
    existing: [existingAlternative]
  });
  assert.equal(duplicate.quarantined.length, 1);
  assert.deepEqual(
    new Set(duplicate.quarantined[0]!.responseIds),
    new Set([existingAlternative.responseId, "response-p1"])
  );
});

test("conflicting response IDs and malformed answer vocabularies do not become successful data", () => {
  const duplicateRows = [
    makeRow("p1", "A"),
    makeRow("p2", "B", { responseId: "response-p1" })
  ];
  const conflict = imported(duplicateRows);
  assert.equal(conflict.accepted.length, 0);
  assert.equal(conflict.rejected.length, 2);
  assert.ok(
    conflict.rejected.every((entry) => entry.reason === "response-id-conflict")
  );
  assert.equal(
    imported([makeRow("p1", "b")]).rejected[0]!.reason,
    "malformed-row"
  );
});

test("CSV and JSON preference exports use the shared strict scalar parser", () => {
  const row = makeRow("p1", "B");
  const csv = [
    Object.keys(manifest).join(","),
    Object.values(manifest)
      .map((column) => row[column] ?? "")
      .join(",")
  ].join("\n");
  assert.equal(parseHumanStudyExportRows(csv, "csv").length, 1);
  assert.equal(
    parseHumanStudyExportRows(JSON.stringify([row]), "json").length,
    1
  );
});
