import assert from "node:assert/strict";
import test from "node:test";

import { findStaleCodexPids } from "@simulatorlife/autodev-runtime/platform/install-check";
import { runInstallCommand } from "@simulatorlife/autodev-runtime/platform/install-command";

test("typed install command rejects check mode until diagnostic ownership migrates", () => {
  assert.throws(
    () => runInstallCommand(["--check"]),
    /installer check boundary/
  );
});

test("typed install command rejects the removed Collector mode and contradictory OpenLIT flags", () => {
  assert.throws(
    () => runInstallCommand(["--enable-otel-collector"]),
    /unsupported install option/
  );
  assert.throws(
    () => runInstallCommand(["--disable-otel-collector"]),
    /unsupported install option/
  );
  assert.throws(
    () => runInstallCommand(["--disable-otel-collector"]),
    /unsupported install option/
  );
  assert.throws(
    () =>
      runInstallCommand([
        "--enable-openlit-ingress",
        "--disable-openlit-ingress"
      ]),
    /mutually exclusive/
  );
});

test("typed install command rejects unknown options", () => {
  assert.throws(
    () => runInstallCommand(["--unknown"]),
    /unsupported install option/
  );
});

test("findStaleCodexPids ignores sandboxed child codex helpers under an authenticated root codex process", () => {
  const token = "current-token-123";
  const commands = new Map<string, string>([
    [
      "7487",
      `codex app-server CODEX_ROUTER_AUTH_TOKEN=${token} PATH=/usr/bin`
    ],
    [
      "59372",
      "codex app-server --listen stdio:// CODEX_HOME=/Users/test/.codex PATH=/usr/bin"
    ]
  ]);
  const parents = new Map<string, string>([
    ["59372", "8181"],
    ["8181", "7487"],
    ["7487", "6395"],
    ["6395", "1"]
  ]);
  assert.deepEqual(
    findStaleCodexPids(token, {
      listCodexPids: () => ["7487", "59372"],
      readProcessCommandWithEnv: (pid) => commands.get(pid) ?? null,
      readParentPid: (pid) => parents.get(pid) ?? null,
      processExists: () => true
    }),
    []
  );
});

test("findStaleCodexPids reports root codex processes with a stale or missing token and ignores exited processes", () => {
  const token = "current-token-123";
  const commands = new Map<string, string>([
    ["1000", "codex app-server CODEX_ROUTER_AUTH_TOKEN=old-token PATH=/usr/bin"]
  ]);
  const parents = new Map<string, string>([["1000", "1"]]);
  assert.deepEqual(
    findStaleCodexPids(token, {
      listCodexPids: () => ["1000", "2000"],
      readProcessCommandWithEnv: (pid) => commands.get(pid) ?? null,
      readParentPid: (pid) => parents.get(pid) ?? null,
      processExists: (pid) => pid !== "2000"
    }),
    ["1000"]
  );
});
