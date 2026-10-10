import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateHumanStudyResponses,
  applyHumanStudySmallCellSuppression,
  type HumanPlaytestStudy,
  type HumanStudyExportManifest,
  type HumanStudyImportValidators,
  type HumanStudyRawRow,
  importHumanStudyResponses,
  parseHumanStudyExportRows,
  PLAYTESTS_HUMAN_STUDY_SCHEMA,
  PLAYTESTS_PXI_CONSTRUCTS,
  withdrawHumanStudyParticipant
} from "../src/playtesting/index.ts";

function makeStudy(
  overrides: Partial<HumanPlaytestStudy> = {}
): HumanPlaytestStudy {
  return {
    schema: PLAYTESTS_HUMAN_STUDY_SCHEMA,
    studyId: "study-fixture-1",
    version: 1,
    workspaceId: "ws-1",
    benchmarkId: "bench-1",
    allowedBuilds: [
      { id: "build-A", version: "1" },
      { id: "build-B", version: "1" }
    ],
    pxiItemConstructMappingHash: null,
    instrument: "miniPXI",
    instrumentVersion: "miniPXI-v1",
    instrumentHash: "hash-miniPXI-v1",
    consentVersion: "consent-v1",
    consentScope: "post-play-feedback",
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

function makeManifest(): HumanStudyExportManifest {
  return {
    studyIdColumn: "studyId",
    responseIdColumn: "responseId",
    revisionColumn: "revision",
    supersedesColumn: "supersedes",
    participantIdColumn: "participantId",
    consentVersionColumn: "consentVersion",
    consentScopeColumn: "consentScope",
    instrumentColumn: "instrument",
    instrumentVersionColumn: "instrumentVersion",
    instrumentHashColumn: "instrumentHash",
    workspaceIdColumn: "workspaceId",
    buildIdColumn: "buildId",
    buildVersionColumn: "buildVersion",
    buildHashColumn: "buildHash",
    episodeIdColumn: "episodeId",
    exposureStartedAtColumn: "exposureStartedAt",
    exposureEndedAtColumn: "exposureEndedAt",
    orderColumn: "order",
    submittedAtColumn: "submittedAt",
    completionStatusColumn: "completionStatus",
    items: [
      {
        itemId: "ENJ",
        valueColumn: "enj",
        missingReasonColumn: "enjMissingReason"
      }
    ]
  };
}

function allowAllValidators(
  overrides: Partial<HumanStudyImportValidators> = {}
): HumanStudyImportValidators {
  return {
    isApprovedStudy: (study) => study.approved,
    isWorkspaceAllowed: () => true,
    isBuildAllowed: () => true,
    isTrustedInstrumentVersion: () => true,
    isTrustedPxiItemConstructMapping: () => true,
    isValidEpisodeLink: () => true,
    isConsentValid: () => true,
    isParticipantWithdrawn: () => false,
    isExposureSufficient: () => true,
    isWithinResponseWindow: () => true,
    ...overrides
  };
}

interface FixtureRow {
  readonly participantId: string;
  readonly buildId: "build-A" | "build-B";
  readonly enj: string;
}

function makeRow(
  study: HumanPlaytestStudy,
  row: FixtureRow,
  revision = "1",
  supersedes = ""
): HumanStudyRawRow {
  return {
    studyId: study.studyId,
    responseId: `${row.participantId}-${row.buildId}-r${revision}`,
    revision,
    supersedes,
    participantId: row.participantId,
    consentVersion: study.consentVersion,
    consentScope: study.consentScope,
    instrument: study.instrument,
    instrumentVersion: study.instrumentVersion,
    instrumentHash: study.instrumentHash,
    workspaceId: study.workspaceId,
    buildId: row.buildId,
    buildVersion: "1",
    buildHash: "",
    episodeId: `ep-${row.participantId}-${row.buildId}`,
    exposureStartedAt: "2026-02-01T00:00:00.000Z",
    exposureEndedAt: "2026-02-01T00:10:00.000Z",
    order: "A-first",
    submittedAt: "2026-02-01T00:15:00.000Z",
    completionStatus: "completed",
    enj: row.enj,
    enjMissingReason: ""
  };
}

/**
 * The exact synthetic five-player fixture from
 * docs/playtesting-measurement-contract.md#7-human-labels-and-change-sensitivity:
 * P1 ENJ=(1,2), P2=(0,1), P3=(-1,null), P4=(2,2), P5=(1,3) then withdraws.
 * Ten invited exposures, eight retained exposure records, seven valid ENJ
 * responses, four retained participants, three complete pairs. A mean=0.5
 * (n=4); B mean=5/3 (n=3); complete-pair differences average 2/3 (n=3).
 */
function fivePlayerFixtureRows(
  study: HumanPlaytestStudy
): readonly HumanStudyRawRow[] {
  const enjByPlayer: Record<string, readonly [string, string]> = {
    p1: ["1", "2"],
    p2: ["0", "1"],
    p3: ["-1", ""],
    p4: ["2", "2"],
    p5: ["1", "3"]
  };
  const rows: HumanStudyRawRow[] = [];
  for (const [participantId, [enjA, enjB]] of Object.entries(enjByPlayer)) {
    rows.push(
      makeRow(study, { participantId, buildId: "build-A", enj: enjA }),
      makeRow(study, { participantId, buildId: "build-B", enj: enjB })
    );
  }
  return rows;
}

test("importHumanStudyResponses accepts the five-player fixture: 10 rows x 1 item, none rejected or quarantined", () => {
  const study = makeStudy();
  const outcome = importHumanStudyResponses(
    study,
    fivePlayerFixtureRows(study),
    makeManifest(),
    allowAllValidators()
  );
  assert.equal(outcome.accepted.length, 10);
  assert.equal(outcome.rejected.length, 0);
  assert.equal(outcome.quarantined.length, 0);
  assert.equal(outcome.unchanged.length, 0);
});

test("P3\u2019s missing B-build ENJ item stays visible as an explicit null, not dropped", () => {
  const study = makeStudy();
  const outcome = importHumanStudyResponses(
    study,
    fivePlayerFixtureRows(study),
    makeManifest(),
    allowAllValidators()
  );
  const p3B = outcome.accepted.find(
    (response) =>
      response.pseudonymousParticipantId === "p3" &&
      response.build.id === "build-B"
  );
  assert.ok(p3B, "expected an accepted response row for p3/build-B");
  assert.equal(p3B!.nativeValue, null);
  assert.equal(p3B!.missingReason, "missing-ENJ");
});

test("re-importing the identical five-player export is idempotent: no new accepted rows, all unchanged", () => {
  const study = makeStudy();
  const rows = fivePlayerFixtureRows(study);
  const first = importHumanStudyResponses(
    study,
    rows,
    makeManifest(),
    allowAllValidators()
  );
  const second = importHumanStudyResponses(
    study,
    rows,
    makeManifest(),
    allowAllValidators(),
    first.accepted
  );
  assert.equal(second.accepted.length, 0);
  assert.equal(second.unchanged.length, 10);
  assert.equal(second.rejected.length, 0);
  assert.equal(second.quarantined.length, 0);
});

test("P5 withdrawal recomputation reproduces the fixture\u2019s exact A/B means and complete-pair difference", () => {
  const study = makeStudy();
  const rows = fivePlayerFixtureRows(study);
  const outcome = importHumanStudyResponses(
    study,
    rows,
    makeManifest(),
    allowAllValidators()
  );
  assert.equal(outcome.accepted.length, 10);

  const withdrawnMarked = withdrawHumanStudyParticipant(outcome.accepted, "p5");
  const result = aggregateHumanStudyResponses(study, withdrawnMarked, {
    pairedArmBuildIds: { a: "build-A", b: "build-B" }
  });

  assert.equal(result.retainedParticipants, 4);

  const armA = result.arms.find(
    (arm) => arm.itemId === "ENJ" && arm.armBuildId === "build-A"
  )!;
  assert.ok(armA, "expected an ENJ aggregate for build-A");
  assert.equal(armA.respondentCount, 4);
  assert.equal(armA.mean, 0.5);
  assert.equal(armA.missingCount, 0);

  const armB = result.arms.find(
    (arm) => arm.itemId === "ENJ" && arm.armBuildId === "build-B"
  )!;
  assert.ok(armB, "expected an ENJ aggregate for build-B");
  assert.equal(armB.respondentCount, 3);
  assert.equal(armB.mean, 5 / 3);
  assert.equal(armB.missingCount, 1);
  assert.deepEqual(armB.missingReasons, ["missing-ENJ"]);

  const pairedEnj = result.pairedDifferences.find(
    (diff) => diff.itemId === "ENJ"
  )!;
  assert.ok(pairedEnj, "expected a paired ENJ difference");
  assert.equal(pairedEnj.pairedParticipants, 3);
  assert.equal(pairedEnj.meanDifference, 2 / 3);

  // Privacy suppression: every retained-participant count in this fixture
  // (4) is below the v1 small-cell floor of 5, so the computed aggregate
  // must be suppressed at the summary boundary even though the underlying
  // math above is exactly right.
  assert.equal(applyHumanStudySmallCellSuppression(result), null);
});

test("applyHumanStudySmallCellSuppression passes through an aggregate at or above the threshold", () => {
  const study = makeStudy();
  const result = aggregateHumanStudyResponses(study, []);
  const atThreshold = { ...result, retainedParticipants: 5 };
  assert.equal(applyHumanStudySmallCellSuppression(atThreshold), atThreshold);
  const belowThreshold = { ...result, retainedParticipants: 4 };
  assert.equal(applyHumanStudySmallCellSuppression(belowThreshold), null);
});

test("importHumanStudyResponses rejects every row for an unapproved study", () => {
  const study = makeStudy({ approved: false });
  const outcome = importHumanStudyResponses(
    study,
    fivePlayerFixtureRows(study),
    makeManifest(),
    allowAllValidators()
  );
  assert.equal(outcome.accepted.length, 0);
  assert.equal(outcome.rejected.length, 10);
  assert.ok(
    outcome.rejected.every(
      (rejection) => rejection.reason === "unapproved-study"
    )
  );
});

test("importHumanStudyResponses rejects an out-of-range native item value as bad-item-range", () => {
  const study = makeStudy();
  const rows = [
    makeRow(study, { participantId: "p1", buildId: "build-A", enj: "9" })
  ];
  const outcome = importHumanStudyResponses(
    study,
    rows,
    makeManifest(),
    allowAllValidators()
  );
  assert.equal(outcome.accepted.length, 0);
  assert.equal(outcome.rejected.length, 1);
  assert.equal(outcome.rejected[0]!.reason, "bad-item-range");
});

test("importHumanStudyResponses rejects a workspace the trusted callback does not allow", () => {
  const study = makeStudy();
  const rows = [
    makeRow(study, { participantId: "p1", buildId: "build-A", enj: "1" })
  ];
  const outcome = importHumanStudyResponses(
    study,
    rows,
    makeManifest(),
    allowAllValidators({ isWorkspaceAllowed: () => false })
  );
  assert.equal(outcome.accepted.length, 0);
  assert.equal(outcome.rejected[0]!.reason, "wrong-workspace");
});

test("trusted build, instrument-hash, episode, consent, exposure, timing, and withdrawal callbacks restrict import", () => {
  const study = makeStudy();
  const row = makeRow(study, {
    participantId: "p1",
    buildId: "build-A",
    enj: "1"
  });
  const cases: readonly [Partial<HumanStudyImportValidators>, string][] = [
    [{ isBuildAllowed: () => false }, "wrong-build"],
    [
      { isTrustedInstrumentVersion: () => false },
      "untrusted-instrument-version"
    ],
    [{ isValidEpisodeLink: () => false }, "invalid-episode-link"],
    [{ isParticipantWithdrawn: () => true }, "withdrawn-participant"],
    [{ isConsentValid: () => false }, "consent-mismatch"],
    [{ isExposureSufficient: () => false }, "invalid-exposure"],
    [{ isWithinResponseWindow: () => false }, "wrong-timing"]
  ];
  for (const [override, reason] of cases) {
    const result = importHumanStudyResponses(
      study,
      [row],
      makeManifest(),
      allowAllValidators(override)
    );
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0]!.reason, reason);
  }
});

