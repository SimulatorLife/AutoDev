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
 * reads each role's sandbox from its own file.
 */
function roleFiles(): Record<string, string> {
  return {
    orchestrator:
      '# role-kind: orchestrator\nname = "orchestrator"\nsandbox_mode = "danger-full-access"\n\n[tools]\nweb_search = true\n',
    smart:
      'name = "smart"\nsandbox_mode = "danger-full-access"\n\n[tools]\nweb_search = true\n',
    "docs-researcher":
      'name = "docs-researcher"\nsandbox_mode = "read-only"\n\n[tools]\nweb_search = true\n',
    explorer: 'name = "explorer"\nsandbox_mode = "read-only"\n',
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
  writeFileSync(
    rootConfigPath,
    '[mcp_servers.lsp]\ncommand = "lsp"\n',
    "utf8"
  );
  return { rolesDirectory, contractPath, rootConfigPath };
}


test("a role's declared sandbox is projected as the mode it states", () => {
  const options = fixture(roleFiles());
  const contract = renderExecutionContract(
    options.rolesDirectory,
    options.rootConfigPath,
    options.contractPath
  );
  // The product names the unsandboxed mode "unrestricted"; the file names it
  // `danger-full-access`.
  assert.equal(contract.roles.orchestrator?.sandboxMode, "unrestricted");
  assert.equal(contract.roles.explorer?.sandboxMode, "read-only");
  // A role that declares no sandbox declares none: it inherits the session's.
  assert.equal(contract.roles.default?.sandboxMode, null);
});

test("the projection carries no read-only boolean", () => {
  const options = fixture(roleFiles());
  const contract = renderExecutionContract(
    options.rolesDirectory,
    options.rootConfigPath,
    options.contractPath
  );
  for (const [role, entry] of Object.entries(contract.roles)) {
    assert.equal(
      Object.hasOwn(entry as Record<string, unknown>, "readOnly"),
      false,
      `role ${role} must not project a read-only boolean`
    );
  }
});

test("a role that declares a sandbox the product does not support is refused", () => {
  const options = fixture({
    ...roleFiles(),
    explorer: 'name = "explorer"\nsandbox_mode = "somewhere-else"\n'
  });
  // A declaration the product cannot honour is refused rather than read as
  // the nearest mode the product knows: a role that cannot be sandboxed the
  // way it asks is not a role whose sandbox is known.
  assert.throws(
    () =>
      renderExecutionContract(
        options.rolesDirectory,
        options.rootConfigPath,
        options.contractPath
      ),
    /sandbox_mode must be one of/u
  );
});
