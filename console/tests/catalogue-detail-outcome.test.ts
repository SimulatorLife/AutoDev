import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogueDetailOutcome,
  catalogueObservation
} from "../src/lib/server/catalogue-detail.ts";

/**
 * The answer a detail route gives for an item its catalogue did not hold.
 *
 * A catalogue is a read, and a read that failed cannot say an item is absent.
 * Only a catalogue that was read can, so the rule is: a catalogue that was
 * read answers "not found", and a catalogue that was not read -- or that was
 * read and found broken -- answers "unavailable", with the reason.
 *
 * These cases pin that rule, and they pin it in one place, because the three
 * detail routes that compose their answer from a catalogue read (hooks, MCP
 * servers and tools) all answer through here. A route that grew its own
 * answer would be a second rule, and the two would drift.
 */

const SUBJECT = "Hook event";
const SOURCE = "canonical hook declaration";
const INVALID_CODE = "autodev_console_hooks_catalogue_invalid";
const UNOBSERVED_CODE = "autodev_console_hooks_catalogue_not_observed";

function outcome(
  observation: ReturnType<typeof catalogueObservation>
): ReturnType<typeof catalogueDetailOutcome> {
  return catalogueDetailOutcome({
    subject: SUBJECT,
    source: SOURCE,
    invalidCode: INVALID_CODE,
    unobservedCode: UNOBSERVED_CODE,
    observation
  });
}

test("a catalogue that was read answers that the item is not there", () => {
  const answer = outcome(catalogueObservation(true));

  assert.equal(answer.kind, "absent");
});

test("a catalogue that was read and found broken refuses, with the reason the Runtime located", () => {
  const answer = outcome(
    catalogueObservation(false, [
      { message: "The hook declaration could not be applied." }
    ])
  );

  assert.equal(answer.kind, "unavailable");
  if (answer.kind !== "unavailable") return;
  assert.equal(answer.code, INVALID_CODE);
  assert.equal(answer.message, "The hook declaration could not be applied.");
  assert.match(answer.title, /could not be read/u);
});

test("a broken catalogue with no located fault still refuses, and says why", () => {
  const answer = outcome(catalogueObservation(false));

  assert.equal(answer.kind, "unavailable");
  if (answer.kind !== "unavailable") return;
  assert.equal(answer.code, INVALID_CODE);
  assert.match(answer.message, /is invalid/u);
  assert.match(answer.message, new RegExp(SOURCE, "u"));
});

test("a catalogue nobody read refuses, and says that it was not observed", () => {
  const answer = outcome(catalogueObservation(null));

  assert.equal(answer.kind, "unavailable");
  if (answer.kind !== "unavailable") return;
  assert.equal(answer.code, UNOBSERVED_CODE);
  assert.match(answer.message, /was not observed/u);
});

test("a refusal names the thing that could not be read, not the item", () => {
  const answer = outcome(catalogueObservation(null));

  assert.equal(answer.kind, "unavailable");
  if (answer.kind !== "unavailable") return;
  assert.match(answer.title, /^Hook event could not be read$/u);
  assert.doesNotMatch(answer.message, /Hook event/u);
});

test("the observation of a flag is the flag, and the reason comes from the issues", () => {
  assert.deepEqual(catalogueObservation(true), { kind: "observed" });
  assert.deepEqual(catalogueObservation(null), {
    kind: "not-observed",
    reason: null
  });
  assert.deepEqual(catalogueObservation(false, [{ message: "broken" }]), {
    kind: "invalid",
    reason: "broken"
  });
  assert.deepEqual(catalogueObservation(false), {
    kind: "invalid",
    reason: null
  });
});
