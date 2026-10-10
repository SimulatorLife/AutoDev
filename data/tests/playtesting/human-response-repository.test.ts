import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import {
  type HumanPlaytestStudy,
  type HumanStudyExportManifest,
  type HumanStudyImportValidators,
  type HumanStudyRawRow,
  PLAYTESTS_HUMAN_STUDY_SCHEMA,
  PLAYTESTS_PXI_CONSTRUCTS
} from "@simulatorlife/autodev-core";

import {
  RestrictedHumanResponseRepository,
  RestrictedHumanStudyNotRegisteredError,
  RestrictedHumanStudyStorageError,
  hashHumanStudyPxiItemConstructMapping
} from "../../src/playtesting/human-response-repository.ts";

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
function makeValidators(
  repository: RestrictedHumanResponseRepository,
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
  value: FixtureRow
): HumanStudyRawRow {
  return {
    studyId: study.studyId,
    responseId: value.participantId + "-" + value.buildId + "-r1",
    revision: "1",
    supersedes: "",
    participantId: value.participantId,
    consentVersion: study.consentVersion,
    consentScope: study.consentScope,
    instrument: study.instrument,
    instrumentVersion: study.instrumentVersion,
    instrumentHash: study.instrumentHash,
    workspaceId: study.workspaceId,
    buildId: value.buildId,
    buildVersion: "1",
    buildHash: "",
    episodeId: "ep-" + value.participantId + "-" + value.buildId,
    exposureStartedAt: "2026-02-01T00:00:00.000Z",
    exposureEndedAt: "2026-02-01T00:10:00.000Z",
    order: "A-first",
    submittedAt: "2026-02-01T00:15:00.000Z",
    completionStatus: "completed",
    enj: value.enj,
    enjMissingReason: ""
  };
}
function fixtureRows(study: HumanPlaytestStudy): readonly HumanStudyRawRow[] {
  const values: Record<string, readonly [string, string]> = {
    p1: ["1", "2"],
    p2: ["0", "1"],
    p3: ["-1", ""],
    p4: ["2", "2"],
    p5: ["1", "3"]
  };
  const rows: HumanStudyRawRow[] = [];
  for (const [participantId, [a, b]] of Object.entries(values)) {
    rows.push(
      makeRow(study, { participantId, buildId: "build-A", enj: a }),
      makeRow(study, { participantId, buildId: "build-B", enj: b })
    );
  }
  return rows;
}
function setup(t: TestContext): {
  readonly root: string;
  readonly repository: RestrictedHumanResponseRepository;
  readonly study: HumanPlaytestStudy;
} {
  const root = mkdtempSync(join(tmpdir(), "autodev-human-study-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  const study = makeStudy();
  repository.registerStudy(study);
  for (const participant of ["p1", "p2", "p3", "p4", "p5"]) {
    repository.recordConsent(
      study.studyId,
      participant,
      study.consentVersion,
      study.consentScope
    );
  }
  const imported = repository.importRows(
    study.studyId,
    fixtureRows(study),
    makeManifest(),
    makeValidators(repository),
    { pairedArmBuildIds: { a: "build-A", b: "build-B" } }
  );
  assert.equal(imported.acceptedCount, 10);
  assert.equal(imported.rejected.length, 0);
  assert.equal(imported.quarantined.length, 0);
  return { root, repository, study };
}

test("rejects an unregistered study and registration itself fails closed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "autodev-human-study-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  const study = makeStudy();
  assert.throws(
    () =>
      repository.importRows(
        study.studyId,
        [],
        makeManifest(),
        makeValidators(repository)
      ),
    RestrictedHumanStudyNotRegisteredError
  );
  assert.throws(
    () => repository.registerStudy(makeStudy({ approved: false })),
    /valid, approved/
  );
});

test("authorized fixture import persists privately and suppresses each under-five item cell", (t) => {
  const { root, repository, study } = setup(t);
  const summaryA = repository.getHumanValidationSummary(
    study.studyId,
    "build-A"
  );
  const summaryB = repository.getHumanValidationSummary(
    study.studyId,
    "build-B"
  );
  assert.ok(summaryA && summaryB);
  assert.equal(summaryA.retainedParticipants, 5);
  assert.equal(summaryA.items[0]!.mean, null);
  assert.equal(summaryA.items[0]!.respondentCount, null);
  assert.equal(summaryA.items[0]!.suppressionState, "suppressed");
  assert.equal(summaryA.items[0]!.categoryCounts, null);
  assert.equal(summaryB.suppressionState, "partially-suppressed");
  assert.equal(summaryB.items[0]!.suppressionState, "suppressed");
  assert.equal(summaryB.items[0]!.mean, null);
  assert.equal(summaryB.items[0]!.respondentCount, null);
  assert.equal(JSON.stringify(summaryA).includes("p1"), false);
  const contents = readFileSync(
    join(
      root,
      readdirSync(root).find((name) => name.endsWith(".json"))!
    ),
    "utf8"
  );
  assert.equal(
    contents.includes("mean"),
    false,
    "numeric summaries must be derived, not persisted"
  );
  assert.equal(
    contents.includes("p3"),
    true,
    "raw responses stay in the restricted owner-only store"
  );
});

test("restricted PXI summaries preserve a null construct and a complete construct", (t) => {
  const root = mkdtempSync(join(tmpdir(), "autodev-human-study-pxi-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pxiItems = PLAYTESTS_PXI_CONSTRUCTS.flatMap((constructId) =>
    [1, 2, 3].map((ordinal) => ({
      itemId: constructId + "_" + String(ordinal),
      valueColumn: constructId + "_" + String(ordinal),
      constructId
    }))
  );
  const pxiItemConstructMapping = {
    instrumentHash: "PXI-hash",
    items: pxiItems.map(({ itemId, constructId }) => ({ itemId, constructId }))
  };
  const study = makeStudy({
    studyId: "study-pxi-fixture",
    instrument: "PXI",
    instrumentVersion: "PXI-v1",
    instrumentHash: "PXI-hash",
    pxiItemConstructMappingHash: hashHumanStudyPxiItemConstructMapping(
      pxiItemConstructMapping
    )
  });
  const manifest: HumanStudyExportManifest = {
    ...makeManifest(),
    items: pxiItems.map(({ itemId, valueColumn }) => ({ itemId, valueColumn })),
    pxiItemConstructMapping
  };
  const repository = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  repository.registerStudy(study);
  const rows: HumanStudyRawRow[] = [];
  for (let index = 1; index <= 5; index += 1) {
    const participantId = "pxi-p" + String(index);
    repository.recordConsent(
      study.studyId,
      participantId,
      study.consentVersion,
      study.consentScope
    );
    const {
      enj: _enj,
      enjMissingReason: _reason,
      ...metadata
    } = makeRow(study, { participantId, buildId: "build-A", enj: "" });
    const itemValues = Object.fromEntries(
      pxiItems.map(({ itemId }) => [
        itemId,
        itemId === "AA_3" && index === 1 ? "" : "1"
      ])
    );
    rows.push({ ...metadata, ...itemValues });
  }
  const imported = repository.importRows(
    study.studyId,
    rows,
    manifest,
    makeValidators(repository)
  );
  assert.equal(imported.acceptedCount, 150);

  const summary = repository.getHumanValidationSummary(
    study.studyId,
    "build-A"
  );
  assert.ok(summary);
  const aa = summary.constructs.find((entry) => entry.constructId === "AA")!;
  assert.equal(aa.suppressionState, "suppressed");
  assert.equal(aa.mean, null);
  const challenge = summary.constructs.find(
    (entry) => entry.constructId === "CH"
  )!;
  assert.equal(challenge.suppressionState, "unsuppressed");
  assert.equal(challenge.mean, 1);
  assert.equal(challenge.respondentCount, 5);
});

test("identical re-import survives repository reconstruction without changing revision or counts", (t) => {
  const { root, repository, study } = setup(t);
  const before = repository.getHumanValidationSummary(
    study.studyId,
    "build-A"
  )!.revision;
  const reconstructed = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  reconstructed.registerStudy(study);
  const report = reconstructed.importRows(
    study.studyId,
    fixtureRows(study),
    makeManifest(),
    makeValidators(reconstructed),
    { pairedArmBuildIds: { a: "build-A", b: "build-B" } }
  );
  assert.equal(report.acceptedCount, 0);
  assert.equal(report.unchangedCount, 10);
  assert.equal(report.revision, before);
});

test("repository startup removes owner-only orphaned atomic staging files", (t) => {
  const { root, study } = setup(t);
  const studyHash = createHash("sha256").update(study.studyId).digest("hex");
  const orphan = join(
    root,
    studyHash + ".json.12345678-1234-4234-8234-123456789abc.tmp"
  );
  writeFileSync(orphan, "synthetic-pseudonym-and-response");
  chmodSync(orphan, 0o600);
  const restarted = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  restarted.registerStudy(study);
  assert.equal(
    readdirSync(root).some((name) => name.endsWith(".tmp")),
    false
  );
});

test("separate processes serialize consent updates and reconstructed readers see both commits", async (t) => {
  const { root, repository, study } = setup(t);
  const moduleUrl = pathToFileURL(
    resolve("src/playtesting/human-response-repository.ts")
  ).href;
  const children = ["p6", "p7"].map((participantId) => {
    const source = [
      `import { RestrictedHumanResponseRepository } from ${JSON.stringify(moduleUrl)};`,
      `const repository = new RestrictedHumanResponseRepository({ rootDirectory: ${JSON.stringify(root)} });`,
      `repository.recordConsent(${JSON.stringify(study.studyId)}, ${JSON.stringify(participantId)}, ${JSON.stringify(study.consentVersion)}, ${JSON.stringify(study.consentScope)});`
    ].join("\n");
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdio: "ignore"
      }
    );
    return new Promise<void>((_resolve, _reject) => {
      child.once("error", _reject);
      child.once("exit", (code, signal) => {
        if (code === 0) _resolve();
        else
          _reject(
            new Error(
              `writer child exited with ${String(code)} (${String(signal)})`
            )
          );
      });
    });
  });
  await Promise.all(children);

  const reconstructed = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  reconstructed.registerStudy(study);
  assert.deepEqual(reconstructed.getConsent(study.studyId, "p6"), {
    consentVersion: study.consentVersion,
    consentScope: study.consentScope
  });
  assert.deepEqual(reconstructed.getConsent(study.studyId, "p7"), {
    consentVersion: study.consentVersion,
    consentScope: study.consentScope
  });
  assert.ok(repository);
});