test("importHumanStudyResponses quarantines an independent duplicate participant\u00D7episode\u00D7instrument submission", () => {
  const study = makeStudy();
  const base = makeRow(study, {
    participantId: "p1",
    buildId: "build-A",
    enj: "1"
  });
  const duplicate: HumanStudyRawRow = {
    ...base,
    responseId: "p1-build-A-r1-duplicate"
  };
  const outcome = importHumanStudyResponses(
    study,
    [base, duplicate],
    makeManifest(),
    allowAllValidators()
  );
  assert.equal(outcome.accepted.length, 0);
  assert.equal(outcome.quarantined.length, 1);
  assert.equal(
    outcome.quarantined[0]!.reason,
    "duplicate-participant-episode-instrument"
  );
  assert.deepEqual(
    [...outcome.quarantined[0]!.responseIds].sort(),
    [base.responseId, duplicate.responseId].sort()
  );
});

test("an amendment with supersedes replaces the prior response without triggering quarantine", () => {
  const study = makeStudy();
  const original = makeRow(study, {
    participantId: "p1",
    buildId: "build-A",
    enj: "1"
  });
  const first = importHumanStudyResponses(
    study,
    [original],
    makeManifest(),
    allowAllValidators()
  );
  assert.equal(first.accepted.length, 1);

  const amendment = makeRow(
    study,
    { participantId: "p1", buildId: "build-A", enj: "2" },
    "2",
    original.responseId as string
  );
  const second = importHumanStudyResponses(
    study,
    [amendment],
    makeManifest(),
    allowAllValidators(),
    first.accepted
  );
  assert.equal(second.accepted.length, 1);
  assert.equal(second.accepted[0]!.nativeValue, 2);
  assert.equal(second.quarantined.length, 0);
  assert.deepEqual(second.superseded, [original.responseId]);
});

