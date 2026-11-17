import assert from "node:assert/strict";
import test from "node:test";

import { parseEnabled } from "../src/lib/server/form-mutation.ts";
import {
  mutationFailure,
  redirectTo
} from "../src/lib/server/mutation-rejection.ts";

/**
 * The Console's own answer to a mutation it turned away.
 *
 * Every mutation route refused a submission the same way: a redirect back to
 * the page the change was made on, carrying the bounded notice that the
 * change did not land, and a log line naming the route that refused it. The
 * routes now share one owner for that answer, so these tests hold the owner
 * to the contract the routes used to keep separately: the status, the
 * location, and the refusal the log line records.
 */

/** The stderr lines written while the callback runs. */
function captureStderr(run: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
    );
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test("a mutation redirect answers 303 with the location it was given", async () => {
  const response = redirectTo("/providers?control=failed");

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/providers?control=failed");
  assert.equal(await response.text(), "");
});

test("a refused mutation logs the route and redirects to the page it owns", async () => {
  const failed = mutationFailure("/api/providers/[provider]", "/providers");

  const lines = captureStderr(() => {
    const response = failed({ cause: "cross_origin" });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "/providers?control=failed",
      "the refusal must send the operator back with the notice attached"
    );
  });

  assert.equal(lines.length, 1, "the refusal must leave one record behind");
  const record = JSON.parse(lines[0] ?? "{}") as {
    readonly route?: string;
    readonly cause?: string;
  };
  assert.equal(record.route, "/api/providers/[provider]");
  assert.equal(record.cause, "cross_origin");
});

test("a refused mutation returns to the page the form came from", async () => {
  const failed = mutationFailure("/api/providers/[provider]", "/providers");

  const lines = captureStderr(() => {
    const response = failed({ cause: "invalid_fields" }, "/providers/claude");
    assert.equal(
      response.headers.get("location"),
      "/providers/claude?control=failed"
    );
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /"cause":"invalid_fields"/u);
});

test("a toggle's enabled field is read as one of two answers or none", () => {
  assert.equal(parseEnabled("true"), true);
  assert.equal(parseEnabled("false"), false);
  assert.equal(parseEnabled(null), null);
  assert.equal(parseEnabled("TRUE"), null);
  assert.equal(parseEnabled("1"), null);
  assert.equal(parseEnabled(""), null);
});
