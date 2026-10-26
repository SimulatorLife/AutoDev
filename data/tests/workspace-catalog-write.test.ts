import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadWorkspaceCatalog,
  readWorkspaceCatalogFile,
  updateWorkspaceCatalogEntry,
  WorkspaceCatalogConflictError,
  WorkspaceCatalogUnknownWorkspaceError,
  WorkspaceCatalogValidationError
} from "../src/config/workspace-catalog.ts";

const CATALOG = `{
  "schema": "autodev-workspaces-v1",
  "workspaces": [
    {
      "id": "SimulatorLife/AutoDev",
      "baseBranch": "main",
      "enabled": true,
      "agentRoles": null
    },
    {
      "id": "SimulatorLife/Colourful-Life",
      "baseBranch": "master",
      "enabled": true,
      "agentRoles": null
    }
  ]
}
`;

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-workspace-catalog-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  const catalogPath = path.join(root, "config", "workspaces.json");
  writeFileSync(catalogPath, CATALOG, "utf8");
  return catalogPath;
}

function revisionOf(catalogPath: string): string {
  return createHash("sha256").update(readFileSync(catalogPath)).digest("hex");
}

test("a write changes the catalog and answers with the revision of the file it wrote", () => {
  const catalogPath = fixture();
  const before = readFileSync(catalogPath, "utf8");
  const revision = revisionOf(catalogPath);

  const written = updateWorkspaceCatalogEntry(
    catalogPath,
    "SimulatorLife/AutoDev",
    revision,
    { enabled: false, baseBranch: " release ", agentRoles: ["worker"] }
  );

  assert.equal(written.changed, true);
  assert.equal(written.revision, revisionOf(catalogPath));
  assert.notEqual(written.revision, revision);
  assert.deepEqual(written.workspace, {
    id: "SimulatorLife/AutoDev",
    baseBranch: "release",
    enabled: false,
    agentRoles: ["worker"]
  });

  // The file keeps its shape: the same indentation, the same key order, a
  // trailing newline, and the entry the write did not name.
  const after = readFileSync(catalogPath, "utf8");
  assert.ok(after.endsWith("}\n"));
  assert.ok(after.includes('\n  "schema": "autodev-workspaces-v1",\n'));
  assert.ok(after.includes('\n      "id": "SimulatorLife/AutoDev",\n'));
  assert.ok(after.includes('\n      "baseBranch": "release",\n'));
  assert.ok(after.includes('\n      "enabled": false,\n'));
  assert.ok(
    after.includes('\n      "agentRoles": [\n        "worker"\n      ]\n')
  );
  assert.ok(after.includes('\n      "id": "SimulatorLife/Colourful-Life",\n'));
  assert.ok(after.includes('\n      "baseBranch": "master",\n'));
  assert.notEqual(after, before);

  // The catalog the owner wrote is one its own rules accept.
  const catalog = loadWorkspaceCatalog(catalogPath);
  assert.equal(catalog.workspaces.size, 2);
  assert.equal(catalog.workspaces.get("SimulatorLife/AutoDev")?.enabled, false);
});

test("a write that changes nothing but the values it names keeps the rest of the catalog", () => {
  const catalogPath = fixture();
  const revision = revisionOf(catalogPath);

  const written = updateWorkspaceCatalogEntry(
    catalogPath,
    "SimulatorLife/Colourful-Life",
    revision,
    { baseBranch: "master" }
  );

  assert.equal(written.changed, false);
  assert.equal(written.revision, revision);
  assert.equal(readFileSync(catalogPath, "utf8"), CATALOG);
});

test("a write decided on a catalog that has since moved is refused and the file is untouched", () => {
  const catalogPath = fixture();
  const stale = revisionOf(catalogPath);
  writeFileSync(
    catalogPath,
    CATALOG.replace('"baseBranch": "master"', '"baseBranch": "trunk"'),
    "utf8"
  );
  const moved = readFileSync(catalogPath, "utf8");

  assert.throws(
    () =>
      updateWorkspaceCatalogEntry(catalogPath, "SimulatorLife/AutoDev", stale, {
        enabled: false
      }),
    WorkspaceCatalogConflictError
  );
  assert.equal(readFileSync(catalogPath, "utf8"), moved);
});

test("a write that could not be expressed is refused and the file is untouched", () => {
  const catalogPath = fixture();
  const revision = revisionOf(catalogPath);

  const refusals: readonly unknown[] = [
    // A revision that is not one.
    { expected: "not-a-revision", update: { enabled: false } },
    // An enablement that is not a flag.
    { expected: revision, update: { enabled: "yes" } },
    // A base branch that is empty.
    { expected: revision, update: { baseBranch: "   " } },
    // A base branch that is not a branch name.
    { expected: revision, update: { baseBranch: 7 } },
    // A role scope that is not a list.
    { expected: revision, update: { agentRoles: "worker" } },
    // A role scope that names no role.
    { expected: revision, update: { agentRoles: [""] } },
    // A role scope that repeats a role.
    { expected: revision, update: { agentRoles: ["worker", " worker "] } },
    // A write that changes nothing.
    { expected: revision, update: {} }
  ];
  for (const refusal of refusals as readonly {
    readonly expected: string;
    readonly update: Record<string, unknown>;
  }[]) {
    assert.throws(
      () =>
        updateWorkspaceCatalogEntry(
          catalogPath,
          "SimulatorLife/AutoDev",
          refusal.expected,
          refusal.update
        ),
      WorkspaceCatalogValidationError,
      JSON.stringify(refusal.update)
    );
  }
  assert.equal(readFileSync(catalogPath, "utf8"), CATALOG);
});

test("a write to a workspace the catalog does not declare is refused", () => {
  const catalogPath = fixture();
  const revision = revisionOf(catalogPath);
  assert.throws(
    () =>
      updateWorkspaceCatalogEntry(
        catalogPath,
        "SimulatorLife/Nothing",
        revision,
        {
          enabled: false
        }
      ),
    WorkspaceCatalogUnknownWorkspaceError
  );
  assert.equal(readFileSync(catalogPath, "utf8"), CATALOG);
});

test("a write replaces the catalog atomically and leaves no half-written file behind", async () => {
  const catalogPath = fixture();
  const revision = revisionOf(catalogPath);
  const before = statSync(catalogPath);

  const written = updateWorkspaceCatalogEntry(
    catalogPath,
    "SimulatorLife/AutoDev",
    revision,
    { baseBranch: "release" }
  );

  // The catalog was replaced rather than rewritten in place: the file the
  // operator reads is a new file that was moved into place whole.
  const after = statSync(catalogPath);
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode & 0o777, before.mode & 0o777);
  // Nothing but the catalog is left in its directory: a write that failed
  // half way would leave a temporary file there.
  assert.deepEqual(readdirSync(path.dirname(catalogPath)), ["workspaces.json"]);
  assert.equal(written.revision, revisionOf(catalogPath));
});

test("the read publishes the revision of the file it read", async () => {
  const catalogPath = fixture();
  const read = readWorkspaceCatalogFile(catalogPath);
  assert.equal(read.status, "valid");
  assert.equal(read.revision, revisionOf(catalogPath));

  const missing = readWorkspaceCatalogFile(
    path.join(path.dirname(catalogPath), "nothing.json")
  );
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.revision, null);
});