test("revision and supersedes require the current same-lineage response at exactly revision+1", () => {
  const study = makeStudy();
  const original = makeRow(study, {
    participantId: "p1",
    buildId: "build-A",
    enj: "1"
  });
  const first = importHumanStudyResponses(
    study,
    [original],
    makeManifest(),
    allowAllValidators()
  );
  for (const revision of ["NaN", "1.5", "0"]) {
    const invalid = { ...original, responseId: "bad-" + revision, revision };
    const result = importHumanStudyResponses(
      study,
      [invalid],
      makeManifest(),
      allowAllValidators(),
      first.accepted
    );
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0]!.reason, "malformed-row");
  }
  const unknownTarget = {
    ...original,
    responseId: "unknown-target",
    revision: "2",
    supersedes: "missing"
  };
  assert.equal(
    importHumanStudyResponses(
      study,
      [unknownTarget],
      makeManifest(),
      allowAllValidators(),
      first.accepted
    ).rejected[0]!.reason,
    "malformed-row"
  );
  const wrongLineage = {
    ...original,
    responseId: "wrong-lineage",
    revision: "2",
    supersedes: original.responseId!,
    participantId: "p2"
  };
  assert.equal(
    importHumanStudyResponses(
      study,
      [wrongLineage],
      makeManifest(),
      allowAllValidators(),
      first.accepted
    ).rejected[0]!.reason,
    "malformed-row"
  );
  const skippedRevision = {
    ...original,
    responseId: "skipped",
    revision: "3",
    supersedes: original.responseId!
  };
  assert.equal(
    importHumanStudyResponses(
      study,
      [skippedRevision],
      makeManifest(),
      allowAllValidators(),
      first.accepted
    ).rejected[0]!.reason,
    "malformed-row"
  );
});

