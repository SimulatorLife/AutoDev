import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  RuleSyncCommandConflictError,
  RuleSyncCommandValidationError,
  RuleSyncRepository,
  RuleSyncSkillConflictError
} from "../src/index.ts";

test("RuleSyncRepository loads canonical RuleSync sources", () => {
  const repo = new RuleSyncRepository();
  const commands = repo.loadCommands();
  assert.equal(commands.valid, true);
  assert.ok(commands.commands.length > 0);
  const dryCommand = commands.commands.find(
    (command) => command.name === "dry"
  );
  assert.ok(dryCommand);
  assert.ok(dryCommand.description?.length);
  assert.deepEqual(dryCommand.targets, ["*"]);
  assert.ok(dryCommand.prompt.length > 0);

  const hooks = repo.loadHooksState();
  assert.equal(hooks.valid, true);
  assert.ok(hooks.hooks.length > 0);
  assert.ok(hooks.hooks.some((hook) => hook.event === "sessionStart"));

  const skills = repo.loadSkills();
  assert.equal(skills.valid, true);
  assert.ok(skills.skills.length > 0);
  assert.ok(skills.skills.some((s) => s.name === "orchestration"));
  assert.ok(
    skills.skills.every(
      (skill) =>
        skill.path === `.rulesync/skills/${skill.name}/SKILL.md` &&
        skill.description !== `RuleSync skill ${skill.name}`
    )
  );

  const mcps = repo.loadMcpState();
  assert.equal(mcps.valid, true);
  assert.ok(mcps.servers.some((server) => server.name === "lsp"));
  assert.ok(mcps.servers.some((server) => server.name === "autodev_spawn"));
  const context7 = mcps.servers.find((server) => server.name === "context7");
  assert.deepEqual(context7?.targetOverrides, [
    { target: "codexcli", enabled: false }
  ]);
});

