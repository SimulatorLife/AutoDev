/**
 * Review-gated issue drafts.
 *
 * A game config may declare `reporting.githubIssues: "review"`, and an
 * operator approval may grant `issueReporting: "review"`. Before this existed
 * both values were validated and then read by nothing: a game that asked for
 * review got silence, indistinguishable from a game that asked for nothing.
 *
 * AutoDev does not publish. Publishing is an externally visible act that
 * cannot be undone from inside the system, so the capability here stops at a
 * draft an operator reads and decides on. The draft carries the finding's own
 * `evidenceStatus` and `verificationStage` verbatim — an unverified hypothesis
 * stays labelled a hypothesis in the issue body, so a draft cannot be
 * published as a confirmed defect by accident.
 *
 * Both gates must say review. Either one alone authorises nothing: a game's
 * config cannot grant itself permission its operator withheld.
 */
import { createHash } from "node:crypto";

import type { PlaytestFinding } from "./types.ts";

/** What a draft asks the operator to do with it. Never "publish". */
export type PlaytestIssueDraftDisposition =
  /** Evidence is verified; an operator still decides whether to open it. */
  | "ready-for-operator-review"
  /** Stated as a hypothesis, so it must not be published as a defect. */
  | "hypothesis-not-a-confirmed-defect"
  /** The finding is closed out; nothing left to open. */
  | "no-issue-proposed";

/** The two dispositions a caller can actually receive. */
export type ProposedPlaytestIssueDraftDisposition = Exclude<
  PlaytestIssueDraftDisposition,
  "no-issue-proposed"
>;

/**
 * Statuses with nothing left to open: fixed, retracted, or aged out.
 *
 * `regressed` is deliberately absent. The measurement contract states that one
 * reproduced recurrence of an exact previously fixed invariant reopens the
 * internal investigation, and that *external* issue reopening "follows existing
 * explicit reporting authority; no hidden GitHub mutation". Explicit authority
 * is exactly the gate this module enforces, so a regression is the case most
 * worth surfacing -- closing it out here would leave the most urgent finding
 * class producing silence precisely when an operator has granted authority.
 * Its `evidenceStatus` still carries the honesty: an unverified regression is
 * drafted as a hypothesis.
 */
const PLAYTEST_ISSUE_CLOSED_STATUSES: readonly PlaytestFinding["status"][] = [
  "fixed",
  "withdrawn",
  "stale"
];

/**
 * The closing directive, per disposition.
 *
 * The footer is where a pasted draft does its last bit of work, so it states
 * the disposition in the operator's terms rather than a generic reminder. A
 * hypothesis draft has to say "must not be published as a confirmed defect"
 * verbatim: that phrase is what stops a suggestion from being filed as a
 * defect, and a softer restatement of the evidence status is not the same
 * instruction.
 */
const PLAYTEST_ISSUE_CLOSING_NOTE: Readonly<
  Record<ProposedPlaytestIssueDraftDisposition, readonly string[]>
> = {
  "ready-for-operator-review": [
    "> This issue was drafted by AutoDev, not filed. Nothing was published.",
    "> The evidence above is verified; an operator still decides whether to open it."
  ],
  "hypothesis-not-a-confirmed-defect": [
    "> This issue was drafted by AutoDev, not filed. Nothing was published.",
    "> **This is a hypothesis, not a confirmed defect.** It must not be published as a confirmed defect, and must not be titled as one."
  ]
};

export interface PlaytestIssueDraft {
  /** Content-addressed so the same finding yields the same draft across runs. */
  readonly draftId: string;
  readonly findingId: string;
  readonly findingVersion: number;
  readonly fingerprint: string;
  readonly title: string;
  /** Ready to paste; carries the evidence state, never a bare assertion. */
  readonly body: string;
  readonly severity: PlaytestFinding["severity"];
  readonly evidenceStatus: PlaytestFinding["evidenceStatus"];
  readonly verificationStage: PlaytestFinding["verificationStage"];
  readonly disposition: PlaytestIssueDraftDisposition;
  readonly evidenceRefs: readonly PlaytestFinding["evidenceRefs"][number][];
  /**
   * Always true. Present so the field cannot be dropped by a later change that
   * reads as ordinary metadata — nothing in AutoDev opens an issue.
   */
  readonly requiresOperatorAction: true;
}

