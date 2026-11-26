import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CommandCatalogueError,
  type CommandDefinition,
  parseCommandCatalogue,
  resolveCommandArguments
} from "../src/mcp/commands-catalogue.ts";
import {
  type ApprovedCommandScope,
  commandSandboxProfile,
  commandWorkspaceKey,
  prepareCommand,
  resolveTrustedExecutables,
  runApprovedCommand
} from "../src/mcp/commands-execution.ts";
import {
  approvedCataloguePath,
  catalogueDigest,
  createApprovedCatalogueGrant,
  createWorkspaceLease
} from "../src/mcp/commands-main.ts";
import {
  classifyRegistryPath,
  rewriteRegistryUrls
} from "../src/mcp/commands-registry-proxy.ts";
import {
  isCommandEligibleInWorkspace,
  createCommandsMcpServer,
  effectiveCommands
} from "../src/mcp/commands-server.ts";

const PRINTF = realpathSync("/usr/bin/printf");
const SHELL = realpathSync("/bin/sh");

const fixture = {
  description: "Harmless fixture",
  executable: "printf",
  args: ["%s", "literal; $HOME"],
  parameters: {},
  timeoutMs: 3000,
  executionClass: "validation",
  concurrency: "exclusive"
} satisfies CommandDefinition;

const catalogue = { version: 1, commands: { fixture } };