test("idempotency includes full consent, build, timing, completion and revision provenance", () => {
  const study = makeStudy();
  const row = makeRow(study, {
    participantId: "p1",
    buildId: "build-A",
    enj: "1"
  });
  const first = importHumanStudyResponses(
    study,
    [row],
    makeManifest(),
    allowAllValidators()
  );
  assert.equal(first.accepted[0]!.completionStatus, "completed");
  const changed = { ...row, submittedAt: "2026-02-01T00:20:00.000Z" };
  const replay = importHumanStudyResponses(
    study,
    [changed],
    makeManifest(),
    allowAllValidators(),
    first.accepted
  );
  assert.equal(replay.unchanged.length, 0);
  assert.equal(replay.accepted.length, 0);
  assert.equal(replay.rejected[0]!.reason, "malformed-row");
  const invalidStatus = {
    ...row,
    responseId: "invalid-status",
    completionStatus: "partial-ish"
  };
  assert.equal(
    importHumanStudyResponses(
      study,
      [invalidStatus],
      makeManifest(),
      allowAllValidators()
    ).rejected[0]!.reason,
    "malformed-row"
  );
});

test("missing reasons are closed-vocabulary values and unknown reasons are rejected", () => {
  const study = makeStudy();
  const row = makeRow(study, {
    participantId: "p1",
    buildId: "build-A",
    enj: ""
  });
  const invalid = {
    ...row,
    enjMissingReason: "operator-typed-private-comment"
  };
  const result = importHumanStudyResponses(
    study,
    [invalid],
    makeManifest(),
    allowAllValidators()
  );
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]!.reason, "bad-missing-reason");
});

