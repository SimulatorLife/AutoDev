import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER } from "../src/shared/compaction.ts";
import {
  buildRootOrchestratorBootstrap,
  readRootBootstrapMarker
} from "../src/shared/root-bootstrap.ts";

function withRepo(
  prompt: string | null,
  run: (repoRoot: string, skillsHome: string) => void
): void {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "autodev-root-bootstrap-"));
  try {
    if (prompt !== null) {
      const prompts = path.join(repoRoot, "agents", "prompts");
      mkdirSync(prompts, { recursive: true });
      writeFileSync(path.join(prompts, "orchestrator.md"), prompt);
    }
    run(repoRoot, path.join(repoRoot, "home"));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("the hook marker and both bootstrap forms read the same first prompt line", () => {
  withRepo("\n  # Custom bootstrap\nBody line\n", (repoRoot, skillsHome) => {
    assert.equal(readRootBootstrapMarker(repoRoot), "# Custom bootstrap");
    const initial = buildRootOrchestratorBootstrap({ repoRoot, skillsHome });
    const compacted = buildRootOrchestratorBootstrap({
      repoRoot,
      skillsHome,
      postCompaction: true
    });
    assert.equal(initial?.marker, "# Custom bootstrap");
    assert.ok(initial?.content.startsWith("# Custom bootstrap\nBody line"));
    assert.equal(compacted?.marker, "# Custom bootstrap");
    assert.ok(
      compacted?.content.startsWith("# Custom bootstrap (post-compaction continuation)")
    );
  });
});

test("an empty orchestrator prompt falls back to the canonical marker", () => {
  withRepo("  \n", (repoRoot, skillsHome) => {
    assert.equal(
      readRootBootstrapMarker(repoRoot),
      ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER
    );
    assert.equal(
      buildRootOrchestratorBootstrap({ repoRoot, skillsHome })?.marker,
      ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER
    );
  });
});

test("a missing orchestrator prompt yields no marker and no bootstrap", () => {
  withRepo(null, (repoRoot, skillsHome) => {
    assert.equal(readRootBootstrapMarker(repoRoot), null);
    assert.equal(buildRootOrchestratorBootstrap({ repoRoot, skillsHome }), null);
    assert.equal(
      buildRootOrchestratorBootstrap({
        repoRoot,
        skillsHome,
        postCompaction: true
      }),
      null
    );
  });
});
