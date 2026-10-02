import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ClickHouseTelemetryClient,
  ConfigRepository,
  RuleSyncRepository,
  RuleSyncSkillConflictError
} from "../src/index.ts";

test("RuleSyncRepository loads canonical RuleSync sources", () => {
  const repo = new RuleSyncRepository();
  const commands = repo.loadCommands();
  assert.ok(commands.length > 0);
  assert.ok(commands.some((c) => c.name === "dry"));

  const hooks = repo.loadHooksState();
  assert.equal(hooks.valid, true);
  assert.ok(hooks.hooks.length > 0);
  assert.ok(hooks.hooks.some((hook) => hook.event === "sessionStart"));

  const skills = repo.loadSkills();
  assert.ok(skills.length > 0);
  assert.ok(skills.some((s) => s.name === "orchestration"));

  const mcps = repo.loadMcpState();
  assert.equal(mcps.valid, true);
  assert.ok(mcps.servers.some((server) => server.name === "lsp"));
  assert.ok(mcps.servers.some((server) => server.name === "autodev_spawn"));
  const context7 = mcps.servers.find((server) => server.name === "context7");
  assert.deepEqual(context7?.targetOverrides, [
    { target: "codexcli", enabled: false }
  ]);
});

test("RuleSync MCP state parses canonical JSONC and target overrides without exposing config", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "autodev-mcp-"));
  const sourcePath = path.join(repositoryRoot, ".rulesync", "mcp.jsonc");
  const repo = new RuleSyncRepository(repositoryRoot);
  try {
    assert.deepEqual(repo.loadMcpState(), {
      source: ".rulesync/mcp.jsonc",
      valid: null,
      servers: []
    });

    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      `{
        // The server launch details and credentials are never returned by this read model.
        "mcpServers": {
          "local": { "command": "node", "env": { "TOKEN": "secret" }, },
          "remote": { "url": "https://mcp.example.test", "bearer_token_env_var": "MCP_TOKEN" },
          "default-disabled": { "command": "node", "disabled": true },
        },
        "codexcli": {
          "mcpServers": {
            "remote": null,
            "local": { "command": "node", "args": ["local"], },
            "codex-only": { "command": "node", "disabled": false, },
            "target-disabled": { "command": "node", "disabled": true, },
          },
        },
        "copilotcli": { "mcpServers": { "local": null, }, },
      }`,
      "utf8"
    );

    assert.deepEqual(repo.loadMcpState(), {
      source: ".rulesync/mcp.jsonc",
      valid: true,
      servers: [
        {
          name: "codex-only",
          enabled: null,
          transport: "stdio",
          targetOverrides: [{ target: "codexcli", enabled: true }]
        },
        {
          name: "default-disabled",
          enabled: false,
          transport: "stdio",
          targetOverrides: []
        },
        {
          name: "local",
          enabled: true,
          transport: "stdio",
          targetOverrides: [
            { target: "codexcli", enabled: true },
            { target: "copilotcli", enabled: false }
          ]
        },
        {
          name: "remote",
          enabled: true,
          transport: "http",
          targetOverrides: [{ target: "codexcli", enabled: false }]
        },
        {
          name: "target-disabled",
          enabled: null,
          transport: "stdio",
          targetOverrides: [{ target: "codexcli", enabled: false }]
        }
      ]
    });

    await writeFile(
      sourcePath,
      `{"mcpServers":{"bad":{"command":"node"}},"codexcli":{"mcpServers":{"bad":{"command":"node","disabled":"yes"}}}}`,
      "utf8"
    );
    assert.deepEqual(repo.loadMcpState(), {
      source: ".rulesync/mcp.jsonc",
      valid: false,
      servers: []
    });

    await writeFile(sourcePath, `{"mcpServers": []}`, "utf8");
    assert.deepEqual(repo.loadMcpState(), {
      source: ".rulesync/mcp.jsonc",
      valid: false,
      servers: []
    });
    await writeFile(sourcePath, "{", "utf8");
    assert.deepEqual(repo.loadMcpState(), {
      source: ".rulesync/mcp.jsonc",
      valid: false,
      servers: []
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync hook state distinguishes absent, valid JSONC, and invalid source", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "autodev-hooks-"));
  const sourcePath = path.join(repositoryRoot, ".rulesync", "hooks.jsonc");
  const repo = new RuleSyncRepository(repositoryRoot);
  try {
    assert.equal(repo.loadHooksState().valid, null);

    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      `{
        // JSONC comments and trailing commas are valid RuleSync source.
        "hooks": {
          "sessionStart": [{
            "type": "command",
            "command": "node hook.ts",
          }],
        },
      }`,
      "utf8"
    );
    const valid = repo.loadHooksState();
    assert.equal(valid.valid, true);
    assert.equal(valid.hooks[0]?.actions[0]?.command, "node hook.ts");

    await writeFile(
      sourcePath,
      `{"hooks":{"sessionStart":[{"type":"command"}]}}`,
      "utf8"
    );
    const invalid = repo.loadHooksState();
    assert.equal(invalid.valid, false);
    assert.deepEqual(invalid.hooks, []);

    await writeFile(sourcePath, "{", "utf8");
    assert.equal(repo.loadHooksState().valid, false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("ConfigRepository loads agent definitions and workspaces", () => {
  const repo = new ConfigRepository();
  const agents = repo.loadAgents();
  assert.ok(agents.length > 0);
  assert.ok(agents.some((a) => a.role === "orchestrator"));

  const workspaces = repo.loadWorkspaces();
  assert.ok(workspaces.length > 0);
  assert.ok(workspaces.some((w) => w.name === "SimulatorLife/AutoDev"));

  const policy = repo.loadPermissionPolicy();
  assert.equal(policy.approvalPolicy, "never");
  assert.equal(policy.sandboxMode, "workspace-write");
});

const SERVICE_PARAM_PATTERN = /ServiceName = \{service:String\}/;
const SPAN_ATTR_PATTERN = /SpanAttributes\['gen_ai.system'\] = \{f_0:String\}/;

test("ClickHouseTelemetryClient constructs safe parameterized queries", () => {
  const client = new ClickHouseTelemetryClient();
  const pq = client.buildTraceQuery({
    serviceName: "autodev-router",
    startTime: "2026-09-30 00:00:00",
    endTime: "2026-09-30 23:59:59",
    filters: { "gen_ai.system": "openai" }
  });
  assert.match(pq.query, SERVICE_PARAM_PATTERN);
  assert.match(pq.query, SPAN_ATTR_PATTERN);
  assert.equal(pq.params.service, "autodev-router");
  assert.equal(pq.params.f_0, "openai");
});

test("RuleSyncRepository promotes skills by creating an idempotent canonical source file", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-skill-promotion-")
  );
  try {
    const repo = new RuleSyncRepository(repositoryRoot);
    const input = {
      name: "verified-memory-workflow",
      description: "Validate current evidence before changing memory.",
      content:
        "## Steps\n\n1. Re-check the repository evidence.\n2. Run the focused tests."
    };
    const artifact = await repo.createSkill(input);
    assert.equal(
      artifact.path,
      ".rulesync/skills/verified-memory-workflow/SKILL.md"
    );
    assert.equal(
      artifact.uri,
      "rulesync://skills/verified-memory-workflow/SKILL.md"
    );
    assert.match(artifact.revision, /^[a-f0-9]{64}$/u);
    assert.equal(
      (
        await readFile(path.join(repositoryRoot, artifact.path), "utf8")
      ).includes(input.content),
      true
    );
    const promoted = repo
      .loadSkills()
      .find((skill) => skill.name === input.name);
    assert.equal(promoted?.description, input.description);

    const repeated = await repo.createSkill(input);
    assert.deepEqual(repeated, artifact);
    await assert.rejects(
      repo.createSkill({ ...input, content: "Different instructions." }),
      RuleSyncSkillConflictError
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository refuses unsafe skill names and symlinked canonical directories", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-skill-promotion-safe-")
  );
  const externalRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-skill-external-")
  );
  try {
    const repo = new RuleSyncRepository(repositoryRoot);
    const valid = {
      name: "safe-skill",
      description: "A safe skill.",
      content: "Do the documented safe steps."
    };
    await assert.rejects(
      repo.createSkill({ ...valid, name: "../escape" }),
      TypeError
    );
    await mkdir(path.join(repositoryRoot, ".rulesync"), { recursive: true });
    await symlink(
      externalRoot,
      path.join(repositoryRoot, ".rulesync", "skills")
    );
    await assert.rejects(repo.createSkill(valid), RuleSyncSkillConflictError);
    assert.equal(existsSync(path.join(externalRoot, "safe-skill")), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});
