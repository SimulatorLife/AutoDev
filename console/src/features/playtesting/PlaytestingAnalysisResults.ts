/** Runtime-owned analyst task state and links to persisted review details. */
import type {
  ControlApiPlaytestingAnalysesResponse,
  ControlApiPlaytestingAnalysisDispatchResponse,
  ControlApiPlaytestingAnalystRun
} from "@simulatorlife/autodev-core";
import React from "react";

import { NavigationLink } from "../../components/navigation/NavigationLink.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";
import { analystRequestKindLabel } from "./playtesting-labels.ts";
import {
  playtestingEpisodeHref,
  type PlaytestingScope
} from "./playtesting-url.ts";

const EVIDENCE_LINK_CLASS = "text-accent hover:underline";

type CrossSessionSynthesisView =
  ControlApiPlaytestingAnalysesResponse["syntheses"][number];

function synthesisEvidenceLinks(
  references: CrossSessionSynthesisView["claims"][number]["evidenceRefs"],
  scope: PlaytestingScope,
  prefix: string
): React.JSX.Element {
  return React.createElement(
    "ul",
    {
      className: "list-none p-0 m-0 flex flex-wrap gap-x-3 gap-y-1",
      "aria-label": prefix
    },
    ...references.map((reference, index) => {
      const step = reference.locator.step ?? null;
      return React.createElement(
        "li",
        {
          key: `${reference.packetId}:${reference.locator.id}:${String(index)}`
        },
        React.createElement(
          NavigationLink,
          {
            className: EVIDENCE_LINK_CLASS,
            href: playtestingEpisodeHref(scope, reference.episodeId, step),
            dataAttributes: {
              "data-synthesis-citation": reference.episodeId
            }
          },
          `${reference.episodeId}: ${reference.locator.kind} ${reference.locator.id}${reference.locator.step === undefined ? "" : ` at step ${String(reference.locator.step)}`}`
        )
      );
    })
  );
}