test("live writer contention has a bounded wait and blocks startup staging cleanup", (t) => {
  const { root, repository, study } = setup(t);
  const lockFile = join(root, ".human-study-writer.lock");
  writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, token: "test-live-owner" })
  );
  chmodSync(lockFile, 0o600);
  const orphan = join(
    root,
    createHash("sha256").update(study.studyId).digest("hex") +
      ".json.12345678-1234-4234-8234-123456789abc.tmp"
  );
  writeFileSync(orphan, "owner-only synthetic staging data");
  chmodSync(orphan, 0o600);

  const startedAt = performance.now();
  assert.throws(
    () =>
      repository.recordConsent(
        study.studyId,
        "p6",
        study.consentVersion,
        study.consentScope
      ),
    /Timed out waiting for the restricted human-study writer lock/
  );
  assert.ok(performance.now() - startedAt < 2000);
  assert.equal(repository.getConsent(study.studyId, "p6"), null);
  assert.throws(
    () => new RestrictedHumanResponseRepository({ rootDirectory: root }),
    /Timed out waiting for the restricted human-study writer lock/
  );
  assert.equal(readdirSync(root).includes(orphan.split("/").at(-1)!), true);
  rmSync(lockFile, { force: true });
  const recovered = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  recovered.registerStudy(study);
  assert.equal(
    readdirSync(root).some((name) => name.endsWith(".tmp")),
    false
  );
});

