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
  const playtestServer = servers.playtest as Record<string, unknown>;
  const playtestEnvVars = playtestServer.env_vars;
  assert.ok(Array.isArray(playtestEnvVars));
  assert.equal(
    playtestEnvVars.includes("AUTODEV_PLAYTEST_CONTROL_API_TOKEN"),
    false,
    "the Playtest MCP resolves its runner token from protected CODEX_HOME secrets, not child env"
  );
  const playtestTools = getEnabledTools(servers, "playtest");
  assert.deepEqual(
    [...playtestTools].sort(),
    [
      "playtest.activeRuns",
      "playtest.cancel",
      "playtest.capabilities",
      "playtest.listEpisodes",
      "playtest.lookupRequest",
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
    "playtest.prepareReview",
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
  assert.equal(
    analystTools?.view_image,
    undefined,
    "the installed Codex schema has no tools.view_image setting"
  );
  const analystFeatures = analystRole.features as Record<string, unknown>;
  assert.equal(analystFeatures.shell_tool, false);
  assert.equal(analystFeatures.multi_agent, false);
  assert.equal(analystFeatures.multi_agent_v2, false);
  const analystShellPolicy = analystRole.shell_environment_policy as
    Record<string, unknown> | undefined;
  assert.equal(analystShellPolicy?.inherit, "none");
  assert.equal(analystShellPolicy?.ignore_default_excludes, false);

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

  // analyst has only evidence reading, bounded packet preparation,
  // metrics/compare, per-session reviews, and cited batch synthesis:
  assert.equal(isServerEnabled(analystServers, "playtest"), true);
  const analystPlaytestServer = analystServers.playtest as Record<
    string,
    unknown
  >;
  const analystEnvironmentVariables = analystPlaytestServer.env_vars;
  assert.ok(Array.isArray(analystEnvironmentVariables));
  assert.equal(
    new Set(analystEnvironmentVariables).size,
    analystEnvironmentVariables.length,
    "analyst MCP environment allowlist must not contain duplicate variables"
  );
  for (const controlApiVariable of [
    "AUTODEV_CONTROL_API_BASE_URL",
    "AUTODEV_PLAYTEST_CONTROL_API_TOKEN",
    "AUTODEV_PLAYTEST_CONTROL_API_ACTOR",
    "AUTODEV_PLAYTEST_CONTROL_API_ROLE"
  ]) {
    assert.ok(
      !analystEnvironmentVariables.includes(controlApiVariable),
      `analyst MCP must not receive ${controlApiVariable}`
    );
  }
  assert.ok(
    !analystEnvironmentVariables.includes("AUTODEV_OPENLIT_USAGE_TOKEN")
  );
  const analystPlugins = analystRole.plugins as Record<string, unknown>;
  assert.equal(
    (
      analystPlugins["codex-app-tools@openai-bundled"] as Record<
        string,
        unknown
      >
    ).enabled,
    false
  );
  const analystPlaytestTools = getEnabledTools(analystServers, "playtest");
  assert.deepEqual(
    [...analystPlaytestTools].sort(),
    [
      "playtest.compare",
      "playtest.listEpisodes",
      "playtest.metrics",
      "playtest.prepareReview",
      "playtest.readEpisode",
      "playtest.readWindow",
      "playtest.submitReview",
      "playtest.submitCrossSessionSynthesis"
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
  assert.match(prompt, /fix this code so the build passes/);
  assert.match(prompt, /analyze why the player was confused/);
  assert.match(prompt, /file a GitHub issue for this bug/);

  // Safety boundaries:
  assert.match(prompt, /source-code read-only/i);
  assert.match(prompt, /Do not critique your own gameplay/i);
  assert.match(prompt, /Do not open, comment on, or write GitHub issues/i);
});

test("playtest-analyst prompt requires smart tier isolation, workspace gate, and 10 report sections", () => {
  const prompt = readText("agents/prompts/roles/playtest-analyst.md");

  // Tool calls must use the role's actual code-mode surface, not assume
  // dotted MCP operation labels are top-level provider functions.
  assert.match(prompt, /AutoDev Code Mode/u);
  assert.match(prompt, /tools\.mcp__<server>__<tool>/u);
  assert.match(prompt, /not direct top-level provider functions/u);

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

  assert.match(
    prompt,
    /current `submitReview` input accepts no model-authored numeric dimension score/u
  );
  assert.match(prompt, /P1.5 visual discovery reviews are hypothesis-only/u);

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

  // Tool calls must use the runtime's code-mode MCP surface.
  assert.match(skillText, /## AutoDev tool invocation/u);
  assert.match(skillText, /tools\.mcp__<server>__<tool>/u);
  assert.match(skillText, /not direct top-level provider functions/u);

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
  assert.match(skillText, /playtest\.prepareReview/);
  assert.match(skillText, /packet is the citation boundary/i);
  assert.match(
    skillText,
    /Runtime-supplied selected-session metric aggregation/i
  );
  assert.match(skillText, /not a matched-seed effect/i);
  assert.match(
    skillText,
    /Required top-level inputs are.*episodeId.*packetId.*packetArtifactId.*packetSha256/s
  );
  assert.match(
    skillText,
    /Each observation and interpretation is exactly.*text, evidenceRefs/s
  );
  assert.match(
    skillText,
    /P1.5 visual discovery reviews, do not score dimensions/u
  );
  assert.match(skillText, /not a model-authored numeric score/u);
  assert.match(skillText, /reportCompleteness.*exactly.*four keys/s);
  assert.match(skillText, /crossSessionContext.*whole-episode locators/s);
  assert.match(skillText, /none-identified/);
  assert.match(skillText, /none-recommended/);
  assert.match(skillText, /findings.*identity\.mechanicKey/s);

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

test("playtester prompt separates autonomous-visual and adapter-accelerated identity, preflight, and DTO", () => {
  const prompt = readText("agents/prompts/roles/playtester.md");

  // The prompt must declare both modes by canonical name and forbid silent fallback.
  assert.match(prompt, /`autonomous-visual`/u);
  assert.match(prompt, /`adapter-accelerated`/u);
  assert.match(prompt, /never (?:falls back|collapse|covert)/iu);
  assert.match(prompt, /typed refusal/u);

  // Operator authorization gate is explicit; "this task" is not authorization.
  assert.match(
    prompt,
    /explicit exact operator approval/u,
    "playtester prompt must require explicit exact operator approval"
  );
  assert.match(prompt, /operator authorization/u);

  // Visual preflight must confirm capabilityRevision + target identity + readiness.
  assert.match(
    prompt,
    /capabilityRevision/u,
    "playtester prompt must mention capabilityRevision"
  );
  assert.match(prompt, /targetId/u);
  assert.match(prompt, /targetRevision/u);
  assert.match(prompt, /approvalId/u);
  assert.match(prompt, /`origin`/u);
  assert.match(prompt, /capabilityRevision/u);
  assert.match(prompt, /`smart-direct`/u);
  assert.match(
    prompt,
    /typed blocker[\s\S]{0,80}`ready`|ready[\s\S]{0,200}typed blocker/is,
    "playtester prompt must cite a typed blocker state with a readiness check"
  );

  // Visual DTO uses the versioned schema, explicit mode, and the seven limits.
  assert.match(prompt, /autodev-playtest-launch-v1/u);
  assert.match(prompt, /`areasOfFocus`/u);
  for (const limit of [
    "episodeCount",
    "maxStepsPerEpisode",
    "wallTimeMs",
    "smartRequestsPerEpisode",
    "smartTokensPerEpisode",
    "screenshotCountPerEpisode",
    "artifactBytesPerEpisode"
  ]) {
    assert.match(
      prompt,
      new RegExp(limit, "u"),
      `playtester prompt missing visual limit: ${limit}`
    );
  }

  // URL-only visual must stay Build unknown / Commit not applicable and never
  // inherit *any* game checkout's HEAD; in particular not RacingGame/HEAD.
  assert.match(prompt, /Build unknown/u);
  assert.match(prompt, /Commit not applicable/u);
  assert.match(
    prompt,
    /never inherit.{0,40}(?:HEAD|checkout)/iu,
    "playtester prompt must forbid inheriting any checkout HEAD"
  );

  // The prompt must refuse not-ready/unsupported visual rather than fall back
  // to adapter-accelerated or scripted-regression.
  assert.match(
    prompt,
    /not-ready.{0,200}typed refusal/is,
    "playtester prompt must treat not-ready visual as a typed refusal"
  );
  assert.match(
    prompt,
    /typed refusal.{0,200}adapter-accelerated.{0,200}scripted-regression/is,
    "playtester prompt must refuse fallback to adapter/scripted"
  );

  // No-fabrication rule must cover scenario/seed/cohort/build SHA/approval/origin/budget.
  assert.match(
    prompt,
    /Never fabricate[\s\S]{0,200}scenario[\s\S]{0,40}seed[\s\S]{0,40}cohort[\s\S]{0,40}build SHA[\s\S]{0,80}(?:target approval|approval)[\s\S]{0,40}origin[\s\S]{0,120}request budget/is,
    "playtester prompt must forbid fabricating scenario/seed/cohort/build SHA/approval/origin/budget"
  );

  // Mode-specific launch fields must never cross-contaminate.
  assert.match(
    prompt,
    /never cross-contaminate|never carry .{0,40}scenario/u,
    "playtester prompt must forbid visual DTO from carrying scenario/seed/repo/build SHA"
  );

  // Analysis stays separate: playtester reads traces; operator triggers
  // analysis in Console; playtest-analyst reviews independently.
  assert.match(
    prompt,
    /Analysis is separate/u,
    "playtester prompt must separate execution from analysis"
  );
  assert.match(prompt, /`playtest-analyst` independently/u);

  // Same-request idempotency/recovery rules survive the mode split.
  assert.match(prompt, /[Ss]ame-request idempotency/u);
  assert.match(prompt, /never mint a new ID/u);
});

test("playtester prompt never leaks an adapter build-SHA requirement into URL-only visual", () => {
  const prompt = readText("agents/prompts/roles/playtester.md");

  // The adapter-accelerated gate and the autonomous-visual gate must be
  // articulated as two separate gates; only one of them uses a build SHA.
  // The adapter-accelerated gate identifies the approved build SHA.
  assert.match(
    prompt,
    /`adapter-accelerated`[\s\S]{0,400}approved committed checkout build SHA/u
  );
  // The autonomous-visual gate explicitly says no build SHA.
  assert.match(
    prompt,
    /`autonomous-visual`[\s\S]{0,400}(?:not|never)[\s\S]{0,200}build SHA/u
  );

  // The visual DTO must never appear with adapter-only fields inside it.
  assert.match(
    prompt,
    /visual DTO[\s\S]{0,400}?scenario[\s\S]{0,200}?seed[\s\S]{0,200}?build SHA/u,
    "visual DTO must never carry scenario/seed/build SHA"
  );

  // The visual gate must include "Build unknown / Commit not applicable"
  // verbatim and explicitly say it does not inherit this AutoDev checkout.
  assert.match(prompt, /`?Build unknown \/ Commit not applicable`?/u);
  assert.match(
    prompt,
    /never inherit this AutoDev checkout/u,
    "visual gate must forbid inheriting this AutoDev checkout"
  );

  // Section 1 of the explicit evidence/report format must show both modes
  // with mode-specific identity and explicitly mark URL-only as Build unknown.
  assert.match(
    prompt,
    /1\. Workspace & build authorization[\s\S]{0,800}Build unknown/u,
    "report-format section 1 must include Build unknown for URL-only visual"
  );
});

test("game-playtesting skill separates autonomous-visual and adapter-accelerated identity, preflight, and DTO", () => {
  const skillText = readText(".rulesync/skills/game-playtesting/SKILL.md");

  // Header section that names both modes and forbids silent fallback.
  assert.match(skillText, /^## Mode separation(?: |\b|$)/mu);
  assert.match(
    skillText,
    /`autonomous-visual`[\s\S]{0,100}`adapter-accelerated`[\s\S]{0,100}`scripted-regression`/u
  );
  assert.match(
    skillText,
    /never (?:falls back|collapse|covert|retried) across modes?/iu
  );
  assert.match(
    skillText,
    /typed refusal/u,
    "skill must treat unavailable visual as a typed refusal"
  );

  // Visual preflight: capabilityRevision + target ID/revision/approval/origin
  // + permitted inputs + per-episode ceilings + smart-direct readiness.
  assert.match(skillText, /capabilityRevision/u);
  assert.match(skillText, /targetId/u);
  assert.match(skillText, /targetRevision/u);
  assert.match(skillText, /approvalId/u);
  assert.match(skillText, /origin/u);
  assert.match(skillText, /`smart-direct`/u);
  assert.match(skillText, /readiness/u);

  // Visual DTO uses the seven limits and the verbatim areasOfFocus.
  for (const limit of [
    "episodeCount",
    "maxStepsPerEpisode",
    "wallTimeMs",
    "smartRequestsPerEpisode",
    "smartTokensPerEpisode",
    "screenshotCountPerEpisode",
    "artifactBytesPerEpisode"
  ]) {
    assert.match(
      skillText,
      new RegExp(limit, "u"),
      `skill missing visual limit: ${limit}`
    );
  }
  assert.match(skillText, /areasOfFocus/u);

  // No-fabrication rule covers scenario/seed/cohort/build SHA/approval/origin/budget.
  assert.match(
    skillText,
    /Never fabricate[\s\S]{0,200}scenario[\s\S]{0,40}seed[\s\S]{0,40}build SHA/u,
    "skill must forbid fabricating scenario/seed/build SHA"
  );

  // Same-request idempotency/recovery rules survive the mode split.
  assert.match(
    skillText,
    /[Ss]ame-request idempotency|[Ss]ame.{0,10}request idempotency/u
  );
  assert.match(skillText, /re-submit the exact stored payload/u);

  // Operator authorization gate: this task is not authorization.
  assert.match(
    skillText,
    /explicit exact operator (?:approval|authorization)/iu,
    "skill must require explicit exact operator approval/authorization"
  );
  assert.match(skillText, /merely because this task asked for code/u);

  // Analysis remains separate and is dispatched through Console by operator.
  assert.match(skillText, /Analysis stays separate/u);
  assert.match(skillText, /`playtest-analyst` independently/u);

  // Existing required strings still appear.
  assert.match(skillText, /## Workspace and build authorization gate/u);
  assert.match(skillText, /workspace enablement alone is not run approval/iu);
  assert.match(skillText, /### Negative trigger examples/u);
  assert.match(skillText, /"fix this code so the build passes"/u);
  assert.match(skillText, /"analyze this existing trace"/u);
  assert.match(skillText, /"score the difficulty curve"/u);
  assert.match(skillText, /"file a GitHub issue for this bug"/u);
  assert.match(skillText, /## Explicit evidence\/report format/u);
  assert.match(skillText, /Workspace & build authorization/u);
  assert.match(skillText, /Authoritative trace & evidence locators/u);
  assert.match(skillText, /Observed anomalies & failures/u);
});

test("game-playtesting skill never leaks an adapter build-SHA requirement into URL-only visual", () => {
  const skillText = readText(".rulesync/skills/game-playtesting/SKILL.md");

  // The Workspace and build authorization gate section must split the two
  // modes and only use build SHA for adapter-accelerated.
  assert.match(skillText, /Adapter-accelerated runs?:[\s\S]{0,400}build SHA/u);
  assert.match(
    skillText,
    /Autonomous-visual runs?:[\s\S]{0,400}never[\s\S]{0,200}build SHA/u
  );

  // URL-only must stay Build unknown / Commit not applicable and explicitly
  // must not inherit this AutoDev checkout's HEAD.
  assert.match(skillText, /Build unknown \/ Commit not applicable/u);
  assert.match(
    skillText,
    /never inherit this AutoDev checkout's HEAD/u,
    "skill must forbid inheriting this AutoDev checkout's HEAD"
  );

  // The visual DTO must never carry adapter-only fields.
  assert.match(
    skillText,
    /visual DTO never carries scenario\/seed\/repository\/build SHA/u
  );

  // The visual-assignment/RunConfiguration section must enumerate the seven
  // approved ceilings verbatim.
  for (const limit of [
    "episodeCount",
    "maxStepsPerEpisode",
    "wallTimeMs",
    "smartRequestsPerEpisode",
    "smartTokensPerEpisode",
    "screenshotCountPerEpisode",
    "artifactBytesPerEpisode"
  ]) {
    assert.match(
      skillText,
      new RegExp(limit, "u"),
      `skill explicit evidence section missing limit: ${limit}`
    );
  }
});

test("playtester visual mode is not blocked by stale adapter-only or pre-driver wording", () => {
  const prompt = readText("agents/prompts/roles/playtester.md");
  const skillText = readText(".rulesync/skills/game-playtesting/SKILL.md");

  for (const text of [prompt, skillText]) {
    assert.match(
      text,
      /modeReadiness\["autonomous-visual"\]\.status\s*=\s*ready/u
    );
    assert.match(text, /visual mode does not require an adapter/iu);
    assert.match(
      text,
      /never fall back|never a fallback|never retry visual as adapter/iu
    );
    assert.doesNotMatch(
      text,
      /bounded playtester role may use only mode:\s*["']adapter-accelerated["']/iu
    );
    assert.doesNotMatch(
      text,
      /visual and scripted launch requests remain typed, but Runtime refuses/iu
    );
    assert.doesNotMatch(
      text,
      /visual\/screenshot capture is optional and adapter-gated/iu
    );
  }
});
