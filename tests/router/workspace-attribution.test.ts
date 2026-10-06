import assert from "node:assert/strict";
import test from "node:test";

import { rememberRecentId } from "@simulatorlife/autodev-runtime/router/usage";
import {
  evaluateWorkspaceAttribution,
  type WorkspaceAttributionInputs
} from "@simulatorlife/autodev-runtime/router/workspace-attribution";

// This is the seam the refactor exists to create. Attribution policy used to be
// reachable only by driving a whole OtelTracker through metric ingestion and
// reading its telemetry back out, so the rule could not be stated directly.
// These cases read the rule; the tracker tests still prove the wiring.

function inputs(
  overrides: Partial<WorkspaceAttributionInputs> = {}
): WorkspaceAttributionInputs {
  return {
    dataPointAttributes: {},
    resourceAttributes: {},
    registeredKeys: new Map(),
    conflictedIds: new Set(),
    ...overrides
  };
}

test("a registered workspace id attributes from the datapoint", () => {
  const verdict = evaluateWorkspaceAttribution(
    inputs({
      dataPointAttributes: { workspace_id: "repo-a" },
      registeredKeys: new Map([["repo-a", "bucket-1"]])
    })
  );
  assert.deepEqual(verdict, {
    status: "attributed",
    workspaceKey: "bucket-1",
    workspaceId: "repo-a",
    source: "datapoint"
  });
});

test("the resource attributes attribute when the datapoint names nothing", () => {
  const verdict = evaluateWorkspaceAttribution(
    inputs({
      resourceAttributes: { "workspace.id": "repo-b" },
      registeredKeys: new Map([["repo-b", "bucket-2"]])
    })
  );
  assert.equal(verdict.status, "attributed");
  assert.equal(verdict.workspaceKey, "bucket-2");
  assert.equal(verdict.workspaceId, "repo-b");
  assert.equal(verdict.source, "resource");
});

test("the datapoint wins over the resource when both name the same workspace", () => {
  const verdict = evaluateWorkspaceAttribution(
    inputs({
      dataPointAttributes: { workspaceId: "repo-a" },
      resourceAttributes: { workspace_id: "repo-a" },
      registeredKeys: new Map([["repo-a", "bucket-1"]])
    })
  );
  assert.equal(verdict.status, "attributed");
  assert.equal(verdict.source, "datapoint");
});

test("two ids in one source are ambiguous and attribute nothing", () => {
  const verdict = evaluateWorkspaceAttribution(
    inputs({
      dataPointAttributes: { workspace_id: "repo-a", workspaceId: "repo-b" }
    })
  );
  assert.equal(verdict.status, "unattributed");
  assert.equal(verdict.reason, "ambiguous_resource");
  // An ambiguous pair carries no usable id, even though it named two.
  assert.equal(verdict.workspaceId, null);
  assert.equal(verdict.workspaceKey, null);
  // The source label is driven by whether the source resolved to a single id,
  // and an ambiguous source resolves to none -- so a datapoint-only ambiguity
  // reports "resource" even though the resource named nothing at all. This is
  // pre-existing behaviour, preserved deliberately: the label is diagnostic and
  // changing it would alter what operators see in attribution diagnostics.
  assert.equal(verdict.source, "resource");
});

test("two sources disagreeing is ambiguous, labelled by whichever source named an id", () => {
  const verdict = evaluateWorkspaceAttribution(
    inputs({
      resourceAttributes: { workspace_id: "repo-b" },
      dataPointAttributes: { workspace_id: "repo-a" }
    })
  );
  assert.equal(verdict.reason, "ambiguous_resource");
  // The label prefers the datapoint and only falls back to the resource when
  // the datapoint named nothing. It reports where the id came from, not which
  // of the two disagreeing values was the wrong one.
  assert.equal(verdict.source, "datapoint");
  assert.equal(verdict.workspaceId, null);
});

