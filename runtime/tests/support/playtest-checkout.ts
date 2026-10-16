/** Real committed-build preparation for Playtesting tests, isolated from CODEX_HOME. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WorkspacePlaytestApproval } from "@simulatorlife/autodev-core";

import {
  type PreparedPlaytestSandbox,
  preparePlaytestSandbox
} from "../../src/playtesting/docker-sandbox.ts";

/** Commit every file in a fixture checkout so the Runtime can snapshot it. */
export function commitFixtureCheckout(root: string): string {
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "add", "--all"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Playtest test",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  ]);
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
}

/** The production preparer with a temporary snapshot root. */
export function isolatedPlaytestPreparer(): {
  readonly prepare: (
    approval: WorkspacePlaytestApproval
  ) => PreparedPlaytestSandbox;
  readonly cleanup: () => void;
} {
  const snapshotRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "autodev-playtest-snapshots-"))
  );
  return {
    prepare: (approval) => preparePlaytestSandbox(approval, { snapshotRoot }),
    cleanup: () => rmSync(snapshotRoot, { recursive: true, force: true })
  };
}
