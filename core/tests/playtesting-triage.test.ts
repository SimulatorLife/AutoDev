import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlaytestFindingIdentity,
  type PlaytestFinding
} from "../src/playtesting/index.ts";
import { triagePlaytestFindings } from "../src/playtesting/triage.ts";

function createFinding(
  partial: Partial<PlaytestFinding> & { findingId: string }
): PlaytestFinding {
  const identity = buildPlaytestFindingIdentity({
    workspaceId: "game-workspace",
    mechanicKey: "mechanic-1",
    failureSignature: {
      events: ["event-1"],
      witness: partial.findingId
    },
    scope: {
      scenarioFamily: "standard"
    }
  });

  return {
    identity,
    fingerprint: "a".repeat(64),
    version: 1,
    title: partial.title ?? partial.findingId,
    description: "test description",
    severity: partial.severity ?? "minor",
    status: partial.status ?? "open",
    verificationStage: partial.verificationStage ?? "not-yet-validated",
    evidenceStatus: partial.evidenceStatus ?? "hypothesis",
    affectedEpisodes: partial.affectedEpisodes ?? 1,
    totalEligibleEpisodes: partial.totalEligibleEpisodes ?? 100,
    affectedOpportunities: partial.affectedOpportunities ?? null,
    totalEligibleOpportunities: partial.totalEligibleOpportunities ?? null,
    affectedCohorts: partial.affectedCohorts ?? ["novice"],
    evidenceRefs: [],
    experimentIds: [],
    issueRefs: [],
    lastVerifiedBuild: null,
    nextReviewAt: null,
    ...partial
  };
}

test("triage ranks catastrophic harm before major harm, and major before minor", () => {
  const fCat = createFinding({
    findingId: "f-cat",
    title: "Save lost after exit",
    severity: "catastrophic",
    affectedOpportunities: 1,
    totalEligibleOpportunities: 12
  });

  const fMaj = createFinding({
    findingId: "f-maj",
    title: "Pit-entry failure",
    severity: "major",
    affectedOpportunities: 12,
    totalEligibleOpportunities: 15
  });

  const fMin = createFinding({
    findingId: "f-min",
    title: "Decorative clipping",
    severity: "minor",
    affectedEpisodes: 900,
    totalEligibleEpisodes: 1000
  });

  const triaged = triagePlaytestFindings([fMin, fCat, fMaj]);

  assert.equal(triaged[0]!.finding.findingId, "f-cat");
  assert.equal(triaged[1]!.finding.findingId, "f-maj");
  assert.equal(triaged[2]!.finding.findingId, "f-min");
  assert.equal(triaged[0]!.rank, 1);
  assert.equal(triaged[1]!.rank, 2);
  assert.equal(triaged[2]!.rank, 3);
});

test("verified evidence outranks hypothesis within the same severity class", () => {
  const fHypo = createFinding({
    findingId: "f-hypo",
    severity: "major",
    evidenceStatus: "hypothesis",
    affectedEpisodes: 50,
    totalEligibleEpisodes: 100
  });

  const fVer = createFinding({
    findingId: "f-ver",
    severity: "major",
    evidenceStatus: "verified",
    affectedEpisodes: 10,
    totalEligibleEpisodes: 100
  });

  const triaged = triagePlaytestFindings([fHypo, fVer]);

  assert.equal(triaged[0]!.finding.findingId, "f-ver");
  assert.equal(triaged[1]!.finding.findingId, "f-hypo");
});

test("higher exposure rate ranks first within the same severity and evidence class", () => {
  const fLowExp = createFinding({
    findingId: "f-low",
    severity: "major",
    evidenceStatus: "verified",
    affectedOpportunities: 2,
    totalEligibleOpportunities: 100
  });

  const fHighExp = createFinding({
    findingId: "f-high",
    severity: "major",
    evidenceStatus: "verified",
    affectedOpportunities: 80,
    totalEligibleOpportunities: 100
  });

  const triaged = triagePlaytestFindings([fLowExp, fHighExp]);

  assert.equal(triaged[0]!.finding.findingId, "f-high");
  assert.equal(triaged[1]!.finding.findingId, "f-low");
});