test("an ambiguous resource with no datapoint id still names the resource", () => {
  const verdict = evaluateWorkspaceAttribution(
    inputs({
      resourceAttributes: { workspace_id: "repo-a", workspaceId: "repo-b" }
    })
  );
  assert.equal(verdict.reason, "ambiguous_resource");
  assert.equal(verdict.source, "resource");
});

test("nothing naming a workspace is missing, not unknown", () => {
  const verdict = evaluateWorkspaceAttribution(inputs());
  assert.equal(verdict.status, "unattributed");
  assert.equal(verdict.reason, "missing_workspace");
  assert.equal(verdict.source, null);
  assert.equal(verdict.workspaceId, null);
});

test("an unregistered id is unknown but keeps its id for series identity", () => {
  const verdict = evaluateWorkspaceAttribution(
    inputs({ dataPointAttributes: { workspace_id: "repo-unknown" } })
  );
  assert.equal(verdict.reason, "unknown_workspace_id");
  assert.equal(verdict.source, "datapoint");
  assert.equal(
    verdict.workspaceId,
    "repo-unknown",
    "the id must survive so a reporting workspace does not look silent"
  );
  assert.equal(verdict.workspaceKey, null);
});

test("a conflicted id stays unattributed even though the registry still holds a key", () => {
  const verdict = evaluateWorkspaceAttribution(
    inputs({
      dataPointAttributes: { workspace_id: "repo-a" },
      registeredKeys: new Map([["repo-a", "bucket-1"]]),
      conflictedIds: new Set(["repo-a"])
    })
  );
  assert.equal(verdict.status, "unattributed");
  assert.equal(verdict.reason, "unknown_workspace_id");
  assert.equal(
    verdict.workspaceKey,
    null,
    "a key claimed by two buckets must never be attributed"
  );
});

test("path-shaped ids are sanitised before they are looked up", () => {
  const verdict = evaluateWorkspaceAttribution(
    inputs({ dataPointAttributes: { workspace_id: "/Users/someone/code" } })
  );
  assert.equal(
    verdict.workspaceId?.startsWith("ws_"),
    true,
    "a local path must be hashed, never used verbatim"
  );
  assert.notEqual(verdict.workspaceId, "/Users/someone/code");
});

test("the evaluator is pure: it reads its inputs and writes nothing", () => {
  const dataPointAttributes = { workspace_id: "repo-a" };
  const resourceAttributes = { workspace_id: "repo-b" };
  const registeredKeys = new Map([["repo-a", "bucket-1"]]);
  const conflictedIds = new Set<string>();
  const first = evaluateWorkspaceAttribution({
    dataPointAttributes,
    resourceAttributes,
    registeredKeys,
    conflictedIds
  });
  const second = evaluateWorkspaceAttribution({
    dataPointAttributes,
    resourceAttributes,
    registeredKeys,
    conflictedIds
  });
  assert.deepEqual(first, second, "a second call must not see an earlier one");
  assert.deepEqual(
    [...registeredKeys.entries()],
    [["repo-a", "bucket-1"]],
    "the registry must be untouched"
  );
  assert.equal(conflictedIds.size, 0, "the conflict set must be untouched");
});

test("rememberRecentId keeps the newest ids and re-records move an id forward", () => {
  const ids = new Set<string>();
  for (let index = 0; index < 5; index += 1)
    rememberRecentId(ids, `id-${index}`, 3);
  assert.deepEqual(
    [...ids],
    ["id-2", "id-3", "id-4"],
    "the cap drops the oldest, keeping insertion order"
  );

  // Re-recording an existing id must not grow the set or duplicate it.
  rememberRecentId(ids, "id-2", 3);
  assert.deepEqual([...ids], ["id-3", "id-4", "id-2"]);
  assert.equal(ids.size, 3);

  rememberRecentId(ids, "id-5", 3);
  assert.deepEqual([...ids], ["id-4", "id-2", "id-5"]);
});
