/**
 * Review-gated issue drafts.
 *
 * The invariants worth protecting: AutoDev drafts and never publishes, a
 * hypothesis stays labelled a hypothesis, a game cannot grant itself the
 * permission its operator withheld, and a closed finding is silent while a
 * regression is not.
 *
 * The fixture builds a real `PlaytestFinding` with no cast, so an invented
 * status or verification stage is a compile error rather than a value that
 * quietly never occurs in the domain.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlaytestFindingIdentity,
  buildPlaytestIssueDrafts,
  type PlaytestFinding,
  playtestIssueReportingRefusal
} from "../src/playtesting/index.ts";

const FINGERPRINT = "a".repeat(64);

let witnessCounter = 0;

function finding(overrides: Partial<PlaytestFinding> = {}): PlaytestFinding {
  const findingId = overrides.findingId ?? `finding-${++witnessCounter}`;
  return {
    identity: buildPlaytestFindingIdentity({
      workspaceId: "owner/game",
      mechanicKey: "action-execution",
      failureSignature: { events: ["action.rejected"], witness: findingId },
      scope: { scenarioFamily: "standard" }
    }),
    fingerprint: FINGERPRINT,
    findingId,
    version: 1,
    title: "Legal action rejected mid-phase",
    description: "A freshly advertised action was refused by the engine.",
    severity: "major",
    status: "open",
    // Evidence is confirmed; no fix has been validated yet, so the finding is
    // still open. Evidence and fix lineage are independent axes.
    verificationStage: "not-yet-validated",
    evidenceStatus: "verified",
    affectedEpisodes: 4,
    totalEligibleEpisodes: 20,
    affectedOpportunities: 9,
    totalEligibleOpportunities: 40,
    affectedCohorts: ["novice"],
    evidenceRefs: [{ kind: "episode", id: "episode-17", step: 23 }],
    experimentIds: [],
    issueRefs: [],
    lastVerifiedBuild: "b".repeat(40),
    nextReviewAt: null,
    ...overrides
  };
}

test("both gates must grant review before anything is drafted", () => {
  const verified = finding();
  // Disabled on either side drafts nothing, and says why.
  for (const [configured, approved] of [
    ["disabled", "review"],
    ["review", "disabled"],
    ["disabled", "disabled"]
  ] as const) {
    assert.deepEqual(
      buildPlaytestIssueDrafts({
        configuredReporting: configured,
        approvedReporting: approved,
        findings: [verified]
      }),
      [],
      `configured=${configured} approved=${approved} must draft nothing`
    );
    assert.match(
      playtestIssueReportingRefusal({
        configuredReporting: configured,
        approvedReporting: approved,
        findings: [verified]
      })!,
      /no issue draft is proposed/u
    );
  }
  assert.equal(
    buildPlaytestIssueDrafts({
      configuredReporting: "review",
      approvedReporting: "review",
      findings: [verified]
    }).length,
    1
  );
  assert.equal(
    playtestIssueReportingRefusal({
      configuredReporting: "review",
      approvedReporting: "review",
      findings: [verified]
    }),
    null
  );
});

test("a hypothesis is never drafted as a confirmed defect", () => {
  const drafts = buildPlaytestIssueDrafts({
    configuredReporting: "review",
    approvedReporting: "review",
    findings: [
      finding({ findingId: "finding-hyp", evidenceStatus: "hypothesis" }),
      finding({
        findingId: "finding-unobs",
        evidenceStatus: "not observed",
        verificationStage: "insufficient-evidence"
      }),
      finding({ findingId: "finding-corr", evidenceStatus: "corroborated" })
    ]
  });
  const byId = new Map(drafts.map((draft) => [draft.findingId, draft]));
  assert.equal(
    byId.get("finding-hyp")?.disposition,
    "hypothesis-not-a-confirmed-defect"
  );
  assert.equal(
    byId.get("finding-unobs")?.disposition,
    "hypothesis-not-a-confirmed-defect"
  );
  assert.equal(
    byId.get("finding-corr")?.disposition,
    "ready-for-operator-review"
  );
  // The body's own label must survive, so a pasted draft cannot read as
  // confirmed when the evidence was not.
  const hypothesis = byId.get("finding-hyp")!;
  assert.match(hypothesis.body, /Evidence status: \*\*hypothesis\*\*/u);
  assert.match(hypothesis.body, /must not be published as a confirmed defect/u);
  // And a verified draft must not inherit that warning: telling an operator
  // never to file a confirmed defect would be its own kind of silence.
  const verified = byId.get("finding-corr")!;
  assert.doesNotMatch(
    verified.body,
    /must not be published as a confirmed defect/u
  );
  assert.match(verified.body, /drafted by AutoDev, not filed/u);
});

