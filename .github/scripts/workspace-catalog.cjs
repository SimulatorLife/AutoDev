#!/usr/bin/env node
// AutoDev canonical workspace catalog owner.
//
// Single source of truth for the GitHub Workspace registry: it loads and
// validates config/workspaces.json, resolves target and prompt repositories
// against the catalog, and exposes the enabled workspace set the target
// workflows iterate over. Every caller (target-automerge, target-pr-janitor,
// target-validation, agent-invoke, agent-02-resolve-merge-conflicts,
// _agent-open-pr-and-ping) must delegate to this module instead of
// re-implementing the schema, identity, or enabled checks inline.
//
// Behavior:
//   - loadCatalog: returns the validated catalog or throws.
//   - resolveTarget: enforces id form, presence, enabled, optional base
//     branch match, and optional agent role membership; fails closed.
//   - resolvePrompt: enforces id form, presence, and enabled; fails closed.
//   - listEnabled: returns the enabled workspace ids for cron-style iteration.
//
// CLI:
//   node workspace-catalog.js load <catalogPath>
//   node workspace-catalog.js resolve-target <catalogPath> <repoId>
//       [--base-branch BRANCH] [--agent-role ROLE]
//   node workspace-catalog.js resolve-prompt <catalogPath> <repoId>
//   node workspace-catalog.js list-enabled <catalogPath>
//
// On CLI success the resolved workspace (or enabled list) is written to
// stdout as JSON. On CLI failure the reason is written to stderr and the
// process exits non-zero, preserving the fail-closed unknown/disabled
// semantics the inline copies used to provide.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CATALOG_SCHEMA = "autodev-workspaces-v1";
const REPO_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/;

class WorkspaceCatalogError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceCatalogError";
  }
}

function readCatalogFile(catalogPath) {
  const absolute = path.resolve(catalogPath);
  if (!fs.existsSync(absolute)) {
    throw new WorkspaceCatalogError(
      `Workspace catalog not found: ${absolute}`
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new WorkspaceCatalogError(
      `Workspace catalog is not valid JSON: ${error.message}`
    );
  }
  return raw;
}

function normalizeWorkspace(entry) {
  const id = typeof entry?.id === "string" ? entry.id : "";
  const enabled = entry?.enabled;
  if (!REPO_ID_PATTERN.test(id) || typeof enabled !== "boolean") {
    throw new WorkspaceCatalogError(
      "Workspace catalog contains an invalid identity or enabled flag."
    );
  }
  const baseBranch =
    typeof entry.baseBranch === "string" && entry.baseBranch.length > 0
      ? entry.baseBranch
      : null;
  const agentRoles = Array.isArray(entry.agentRoles) ? entry.agentRoles : null;
  return { id, baseBranch, enabled, agentRoles };
}

function loadCatalog(catalogPath) {
  const raw = readCatalogFile(catalogPath);
  if (raw?.schema !== CATALOG_SCHEMA || !Array.isArray(raw.workspaces)) {
    throw new WorkspaceCatalogError("Workspace catalog is invalid.");
  }
  const workspaces = new Map();
  for (const entry of raw.workspaces) {
    const workspace = normalizeWorkspace(entry);
    if (workspaces.has(workspace.id)) {
      throw new WorkspaceCatalogError(`Duplicate workspace: ${workspace.id}`);
    }
    workspaces.set(workspace.id, workspace);
  }
  return { workspaces, list: [...workspaces.values()] };
}

function isValidRepoId(repoId) {
  return typeof repoId === "string" && REPO_ID_PATTERN.test(repoId);
}

function resolveTarget(catalog, repoId, options = {}) {
  if (!isValidRepoId(repoId)) {
    return { ok: false, reason: "target_repository must use the owner/name form." };
  }
  const workspace = catalog.workspaces.get(repoId);
  if (!workspace) {
    return {
      ok: false,
      reason: `Unconfigured target repository: ${repoId}`,
    };
  }
  if (!workspace.enabled) {
    return {
      ok: false,
      reason: `target_repository is disabled in the canonical workspace catalog: ${repoId}`,
    };
  }
  const { baseBranch, agentRole } = options;
  if (typeof baseBranch === "string" && baseBranch.length > 0) {
    if (workspace.baseBranch !== baseBranch) {
      return {
        ok: false,
        reason: `base_branch must match the Workspace registry for ${repoId}.`,
      };
    }
  }
  if (typeof agentRole === "string" && agentRole.length > 0) {
    if (
      !Array.isArray(workspace.agentRoles) ||
      !workspace.agentRoles.includes(agentRole)
    ) {
      return {
        ok: false,
        reason: `agent '${agentRole}' is not allowed for workspace ${repoId}.`,
      };
    }
  }
  return { ok: true, workspace };
}

function resolvePrompt(catalog, repoId) {
  if (!isValidRepoId(repoId)) {
    return { ok: false, reason: "prompt_repository must use the owner/name form." };
  }
  const workspace = catalog.workspaces.get(repoId);
  if (!workspace) {
    return {
      ok: false,
      reason: `prompt_repository is not present in the canonical workspace catalog: ${repoId}`,
    };
  }
  if (!workspace.enabled) {
    return {
      ok: false,
      reason: `prompt_repository is not enabled in the canonical workspace catalog: ${repoId}`,
    };
  }
  return { ok: true, workspace };
}

function listEnabled(catalog) {
  return catalog.list
    .filter((workspace) => workspace.enabled)
    .map((workspace) => workspace.id);
}

function parseCliOptions(tokens) {
  const options = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--base-branch") {
      options.baseBranch = tokens[i + 1] ?? "";
      i += 1;
    } else if (token === "--agent-role") {
      options.agentRole = tokens[i + 1] ?? "";
      i += 1;
    } else {
      throw new WorkspaceCatalogError(`Unknown option: ${token}`);
    }
  }
  return options;
}

