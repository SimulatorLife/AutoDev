import assert from "node:assert/strict";
import test from "node:test";

import {
  ClickHouseTelemetryClient,
  ConfigRepository,
  RuleSyncRepository
} from "../src/index.ts";

test("RuleSyncRepository loads canonical RuleSync sources", () => {
  const repo = new RuleSyncRepository();
  const commands = repo.loadCommands();
  assert.ok(commands.length > 0);
  assert.ok(commands.some((c) => c.name === "dry"));

  const hooks = repo.loadHooks();
  assert.ok(hooks.length > 0);
  assert.ok(hooks.some((h) => h.event === "sessionStart"));

  const skills = repo.loadSkills();
  assert.ok(skills.length > 0);
  assert.ok(skills.some((s) => s.name === "orchestration"));
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