test("CSV/JSON parsers reject oversized, ragged, duplicate-header and object-coercion exports", () => {
  assert.throws(() => parseHumanStudyExportRows("a,a\n1,2", "csv"), /unique/);
  assert.throws(
    () => parseHumanStudyExportRows("a,b\n1", "csv"),
    /column count/
  );
  assert.throws(
    () => parseHumanStudyExportRows('[{"x":{"toString":"coerced"}}]', "json"),
    /scalar/
  );
  assert.throws(
    () => parseHumanStudyExportRows('[{"x":1,"x":2}]', "json"),
    /unique/
  );
  assert.throws(
    () => parseHumanStudyExportRows("x".repeat(2_000_001), "json"),
    /maximum allowed size/
  );
  assert.throws(
    () => parseHumanStudyExportRows("column\n" + "x".repeat(16_385), "csv"),
    /field exceeds/
  );
  assert.throws(
    () => parseHumanStudyExportRows("a,".repeat(256) + "b\n", "csv"),
    /too many columns/
  );
  assert.throws(
    () => parseHumanStudyExportRows("[" + "{},".repeat(10_000) + "{}]", "json"),
    /maximum allowed row count/
  );
});

test("project-authored scales use the declared native range instead of miniPXI bounds", () => {
  const study = makeStudy({
    instrument: "project-authored",
    instrumentVersion: "project-v2",
    instrumentHash: "project-hash"
  });
  const manifest: HumanStudyExportManifest = {
    ...makeManifest(),
    nativeScale: { minimum: 0, maximum: 100, unit: "project-score-0-100" },
    items: [{ itemId: "Q1", valueColumn: "q1" }]
  };
  const {
    enj: _enj,
    enjMissingReason: _reason,
    ...base
  } = makeRow(makeStudy(), {
    participantId: "p1",
    buildId: "build-A",
    enj: ""
  });
  const row = {
    ...base,
    instrument: "project-authored",
    instrumentVersion: "project-v2",
    instrumentHash: "project-hash",
    q1: "37.5"
  };
  const outcome = importHumanStudyResponses(
    study,
    [row],
    manifest,
    allowAllValidators()
  );
  assert.equal(outcome.rejected.length, 0);
  assert.equal(outcome.accepted[0]!.nativeValue, 37.5);
  assert.equal(outcome.accepted[0]!.nativeUnit, "project-score-0-100");
  const bad = { ...row, responseId: "bad-range", q1: "101" };
  assert.equal(
    importHumanStudyResponses(study, [bad], manifest, allowAllValidators())
      .rejected[0]!.reason,
    "bad-item-range"
  );
});