/**
A private workspace, scratch and cache, with the system binaries trusted.
*/
function scopeFixture(root: string): ApprovedCommandScope {
  const base = mkdtempSync(path.join(root, "scope-"));
  const workspace = path.join(base, "workspace");
  const scratch = path.join(base, "scratch");
  const cache = path.join(base, "cache");
  for (const directory of [workspace, scratch, cache]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  return {
    workspace,
    scratch,
    cache,
    toolchainRoots: [path.dirname(PRINTF), path.dirname(SHELL)],
    executables: { printf: PRINTF, sh: SHELL }
  };
}

test("the catalogue is strict, and a parameter is only ever a whole argument", () => {
  assert.deepEqual(parseCommandCatalogue(catalogue).commands.fixture, fixture);
  for (const definition of [
    { ...fixture, executable: "../shell" },
    { ...fixture, args: ["a\0b"] },
    { ...fixture, cwd: "/tmp" },
    { ...fixture, env: { SECRET: "value" } },
    { ...fixture, timeoutMs: 0 },
    { ...fixture, concurrency: "unbounded" }
  ]) {
    assert.throws(() =>
      parseCommandCatalogue({ version: 1, commands: { fixture: definition } })
    );
  }
  assert.throws(() =>
    parseCommandCatalogue({ version: 1, commands: { "invalid name": fixture } })
  );
  // A placeholder that names no parameter, and a parameter nothing uses, are
  // both configuration errors rather than silently ignored.
  assert.throws(() =>
    parseCommandCatalogue({
      version: 1,
      commands: {
        broken: { ...fixture, args: ["--message", "{missing}"] }
      }
    })
  );
  assert.throws(() =>
    parseCommandCatalogue({
      version: 1,
      commands: {
        broken: {
          ...fixture,
          parameters: {
            unused: { description: "unused", minLength: 1, maxLength: 10 }
          }
        }
      }
    })
  );
  assert.throws(() =>
    parseCommandCatalogue({
      version: 1,
      commands: {
        broken: {
          ...fixture,
          parameters: {
            message: { description: "bad", minLength: 10, maxLength: 1 }
          },
          args: ["--message", "{message}"]
        }
      }
    })
  );
});

test("parameters are validated, substituted literally, and never interpolated", () => {
  const definition = {
    ...fixture,
    executable: "sh",
    args: ["-c", 'printf "%s" "$1"', "sh", "{message}"],
    parameters: {
      message: { description: "the message", minLength: 1, maxLength: 32 }
    }
  } satisfies CommandDefinition;
  // A value that would be catastrophic in a shell is one literal argument.
  const argv = resolveCommandArguments(definition, {
    message: "; rm -rf / #$(whoami)`id`"
  });
  assert.equal(argv.length, 4);
  assert.equal(argv[3], "; rm -rf / #$(whoami)`id`");
  assert.throws(
    () => resolveCommandArguments(definition, { message: "" }),
    CommandCatalogueError
  );
  assert.throws(
    () => resolveCommandArguments(definition, { message: "x".repeat(33) }),
    CommandCatalogueError
  );
  assert.throws(
    () => resolveCommandArguments(definition, { message: "a\0b" }),
    CommandCatalogueError
  );
  assert.throws(
    () => resolveCommandArguments(definition, {}),
    CommandCatalogueError
  );
  // An undeclared parameter is rejected, not ignored.
  assert.throws(
    () => resolveCommandArguments(definition, { message: "ok", extra: "no" }),
    CommandCatalogueError
  );
});

test("a role's grant decides the effective command set, and a read-only role gets none", () => {
  const worker = effectiveCommands({
    role: "worker",
    workspaceId: null,
    catalogue: parseCommandCatalogue({
      version: 1,
      commands: {
        typecheck: {
          ...fixture,
          description: "typecheck",
          executable: "pnpm"
        }
      }
    }),
    scope: scopeFixture("/tmp"),
    isAuthorized: () => true,
    tryAcquireWorkspace: () => null
  });
  assert.deepEqual(worker.keys().toArray(), ["typecheck"]);
  // A read-only role is refused outright, not merely given a smaller set.
  assert.throws(
    () =>
      createCommandsMcpServer({
        role: "explorer",
        workspaceId: null,
        catalogue: parseCommandCatalogue(catalogue),
        scope: scopeFixture("/tmp"),
        isAuthorized: () => true,
        tryAcquireWorkspace: () => null
      }),
    /not authorized/u
  );
  // A revoked grant is refused before anything is served.
  assert.throws(
    () =>
      createCommandsMcpServer({
        role: "orchestrator",
        workspaceId: null,
        catalogue: parseCommandCatalogue(catalogue),
        scope: scopeFixture("/tmp"),
        isAuthorized: () => false,
        tryAcquireWorkspace: () => null
      }),
    /revoked/u
  );
});

test("a command may be restricted to the workspaces it names", () => {
  const definition = {
    ...fixture,
    workspaces: ["SimulatorLife/AutoDev"]
  } satisfies CommandDefinition;
  assert.equal(isCommandEligibleInWorkspace(definition, "SimulatorLife/AutoDev"), true);
  assert.equal(isCommandEligibleInWorkspace(definition, "SimulatorLife/Other"), false);
  assert.equal(isCommandEligibleInWorkspace(definition, null), false);
  assert.equal(isCommandEligibleInWorkspace(fixture, null), true);
});

test("the approved catalogue may not live inside the workspace it authorizes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-policy-"));
  try {
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { mode: 0o700 });
    // The Runtime's own configuration root, outside every workspace.
    const outside = path.join(root, "runtime-root");
    mkdirSync(path.join(outside, "config"), { recursive: true });
    const moduleDirectory = path.join(outside, "src", "mcp");
    mkdirSync(moduleDirectory, { recursive: true });
    const cataloguePath = path.join(outside, "config", "commands.json");
    writeFileSync(cataloguePath, JSON.stringify(catalogue));
    const resolved = approvedCataloguePath(moduleDirectory, workspace);
    const expected = path.join(realpathSync(path.join(outside, "config")), "commands.json");
    assert.equal(resolved, expected);
    // A catalogue inside the workspace is refused: an agent that can edit it
    // would be editing its own authority.
    const insideRoot = path.join(root, "inside-root");
    mkdirSync(path.join(insideRoot, "config"), { recursive: true });
    const insideModule = path.join(insideRoot, "src", "mcp");
    mkdirSync(insideModule, { recursive: true });
    writeFileSync(
      path.join(insideRoot, "config", "commands.json"),
      JSON.stringify(catalogue)
    );
    assert.throws(
      () => approvedCataloguePath(insideModule, insideRoot),
      /inside the authorized workspace/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacing the approved catalogue revokes the grant", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-revoke-"));
  try {
    const cataloguePath = path.join(root, "commands.json");
    writeFileSync(cataloguePath, JSON.stringify(catalogue));
    const grant = createApprovedCatalogueGrant(cataloguePath);
    assert.equal(grant.isAuthorized(), true);
    assert.equal(grant.digest, catalogueDigest(readFileSync(cataloguePath, "utf8")));
    writeFileSync(
      cataloguePath,
      JSON.stringify({
        version: 1,
        commands: {
          fixture: { ...fixture, executable: "sh" }
        }
      })
    );
    assert.equal(grant.isAuthorized(), false);
    rmSync(cataloguePath);
    assert.equal(grant.isAuthorized(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace lease is exclusive across sessions and released on completion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-lease-"));
  try {
    const lease = createWorkspaceLease(root, "workspace-key");
    const release = lease.tryAcquire();
    assert.ok(release);
    assert.equal(lease.tryAcquire(), null);
    release!();
    assert.ok(lease.tryAcquire());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command profile denies the network, the host and the credentials", () => {
  const profile = commandSandboxProfile("/workspace", "/scratch", "/cache", [
    "/toolchain"
  ]);
  assert.match(profile, /\(deny default\)/u);
  assert.match(profile, /\(subpath "\/workspace"\)/u);
  assert.match(profile, /\(subpath "\/scratch"\)/u);
  assert.match(profile, /\(subpath "\/cache"\)/u);
  assert.doesNotMatch(profile, /\(allow (?:network|mach-lookup|ipc)/u);
  assert.doesNotMatch(profile, /\(allow file-read\*\)/u);
  assert.match(profile, /\\\.env/u);
  assert.match(profile, /\\\.ssh/u);
  assert.match(profile, /\\\.codex/u);
  assert.match(profile, /\\\.autodev/u);
  // The only writable roots are the workspace and the Runtime's own roots.
  const writeRule = profile
    .split("\n")
    .find((line) => line.startsWith("(allow file-write*"))!;
  assert.match(writeRule, /\(subpath "\/workspace"\)/u);
  assert.match(writeRule, /\(subpath "\/scratch"\)/u);
  assert.match(writeRule, /\(subpath "\/cache"\)/u);
});

test("only a dependency install may reach the network, and only the registry proxy", () => {
  const profile = commandSandboxProfile(
    "/workspace",
    "/scratch",
    "/cache",
    ["/toolchain"],
    { registryPort: 4321 }
  );
  assert.match(profile, /\(allow network-outbound \(remote ip "127\.0\.0\.1:4321"\)\)/u);
  assert.doesNotMatch(profile, /\(allow network-outbound \(remote ip "\*"/u);
  assert.doesNotMatch(profile, /\(allow network\*/u);
});

test("a command's environment carries no operator credentials and no host paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-env-"));
  try {
    const scope = scopeFixture(root);
    const prepared = prepareCommand(scope, fixture);
    assert.equal(prepared.cwd, realpathSync(scope.workspace));
    const scratch = realpathSync(scope.scratch);
    const cache = realpathSync(scope.cache);
    assert.equal(prepared.env.HOME, scratch);
    assert.equal(prepared.env.TMPDIR, scratch);
    assert.equal(prepared.env.XDG_CACHE_HOME, path.join(cache, "xdg"));
    assert.equal(prepared.env.CI, "1");
    // No operator secret, tunnel token or provider credential is inherited.
    for (const forbidden of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CODEX_ROUTER_OPENCLI_API_KEY",
      "SSH_AUTH_SOCK",
      "AWS_ACCESS_KEY_ID",
      "NPM_TOKEN"
    ]) {
      assert.equal(prepared.env[forbidden], undefined);
    }
    assert.equal(prepared.env.npm_config_update_notifier, "false");
    assert.equal(prepared.env.npm_config_audit, "false");
    // The workspace root is not on the PATH of the confined process; only
    // the project's own tool directory is, so a project script can resolve
    // the tools it declares.
    const pathEntries = new Set(prepared.env.PATH!.split(path.delimiter));
    const physicalWorkspace = realpathSync(scope.workspace);
    assert.ok(!pathEntries.has(physicalWorkspace));
    assert.ok(
      pathEntries.has(path.join(physicalWorkspace, "node_modules", ".bin"))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scope that overlaps a protected root, or an unapproved executable, is refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-scope-"));
  try {
    const scope = scopeFixture(root);
    assert.throws(
      () => prepareCommand(scope, { ...fixture, executable: "unknown" }),
      /not been approved/u
    );
    // The scratch may not be the workspace, and the workspace may not be the
    // filesystem root.
    assert.throws(
      () => prepareCommand({ ...scope, scratch: scope.workspace }, fixture),
      /overlaps/u
    );
    assert.throws(
      () => prepareCommand({ ...scope, workspace: "/" }, fixture),
      /overlaps|not a directory/u
    );
    // Dependency installation needs an approved egress, and without one it
    // is refused rather than silently allowed.
    assert.throws(
      () => prepareCommand(scope, { ...fixture, executionClass: "dependency_install" }),
      /egress|package-registry/u
    );
    const withRegistry = {
      ...scope,
      registryEndpoint: "http://127.0.0.1:5555"
    };
    const prepared = prepareCommand(withRegistry, {
      ...fixture,
      executionClass: "dependency_install"
    });
    assert.equal(prepared.env.npm_config_registry, "http://127.0.0.1:5555");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted executables never resolve out of the workspace", () => {
  const resolved = resolveTrustedExecutables(["git"]);
  assert.ok(path.isAbsolute(resolved.executables.git!));
  assert.ok(resolved.toolchainRoots.length > 0);
  const filesystemRoot = path.parse(path.resolve("/")).root;
  assert.ok(!resolved.toolchainRoots.includes(filesystemRoot));
  assert.throws(() => resolveTrustedExecutables(["definitely-not-installed-xyz"]));
});

test("the workspace key is derived from the workspace and is stable", () => {
  assert.equal(commandWorkspaceKey("/tmp/one"), commandWorkspaceKey("/tmp/one"));
  assert.notEqual(commandWorkspaceKey("/tmp/one"), commandWorkspaceKey("/tmp/two"));
});

test("the registry proxy serves package metadata and tarballs, and nothing else", () => {
  assert.equal(classifyRegistryPath("/pnpm"), "metadata");
  assert.equal(classifyRegistryPath("/@scope%2fname"), null);
  assert.equal(classifyRegistryPath("/pnpm/-/pnpm-1.0.0.tgz"), "tarball");
  assert.equal(classifyRegistryPath("/-/ping"), null);
  assert.equal(classifyRegistryPath("/-/npm/v1/security/audits"), null);
  assert.equal(classifyRegistryPath("//evil.example/"), null);
  const rewritten = rewriteRegistryUrls(
    '{"tarball":"https://registry.npmjs.org/pnpm/-/pnpm-1.0.0.tgz"}',
    "https://registry.npmjs.org",
    "http://127.0.0.1:9999"
  );
  assert.match(rewritten, /http:\/\/127\.0\.0\.1:9999\/pnpm\/-\/pnpm-1\.0\.0\.tgz/u);
  assert.doesNotMatch(rewritten, /registry\.npmjs\.org/u);
});

test(
  "a confined command keeps literal arguments, cannot write outside the workspace and cannot read secrets",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-fixture-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const result = await runApprovedCommand(
      "fixture",
      fixture,
      fixture.args,
      scope,
      AbortSignal.timeout(10_000)
    );
    assert.equal(result.status, "succeeded", result.stderr);
    assert.equal(result.stdout, "literal; $HOME");
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputTruncated, false);

    // A write outside the workspace is denied.
    const protectedPath = path.join(root, "protected.txt");
    writeFileSync(protectedPath, "original");
    const mutation = {
      ...fixture,
      executable: "sh",
      args: ["-c", 'printf changed > "$1"', "sh", protectedPath],
      executionClass: "workspace_mutation"
    } satisfies CommandDefinition;
    const denied = await runApprovedCommand(
      "denied",
      mutation,
      mutation.args,
      scope,
      AbortSignal.timeout(10_000)
    );
    assert.notEqual(denied.status, "succeeded");
    assert.equal(readFileSync(protectedPath, "utf8"), "original");

    // A workspace secret file is not readable through the command either.
    const secretPath = path.join(scope.workspace, ".env");
    writeFileSync(secretPath, "fixture-secret");
    const secret = await runApprovedCommand(
      "secret",
      { ...mutation, args: ["-c", 'cat "$1"', "sh", secretPath] },
      ["-c", 'cat "$1"', "sh", secretPath],
      scope,
      AbortSignal.timeout(10_000)
    );
    assert.notEqual(secret.status, "succeeded");
    assert.doesNotMatch(secret.stdout, /fixture-secret/u);
  }
);

test(
  "a symlink in the workspace cannot be used to reach outside it",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-symlink-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "outside-secret");
    const link = path.join(scope.workspace, "link.txt");
    symlinkSync(outside, link);
    const definition = {
      ...fixture,
      executable: "sh",
      args: ["-c", 'cat "$1"', "sh", link],
      executionClass: "validation"
    } satisfies CommandDefinition;
    const result = await runApprovedCommand(
      "symlink",
      definition,
      definition.args,
      scope,
      AbortSignal.timeout(10_000)
    );
    // Reading through the symlink resolves outside the workspace, so the
    // profile's read grant does not cover it.
    assert.doesNotMatch(result.stdout, /outside-secret/u);
  }
);

test(
  "a command that outlives its deadline is stopped and reported as timed out",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-timeout-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const definition = {
      ...fixture,
      executable: "sh",
      args: ["-c", "sleep 30"],
      timeoutMs: 1500
    } satisfies CommandDefinition;
    const result = await runApprovedCommand(
      "slow",
      definition,
      definition.args,
      scope,
      AbortSignal.timeout(20_000)
    );
    assert.equal(result.status, "timed_out");
  }
);

