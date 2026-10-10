import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "smol-toml";

const repositoryRoot = new URL("../", import.meta.url);

function readToml(relativePath: string): Record<string, unknown> {
  const text = readFileSync(new URL(relativePath, repositoryRoot), "utf8");
  return parse(text) as Record<string, unknown>;
}

function readText(relativePath: string): string {
  return readFileSync(new URL(relativePath, repositoryRoot), "utf8");
}

function getMcpServers(role: Record<string, unknown>): Record<string, unknown> {
  const servers = role.mcp_servers;
  assert.ok(
    servers && typeof servers === "object" && !Array.isArray(servers),
    "role must declare [mcp_servers.*]"
  );
  return servers as Record<string, unknown>;
}

function isServerEnabled(
  servers: Record<string, unknown>,
  name: string
): boolean {
  const server = servers[name];
  if (!server || typeof server !== "object") return false;
  return (server as Record<string, unknown>).enabled === true;
}

function getEnabledTools(
  servers: Record<string, unknown>,
  name: string
): string[] {
  const server = servers[name];
  assert.ok(
    server && typeof server === "object",
    `[mcp_servers.${name}] must be present`
  );
  const tools = (server as Record<string, unknown>).enabled_tools;
  assert.ok(
    Array.isArray(tools),
    `[mcp_servers.${name}].enabled_tools must be an array`
  );
  return tools as string[];
}

function isSkillEnabled(
  role: Record<string, unknown>,
  skillName: string
): boolean | undefined {
  const skills = role.skills as
    { config?: Array<Record<string, unknown>> } | undefined;
  const entry = skills?.config?.find((cfg) => cfg.name === skillName);
  return entry?.enabled as boolean | undefined;
}

const CODE_WRITE_OR_DELEGATION_SERVERS = [
  "lsp",
  "cocoindex-code",
  "codegraphcontext",
  "playwright",
  "context7",
  "autodev_spawn",
  "codex_app"
];

test("playtester role enforces read-only sandbox and approved run/read tool subset", () => {
  const role = readToml("agents/roles/playtester.toml");
  assert.equal(role.name, "playtester");
  assert.equal(role.sandbox_mode, "read-only");
  assert.notEqual(role.sandbox_mode, "danger-full-access");

  const servers = getMcpServers(role);
  for (const serverName of CODE_WRITE_OR_DELEGATION_SERVERS) {
    assert.equal(
      isServerEnabled(servers, serverName),
      false,
      `playtester must disable [mcp_servers.${serverName}]`
    );
  }

  assert.equal(isServerEnabled(servers, "playtest"), true);
  const playtestTools = getEnabledTools(servers, "playtest");
  assert.deepEqual(
    [...playtestTools].sort(),
    [
      "playtest.activeRuns",
      "playtest.cancel",
      "playtest.capabilities",
      "playtest.listEpisodes",
      "playtest.readEpisode",
      "playtest.readWindow",
      "playtest.run",
      "playtest.wait"
    ].sort()
  );

  // Forbidden tools for playtester:
  for (const forbidden of [
    "playtest.metrics",
    "playtest.compare",
    "playtest.submitReview",
    "playtest.branch",
    "playtest.findings"
  ]) {
    assert.equal(
      playtestTools.includes(forbidden),
      false,
      `playtester must not have tool: ${forbidden}`
    );
  }

  const tools = role.tools as Record<string, unknown> | undefined;
  assert.equal(tools?.web_search, false);
  assert.equal(isSkillEnabled(role, "orchestration"), false);
  assert.equal(isSkillEnabled(role, "game-playtesting"), true);
});

