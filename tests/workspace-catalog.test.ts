import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  listEnabled,
  loadWorkspaceCatalog,
  parseWorkspaceCatalog,
  readWorkspaceCatalogFile,
  resolvePrompt,
  resolveTarget,
  WORKSPACE_CATALOG_SCHEMA,
  WORKSPACE_ID_PATTERN,
  workspaceAdmitsRole,
  WorkspaceCatalogError
} from "../data/src/config/workspace-catalog.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const ownerPath = path.join(
  repositoryRoot,
  "data",
  "src",
  "config",
  "workspace-catalog.ts"
);
const canonicalCatalogPath = path.join(
  repositoryRoot,
  "config",
  "workspaces.json"
);

interface Workspace {
  id: string;
  baseBranch: string;
  enabled: boolean;
  agentRoles: string[] | null;
}

function runCli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [ownerPath, ...args], {
    encoding: "utf8"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status === null) {
    throw new Error(`CLI terminated with signal ${result.signal ?? "unknown"}`);
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function writeCatalog(name: string, body: unknown): string {
  const directory = mkdtempSync(path.join(tmpdir(), "workspace-catalog-"));
  const file = path.join(directory, `${name}.json`);
  writeFileSync(file, JSON.stringify(body));
  return file;
}

function makeWorkspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: "SimulatorLife/AutoDev",
    baseBranch: "main",
    enabled: true,
    agentRoles: null,
    ...overrides
  };
}

test("the catalog owner exposes the canonical schema and identity regex", () => {
  assert.equal(WORKSPACE_CATALOG_SCHEMA, "autodev-workspaces-v1");
  assert.ok(WORKSPACE_ID_PATTERN instanceof RegExp);
  assert.equal(typeof WorkspaceCatalogError, "function");
});

test("the owner validates and indexes the canonical registry", () => {
  const catalog = loadWorkspaceCatalog(canonicalCatalogPath);
  assert.ok(catalog.workspaces instanceof Map);
  assert.equal(
    catalog.workspaces.get("SimulatorLife/AutoDev")?.baseBranch,
    "main"
  );
  assert.equal(
    catalog.workspaces.get("SimulatorLife/Colourful-Life")?.baseBranch,
    "master"
  );
  for (const workspace of catalog.list) {
    assert.equal(workspace.id, workspace.id.match(WORKSPACE_ID_PATTERN)?.[0]);
  }
});