test(
  "a cancelled command is stopped and reported as cancelled",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-cancel-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const definition = {
      ...fixture,
      executable: "sh",
      args: ["-c", "sleep 30"],
      timeoutMs: 30_000
    } satisfies CommandDefinition;
    const controller = new AbortController();
    const pending = runApprovedCommand(
      "cancelled",
      definition,
      definition.args,
      scope,
      controller.signal
    );
    setTimeout(() => controller.abort(), 500);
    const result = await pending;
    assert.equal(result.status, "cancelled");
  }
);

test(
  "output beyond the bound is reported as truncated rather than buffered without limit",
  {
    skip:
      process.platform !== "darwin" ||
      !existsSync("/usr/bin/sandbox-exec")
  },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "autodev-command-output-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = scopeFixture(root);
    const definition = {
      ...fixture,
      executable: "sh",
      args: ["-c", "yes abcdefghijklmnopqrstuvwxyz"],
      timeoutMs: 20_000
    } satisfies CommandDefinition;
    const result = await runApprovedCommand(
      "noisy",
      definition,
      definition.args,
      scope,
      AbortSignal.timeout(20_000)
    );
    assert.equal(result.outputTruncated, true);
    assert.equal(result.status, "output_limit");
    assert.ok(result.stdout.length <= 256 * 1024);
  }
);

