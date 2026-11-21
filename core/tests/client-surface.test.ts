import assert from "node:assert/strict";
import test from "node:test";

import {
  clientSurfaceFromOriginator,
  clientSurfaceFromUserAgent,
  formatClientSurface,
  isClientSurface
} from "../src/diagnostics/index.ts";

test("maps every known Codex originator onto its client surface", () => {
  assert.equal(clientSurfaceFromOriginator("Codex Desktop"), "codex_desktop");
  assert.equal(clientSurfaceFromOriginator("codex_cli_rs"), "codex_cli");
  assert.equal(clientSurfaceFromOriginator("codex_exec"), "codex_exec");
  assert.equal(clientSurfaceFromOriginator("codex_vscode"), "codex_vscode");
});

test("keeps an unrecognised originator distinct from an unobserved one", () => {
  assert.equal(clientSurfaceFromOriginator("some_future_client"), "other");
  assert.equal(clientSurfaceFromOriginator("  "), null);
  assert.equal(clientSurfaceFromOriginator(undefined), null);
  assert.equal(formatClientSurface(null), "Not observed");
  assert.equal(formatClientSurface("codex_desktop"), "Codex app");
});

test("reads the originator from the User-Agent product token", () => {
  assert.equal(
    clientSurfaceFromUserAgent("codex_exec/0.171.0 (Mac OS 26.5.0; arm64) xterm"),
    "codex_exec"
  );
  assert.equal(clientSurfaceFromUserAgent("Codex Desktop/0.171.0-alpha.13"), "codex_desktop");
  assert.equal(clientSurfaceFromUserAgent(""), null);
});

test("narrows only the closed surface set", () => {
  assert.equal(isClientSurface("codex_cli"), true);
  assert.equal(isClientSurface("unknown"), false);
  assert.equal(isClientSurface(null), false);
});
