/** How the Console presents an analyst review's own words. */
import type { ControlApiPlaytestingReview } from "@simulatorlife/autodev-core";

/**
 * What the analyst wrote when it wrote nothing.
 *
 * A review's headline is the analyst's first asserted claim. A review that
 * asserted no claim has no headline, and every surface that shows the
 * headline says this instead of leaving the reader looking at an empty cell.
 */
export const NO_CONCLUSION_LABEL =
  "The analyst recorded no written conclusion for this session.";

/** The review's conclusion, or the sentence that stands in for one. */
export function reviewHeadlineText(
  review: ControlApiPlaytestingReview
): string {
  return review.headline.length > 0 ? review.headline : NO_CONCLUSION_LABEL;
}

/**
 * One line of counts for a review.
 *
 * The counts are how a reader tells a review that asserted one hypothesis
 * from one that asserted six, so they are stated in words rather than as bare
 * digits. Every surface that shows a review says them this way.
 */
export function reviewSummaryLine(review: ControlApiPlaytestingReview): string {
  return [
    `${review.kind === "discovery" ? "Discovery" : "Confirmatory"} review`,
    `${String(review.interpretationCount)} ${review.interpretationCount === 1 ? "hypothesis" : "hypotheses"}`,
    `${String(review.observationCount)} ${review.observationCount === 1 ? "observation" : "observations"}`
  ].join(" · ");
}