test("RuleSyncRepository reflects command and skill edits, additions, and removals between reads", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-reread-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    const skillDir = path.join(repositoryRoot, ".rulesync", "skills", "audit");
    await mkdir(commandsDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    const command = (description: string): string =>
      `---\ntargets: [codexcli]\ndescription: ${description}\n---\n\n# Body\n`;
    const skill = (description: string): string =>
      `---\nname: audit\ndescription: ${description}\n---\n\n# Audit\n`;
    await writeFile(path.join(commandsDir, "audit.md"), command("First."));
    await writeFile(path.join(skillDir, "SKILL.md"), skill("First skill."));

    // Parses are cached by content, so each read must still observe the
    // current files rather than an earlier parse.
    const repo = new RuleSyncRepository(repositoryRoot);
    assert.equal(repo.loadCommands().commands[0]?.description, "First.");
    assert.equal(repo.loadSkills().skills[0]?.description, "First skill.");

    await writeFile(path.join(commandsDir, "audit.md"), command("Edited."));
    await writeFile(path.join(commandsDir, "review.md"), command("Added."));
    await writeFile(path.join(skillDir, "SKILL.md"), skill("Edited skill."));
    const edited = repo.loadCommands();
    assert.deepEqual(
      edited.commands.map(({ name, description }) => [name, description]),
      [
        ["audit", "Edited."],
        ["review", "Added."]
      ]
    );
    assert.equal(
      edited.commands[0]?.revision,
      createHash("sha256").update(command("Edited."), "utf8").digest("hex")
    );
    assert.equal(repo.loadSkills().skills[0]?.description, "Edited skill.");

    await rm(path.join(commandsDir, "review.md"));
    assert.deepEqual(
      repo.loadCommands().commands.map(({ name }) => name),
      ["audit"]
    );

    await writeFile(path.join(commandsDir, "audit.md"), "No frontmatter.\n");
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: false,
      commands: []
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository updates an existing command with revision checks", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-update-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = path.join(commandsDir, "audit.md");
    const original =
      "---\ntargets: [codexcli]\ndescription: Inspect the repository.\n---\n\n# Audit\n\nReview the source.\n";
    const updated =
      "---\ntargets: [codexcli, claudecode]\ndescription: Audit canonical input.\n---\n\n# Audit\n\nReview canonical source and verify the generated result.\n";
    await writeFile(commandPath, original);

    const repo = new RuleSyncRepository(repositoryRoot);
    const originalCommand = repo.loadCommands().commands[0];
    assert.ok(originalCommand);
    const saved = await repo.updateCommand({
      name: "audit",
      expectedRevision: originalCommand.revision,
      content: updated
    });
    assert.equal(saved.content, updated);
    assert.equal(saved.description, "Audit canonical input.");
    assert.deepEqual(saved.targets, ["codexcli", "claudecode"]);
    assert.notEqual(saved.revision, originalCommand.revision);
    assert.equal(await readFile(commandPath, "utf8"), updated);

    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: originalCommand.revision,
        content: original
      }),
      RuleSyncCommandConflictError
    );
    await assert.rejects(
      repo.updateCommand({
        name: "../outside",
        expectedRevision: saved.revision,
        content: updated
      }),
      RuleSyncCommandValidationError
    );
    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: saved.revision,
        content: "Invalid frontmatter"
      }),
      RuleSyncCommandValidationError
    );
    assert.equal(await readFile(commandPath, "utf8"), updated);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository updates only the expected command revision", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-update-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = path.join(commandsDir, "audit.md");
    const original =
      "---\ntargets: [codexcli]\ndescription: Inspect the repository.\n---\n\n# Audit\n\nReview the source.\n";
    const updated =
      "---\ntargets: [codexcli, claudecode]\ndescription: Audit canonical input.\n---\n\n# Audit\n\nReview canonical source and verify the generated result.\n";
    await writeFile(commandPath, original);

    const repo = new RuleSyncRepository(repositoryRoot);
    const current = repo.loadCommands().commands[0];
    assert.ok(current);
    const saved = await repo.updateCommand({
      name: "audit",
      expectedRevision: current.revision,
      content: updated
    });
    assert.equal(saved.content, updated);
    assert.equal(saved.description, "Audit canonical input.");
    assert.deepEqual(saved.targets, ["codexcli", "claudecode"]);
    assert.notEqual(saved.revision, current.revision);
    assert.equal(await readFile(commandPath, "utf8"), updated);

    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: current.revision,
        content: original
      }),
      RuleSyncCommandConflictError
    );
    await assert.rejects(
      repo.updateCommand({
        name: "../outside",
        expectedRevision: saved.revision,
        content: updated
      }),
      RuleSyncCommandValidationError
    );
    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: saved.revision,
        content: "Missing frontmatter."
      }),
      RuleSyncCommandValidationError
    );
    assert.equal(await readFile(commandPath, "utf8"), updated);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository rejects a symlinked canonical command root before writes", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-root-")
  );
  const externalRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-external-")
  );
  try {
    const externalCommands = path.join(externalRoot, ".rulesync", "commands");
    await mkdir(externalCommands, { recursive: true });
    const content =
      "---\ntargets: [codexcli]\ndescription: External command.\n---\n\nReview.\n";
    await writeFile(path.join(externalCommands, "audit.md"), content);
    await symlink(
      path.join(externalRoot, ".rulesync"),
      path.join(repositoryRoot, ".rulesync"),
      "dir"
    );

    const repo = new RuleSyncRepository(repositoryRoot);
    assert.equal(repo.loadCommands().valid, false);
    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: "0".repeat(64),
        content
      }),
      RuleSyncCommandValidationError
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository updates an existing command with optimistic concurrency", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-update-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = path.join(commandsDir, "audit.md");
    const original =
      "---\ntargets: [codexcli]\ndescription: Inspect the repository.\n---\n\n# Audit\n\nReview the source.\n";
    const updated =
      "---\ntargets: [codexcli, claudecode]\ndescription: Audit canonical input.\n---\n\n# Audit\n\nReview canonical source and verify the generated result.\n";
    await writeFile(commandPath, original);

    const repo = new RuleSyncRepository(repositoryRoot);
    const current = repo.loadCommands().commands[0];
    assert.ok(current);
    const saved = await repo.updateCommand({
      name: "audit",
      expectedRevision: current.revision,
      content: updated
    });
    assert.equal(saved.content, updated);
    assert.equal(saved.description, "Audit canonical input.");
    assert.deepEqual(saved.targets, ["codexcli", "claudecode"]);
    assert.notEqual(saved.revision, current.revision);
    assert.equal(await readFile(commandPath, "utf8"), updated);

    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: current.revision,
        content: original
      }),
      RuleSyncCommandConflictError
    );
    await assert.rejects(
      repo.updateCommand({
        name: "../outside",
        expectedRevision: saved.revision,
        content: updated
      }),
      RuleSyncCommandValidationError
    );
    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: saved.revision,
        content: "Missing frontmatter."
      }),
      RuleSyncCommandValidationError
    );
    assert.equal(await readFile(commandPath, "utf8"), updated);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository refuses a symlinked canonical source root for command updates", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-root-")
  );
  const externalRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-external-")
  );
  try {
    const externalCommands = path.join(externalRoot, ".rulesync", "commands");
    await mkdir(externalCommands, { recursive: true });
    await writeFile(
      path.join(externalCommands, "audit.md"),
      "---\ntargets: [codexcli]\ndescription: External command.\n---\n\nReview.\n"
    );
    await symlink(
      path.join(externalRoot, ".rulesync"),
      path.join(repositoryRoot, ".rulesync"),
      "dir"
    );
    const repo = new RuleSyncRepository(repositoryRoot);
    assert.equal(repo.loadCommands().valid, false);
    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: "0".repeat(64),
        content:
          "---\ntargets: [codexcli]\ndescription: Replace.\n---\n\nReview.\n"
      }),
      RuleSyncCommandValidationError
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("RuleSync command catalog distinguishes an absent, empty, and invalid source", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-commands-state-")
  );
  try {
    const repo = new RuleSyncRepository(repositoryRoot);
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: null,
      commands: []
    });

    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: true,
      commands: []
    });

    const commandPath = path.join(commandsDir, "audit.md");
    await writeFile(commandPath, "No command frontmatter.");
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: false,
      commands: []
    });

    await writeFile(
      commandPath,
      "---\ntargets: [codexcli, claudecode]\ndescription: Review canonical sources.\n---\n\n# Audit\n\nCheck the source tree.\n"
    );
    const state = repo.loadCommands();
    assert.equal(state.valid, true);
    assert.deepEqual(state.commands, [
      {
        name: "audit",
        path: ".rulesync/commands/audit.md",
        kind: "command",
        content:
          "---\ntargets: [codexcli, claudecode]\ndescription: Review canonical sources.\n---\n\n# Audit\n\nCheck the source tree.\n",
        prompt: "# Audit\n\nCheck the source tree.",
        revision: createHash("sha256")
          .update(
            "---\ntargets: [codexcli, claudecode]\ndescription: Review canonical sources.\n---\n\n# Audit\n\nCheck the source tree.\n",
            "utf8"
          )
          .digest("hex"),
        description: "Review canonical sources.",
        targets: ["codexcli", "claudecode"]
      }
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync catalogs reject a symlinked canonical .rulesync root", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-root-")
  );
  const externalRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-external-")
  );
  try {
    await mkdir(path.join(externalRoot, ".rulesync", "commands"), {
      recursive: true
    });
    await mkdir(path.join(externalRoot, ".rulesync", "skills", "audit"), {
      recursive: true
    });
    await writeFile(
      path.join(externalRoot, ".rulesync", "commands", "audit.md"),
      "---\ntargets: [codexcli]\ndescription: External command.\n---\n\nReview.\n"
    );
    await writeFile(
      path.join(externalRoot, ".rulesync", "skills", "audit", "SKILL.md"),
      "---\nname: audit\ndescription: External skill.\n---\n\nReview.\n"
    );
    await symlink(
      path.join(externalRoot, ".rulesync"),
      path.join(repositoryRoot, ".rulesync"),
      "dir"
    );

    const repo = new RuleSyncRepository(repositoryRoot);
    assert.equal(repo.loadCommands().valid, false);
    assert.equal(repo.loadSkills().valid, false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("RuleSync skill catalog distinguishes an absent, empty, and invalid source", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-skills-state-")
  );
  try {
    const repo = new RuleSyncRepository(repositoryRoot);
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: null,
      skills: []
    });

    const skillsDir = path.join(repositoryRoot, ".rulesync", "skills");
    await mkdir(skillsDir, { recursive: true });
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: true,
      skills: []
    });

    const skillDir = path.join(skillsDir, "audit");
    await mkdir(skillDir);
    const skillPath = path.join(skillDir, "SKILL.md");
    await writeFile(skillPath, "Not a RuleSync skill document.");
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: false,
      skills: []
    });

    await writeFile(
      skillPath,
      "---\nname: audit\ndescription: Check the source catalog.\n---\n\nInspect source state.\n"
    );
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: true,
      skills: [
        {
          name: "audit",
          description: "Check the source catalog.",
          path: ".rulesync/skills/audit/SKILL.md"
        }
      ]
    });

    const externalSkillPath = path.join(repositoryRoot, "external-SKILL.md");
    await writeFile(
      externalSkillPath,
      "---\nname: audit\ndescription: External content.\n---\n"
    );
    await rm(skillPath);
    await symlink(externalSkillPath, skillPath);
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: false,
      skills: []
    });

    await rm(skillPath);
    await rm(skillDir, { recursive: true });
    await symlink(externalSkillPath, skillDir, "dir");
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: false,
      skills: []
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
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
        // Credential values and credential references (env values, bearer_token_env_var)
        // are never returned by this read model; launch descriptors like command, url,
        // and env key names are.
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
          command: "node",
          targetOverrides: []
        },
        {
          name: "local",
          enabled: true,
          transport: "stdio",
          command: "node",
          envKeys: ["TOKEN"],
          targetOverrides: [
            { target: "codexcli", enabled: true },
            { target: "copilotcli", enabled: false }
          ]
        },
        {
          name: "remote",
          enabled: true,
          transport: "http",
          url: "https://mcp.example.test",
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

  const workspaceCatalog = repo.readWorkspaceCatalog();
  assert.equal(workspaceCatalog.status, "valid");
  const workspaces = workspaceCatalog.workspaces;
  assert.ok(workspaces.length > 0);
  assert.ok(workspaces.some((w) => w.id === "SimulatorLife/AutoDev"));

  const policy = repo.loadPermissionPolicy();
  assert.equal(policy.approvalPolicy, "never");
  assert.equal(policy.sandboxMode, "workspace-write");
});

test("ConfigRepository distinguishes missing and invalid workspace sources from an empty catalog", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-config-workspaces-")
  );
  const repository = new ConfigRepository(repositoryRoot);
  try {
    assert.deepEqual(repository.readWorkspaceCatalog(), {
      status: "unavailable",
      workspaces: []
    });

    const configDirectory = path.join(repositoryRoot, "config");
    await mkdir(configDirectory, { recursive: true });
    const catalogPath = path.join(configDirectory, "workspaces.json");
    await writeFile(
      catalogPath,
      JSON.stringify({ schema: "autodev-workspaces-v1", workspaces: [] }),
      "utf8"
    );
    assert.deepEqual(repository.readWorkspaceCatalog(), {
      status: "valid",
      workspaces: []
    });

    await writeFile(
      catalogPath,
      JSON.stringify({
        schema: "autodev-workspaces-v1",
        workspaces: [{ id: "SimulatorLife/AutoDev" }]
      }),
      "utf8"
    );
    assert.deepEqual(repository.readWorkspaceCatalog(), {
      status: "invalid",
      workspaces: []
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
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
      .skills.find((skill) => skill.name === input.name);
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