test("stale writer-owner metadata fails closed rather than stealing or deleting the lock", (t) => {
  const { root, repository, study } = setup(t);
  const lockFile = join(root, ".human-study-writer.lock");
  writeFileSync(
    lockFile,
    JSON.stringify({ pid: 2_000_000_000, token: "dead-owner" })
  );
  chmodSync(lockFile, 0o600);
  assert.throws(
    () =>
      repository.recordConsent(
        study.studyId,
        "p6",
        study.consentVersion,
        study.consentScope
      ),
    /stale writer lock exists; automatic removal is unsafe/
  );
  assert.equal(readdirSync(root).includes(".human-study-writer.lock"), true);
  assert.equal(repository.getConsent(study.studyId, "p6"), null);
});

test("writer lock symlinks fail closed without following or replacing the target", (t) => {
  const root = mkdtempSync(join(tmpdir(), "autodev-human-study-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const lock = join(root, ".human-study-writer.lock");
  writeFileSync(target, "unchanged target");
  chmodSync(target, 0o600);
  symlinkSync(target, lock);
  assert.throws(
    () => new RestrictedHumanResponseRepository({ rootDirectory: root }),
    RestrictedHumanStudyStorageError
  );
  assert.equal(readFileSync(target, "utf8"), "unchanged target");
});

test("stored consent is mandatory even when caller validator attempts to authorize without consent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "autodev-human-study-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  const study = makeStudy();
  repository.registerStudy(study);
  const row = makeRow(study, {
    participantId: "p1",
    buildId: "build-A",
    enj: "1"
  });
  const report = repository.importRows(
    study.studyId,
    [row],
    makeManifest(),
    makeValidators(repository, { isConsentValid: () => true })
  );
  assert.equal(report.acceptedCount, 0);
  assert.equal(report.rejected[0]!.reason, "consent-mismatch");
  repository.recordConsent(
    study.studyId,
    "p1",
    study.consentVersion,
    study.consentScope
  );
  assert.equal(
    repository.importRows(
      study.studyId,
      [row],
      makeManifest(),
      makeValidators(repository)
    ).acceptedCount,
    1
  );
});

test("withdrawal is durable, removes participant response/consent links, and retains metadata-only tombstones", (t) => {
  const { root, repository, study } = setup(t);
  const priorRevision = repository.getHumanValidationSummary(
    study.studyId,
    "build-A"
  )!.revision;
  repository.withdrawParticipant(study.studyId, "p5", {
    pairedArmBuildIds: { a: "build-A", b: "build-B" }
  });
  assert.equal(repository.getConsent(study.studyId, "p5"), null);
  assert.equal(repository.isParticipantWithdrawn(study.studyId, "p5"), true);
  const restarted = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  restarted.registerStudy(study);
  assert.equal(restarted.isParticipantWithdrawn(study.studyId, "p5"), true);
  assert.equal(restarted.getConsent(study.studyId, "p5"), null);
  const summary = restarted.getHumanValidationSummary(study.studyId, "build-A");
  assert.ok(summary);
  assert.equal(summary.suppressionState, "suppressed");
  assert.equal(summary.retainedParticipants, null);
  assert.equal(summary.items[0]!.mean, null);
  const paired = restarted.getPairedDifferenceSummaries(study.studyId, {
    a: "build-A",
    b: "build-B"
  });
  assert.equal(paired[0]!.suppressionState, "suppressed");
  assert.equal(paired[0]!.meanDifference, null);
  assert.equal(paired[0]!.pairedParticipants, null);
  const history = restarted.getTombstonedHistory(study.studyId);
  assert.ok(
    history.some(
      (entry) =>
        entry.revision === priorRevision && entry.status === "withdrawn"
    )
  );
  assert.equal(JSON.stringify(history).includes("mean"), false);
  assert.equal(JSON.stringify(history).includes("p5"), false);
  const persisted = readFileSync(
    join(
      root,
      readdirSync(root).find((name) => name.endsWith(".json"))!
    ),
    "utf8"
  );
  assert.equal(
    persisted.includes("p5"),
    false,
    "withdrawn pseudonym and response links must be deleted from durable state"
  );
  assert.equal(
    persisted.includes("mean"),
    false,
    "prior numeric summaries must not survive as tombstones"
  );
  assert.equal(
    restarted.importRows(
      study.studyId,
      [makeRow(study, { participantId: "p5", buildId: "build-A", enj: "1" })],
      makeManifest(),
      makeValidators(restarted, {
        isParticipantWithdrawn: () => false,
        isConsentValid: () => true
      })
    ).rejected[0]!.reason,
    "withdrawn-participant"
  );
});

test("CSV and JSON imports reject duplicate columns, ragged rows, nested coercion, and overlarge payloads", (t) => {
  const { repository, study } = setup(t);
  const valid = fixtureRows(study)[0]!;
  const headers = Object.keys(valid);
  const csvHeader = headers.join(",");
  assert.throws(
    () =>
      repository.importExport(
        study.studyId,
        "a,a\n1,2",
        "csv",
        makeManifest(),
        makeValidators(repository)
      ),
    /headers/
  );
  assert.throws(
    () =>
      repository.importExport(
        study.studyId,
        csvHeader + "\n1",
        "csv",
        makeManifest(),
        makeValidators(repository)
      ),
    /column count/
  );
  assert.throws(
    () =>
      repository.importExport(
        study.studyId,
        '[{"participantId":{"toString":"spoof"}}]',
        "json",
        makeManifest(),
        makeValidators(repository)
      ),
    /scalar/
  );
  assert.throws(
    () =>
      repository.importExport(
        study.studyId,
        "x".repeat(2_000_001),
        "json",
        makeManifest(),
        makeValidators(repository)
      ),
    /maximum allowed size/
  );
});

test("duplicate submissions stay restricted until an operator selects one response", (t) => {
  const root = mkdtempSync(join(tmpdir(), "autodev-human-study-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  const study = makeStudy();
  repository.registerStudy(study);
  for (const participant of ["p1", "p2", "p3", "p4", "p5"]) {
    repository.recordConsent(
      study.studyId,
      participant,
      study.consentVersion,
      study.consentScope
    );
  }
  const first = makeRow(study, {
    participantId: "p1",
    buildId: "build-A",
    enj: "-3"
  });
  const second = { ...first, responseId: "p1-build-A-selected", enj: "2" };
  const others = ["p2", "p3", "p4", "p5"].map((participantId) =>
    makeRow(study, { participantId, buildId: "build-A", enj: "0" })
  );
  const report = repository.importRows(
    study.studyId,
    [first, second, ...others],
    makeManifest(),
    makeValidators(repository)
  );
  assert.equal(report.acceptedCount, 4);
  assert.equal(report.quarantined.length, 1);
  assert.equal(
    repository.getHumanValidationSummary(study.studyId, "build-A")!
      .suppressionState,
    "suppressed"
  );
  assert.throws(
    () =>
      repository.importRows(
        study.studyId,
        [
          {
            ...first,
            responseId: "p1-amendment-before-quarantine-resolution",
            revision: "2",
            supersedes: first.responseId!
          }
        ],
        makeManifest(),
        makeValidators(repository)
      ),
    /Resolve the pending duplicate quarantine/
  );

  repository.resolveQuarantine(study.studyId, second.responseId);
  assert.equal(repository.listQuarantine(study.studyId).length, 0);
  const summary = repository.getHumanValidationSummary(
    study.studyId,
    "build-A"
  )!;
  assert.equal(summary.retainedParticipants, 5);
  assert.equal(summary.items[0]!.respondentCount, null);
  assert.equal(summary.items[0]!.mean, null);
});

test("one sub-five category suppresses the whole item cell even when retained study n is six", (t) => {
  const { repository, study } = setup(t);
  repository.recordConsent(
    study.studyId,
    "p6",
    study.consentVersion,
    study.consentScope
  );
  const report = repository.importRows(
    study.studyId,
    [makeRow(study, { participantId: "p6", buildId: "build-A", enj: "1" })],
    makeManifest(),
    makeValidators(repository)
  );
  assert.equal(report.acceptedCount, 1);
  assert.equal(report.retainedParticipants, 6);
  const summary = repository.getHumanValidationSummary(
    study.studyId,
    "build-A"
  );
  assert.ok(summary);
  assert.equal(summary.retainedParticipants, 6);
  assert.equal(summary.suppressionState, "partially-suppressed");
  const item = summary.items[0]!;
  assert.equal(item.suppressionState, "suppressed");
  assert.equal(item.mean, null);
  assert.equal(item.respondentCount, null);
  assert.equal(item.missingCount, null);
  assert.equal(item.categoryCounts, null);
});

test("symlink state files fail closed and owner-only files are written", (t) => {
  const root = mkdtempSync(join(tmpdir(), "autodev-human-study-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const study = makeStudy();
  const digest =
    createHash("sha256").update(study.studyId).digest("hex") + ".json";
  const outside = join(root, "target");
  writeFileSync(outside, "{}");
  symlinkSync(outside, join(root, digest));
  const repository = new RestrictedHumanResponseRepository({
    rootDirectory: root
  });
  assert.throws(
    () => repository.registerStudy(study),
    RestrictedHumanStudyStorageError
  );
  rmSync(join(root, digest));
  const clean = new RestrictedHumanResponseRepository({ rootDirectory: root });
  clean.registerStudy(study);
  const file = join(root, digest);
  assert.equal(statSync(file).mode & 0o077, 0);
});
