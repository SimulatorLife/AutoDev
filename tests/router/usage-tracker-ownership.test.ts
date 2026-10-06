import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  MAX_UNKNOWN_WORKSPACE_IDS,
  UsageTracker
} from "@simulatorlife/autodev-runtime/router/usage";

/**
 * `UsageTracker`'s attribution diagnostics belong to `UsageTracker`.
 *
 * The counters are a state machine: one observation increments `total`, then
 * exactly one of `attributed`/`unattributed`, and then `bySource` or `byReason`
 * depending on which. Two router modules were performing that transition by
 * hand -- four levels down into `usageTracker.attributionDiagnostics.total`,
 * `.byReason.<key>`, `.bySource.<key>` -- while the tracker already exposed it
 * as `recordAttributionDiagnostic` and `recordMissing{Provider,Model}Diagnostic`.
 *
 * The result was two sources of truth for one invariant, in the one place a
 * partial re-implementation is invisible until a counter disagrees: a caller
 * that forgot the `total += 1`, or added an id to `byReason` under `attributed`,
 * would produce a status the router never rejected. These tests pin the
 * ownership so the counters are only reachable through the owner.
 */

const routerRoot = path.join(
  import.meta.dirname,
  "..",
  "..",
  "runtime",
  "src",
  "router"
);

/** Walk the router tree so a module added after this test is policed too. */
function routerModules(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...routerModules(child));
    else if (entry.name.endsWith(".ts")) found.push(child);
  }
  return found.sort();
}

test("a router module owns attribution diagnostics and is the only one that names them", () => {
  // Derived rather than hand-listed: the owner is whichever module declares the
  // field, so moving the state does not require editing this test, and a second
  // declaration anywhere fails instead of silently shadowing.
  const modules = routerModules(routerRoot);
  assert.ok(
    modules.length > 10,
    "the router module tree is what this rule governs, not a fixed list"
  );

  const declares = (file: string): boolean =>
    /^\s*readonly attributionDiagnostics\s*:/mu.test(
      readFileSync(file, "utf8")
    );
  const owners = modules.filter(declares);
  assert.equal(
    owners.length,
    1,
    `exactly one module declares the diagnostics field, found: ${owners
      .map((file) => path.relative(routerRoot, file))
      .join(", ")}`
  );

  const owner = owners[0]!;
  const reachers = modules.filter(
    (file) =>
      file !== owner &&
      /\.attributionDiagnostics\b/u.test(readFileSync(file, "utf8"))
  );
  assert.deepEqual(
    reachers.map((file) => path.relative(routerRoot, file)),
    [],
    "no module may read or mutate another object's diagnostics directly; " +
      "call UsageTracker's recordAttributionDiagnostic / recordMissing*Diagnostic instead"
  );
});

test("the diagnostics state machine increments total exactly once per observation", () => {
  const tracker = new UsageTracker();

  tracker.recordAttributionDiagnostic({
    attributed: true,
    source: "datapoint"
  });
  tracker.recordAttributionDiagnostic({ attributed: true, source: "resource" });
  tracker.recordAttributionDiagnostic({
    attributed: false,
    reason: "missing_workspace"
  });
  tracker.recordMissingProviderDiagnostic(3);
  tracker.recordMissingModelDiagnostic(2);

  // `missing_provider`/`missing_model` are reasons, not observations, so they
  // must not inflate `total` -- a caller that conflated the two would report
  // more observations than the router actually attributed.
  const status = tracker.attributionDiagnosticsStatus();
  assert.equal(status.total, 3);
  assert.equal(status.attributed, 2);
  assert.equal(status.unattributed, 1);
  assert.equal(status.bySource.datapoint, 1);
  assert.equal(status.bySource.resource, 1);
  assert.equal(status.byReason.missing_workspace, 1);
  assert.equal(status.byReason.missing_provider, 3);
  assert.equal(status.byReason.missing_model, 2);
});

test("an unknown workspace id can be remembered without being counted", () => {
  // The ring deliberately follows every observation rather than only the counted
  // ones, so it cannot be folded into recordAttributionDiagnostic: an observer
  // that did not count the datapoint still needs to learn which id was unknown.
  // That is the whole reason this is a separate method.
  const tracker = new UsageTracker();
  const before = tracker.attributionDiagnosticsStatus();

  tracker.rememberUnknownWorkspaceId("ws-never-counted");

  const after = tracker.attributionDiagnosticsStatus();
  assert.equal(after.total, before.total);
  assert.equal(after.attributed, before.attributed);
  assert.equal(after.unattributed, before.unattributed);
  assert.deepEqual(after.unknownWorkspaceIds, ["ws-never-counted"]);
});

test("the remembered-id ring stays bounded and drops the oldest first", () => {
  const tracker = new UsageTracker();
  tracker.rememberUnknownWorkspaceId("oldest");
  for (let i = 0; i < MAX_UNKNOWN_WORKSPACE_IDS; i++)
    tracker.rememberUnknownWorkspaceId(`ws-${i}`);

  const ids = tracker.attributionDiagnosticsStatus().unknownWorkspaceIds;
  assert.equal(ids.length, MAX_UNKNOWN_WORKSPACE_IDS);
  assert.equal(ids.includes("oldest"), false);
  assert.equal(
    ids.at(-1),
    `ws-${MAX_UNKNOWN_WORKSPACE_IDS - 1}`,
    "the newest id must survive"
  );
});