test("full PXI constructs use the trusted 30-item mapping and null any incomplete three-item construct", () => {
  const pxiStudy = makeStudy({
    instrument: "PXI",
    instrumentVersion: "PXI-v1",
    instrumentHash: "PXI-hash",
    pxiItemConstructMappingHash: "d".repeat(64)
  });
  const pxiItems = PLAYTESTS_PXI_CONSTRUCTS.flatMap((constructId) =>
    [1, 2, 3].map((ordinal) => ({
      itemId: `${constructId}_${String(ordinal)}`,
      valueColumn: `${constructId}_${String(ordinal)}`,
      constructId
    }))
  );
  const pxiManifest: HumanStudyExportManifest = {
    ...makeManifest(),
    items: pxiItems.map(({ itemId, valueColumn }) => ({
      itemId,
      valueColumn
    })),
    pxiItemConstructMapping: {
      instrumentHash: pxiStudy.instrumentHash,
      items: pxiItems.map(({ itemId, constructId }) => ({
        itemId,
        constructId
      }))
    }
  };
  const {
    enj: _enj,
    enjMissingReason: _reason,
    ...pxiBase
  } = makeRow(makeStudy(), {
    participantId: "p1",
    buildId: "build-A",
    enj: ""
  });
  const pxiRow = {
    ...pxiBase,
    instrument: "PXI",
    instrumentVersion: "PXI-v1",
    instrumentHash: "PXI-hash",
    ...Object.fromEntries(
      pxiItems.map(({ itemId }) => [
        itemId,
        itemId === "AA_3" ? "" : itemId === "AA_1" ? "2" : "1"
      ])
    )
  };
  const pxi = importHumanStudyResponses(
    pxiStudy,
    [pxiRow],
    pxiManifest,
    allowAllValidators()
  );
  assert.equal(pxi.accepted.length, 30);
  assert.equal(
    pxi.accepted.find((response) => response.itemId === "AA_1")!.nativeValue,
    2
  );
  assert.equal(pxi.accepted[0]!.nativeUnit, "native-Likert-minus3-plus3");
  const pxiAggregate = aggregateHumanStudyResponses(pxiStudy, pxi.accepted);
  assert.equal(pxiAggregate.arms.length, 30);
  assert.equal(pxiAggregate.constructs.length, 10);
  const autonomyAesthetics = pxiAggregate.constructs.find(
    (construct) => construct.constructId === "AA"
  )!;
  assert.equal(autonomyAesthetics.mean, null);
  assert.equal(autonomyAesthetics.respondentCount, 0);
  assert.equal(autonomyAesthetics.missingCount, 1);
  const challenge = pxiAggregate.constructs.find(
    (construct) => construct.constructId === "CH"
  )!;
  assert.equal(challenge.mean, 1);
  assert.equal(challenge.respondentCount, 1);
  assert.equal(challenge.missingCount, 0);
  assert.equal(autonomyAesthetics.unit, "native-Likert-minus3-plus3");

  const untrustedMapping = importHumanStudyResponses(
    pxiStudy,
    [pxiRow],
    pxiManifest,
    allowAllValidators({
      isTrustedPxiItemConstructMapping: () => false
    })
  );
  assert.equal(untrustedMapping.accepted.length, 0);
  assert.equal(
    untrustedMapping.rejected[0]!.reason,
    "untrusted-instrument-version"
  );

  const wrongConstructCount = {
    ...pxiManifest,
    pxiItemConstructMapping: {
      ...pxiManifest.pxiItemConstructMapping!,
      items: pxiManifest.pxiItemConstructMapping!.items.map((item) =>
        item.itemId === "AA_3" ? { ...item, constructId: "CH" as const } : item
      )
    }
  };
  assert.throws(
    () =>
      importHumanStudyResponses(
        pxiStudy,
        [pxiRow],
        wrongConstructCount,
        allowAllValidators()
      ),
    /exactly three published items/
  );

  assert.throws(
    () =>
      importHumanStudyResponses(
        pxiStudy,
        [pxiRow],
        {
          ...pxiManifest,
          pxiItemConstructMapping: {
            ...pxiManifest.pxiItemConstructMapping!,
            instrumentHash: "untrusted-hash"
          }
        },
        allowAllValidators()
      ),
    /bound to the approved instrument hash/
  );
  assert.throws(
    () =>
      importHumanStudyResponses(
        pxiStudy,
        [pxiRow],
        { ...pxiManifest, items: pxiManifest.items.slice(0, 29) },
        allowAllValidators()
      ),
    /30 item mappings/
  );

  const miniStudy = makeStudy();
  const missingRows = [
    makeRow(miniStudy, { participantId: "p1", buildId: "build-A", enj: "" })
  ];
  const missing = importHumanStudyResponses(
    miniStudy,
    missingRows,
    makeManifest(),
    allowAllValidators()
  );
  const missingAggregate = aggregateHumanStudyResponses(
    miniStudy,
    missing.accepted
  );
  assert.equal(missingAggregate.arms[0]!.itemId, "ENJ");
  assert.equal(missingAggregate.arms[0]!.mean, null);
  assert.equal(missingAggregate.arms[0]!.missingCount, 1);
});

test("manifest rejects duplicate mapped columns and duplicate item IDs", () => {
  const study = makeStudy();
  const duplicateColumn = {
    ...makeManifest(),
    items: [{ itemId: "ENJ", valueColumn: "studyId" }]
  };
  assert.throws(
    () =>
      importHumanStudyResponses(
        study,
        [],
        duplicateColumn,
        allowAllValidators()
      ),
    /columns/
  );
  const duplicateItem = {
    ...makeManifest(),
    items: [
      { itemId: "ENJ", valueColumn: "one" },
      { itemId: "ENJ", valueColumn: "two" }
    ]
  };
  assert.throws(
    () =>
      importHumanStudyResponses(study, [], duplicateItem, allowAllValidators()),
    /unique item/
  );
});