export interface BuildPlaytestIssueDraftsInput {
  /** The game's checked-in `reporting.githubIssues`. */
  readonly configuredReporting: "disabled" | "review";
  /** The operator's approval grant. */
  readonly approvedReporting: "disabled" | "review";
  readonly findings: readonly PlaytestFinding[];
}

function dispositionFor(finding: PlaytestFinding): PlaytestIssueDraftDisposition {
  if (PLAYTEST_ISSUE_CLOSED_STATUSES.includes(finding.status)) {
    return "no-issue-proposed";
  }
  // "hypothesis" and "not observed" are not claims about the game. A draft that
  // dropped this label is how an unverified suspicion becomes a filed defect.
  return finding.evidenceStatus === "verified" ||
    finding.evidenceStatus === "corroborated"
    ? "ready-for-operator-review"
    : "hypothesis-not-a-confirmed-defect";
}

function bodyFor(
  finding: PlaytestFinding,
  disposition: ProposedPlaytestIssueDraftDisposition
): string {
  const evidence = finding.evidenceRefs.length
    ? finding.evidenceRefs
        .map(
          (ref) =>
            `- ${ref.kind} ${ref.id}${ref.step === undefined ? "" : ` @ step ${ref.step}`}`
        )
        .join("\n")
    : "- none recorded";
  const denominators =
    finding.affectedEpisodes === null
      ? "not measured"
      : `${finding.affectedEpisodes} of ${finding.totalEligibleEpisodes ?? "?"} eligible episodes`;
  return [
    finding.description,
    "",
    "## Measured by AutoDev Playtesting",
    "",
    `- Evidence status: **${finding.evidenceStatus}**`,
    `- Verification stage: **${finding.verificationStage}**`,
    `- Affected: ${denominators}`,
    `- Cohorts: ${finding.affectedCohorts.length ? finding.affectedCohorts.join(", ") : "none recorded"}`,
    `- Finding: \`${finding.findingId}\` v${finding.version} (fingerprint \`${finding.fingerprint}\`)`,
    "",
    "## Evidence",
    "",
    evidence,
    "",
    ...PLAYTEST_ISSUE_CLOSING_NOTE[disposition]
  ].join("\n");
}

/**
 * Draft the issues a review-gated reporting mode would ask for.
 *
 * Returns an empty list when either gate says disabled. A game asking for
 * review and an operator withholding it produce nothing, and the caller can say
 * so from the empty result rather than discovering it at publication time.
 *
 * Filtered by disposition rather than by status inline, so the full triage
 * story stays readable at one site: `dispositionFor` is total over every
 * finding, and the only reason a disposition never reaches a caller is that
 * the finding is closed out.
 */
export function buildPlaytestIssueDrafts(
  input: BuildPlaytestIssueDraftsInput
): readonly PlaytestIssueDraft[] {
  if (input.configuredReporting !== "review") return [];
  if (input.approvedReporting !== "review") return [];
  return input.findings
    .map((finding) => ({ finding, disposition: dispositionFor(finding) }))
    .filter(
      (
        entry
      ): entry is {
        finding: PlaytestFinding;
        disposition: ProposedPlaytestIssueDraftDisposition;
      } => entry.disposition !== "no-issue-proposed"
    )
    .map(({ finding, disposition }) => ({
      // Content-addressed over the identity the draft is about, so a re-run
      // proposes the same draft rather than a new one each time.
      draftId: `draft-${createHash("sha256")
        .update(finding.fingerprint, "utf8")
        .update(`\0v${finding.version}`, "utf8")
        .digest("hex")
        .slice(0, 32)}`,
      findingId: finding.findingId,
      findingVersion: finding.version,
      fingerprint: finding.fingerprint,
      title: finding.title,
      body: bodyFor(finding, disposition),
      severity: finding.severity,
      evidenceStatus: finding.evidenceStatus,
      verificationStage: finding.verificationStage,
      disposition,
      evidenceRefs: [...finding.evidenceRefs],
      requiresOperatorAction: true as const
    }));
}

/** One line explaining why a caller produced no drafts. */
export function playtestIssueReportingRefusal(
  input: BuildPlaytestIssueDraftsInput
): string | null {
  if (input.configuredReporting !== "review") {
    return `The game config declares reporting.githubIssues="${input.configuredReporting}", so no issue draft is proposed.`;
  }
  if (input.approvedReporting !== "review") {
    return "The workspace approval does not grant issueReporting: review, so no issue draft is proposed.";
  }
  return null;
}