function metricAggregationView(
  aggregation: CrossSessionSynthesisView["metricAggregation"],
  scope: PlaytestingScope
): React.JSX.Element {
  const statusMessage =
    aggregation.status === "available" || aggregation.status === "partial"
      ? "Descriptive ratio-of-sums over the exact selected sessions and matching strata only. This is not a matched-seed effect, confidence interval, or population estimate."
      : aggregation.status === "no-applicable-metrics"
        ? "No applicable deterministic metric rows were present in these frozen packets."
        : aggregation.status === "not-recorded"
          ? "This saved synthesis predates deterministic metric aggregation. No metric result was reconstructed."
          : aggregation.status === "insufficient-packets"
            ? "Fewer than two frozen packets were available for a cross-session metric aggregate."
            : "Deterministic metric aggregation is unavailable for this packet set; no values were inferred.";
  return React.createElement(
    "section",
    {
      className: "flex flex-col gap-2 rounded border border-border p-3",
      "data-testid": "playtesting-metric-aggregation",
      "data-aggregation-status": aggregation.status
    },
    React.createElement(
      "h4",
      { className: "font-medium" },
      "Deterministic selected-session metrics"
    ),
    React.createElement("p", { className: MUTED_META_CLASS }, statusMessage),
    aggregation.reason === null
      ? null
      : React.createElement(
          "p",
          {
            className: MUTED_META_CLASS,
            "data-aggregation-reason": aggregation.reason
          },
          `Status reason: ${aggregation.reason}.`
        ),
    aggregation.rows.length > 0
      ? React.createElement(
          "ul",
          {
            className: "list-none p-0 m-0 flex flex-col gap-2",
            "aria-label": "Deterministic metric aggregates"
          },
          ...aggregation.rows.map((row) => {
            const sources = row.sourcePacketIndices.flatMap((index) => {
              const source = aggregation.sourcePackets[index];
              return source === undefined ? [] : [source];
            });
            const estimate =
              row.estimate === null ? "Not observed" : String(row.estimate);
            const coverage =
              row.coverage === null ? "Not recorded" : String(row.coverage);
            return React.createElement(
              "li",
              {
                key: `${row.metricId}:${String(row.metricVersion)}:${row.phaseId ?? "whole-episode"}:${row.buildSha}:${row.scenarioId}:${row.cohort}:${row.policyId}`,
                className:
                  "flex flex-col gap-1 rounded-md border border-border p-3",
                "data-testid": "playtesting-metric-aggregate",
                "data-metric-id": row.metricId
              },
              React.createElement(
                "p",
                { className: MUTED_BODY_CLASS },
                `${row.metricId}@${String(row.metricVersion)} · ${row.aggregationWindow}/${row.phaseId ?? "whole episode"} · ${row.scenarioFamily}/${row.scenarioId} · ${row.cohort} · ${row.policyId}@${row.policyVersion} · ${row.buildSha.slice(0, 12)}`
              ),
              React.createElement(
                "p",
                { className: MUTED_META_CLASS },
                `${String(row.numerator)} / ${String(row.denominator)} ${row.unit} · ratio ${estimate} · coverage ${coverage} · ${String(row.missing)} missing of ${row.opportunityCount === null ? "unknown" : String(row.opportunityCount)} opportunities · ${String(row.sessionCount)} selected sessions · independent N ${row.independentUnits === null ? "not deduplicated" : String(row.independentUnits)}`
              ),
              sources.length > 0
                ? React.createElement(
                    "ul",
                    {
                      className:
                        "list-none p-0 m-0 flex flex-wrap gap-x-3 gap-y-1",
                      "aria-label": `Source sessions for ${row.metricId}`
                    },
                    ...sources.map((source) =>
                      React.createElement(
                        "li",
                        { key: source.packetId },
                        React.createElement(
                          NavigationLink,
                          {
                            className: EVIDENCE_LINK_CLASS,
                            href: playtestingEpisodeHref(
                              scope,
                              source.episodeId,
                              null
                            ),
                            dataAttributes: {
                              "data-aggregate-source": source.episodeId
                            }
                          },
                          `Open ${source.episodeId}`
                        )
                      )
                    )
                  )
                : null
            );
          })
        )
      : null,
    aggregation.omittedMetrics.length > 0
      ? React.createElement(
          "ul",
          {
            className: MUTED_META_CLASS,
            "aria-label": "Metrics not aggregated"
          },
          ...aggregation.omittedMetrics.map((omitted) =>
            React.createElement(
              "li",
              {
                key: `${omitted.metricId}:${String(omitted.metricVersion)}:${omitted.reason}`
              },
              `${omitted.metricId}@${String(omitted.metricVersion)}: ${omitted.reason}`
            )
          )
        )
      : null
  );
}

function crossSessionSynthesisView(
  synthesis: CrossSessionSynthesisView,
  scope: PlaytestingScope
): React.JSX.Element {
  return React.createElement(
    "section",
    {
      className: "flex flex-col gap-2 rounded border border-border p-3",
      "data-testid": "playtesting-cross-session-synthesis",
      "data-synthesis-id": synthesis.synthesisId
    },
    React.createElement(
      "h3",
      { className: "font-medium" },
      "Batch-level cross-session synthesis — hypotheses only"
    ),
    React.createElement(
      "p",
      { className: MUTED_BODY_CLASS },
      synthesis.summary
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      `Grounded in ${String(synthesis.contributors.length)} of ${String(synthesis.packetEligibleEpisodeIds.length)} packet-eligible selected sessions; this is a hypothesis, not independent verification.`
    ),
    metricAggregationView(synthesis.metricAggregation, scope),
    React.createElement(
      "ul",
      {
        className: "list-none p-0 m-0 flex flex-wrap gap-x-3 gap-y-1",
        "aria-label": "Cross-session synthesis contributors"
      },
      ...synthesis.contributors.map((contributor) =>
        React.createElement(
          "li",
          { key: contributor.episodeId, className: MUTED_META_CLASS },
          React.createElement(
            NavigationLink,
            {
              className: EVIDENCE_LINK_CLASS,
              href: playtestingEpisodeHref(scope, contributor.episodeId, null)
            },
            `Open contributing session ${contributor.episodeId}`
          )
        )
      )
    ),
    synthesis.claims.length > 0
      ? React.createElement(
          "ul",
          {
            className: "list-none p-0 m-0 flex flex-col gap-2",
            "aria-label": "Cross-session synthesis claims"
          },
          ...synthesis.claims.map((claim, index) =>
            React.createElement(
              "li",
              {
                key: `${claim.kind}:${String(index)}`,
                className: "flex flex-col gap-1",
                "data-testid": "playtesting-cross-session-claim",
                "data-claim-kind": claim.kind
              },
              React.createElement(
                "p",
                { className: MUTED_BODY_CLASS },
                `${claim.kind}: ${claim.text}`
              ),
              synthesisEvidenceLinks(
                claim.evidenceRefs,
                scope,
                `Citations for synthesis ${claim.kind}`
              )
            )
          )
        )
      : null,
    ...synthesis.experiments.map((experiment, index) =>
      React.createElement(
        "section",
        {
          key: `experiment:${String(index)}`,
          className: "flex flex-col gap-1",
          "data-testid": "playtesting-cross-session-experiment"
        },
        React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          `Proposed experiment: ${experiment.hypothesis}`
        ),
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          `Falsifier: ${experiment.falsifier} · Metric: ${experiment.metricId} · Budget: ${experiment.budget}`
        ),
        synthesisEvidenceLinks(
          experiment.evidenceRefs,
          scope,
          "Citations for proposed experiment"
        )
      )
    )
  );
}

