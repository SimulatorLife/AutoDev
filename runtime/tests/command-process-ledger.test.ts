import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandProcessLedger,
  parseCommandProcessSnapshot
} from "../src/mcp/command-process-tree.ts";

const BROKER = "10 1 10 S broker-start";
const ROOT = "20 10 20 S root-start";

function snapshot(...rows: string[]) {
  return parseCommandProcessSnapshot([BROKER, ...rows].join("\n"), 10);
}

test("a malformed or incomplete process snapshot cannot prove cleanup", () => {
  assert.throws(() => snapshot("invalid row"), /Invalid host process snapshot/u);
  assert.throws(() => snapshot(ROOT, ROOT), /Invalid host process snapshot/u);
  assert.throws(
    () => parseCommandProcessSnapshot(ROOT, 10),
    /Host process snapshot is unavailable/u
  );
});

test("zombie ancestry and reparented descendants remain discoverable without signaling zombies", () => {
  const ledger = new CommandProcessLedger();
  const first = ledger.observe(
    snapshot(ROOT, "21 20 21 Z zombie-start", "22 21 22 S child-start"),
    20,
    10,
    false
  );
  assert.deepEqual(first.map((node) => node.pid), [20, 22]);
  assert.equal(first[1]?.depth, 2);
  const later = ledger.observe(
    snapshot("22 1 22 S child-start", "23 22 23 S grandchild-start"),
    20,
    10,
    true
  );
  assert.deepEqual(later.map((node) => node.pid), [22, 23]);
});

test("an anchored independent root group recovers previously unobserved orphans", () => {
  const ledger = new CommandProcessLedger();
  ledger.observe(snapshot(ROOT, "21 20 20 S child-start"), 20, 10, false);
  const later = ledger.observe(
    snapshot(
      "21 1 20 S child-start",
      "22 1 20 S orphan-start",
      "23 22 23 S detached-start",
      "99 1 99 S unrelated-start"
    ),
    20,
    10,
    true
  );
  assert.deepEqual(later.map((node) => node.pid), [21, 22, 23]);
});

test("a disappeared group or reused PID cannot establish new ownership", () => {
  const ledger = new CommandProcessLedger();
  ledger.observe(snapshot(ROOT, "21 20 20 S child-start"), 20, 10, false);
  assert.deepEqual(ledger.observe(snapshot(), 20, 10, true), []);
  assert.deepEqual(
    ledger.observe(
      snapshot("20 1 20 S unrelated-root", "21 20 20 S reused-pid"),
      20,
      10,
      true
    ),
    []
  );
  const reused = new CommandProcessLedger();
  reused.observe(snapshot(ROOT, "21 20 21 S child-start"), 20, 10, false);
  assert.deepEqual(
    reused.observe(snapshot("21 1 21 S reused-pid"), 20, 10, true),
    []
  );
});
