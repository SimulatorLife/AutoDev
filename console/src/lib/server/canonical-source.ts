/**
 * The revision a canonical source editor's content is based on.
 *
 * A write to a canonical source is a compare-and-swap: the form carries the
 * revision the editor loaded, and the service refuses a write whose revision
 * has moved. That pairing has to survive a refused write, because a browser
 * restores the text an operator typed into a form control when the write it
 * submitted is redirected back to the page: the editor still holds the edit
 * the operator made, while the page renders the source that moved on. A form
 * that carried the new revision would pair the stale edit with it, and the
 * next save would write that edit over the change that moved the source.
 */

/** The outcomes a canonical source write can end in. */
export type CanonicalSourceSaveOutcome =
  "conflict" | "validation" | "apply-failed" | "failed";

/** A source revision: the sha256 of the canonical file. */
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * The revision the editor's content is based on, when the source moved.
 *
 * A refused validation and a failed apply leave the source where it was, so
 * the page's own revision is still the one the editor is based on.
 */
export function editorBaseRevision(
  outcome: CanonicalSourceSaveOutcome,
  expectedRevision: string
): string | undefined {
  return outcome === "conflict" || outcome === "failed"
    ? expectedRevision
    : undefined;
}

/**
 * The revision a page was redirected with, when it names one.
 *
 * A query value that is not a revision is not a revision: it is ignored, and
 * the page falls back to the revision the source is at.
 */
export function editorBaseRevisionFromQuery(
  value: string | readonly string[] | undefined
): string | undefined {
  const revision = typeof value === "string" ? value : value?.[0];
  return revision !== undefined && REVISION_PATTERN.test(revision)
    ? revision
    : undefined;
}
