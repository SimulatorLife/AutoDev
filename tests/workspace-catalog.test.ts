import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = path.join(
  repositoryRoot,
  ".github",
  "scripts",
  "workspace-catalog.cjs"
);
const canonicalCatalogPath = path.join(
  repositoryRoot,
  "config",
  "workspaces.json"
);

const require = createRequire(import.meta.url);
const workspaceCatalog = require(scriptPath) as {
  CATALOG_SCHEMA: string;
  REPO_ID_PATTERN: RegExp;
  WorkspaceCatalogError: ErrorConstructor;
  loadCatalog(catalogPath: string): {
    workspaces: Map<string, Workspace>;
    list: Workspace[];
  };
  resolveTarget(
    catalog: { workspaces: Map<string, Workspace> },
    repoId: string,
    options?: { baseBranch?: string; agentRole?: string }
  ): { ok: true; workspace: Workspace } | { ok: false; reason: string };
  resolvePrompt(
    catalog: { workspaces: Map<string, Workspace> },
    repoId: string
  ): { ok: true; workspace: Workspace } | { ok: false; reason: string };
  listEnabled(catalog: { list: Workspace[] }): string[];
};

interface Workspace {
  id: string;
  baseBranch: string | null;
  enabled: boolean;
  agentRoles: string[] | null;
}

function runCli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
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

test("workspace catalog module exposes the canonical schema and identity regex", () => {
  assert.equal(workspaceCatalog.CATALOG_SCHEMA, "autodev-workspaces-v1");
  assert.ok(workspaceCatalog.REPO_ID_PATTERN instanceof RegExp);
  assert.equal(typeof workspaceCatalog.WorkspaceCatalogError, "function");
});

test("loadCatalog validates and indexes the canonical registry", () => {
  const catalog = workspaceCatalog.loadCatalog(canonicalCatalogPath);
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
    assert.equal(
      workspace.id,
      workspace.id.match(workspaceCatalog.REPO_ID_PATTERN)?.[0]
    );
  }
});

test("loadCatalog rejects malformed entries, duplicates, and missing files", () => {
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

test("resolveTarget enforces id form, presence, enabled, base branch, and role", () => {
  const catalog = workspaceCatalog.loadCatalog(canonicalCatalogPath);
  const known = workspaceCatalog.resolveTarget(
    catalog,
    "SimulatorLife/AutoDev"
  );
  assert.equal(known.ok, true);
  if (known.ok) {
    assert.equal(known.workspace.baseBranch, "main");
  }

  const badForm = workspaceCatalog.resolveTarget(catalog, "no-slash");
  assert.equal(badForm.ok, false);
  if (!badForm.ok) assert.match(badForm.reason, /owner\/name form/);

  const unknown = workspaceCatalog.resolveTarget(
    catalog,
    "SimulatorLife/Missing"
  );
  assert.equal(unknown.ok, false);
  if (!unknown.ok)
    assert.match(unknown.reason, /Unconfigured target repository/);

  const restricted = workspaceCatalog.loadCatalog(
    writeCatalog("restricted", {
      schema: "autodev-workspaces-v1",
      workspaces: [
        makeWorkspace({
          id: "SimulatorLife/Locked",
          enabled: true,
          agentRoles: ["codex", "claude"]
        })
      ]
    })
  );
  const unlocked = workspaceCatalog.resolveTarget(
    restricted,
    "SimulatorLife/Locked"
  );
  assert.equal(unlocked.ok, true);
  assert.equal(
    workspaceCatalog.resolveTarget(restricted, "SimulatorLife/Locked", {
      agentRole: "codex"
    }).ok,
    true
  );
  const disallowed = workspaceCatalog.resolveTarget(
    restricted,
    "SimulatorLife/Locked",
    {
      agentRole: "gemini"
    }
  );
  assert.equal(disallowed.ok, false);
  if (!disallowed.ok)
    assert.match(disallowed.reason, /is not allowed for workspace/);
  rmSync(path.dirname(restricted.list[0]?.id ?? ""), {
    recursive: true,
    force: true
  });

  const disabledFile = writeCatalog("disabled", {
    schema: "autodev-workspaces-v1",
    workspaces: [makeWorkspace({ id: "SimulatorLife/Off", enabled: false })]
  });
  const disabledCatalog = workspaceCatalog.loadCatalog(disabledFile);
  const disabled = workspaceCatalog.resolveTarget(
    disabledCatalog,
    "SimulatorLife/Off"
  );
  assert.equal(disabled.ok, false);
  if (!disabled.ok)
    assert.match(
      disabled.reason,
      /disabled in the canonical workspace catalog/
    );
  rmSync(disabledFile, { force: true });

  const baseMatch = workspaceCatalog.resolveTarget(
    catalog,
    "SimulatorLife/Colourful-Life",
    {
      baseBranch: "master"
    }
  );
  assert.equal(baseMatch.ok, true);
  const baseMismatch = workspaceCatalog.resolveTarget(
    catalog,
    "SimulatorLife/Colourful-Life",
    { baseBranch: "main" }
  );
  assert.equal(baseMismatch.ok, false);
  if (!baseMismatch.ok)
    assert.match(baseMismatch.reason, /base_branch must match/);
});

test("resolvePrompt requires an enabled workspace", () => {
  const catalog = workspaceCatalog.loadCatalog(canonicalCatalogPath);
  const allowed = workspaceCatalog.resolvePrompt(
    catalog,
    "SimulatorLife/AutoDev"
  );
  assert.equal(allowed.ok, true);
  const missing = workspaceCatalog.resolvePrompt(
    catalog,
    "SimulatorLife/Ghost"
  );
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
  const disabledCatalog = workspaceCatalog.loadCatalog(disabledFile);
  const disabled = workspaceCatalog.resolvePrompt(
    disabledCatalog,
    "SimulatorLife/Auto"
  );
  assert.equal(disabled.ok, false);
  if (!disabled.ok)
    assert.match(
      disabled.reason,
      /not enabled in the canonical workspace catalog/
    );
  rmSync(disabledFile, { force: true });
});

test("listEnabled returns only the enabled workspace ids", () => {
  const catalog = workspaceCatalog.loadCatalog(
    writeCatalog("mixed", {
      schema: "autodev-workspaces-v1",
      workspaces: [
        makeWorkspace({ id: "SimulatorLife/A", enabled: true }),
        makeWorkspace({ id: "SimulatorLife/B", enabled: false }),
        makeWorkspace({ id: "SimulatorLife/C", enabled: true })
      ]
    })
  );
  assert.deepEqual(workspaceCatalog.listEnabled(catalog), [
    "SimulatorLife/A",
    "SimulatorLife/C"
  ]);
});

test("CLI surfaces success JSON and fail-closed exit codes", () => {
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
  assert.ok(!ids.includes("SimulatorLife/Colourful-Life") || ids.length > 0);

  const unknownCommand = runCli(["nope", canonicalCatalogPath]);
  assert.equal(unknownCommand.status, 1);
});