test("playtest-analyst reuses autodev/smart model tier without inheriting smart permissions", () => {
  const analystRole = readToml("agents/roles/playtest-analyst.toml");
  const smartRole = readToml("agents/roles/smart.toml");

  // Both use the smart model route:
  assert.equal(analystRole.model, "autodev/smart");
  assert.equal(smartRole.model, "autodev/smart");

  // smart role has danger-full-access sandbox; analyst MUST be read-only:
  assert.equal(smartRole.sandbox_mode, "danger-full-access");
  assert.equal(analystRole.sandbox_mode, "read-only");

  // smart role has web_search enabled; analyst MUST disable it:
  const smartTools = smartRole.tools as Record<string, unknown> | undefined;
  const analystTools = analystRole.tools as Record<string, unknown> | undefined;
  assert.equal(smartTools?.web_search, true);
  assert.equal(analystTools?.web_search, false);

  // smart role has lsp, playwright, cocoindex, codegraphcontext enabled:
  const smartServers = getMcpServers(smartRole);
  assert.equal(isServerEnabled(smartServers, "lsp"), true);
  assert.equal(isServerEnabled(smartServers, "playwright"), true);
  assert.equal(isServerEnabled(smartServers, "cocoindex-code"), true);
  assert.equal(isServerEnabled(smartServers, "codegraphcontext"), true);

  // analyst role MUST disable all code-editing, browser, and search servers:
  const analystServers = getMcpServers(analystRole);
  for (const serverName of CODE_WRITE_OR_DELEGATION_SERVERS) {
    assert.equal(
      isServerEnabled(analystServers, serverName),
      false,
      `playtest-analyst must disable [mcp_servers.${serverName}]`
    );
  }

  // analyst has only evidence reading, metrics/compare, and submitReview:
  assert.equal(isServerEnabled(analystServers, "playtest"), true);
  const analystPlaytestTools = getEnabledTools(analystServers, "playtest");
  assert.deepEqual(
    [...analystPlaytestTools].sort(),
    [
      "playtest.compare",
      "playtest.listEpisodes",
      "playtest.metrics",
      "playtest.readEpisode",
      "playtest.readWindow",
      "playtest.submitReview"
    ].sort()
  );

  // Forbidden tools for playtest-analyst:
  for (const forbidden of [
    "playtest.run",
    "playtest.branch",
    "playtest.capabilities",
    "playtest.findings"
  ]) {
    assert.equal(
      analystPlaytestTools.includes(forbidden),
      false,
      `playtest-analyst must not have tool: ${forbidden}`
    );
  }

  assert.equal(isSkillEnabled(analystRole, "orchestration"), false);
  assert.equal(isSkillEnabled(analystRole, "playtest-analysis"), true);
});

test("playtester prompt requires exact authorized workspace/build gate and explicit report format", () => {
  const prompt = readText("agents/prompts/roles/playtester.md");

  // Workspace and build gate:
  assert.match(
    prompt,
    /authorized workspace and build gate/i,
    "playtester prompt must mention authorized workspace and build gate"
  );
  assert.match(
    prompt,
    /workspace enablement alone is not run approval/i,
    "playtester prompt must state workspace enablement alone is not run approval"
  );
  assert.match(
    prompt,
    /approved (?:checkout\/)?build SHA/i,
    "playtester prompt must check approved build SHA"
  );

  // Explicit evidence/report format:
  assert.match(
    prompt,
    /explicit evidence and report format/i,
    "playtester prompt must define explicit evidence/report format"
  );
  assert.match(prompt, /Workspace & build authorization/i);
  assert.match(prompt, /Run configuration/i);
  assert.match(prompt, /Execution outcome/i);
  assert.match(prompt, /Authoritative evidence locators/i);
  assert.match(prompt, /Observed anomalies and failures/i);
  assert.match(prompt, /Evidence handoff/i);

  // Negative trigger examples:
  assert.match(prompt, /Negative triggers/i);
  assert.match(prompt, /"fix this code so the build passes"/);
  assert.match(prompt, /"analyze why the player was confused"/);
  assert.match(prompt, /"file a GitHub issue for this bug"/);

  // Safety boundaries:
  assert.match(prompt, /source-code read-only/i);
  assert.match(prompt, /Do not critique your own gameplay/i);
  assert.match(prompt, /Do not open, comment on, or write GitHub issues/i);
});