test("every draft states that AutoDev filed nothing", () => {
  for (const evidenceStatus of [
    "verified",
    "corroborated",
    "hypothesis"
  ] as const) {
    const draft = buildPlaytestIssueDrafts({
      configuredReporting: "review",
      approvedReporting: "review",
      findings: [finding({ evidenceStatus })]
    })[0]!;
    assert.equal(draft.requiresOperatorAction, true);
    assert.match(draft.body, /drafted by AutoDev, not filed/u);
    assert.match(draft.body, /Nothing was published/u);
  }
});

test("a closed finding proposes no issue", () => {
  assert.deepEqual(
    buildPlaytestIssueDrafts({
      configuredReporting: "review",
      approvedReporting: "review",
      findings: (["fixed", "withdrawn", "stale"] as const).map((status) =>
        finding({ status })
      )
    }),
    [],
    "a closed finding is not something to file"
  );
});

test("a regression is drafted, not treated as closed", () => {
  // The measurement contract treats a reproduced recurrence of a fixed
  // invariant as reopening the investigation, with external reopening gated on
  // explicit authority. Authority is granted here, so the regression must
  // surface; treating it as closed would silence the most urgent class.
  const [draft] = buildPlaytestIssueDrafts({
    configuredReporting: "review",
    approvedReporting: "review",
    findings: [
      finding({
        status: "regressed",
        verificationStage: "regressed-elsewhere",
        evidenceStatus: "verified"
      })
    ]
  });
  assert.equal(draft?.disposition, "ready-for-operator-review");
  assert.match(draft!.body, /Verification stage: \*\*regressed-elsewhere\*\*/u);
  // Authority withheld still wins, even for a regression.
  assert.deepEqual(
    buildPlaytestIssueDrafts({
      configuredReporting: "review",
      approvedReporting: "disabled",
      findings: [finding({ status: "regressed" })]
    }),
    []
  );
});

test("the draft identity is stable across runs and changes with the finding", () => {
  const run = () =>
    buildPlaytestIssueDrafts({
      configuredReporting: "review",
      approvedReporting: "review",
      findings: [finding({ findingId: "finding-stable" })]
    })[0]!;
  // Re-running must propose the same draft, not a new one each time.
  assert.equal(run().draftId, run().draftId);
  const next = buildPlaytestIssueDrafts({
    configuredReporting: "review",
    approvedReporting: "review",
    findings: [finding({ findingId: "finding-stable", version: 2 })]
  })[0]!;
  assert.notEqual(next.draftId, run().draftId);
});

test("the body carries the finding's own denominators rather than a bare number", () => {
  const draft = buildPlaytestIssueDrafts({
    configuredReporting: "review",
    approvedReporting: "review",
    findings: [finding()]
  })[0]!;
  // "4 affected" reads as a rate; the denominator is what makes it one.
  assert.match(draft.body, /4 of 20 eligible episodes/u);
  const unmeasured = buildPlaytestIssueDrafts({
    configuredReporting: "review",
    approvedReporting: "review",
    findings: [finding({ affectedEpisodes: null })]
  })[0]!;
  assert.match(unmeasured.body, /Affected: not measured/u);
});

test("a draft carries the finding's evidence verbatim, not a summary of it", () => {
  const draft = buildPlaytestIssueDrafts({
    configuredReporting: "review",
    approvedReporting: "review",
    findings: [finding()]
  })[0]!;
  // The structured fields and the rendered body must not drift apart: the body
  // is what a human reads, the fields are what a tool records.
  assert.match(
    draft.body,
    new RegExp(
      String.raw`Evidence status: \*\*${draft.evidenceStatus}\*\*`,
      "u"
    )
  );
  assert.match(
    draft.body,
    new RegExp(
      String.raw`Verification stage: \*\*${draft.verificationStage}\*\*`,
      "u"
    )
  );
  assert.match(draft.body, new RegExp(draft.findingId, "u"));
  assert.match(draft.body, new RegExp(draft.fingerprint, "u"));
  assert.deepEqual(
    draft.evidenceRefs.map((ref) => `${ref.kind} ${ref.id} @ step ${ref.step}`),
    ["episode episode-17 @ step 23"]
  );
});