function runCli(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case "load": {
      const [catalogPath] = rest;
      if (!catalogPath) {
        throw new WorkspaceCatalogError("load requires <catalogPath>");
      }
      loadCatalog(catalogPath);
      return;
    }
    case "resolve-target": {
      const [catalogPath, repoId, ...optionTokens] = rest;
      if (!catalogPath || !repoId) {
        throw new WorkspaceCatalogError(
          "resolve-target requires <catalogPath> <repoId>"
        );
      }
      const catalog = loadCatalog(catalogPath);
      const options = parseCliOptions(optionTokens);
      const result = resolveTarget(catalog, repoId, options);
      if (!result.ok) {
        throw new WorkspaceCatalogError(result.reason);
      }
      process.stdout.write(`${JSON.stringify(result.workspace)}\n`);
      return;
    }
    case "resolve-prompt": {
      const [catalogPath, repoId] = rest;
      if (!catalogPath || !repoId) {
        throw new WorkspaceCatalogError(
          "resolve-prompt requires <catalogPath> <repoId>"
        );
      }
      const catalog = loadCatalog(catalogPath);
      const result = resolvePrompt(catalog, repoId);
      if (!result.ok) {
        throw new WorkspaceCatalogError(result.reason);
      }
      process.stdout.write(`${JSON.stringify(result.workspace)}\n`);
      return;
    }
    case "list-enabled": {
      const [catalogPath] = rest;
      if (!catalogPath) {
        throw new WorkspaceCatalogError("list-enabled requires <catalogPath>");
      }
      const catalog = loadCatalog(catalogPath);
      process.stdout.write(`${JSON.stringify(listEnabled(catalog))}\n`);
      return;
    }
    default: {
      throw new WorkspaceCatalogError(`Unknown command: ${command ?? ""}`);
    }
  }
}

module.exports = {
  CATALOG_SCHEMA,
  REPO_ID_PATTERN,
  WorkspaceCatalogError,
  loadCatalog,
  resolveTarget,
  resolvePrompt,
  listEnabled,
};

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof WorkspaceCatalogError
        ? error.message
        : `Workspace catalog CLI failed: ${error.message}`;
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