type AnalysisReceipt =
  ControlApiPlaytestingAnalysisDispatchResponse["receipts"][number];

function analysisReceiptList(
  receipts: readonly AnalysisReceipt[],
  scope: PlaytestingScope,
  testId: string
): React.JSX.Element | null {
  if (receipts.length === 0) return null;
  return React.createElement(
    "ul",
    {
      className: "list-none p-0 m-0 flex flex-col gap-1",
      "aria-label": "Analyst packet availability receipts"
    },
    ...receipts.map((receipt) =>
      React.createElement(
        "li",
        {
          key: `${receipt.episodeId}:${receipt.batchId ?? "unknown"}:${receipt.reason}`,
          className: MUTED_META_CLASS,
          "data-testid": testId,
          "data-reason": receipt.reason
        },
        scope.workspaceId === null
          ? `${receipt.episodeId}: ${receipt.reason} — ${receipt.detail}`
          : React.createElement(
              React.Fragment,
              null,
              React.createElement(
                NavigationLink,
                {
                  className: EVIDENCE_LINK_CLASS,
                  href: playtestingEpisodeHref(scope, receipt.episodeId, null)
                },
                `Open session ${receipt.episodeId}`
              ),
              `: ${receipt.reason} — ${receipt.detail}`
            )
      )
    )
  );
}

function statusDescription(run: ControlApiPlaytestingAnalystRun): string {
  const requested = run.requestedEpisodeIds.length;
  const persisted = run.reviews.length;
  const progress = `${String(persisted)} of ${String(requested)} selected ${requested === 1 ? "session has" : "sessions have"} a persisted review.`;
  if (run.status === "running") {
    return `Analyst review running; ${progress}`;
  }
  if (run.status === "completed") {
    return `Analyst process completed; ${progress}`;
  }
  if (run.status === "partial") {
    return `Analyst process partially completed; ${progress}`;
  }
  return `The analyst process failed; ${progress}`;
}