test("the installed catalogue is a valid, generic catalogue", () => {
  const cataloguePath = path.join(
    process.cwd(),
    "..",
    "config",
    "commands.json"
  );
  const parsed = parseCommandCatalogue(
    JSON.parse(readFileSync(cataloguePath, "utf8"))
  );
  const ids = Object.keys(parsed.commands);
  for (const required of [
    "install_dependencies",
    "typecheck",
    "test",
    "lint_fix",
    "git_status",
    "git_diff",
    "git_stage",
    "git_commit"
  ]) {
    assert.ok(ids.includes(required), `missing ${required}`);
  }
  // The Git capabilities are exactly the ones the migration names: no push,
  // no reset, no configuration change.
  const gitArguments = new Set(Object.entries(parsed.commands)
    .filter(([, definition]) => definition.executable === "git")
    .flatMap(([, definition]) => definition.args));
  for (const forbidden of ["push", "reset", "config", "rebase", "clean"]) {
    assert.ok(!gitArguments.has(forbidden), `git ${forbidden} is not granted`);
  }
  // The commit message is a validated parameter, not free-form argv.
  assert.deepEqual(parsed.commands.git_commit!.parameters.message, {
    description: "The commit message for the staged changes.",
    minLength: 1,
    maxLength: 500
  });
  assert.deepEqual(parsed.commands.git_commit!.args, ["commit", "-m", "{message}"]);
});

test("the host's sandbox tooling really confines, so the negative tests mean something", () => {
  // A profile that denies everything must actually stop the process; if it
  // did not, every negative confinement test above would be vacuous.
  const denied = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)(deny default)", "/usr/bin/true"],
    { stdio: "ignore" }
  );
  assert.notEqual(denied.status, 0);
  const allowed = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)(allow default)", "/usr/bin/true"],
    { stdio: "ignore" }
  );
  assert.equal(allowed.status, 0);
});

test("the command scratch and cache are private", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-command-private-"));
  try {
    const scope = scopeFixture(root);
    for (const directory of [scope.scratch, scope.cache]) {
      const mode = spawnSync("/usr/bin/stat", ["-f", "%Lp", directory], {
        encoding: "utf8"
      }).stdout.trim();
      assert.equal(mode, "700");
    }
    chmodSync(scope.scratch, 0o755);
    assert.throws(() => prepareCommand(scope, fixture), /private/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
