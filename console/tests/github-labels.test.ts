import assert from "node:assert/strict";
import test from "node:test";

import { githubRunOutcome } from "../src/features/github/github-labels.ts";

test("a run's outcome is named in the Console's words", () => {
  // The badge used to print GitHub's own codes -- "success", "failure",
  // "in_progress" -- so the one place an operator reads whether a pipeline was
  // green was the one place the storage shape leaked through.
  assert.deepEqual(githubRunOutcome("success", "completed"), {
    label: "Succeeded",
    variant: "ready"
  });
  assert.deepEqual(githubRunOutcome("failure", "completed"), {
    label: "Failed",
    variant: "error"
  });
  assert.deepEqual(githubRunOutcome("timed_out", "completed"), {
    label: "Timed out",
    variant: "error"
  });
  assert.deepEqual(githubRunOutcome("cancelled", "completed"), {
    label: "Cancelled",
    variant: "unavailable"
  });
  assert.deepEqual(githubRunOutcome(null, "in_progress"), {
    label: "In progress",
    variant: "pending"
  });

  // The words are the page's own: the outcome facet narrows a list to
  // "Succeeded", "Failed", "Cancelled" and "In progress", so an operator who
  // selects a filter and then reads the rows it kept is not translating
  // between two vocabularies.
  assert.deepEqual(
    ["success", "failure", "cancelled", "in_progress"].map(
      (code) => githubRunOutcome(code, null).label
    ),
    ["Succeeded", "Failed", "Cancelled", "In progress"]
  );
});

test("a run that was cancelled was observed", () => {
  // The cancelled tone used to be the "not observed" one, which claims the
  // Console did not hear back. GitHub reported the conclusion, so the badge
  // says what was reported and paints it as the gap it is: a run that never
  // produced a pass or a fail.
  const cancelled = githubRunOutcome("cancelled", "completed");
  assert.notEqual(cancelled.variant, "not-observed");
  assert.equal(cancelled.variant, "unavailable");
});

test("an outcome the Console has no word for is spoken from its own key", () => {
  // GitHub can add a conclusion the Console has not been taught. The Console
  // cannot claim a pass or a fail for a state it does not know, and it cannot
  // claim it did not hear either -- so the key is spoken and the badge is
  // painted as a gap.
  const unknown = githubRunOutcome("brand_new_code", null);
  assert.equal(unknown.label, "Brand new code");
  assert.equal(unknown.variant, "unavailable");
});

test("a run that reported nothing says so", () => {
  assert.deepEqual(githubRunOutcome(null, null), {
    label: "Not observed",
    variant: "not-observed"
  });
});