test("playtest-analyst prompt requires smart tier isolation, workspace gate, and 10 report sections", () => {
  const prompt = readText("agents/prompts/roles/playtest-analyst.md");

  // Smart model tier without smart permissions:
  assert.match(
    prompt,
    /autodev\/smart/i,
    "analyst prompt must mention autodev/smart model tier"
  );
  assert.match(
    prompt,
    /without inheriting smart role permissions/i,
    "analyst prompt must specify not inheriting smart role permissions"
  );

  // Workspace and build gate:
  assert.match(
    prompt,
    /authorized workspace and build gate/i,
    "analyst prompt must mention authorized workspace and build gate"
  );
  assert.match(
    prompt,
    /Reject cross-workspace data access/i,
    "analyst prompt must reject cross-workspace data"
  );

  // Explicit evidence/report format (10 sections per docs/playtesting-target-state.md §6):
  for (const section of [
    "Provenance and coverage",
    "Chronological episode summary",
    "Authoritative metrics",
    "Scored experience dimensions",
    "Evidence-linked observations",
    "Alternative explanations",
    "Cross-session context",
    "Testable hypotheses",
    "Evidence-status decision",
    "Suggested follow-up"
  ]) {
    assert.match(
      prompt,
      new RegExp(section, "i"),
      `analyst prompt missing section: ${section}`
    );
  }

  // Negative trigger examples:
  assert.match(prompt, /Negative triggers/i);
  assert.match(prompt, /"play ten episodes of the target game"/);
  assert.match(prompt, /"fix this code so the build passes"/);

  // Safety boundaries:
  assert.match(prompt, /read-only for source code and for gameplay/i);
  assert.match(prompt, /never run, branch, or extend gameplay/i);
  assert.match(prompt, /Do not create, comment on, or close a GitHub issue/i);
});

test("game-playtesting skill enforces workspace gate, explicit report format, and negative triggers", () => {
  const skillText = readText(".rulesync/skills/game-playtesting/SKILL.md");

  // Authorized workspace/build gate:
  assert.match(
    skillText,
    /## Workspace and build authorization gate/i,
    "skill must include workspace authorization section"
  );
  assert.match(
    skillText,
    /workspace enablement alone is not run approval/i,
    "skill must state workspace enablement alone is not run approval"
  );

  // Negative trigger examples:
  assert.match(skillText, /### Negative trigger examples/i);
  assert.match(skillText, /"fix this code so the build passes"/);
  assert.match(skillText, /"analyze this existing trace"/);
  assert.match(skillText, /"score the difficulty curve"/);
  assert.match(skillText, /"file a GitHub issue for this bug"/);

  // Explicit evidence/report format:
  assert.match(skillText, /## Explicit evidence\/report format/i);
  assert.match(skillText, /Workspace & build authorization/i);
  assert.match(skillText, /Authoritative trace & evidence locators/i);
  assert.match(skillText, /Observed anomalies & failures/i);
});

test("playtest-analysis skill enforces workspace gate, negative triggers, and null-safe scoring", () => {
  const skillText = readText(".rulesync/skills/playtest-analysis/SKILL.md");

  // Authorized workspace/build gate:
  assert.match(
    skillText,
    /## Workspace and build authorization gate/i,
    "skill must include workspace authorization section"
  );
  assert.match(
    skillText,
    /Reject cross-workspace data access/i,
    "skill must reject cross-workspace data access"
  );

  // Negative trigger examples:
  assert.match(skillText, /### Negative trigger examples/i);
  assert.match(skillText, /"play ten episodes of the target game"/);
  assert.match(skillText, /"run a playtest batch"/);
  assert.match(skillText, /"fix this code so the build passes"/);
  assert.match(skillText, /"file a GitHub issue for this bug"/);

  // References exist and are linked:
  assert.ok(
    existsSync(
      new URL(
        ".rulesync/skills/playtest-analysis/references/session-review.md",
        repositoryRoot
      )
    )
  );
  assert.ok(
    existsSync(
      new URL(
        ".rulesync/skills/playtest-analysis/references/scoring.md",
        repositoryRoot
      )
    )
  );
  assert.ok(
    existsSync(
      new URL(
        ".rulesync/skills/playtest-analysis/references/comparisons.md",
        repositoryRoot
      )
    )
  );
  assert.ok(
    existsSync(
      new URL(
        ".rulesync/skills/playtest-analysis/references/human-validation.md",
        repositoryRoot
      )
    )
  );
});