test("operator override elevates finding with author and reason audit trail", () => {
  const fMin = createFinding({
    findingId: "f-min",
    severity: "minor",
    title: "Minor UI glitch"
  });

  const fMaj = createFinding({
    findingId: "f-maj",
    severity: "major",
    title: "Major progression blocker"
  });

  const triaged = triagePlaytestFindings(
    [fMin, fMaj],
    [
      {
        findingId: "f-min",
        author: "lead-designer",
        reason: "Affects tournament build broadcast",
        forcedSeverity: "catastrophic"
      }
    ]
  );

  assert.equal(triaged[0]!.finding.findingId, "f-min");
  assert.equal(triaged[0]!.effectiveSeverity, "catastrophic");
  assert.equal(triaged[0]!.override?.author, "lead-designer");
  assert.match(triaged[0]!.explanation, /Operator override by lead-designer/u);

  assert.equal(triaged[1]!.finding.findingId, "f-maj");
  assert.equal(triaged[1]!.effectiveSeverity, "major");
});

test("an unmeasured exposure rate is reported unmeasured, not as zero", () => {
  // `getExposureRate` used to return 0 when no denominator was recorded, which
  // said the finding was rarely exposed and produced the fabricated
  // worst-looking `priorityScoreKey` of `1.0000`. Nothing asserted that key.
  const unmeasured = createFinding({
    findingId: "finding-unmeasured-exposure",
    title: "Exposure never observed",
    evidenceStatus: "verified",
    affectedEpisodes: null,
    totalEligibleEpisodes: null,
    affectedOpportunities: null,
    totalEligibleOpportunities: null,
    affectedCohorts: []
  });
  const measured = createFinding({
    findingId: "finding-measured-exposure",
    title: "Exposure observed",
    evidenceStatus: "verified",
    affectedEpisodes: 5,
    totalEligibleEpisodes: 100
  });

  const ranked = triagePlaytestFindings([unmeasured, measured]);
  const unranked = ranked.find(
    (r) => r.finding.findingId === unmeasured.findingId
  );
  const measuredRank = ranked.find(
    (r) => r.finding.findingId === measured.findingId
  );

  assert.ok(unranked && measuredRank);
  // Measured exposure outranks unmeasured: a finding we know less about must
  // not be treated as if the run showed it was rarely exposed.
  assert.equal(measuredRank.rank, 1);
  assert.equal(unranked.rank, 2);

  assert.match(unranked.priorityScoreKey, /_unmeasured$/u);
  assert.doesNotMatch(unranked.priorityScoreKey, /_1\.0000$/u);
  // The explanation says so rather than omitting the rate and implying none.
  assert.match(unranked.explanation, /Exposure rate: not measured/u);
  assert.match(measuredRank.explanation, /Exposure rate: 5%/u);
});

test("two unmeasured-exposure findings fall through to breadth, then the id tie-break", () => {
  const narrow = createFinding({
    findingId: "finding-narrow",
    evidenceStatus: "verified",
    affectedEpisodes: null,
    totalEligibleEpisodes: null,
    affectedOpportunities: null,
    totalEligibleOpportunities: null,
    affectedCohorts: ["novice"]
  });
  const broad = createFinding({
    findingId: "finding-broad",
    evidenceStatus: "verified",
    affectedEpisodes: null,
    totalEligibleEpisodes: null,
    affectedOpportunities: null,
    totalEligibleOpportunities: null,
    affectedCohorts: ["novice", "expert", "veteran"]
  });

  const ranked = triagePlaytestFindings([narrow, broad]);
  // Breadth still orders them even though exposure is unknown for both.
  assert.equal(ranked[0]?.finding.findingId, broad.findingId);
  for (const row of ranked) {
    assert.match(row.priorityScoreKey, /_unmeasured$/u);
  }
});
