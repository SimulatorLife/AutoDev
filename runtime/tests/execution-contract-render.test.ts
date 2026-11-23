import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { renderExecutionContract } from "../src/config/render-execution-contract.ts";

/**
 * The execution contract's own tests.
 *
 * The contract is the projection of the role declarations, and the sandbox a
 * role declares is one of the things it projects. It used to project a
 * boolean, which could say only "read-only" or "not read-only" and so
 * reported every unrestricted role as a workspace-write one.
 */

interface Fixture {
  readonly rolesDirectory: string;
  readonly contractPath: string;
  readonly rootConfigPath: string;
}

/**
 * A contract template with the shape the renderer reads.
 *
 * The renderer reads the roles from the role files and the template for the
 * rest, so the template carries the per-role facts the role files do not:
 * the role-scoped MCP grants and the web-research declaration.
 */
const CONTRACT_TEMPLATE = {
  version: 1,
  roles: {
    orchestrator: {
      roleScopedMcp: [],
      webResearch: { search: true, fetch: true }
    },
    smart: {
      roleScopedMcp: [],
      webResearch: { search: true, fetch: true }
    },
    "docs-researcher": {
      roleScopedMcp: [],
      webResearch: { search: true, fetch: true }
    },
    explorer: { roleScopedMcp: [] },
    default: { roleScopedMcp: [] }
  },
  providers: {}
};

/**
 * The role files every contract needs.
 *
 * The renderer requires an orchestrator and the three research roles, and it
 * derives `readOnly` from `# role-access: read-only` or `AUTODEV_MCP_READ_ONLY`.
 */
function roleFiles(): Record<string, string> {
  return {
    orchestrator:
      '# role-kind: orchestrator\nname = "orchestrator"\n\n[tools]\nweb_search = true\n',
    smart: 'name = "smart"\n\n[tools]\nweb_search = true\n',
    "docs-researcher":
      '# role-access: read-only\nname = "docs-researcher"\n\n[tools]\nweb_search = true\n',
    explorer: '# role-access: read-only\nname = "explorer"\n',
    default: 'name = "default"\n'
  };
}

function fixture(roles: Record<string, string>): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-contract-roles-"));
  const rolesDirectory = path.join(root, "agents", "roles");
  mkdirSync(rolesDirectory, { recursive: true });
  for (const [role, source] of Object.entries(roles)) {
    writeFileSync(path.join(rolesDirectory, `${role}.toml`), source, "utf8");
  }
  const contractPath = path.join(root, "config", "execution-contract.json");
  mkdirSync(path.dirname(contractPath), { recursive: true });
  writeFileSync(contractPath, JSON.stringify(CONTRACT_TEMPLATE), "utf8");
  // The root config is the portable source: the renderer's second argument.
  const rootConfigPath = path.join(root, "config", "config.autodev.toml");
  writeFileSync(rootConfigPath, '[mcp_servers.lsp]\ncommand = "lsp"\n', "utf8");
  return { rolesDirectory, contractPath, rootConfigPath };
}

test("a role's readOnly capability flag is projected from role access declarations", () => {
  const options = fixture(roleFiles());
  const contract = renderExecutionContract(
    options.rolesDirectory,
    options.rootConfigPath,
    options.contractPath
  );
  assert.equal(contract.roles.orchestrator?.readOnly, false);
  assert.equal(contract.roles.explorer?.readOnly, true);
  assert.equal(contract.roles["docs-researcher"]?.readOnly, true);
  assert.equal(contract.roles.default?.readOnly, false);
});

test("a role carrying AUTODEV_MCP_READ_ONLY in filesystem env_vars projects readOnly = true", () => {
  const options = fixture({
    ...roleFiles(),
    explorer:
      'name = "explorer"\n\n[mcp_servers.filesystem]\nenabled = true\nenv_vars = ["AUTODEV_MCP_READ_ONLY"]\n'
  });
  const contract = renderExecutionContract(
    options.rolesDirectory,
    options.rootConfigPath,
    options.contractPath
  );
  assert.equal(contract.roles.explorer?.readOnly, true);
});