test("the owner rejects malformed entries, duplicates, and missing files", () => {
  const missing = runCli(["load", path.join(tmpdir(), "missing.json")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Workspace catalog not found/);

  const wrongSchema = writeCatalog("schema", {
    schema: "other",
    workspaces: []
  });
  const schemaResult = runCli(["load", wrongSchema]);
  assert.equal(schemaResult.status, 1);
  assert.match(schemaResult.stderr, /Workspace catalog is invalid/);
  rmSync(wrongSchema, { force: true });

  const malformed = writeCatalog("malformed", {
    schema: "autodev-workspaces-v1",
    workspaces: [
      { id: "noSlash", baseBranch: "main", enabled: true, agentRoles: null }
    ]
  });
  const malformedResult = runCli(["load", malformed]);
  assert.equal(malformedResult.status, 1);
  assert.match(malformedResult.stderr, /invalid identity or enabled flag/);
  rmSync(malformed, { force: true });

  const duplicate = writeCatalog("dup", {
    schema: "autodev-workspaces-v1",
    workspaces: [
      makeWorkspace({ id: "SimulatorLife/AutoDev" }),
      makeWorkspace({ id: "SimulatorLife/AutoDev" })
    ]
  });
  const duplicateResult = runCli(["load", duplicate]);
  assert.equal(duplicateResult.status, 1);
  assert.match(
    duplicateResult.stderr,
    /Duplicate workspace: SimulatorLife\/AutoDev/
  );
  rmSync(duplicate, { force: true });
});

test("the owner requires all four keys, so the canonical file has one shape", () => {
  for (const missing of ["id", "baseBranch", "enabled", "agentRoles"]) {
    const entry: Record<string, unknown> = {
      id: "SimulatorLife/AutoDev",
      baseBranch: "main",
      enabled: true,
      agentRoles: null
    };
    delete entry[missing];
    const file = writeCatalog(`missing-${missing}`, {
      schema: "autodev-workspaces-v1",
      workspaces: [entry]
    });
    const result = runCli(["load", file]);
    assert.equal(result.status, 1, `a catalog without ${missing} is refused`);
    rmSync(file, { force: true });
  }
});

test("the owner normalises every string it reads", () => {
  const file = writeCatalog("padded", {
    schema: "autodev-workspaces-v1",
    workspaces: [
      makeWorkspace({ id: " SimulatorLife/AutoDev ", baseBranch: " main " })
    ]
  });
  const catalog = loadWorkspaceCatalog(file);
  assert.equal(catalog.list[0]?.id, "SimulatorLife/AutoDev");
  assert.equal(catalog.list[0]?.baseBranch, "main");
  rmSync(file, { force: true });
});

test("resolveTarget enforces id form, presence, enabled, base branch, and role", () => {
  const catalog = loadWorkspaceCatalog(canonicalCatalogPath);
  const known = resolveTarget(catalog, "SimulatorLife/AutoDev");
  assert.equal(known.ok, true);
  if (known.ok) {
    assert.equal(known.workspace.baseBranch, "main");
  }

  const badForm = resolveTarget(catalog, "no-slash");
  assert.equal(badForm.ok, false);
  if (!badForm.ok) assert.match(badForm.reason, /owner\/name form/);

  const unknown = resolveTarget(catalog, "SimulatorLife/Missing");
  assert.equal(unknown.ok, false);
  if (!unknown.ok)
    assert.match(unknown.reason, /Unconfigured target repository/);

  const restrictedFile = writeCatalog("restricted", {
    schema: "autodev-workspaces-v1",
    workspaces: [
      makeWorkspace({
        id: "SimulatorLife/Locked",
        enabled: true,
        agentRoles: ["codex", "claude"]
      })
    ]
  });
  const restricted = loadWorkspaceCatalog(restrictedFile);
  const unlocked = resolveTarget(restricted, "SimulatorLife/Locked");
  assert.equal(unlocked.ok, true);
  assert.equal(
    resolveTarget(restricted, "SimulatorLife/Locked", {
      agentRole: "codex"
    }).ok,
    true
  );
  const disallowed = resolveTarget(restricted, "SimulatorLife/Locked", {
    agentRole: "gemini"
  });
  assert.equal(disallowed.ok, false);
  if (!disallowed.ok)
    assert.match(disallowed.reason, /is not allowed for workspace/);
  rmSync(restrictedFile, { force: true });

  const disabledFile = writeCatalog("disabled", {
    schema: "autodev-workspaces-v1",
    workspaces: [makeWorkspace({ id: "SimulatorLife/Off", enabled: false })]
  });
  const disabledCatalog = loadWorkspaceCatalog(disabledFile);
  const disabled = resolveTarget(disabledCatalog, "SimulatorLife/Off");
  assert.equal(disabled.ok, false);
  if (!disabled.ok)
    assert.match(
      disabled.reason,
      /disabled in the canonical workspace catalog/
    );
  rmSync(disabledFile, { force: true });

  const baseMatch = resolveTarget(catalog, "SimulatorLife/Colourful-Life", {
    baseBranch: "master"
  });
  assert.equal(baseMatch.ok, true);
  const baseMismatch = resolveTarget(catalog, "SimulatorLife/Colourful-Life", {
    baseBranch: "main"
  });
  assert.equal(baseMismatch.ok, false);
  if (!baseMismatch.ok)
    assert.match(baseMismatch.reason, /base_branch must match/);
});

test("a workspace with no role scope admits every agent", () => {
  // The catalog's own type says that null means the workspace has not
  // declared a role scope, so every agent may work there. The scheduler and
  // the runtime's configuration health already read it that way; the owner
  // has to say the same thing, or the CI refuses every unscoped workspace.
  const unscoped = makeWorkspace({ id: "SimulatorLife/Open" });
  assert.equal(workspaceAdmitsRole(unscoped, "codex"), true);
  const scoped = makeWorkspace({
    id: "SimulatorLife/Scoped",
    agentRoles: ["codex"]
  });
  assert.equal(workspaceAdmitsRole(scoped, "codex"), true);
  assert.equal(workspaceAdmitsRole(scoped, "gemini"), false);

  const file = writeCatalog("unscoped", {
    schema: "autodev-workspaces-v1",
    workspaces: [makeWorkspace({ id: "SimulatorLife/Open" })]
  });
  const catalog = loadWorkspaceCatalog(file);
  const resolved = resolveTarget(catalog, "SimulatorLife/Open", {
    agentRole: "codex"
  });
  assert.equal(resolved.ok, true);
  rmSync(file, { force: true });
});

test("resolvePrompt requires an enabled workspace", () => {
  const catalog = loadWorkspaceCatalog(canonicalCatalogPath);
  const allowed = resolvePrompt(catalog, "SimulatorLife/AutoDev");
  assert.equal(allowed.ok, true);
  const missing = resolvePrompt(catalog, "SimulatorLife/Ghost");
  assert.equal(missing.ok, false);
  if (!missing.ok)
    assert.match(
      missing.reason,
      /not present in the canonical workspace catalog/
    );

  const disabledFile = writeCatalog("prompt-disabled", {
    schema: "autodev-workspaces-v1",
    workspaces: [makeWorkspace({ id: "SimulatorLife/Auto", enabled: false })]
  });
  const disabledCatalog = loadWorkspaceCatalog(disabledFile);
  const disabled = resolvePrompt(disabledCatalog, "SimulatorLife/Auto");
  assert.equal(disabled.ok, false);
  if (!disabled.ok)
    assert.match(
      disabled.reason,
      /not enabled in the canonical workspace catalog/
    );
  rmSync(disabledFile, { force: true });
});

test("listEnabled returns only the enabled workspace ids", () => {
  const file = writeCatalog("mixed", {
    schema: "autodev-workspaces-v1",
    workspaces: [
      makeWorkspace({ id: "SimulatorLife/A", enabled: true }),
      makeWorkspace({ id: "SimulatorLife/B", enabled: false }),
      makeWorkspace({ id: "SimulatorLife/C", enabled: true })
    ]
  });
  const catalog = loadWorkspaceCatalog(file);
  assert.deepEqual(listEnabled(catalog), [
    "SimulatorLife/A",
    "SimulatorLife/C"
  ]);
  rmSync(file, { force: true });
});

test("the tolerant reader distinguishes missing, broken, and valid catalogs", () => {
  const missing = readWorkspaceCatalogFile(
    path.join(tmpdir(), "autodev-missing-catalog.json")
  );
  assert.equal(missing.status, "unavailable");
  assert.deepEqual(missing.workspaces, []);

  const brokenFile = writeCatalog("broken", {
    schema: "autodev-workspaces-v1",
    workspaces: [makeWorkspace({ id: "no-slash" })]
  });
  const broken = readWorkspaceCatalogFile(brokenFile);
  assert.equal(broken.status, "invalid");
  assert.deepEqual(broken.workspaces, []);
  assert.match(broken.reason ?? "", /invalid identity or enabled flag/);
  rmSync(brokenFile, { force: true });

  const valid = readWorkspaceCatalogFile(canonicalCatalogPath);
  assert.equal(valid.status, "valid");
  assert.ok(valid.workspaces.length > 0);
});

test("parseWorkspaceCatalog validates a document it is handed", () => {
  const catalog = parseWorkspaceCatalog({
    schema: "autodev-workspaces-v1",
    workspaces: [makeWorkspace({ id: "SimulatorLife/AutoDev" })]
  });
  assert.equal(catalog.list.length, 1);
  assert.throws(
    () => parseWorkspaceCatalog({ schema: "other", workspaces: [] }),
    WorkspaceCatalogError
  );
});

test("the CLI surfaces success JSON and fail-closed exit codes", () => {
  const ok = runCli([
    "resolve-target",
    canonicalCatalogPath,
    "SimulatorLife/AutoDev"
  ]);
  assert.equal(ok.status, 0);
  const parsed = JSON.parse(ok.stdout) as Workspace;
  assert.equal(parsed.id, "SimulatorLife/AutoDev");
  assert.equal(parsed.enabled, true);

  const unknown = runCli([
    "resolve-target",
    canonicalCatalogPath,
    "SimulatorLife/Ghost"
  ]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unconfigured target repository/);

  const disabledFile = writeCatalog("cli-disabled", {
    schema: "autodev-workspaces-v1",
    workspaces: [makeWorkspace({ id: "SimulatorLife/Off", enabled: false })]
  });
  const disabled = runCli([
    "resolve-target",
    disabledFile,
    "SimulatorLife/Off"
  ]);
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /disabled in the canonical workspace catalog/);
  rmSync(disabledFile, { force: true });

  const prompt = runCli([
    "resolve-prompt",
    canonicalCatalogPath,
    "SimulatorLife/AutoDev"
  ]);
  assert.equal(prompt.status, 0);
  assert.equal(JSON.parse(prompt.stdout).id, "SimulatorLife/AutoDev");

  const list = runCli(["list-enabled", canonicalCatalogPath]);
  assert.equal(list.status, 0);
  const ids = JSON.parse(list.stdout) as string[];
  assert.ok(ids.includes("SimulatorLife/AutoDev"));

  const unknownCommand = runCli(["nope", canonicalCatalogPath]);
  assert.equal(unknownCommand.status, 1);
});