export function PlaytestingAnalysisResults({
  result,
  runs,
  syntheses,
  stale,
  scope
}: {
  readonly result: ControlApiPlaytestingAnalysisDispatchResponse | null;
  readonly runs: ControlApiPlaytestingAnalysesResponse["runs"];
  readonly syntheses: ControlApiPlaytestingAnalysesResponse["syntheses"];
  readonly stale: boolean;
  readonly scope: PlaytestingScope;
}): React.JSX.Element {
  const synthesisById = new Map(
    syntheses.map((synthesis) => [synthesis.synthesisId, synthesis])
  );
  const runItems = runs.map((run) => {
    const synthesis =
      run.synthesisId === null
        ? null
        : (synthesisById.get(run.synthesisId) ?? null);
    return React.createElement(
      "section",
      {
        key: run.analysisId,
        className: "flex flex-col gap-2 border-l-2 border-l-border pl-3",
        "data-testid": "playtesting-analysis-run",
        "data-analysis-id": run.analysisId,
        "data-analysis-status": stale ? "stale" : run.status
      },
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS },
        statusDescription(run),
        stale ? " Last known status; the Runtime could not refresh it." : ""
      ),
      React.createElement(
        "p",
        {
          className: MUTED_META_CLASS,
          "data-testid": "playtesting-analysis-request-kind"
        },
        analystRequestKindLabel(run.requireFindings)
      ),
      run.error
        ? React.createElement(
            "p",
            {
              className: MUTED_META_CLASS,
              "data-testid": "playtesting-analysis-error"
            },
            run.error
          )
        : null,
      synthesis
        ? crossSessionSynthesisView(synthesis, scope)
        : run.packets.length >= 2 && run.status !== "running"
          ? React.createElement(
              "p",
              {
                className: MUTED_META_CLASS,
                "data-testid": "playtesting-cross-session-synthesis-unavailable"
              },
              "No aggregate-grounded cross-session synthesis was persisted; per-session reviews remain separate."
            )
          : null,
      run.reviews.length > 0
        ? React.createElement(
            "ul",
            { className: "list-none p-0 m-0 flex flex-col gap-1" },
            ...run.reviews.map((review) =>
              React.createElement(
                "li",
                {
                  key: review.episodeId,
                  className: MUTED_META_CLASS,
                  "data-testid": "playtesting-analysis-review-link",
                  "data-review-status": review.status
                },
                React.createElement(
                  NavigationLink,
                  {
                    className: EVIDENCE_LINK_CLASS,
                    href: playtestingEpisodeHref(scope, review.episodeId, null)
                  },
                  `Open ${review.status} review for ${review.episodeId}`
                )
              )
            )
          )
        : null,
      analysisReceiptList(run.receipts, scope, "playtesting-analysis-receipt"),
      ...run.budget.map((entry) =>
        React.createElement(
          "p",
          {
            key: entry.batchId,
            className: MUTED_META_CLASS,
            "data-testid": "playtesting-analysis-budget"
          },
          `${entry.batchId}: ${String(entry.remaining)} of ${String(entry.reviewCap)} critiques remain; ${String(entry.reserved)} reserved.`
        )
      )
    );
  });

  const visibleSynthesisIds = new Set(
    runs.flatMap((run) => (run.synthesisId === null ? [] : [run.synthesisId]))
  );
  const persistedSynthesisItems = syntheses
    .filter((synthesis) => !visibleSynthesisIds.has(synthesis.synthesisId))
    .map((synthesis) =>
      React.createElement(
        "section",
        {
          key: synthesis.synthesisId,
          className: "flex flex-col gap-2 border-l-2 border-l-border pl-3",
          "data-testid": "playtesting-persisted-cross-session-synthesis",
          "data-analysis-id": synthesis.analysisId
        },
        React.createElement(
          "p",
          { className: MUTED_META_CLASS },
          "Saved batch-level synthesis; task status may have expired."
        ),
        crossSessionSynthesisView(synthesis, scope)
      )
    );

  const noAnalysisStarted = result !== null && result.analysis === null;
  const noRunMessage = noAnalysisStarted
    ? React.createElement(
        "p",
        {
          className: MUTED_BODY_CLASS,
          "data-testid": "playtesting-analysis-not-started"
        },
        result.packets.length === 0
          ? `No analyst process was started: Runtime found no new reviewable packet among ${String(result.requested)} selected sessions.`
          : "Runtime returned prepared packets but did not start an analyst process."
      )
    : null;
  const dispatchReceipts = noAnalysisStarted
    ? analysisReceiptList(
        result.receipts,
        scope,
        "playtesting-analysis-dispatch-receipt"
      )
    : null;

  return React.createElement(
    "div",
    {
      "data-testid": "playtesting-selection-result",
      className: "flex flex-col gap-3"
    },
    noRunMessage,
    dispatchReceipts,
    ...persistedSynthesisItems,
    stale && runs.length === 0 && syntheses.length === 0
      ? React.createElement(
          "p",
          {
            className: MUTED_BODY_CLASS,
            "data-testid": "playtesting-analysis-stale"
          },
          "Analyst status is unavailable. No current state is being shown."
        )
      : null,
    ...runItems
  );
}
