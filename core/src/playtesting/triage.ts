/**
 * Explainable finding priority ordering and triage (§9).
 * Normative design in docs/playtesting-measurement-contract.md §9 and
 * docs/playtesting-target-state.md §1 & §4.
 *
 * Rules:
 * 1. Catastrophic/data-loss/access-blocking harm first;
 * 2. Major progress/experience harm second;
 * 3. Minor friction third;
 * 4. Informational fourth.
 * Within a class:
 * - Corroborated/verified impact and human-confirmed severity outrank
 *   unconfirmed or purely cosmetic findings.
 * - Exposure/recurrence and breadth sort within class.
 * - Operator overrides are tracked with author and reason.
 * - Never compute an opaque weighted LLM priority score.
 */

import type { PlaytestFinding, PlaytestSeverity } from "./types.ts";

export interface PlaytestFindingTriageOverride {
  readonly findingId: string;
  readonly author: string;
  readonly reason: string;
  readonly forcedSeverity: PlaytestSeverity;
}

export interface PlaytestTriagedFinding {
  readonly rank: number;
  readonly finding: PlaytestFinding;
  readonly effectiveSeverity: PlaytestSeverity;
  readonly priorityScoreKey: string;
  readonly explanation: string;
  readonly override: PlaytestFindingTriageOverride | null;
}

const SEVERITY_ORDER: Record<PlaytestSeverity, number> = {
  catastrophic: 0,
  major: 1,
  minor: 2,
  informational: 3
};

const EVIDENCE_ORDER: Record<string, number> = {
  verified: 0,
  corroborated: 1,
  hypothesis: 2,
  "not observed": 3
};

function getExposureRate(finding: PlaytestFinding): number {
  if (
    finding.affectedOpportunities !== null &&
    finding.totalEligibleOpportunities !== null &&
    finding.totalEligibleOpportunities > 0
  ) {
    return finding.affectedOpportunities / finding.totalEligibleOpportunities;
  }
  if (
    finding.affectedEpisodes !== null &&
    finding.totalEligibleEpisodes !== null &&
    finding.totalEligibleEpisodes > 0
  ) {
    return finding.affectedEpisodes / finding.totalEligibleEpisodes;
  }
  return 0;
}

/**
 * Compare two findings for explainable triage order.
 * Returns negative if a outranks b (comes first), positive if b outranks a.
 */
export function comparePlaytestFindings(
  a: PlaytestFinding,
  b: PlaytestFinding,
  overrides?: ReadonlyMap<string, PlaytestFindingTriageOverride>
): number {
  const overrideA = overrides?.get(a.findingId);
  const overrideB = overrides?.get(b.findingId);

  const sevA = overrideA ? overrideA.forcedSeverity : a.severity;
  const sevB = overrideB ? overrideB.forcedSeverity : b.severity;

  const sevDiff = SEVERITY_ORDER[sevA] - SEVERITY_ORDER[sevB];
  if (sevDiff !== 0) return sevDiff;

  // Within the same severity class:
  // Verified / corroborated evidence comes before unverified hypothesis
  const evA = EVIDENCE_ORDER[a.evidenceStatus] ?? 3;
  const evB = EVIDENCE_ORDER[b.evidenceStatus] ?? 3;
  if (evA !== evB) return evA - evB;

  // Higher exposure rate when exposed comes first
  const expA = getExposureRate(a);
  const expB = getExposureRate(b);
  if (Math.abs(expA - expB) > 1e-6) {
    return expB - expA; // Higher exposure first
  }

  // Breadth (affected cohorts)
  const cohortsA = a.affectedCohorts.length;
  const cohortsB = b.affectedCohorts.length;
  if (cohortsA !== cohortsB) {
    return cohortsB - cohortsA;
  }

  // Deterministic tie-break by findingId
  return a.findingId.localeCompare(b.findingId);
}

/**
 * Triages an array of findings into an explainable ranked order.
 */
export function triagePlaytestFindings(
  findings: readonly PlaytestFinding[],
  overrides?: readonly PlaytestFindingTriageOverride[]
): readonly PlaytestTriagedFinding[] {
  const overrideMap = new Map<string, PlaytestFindingTriageOverride>();
  if (overrides) {
    for (const ov of overrides) {
      if (!ov.author || !ov.reason) {
        throw new TypeError("Triage override must have author and reason.");
      }
      overrideMap.set(ov.findingId, ov);
    }
  }

  const sorted = [...findings].sort((a, b) =>
    comparePlaytestFindings(a, b, overrideMap)
  );

  return sorted.map((finding, index) => {
    const override = overrideMap.get(finding.findingId) ?? null;
    const effectiveSeverity = override
      ? override.forcedSeverity
      : finding.severity;
    const expRate = getExposureRate(finding);
    const expPercent = Math.round(expRate * 100);

    let explanation = `${effectiveSeverity.toUpperCase()}: ${finding.title}. `;
    if (override) {
      explanation += `[Operator override by ${override.author}: ${override.reason}] `;
    } else {
      explanation += `Evidence status: ${finding.evidenceStatus}. `;
      if (expRate > 0) {
        explanation += `Exposure rate: ${expPercent}%. `;
      }
      if (finding.affectedCohorts.length > 0) {
        explanation += `Affected cohorts: ${finding.affectedCohorts.join(", ")}.`;
      }
    }

    return {
      rank: index + 1,
      finding,
      effectiveSeverity,
      priorityScoreKey: `${SEVERITY_ORDER[effectiveSeverity]}_${EVIDENCE_ORDER[finding.evidenceStatus] ?? 3}_${(1 - expRate).toFixed(4)}`,
      explanation: explanation.trim(),
      override
    };
  });
}
