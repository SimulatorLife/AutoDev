import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const TASK_CATEGORIES = new Set(["code", "merging", "regressions"]);
const WEIGHT_SCALE = 1000;

type WorkspaceWeight = { workspaceId: string; weight: number };
type Agent = { weight: number; category: string[] };
type Prompt = {
  category: string;
  promptRepository?: string;
  path: string;
  complexity: number;
  weight: number;
};
type WeightConfig = {
  repositories: WorkspaceWeight[];
  agents: Agent[];
  prompts: Prompt[];
  agentPools?: { followUps?: unknown };
};
type WorkspaceConfig = {
  schema: "autodev-workspaces-v1";
  workspaces: Array<{
    id: string;
    baseBranch: string;
    enabled: boolean;
    agentRoles: readonly string[] | null;
  }>;
};

const config = JSON.parse(
  await readFile(
    new URL("../.github/workflows/weights.json", import.meta.url),
    "utf8"
  )
) as WeightConfig;
const workspaceConfig = JSON.parse(
  await readFile(new URL("../config/workspaces.json", import.meta.url), "utf8")
) as WorkspaceConfig;

const COLLATOR = new Intl.Collator();

function toSlots(weight: number): number {
  return Math.max(1, Math.round(weight * WEIGHT_SCALE));
}

function weightedCycle(items: WorkspaceWeight[]): string[] {
  const sorted = [...items]
    .filter((item) => item.weight > 0)
    .sort((a, b) => COLLATOR.compare(a.workspaceId, b.workspaceId));
  const maxSlots = Math.max(...sorted.map((item) => toSlots(item.weight)), 0);
  const cycle: string[] = [];
  for (let slot = 1; slot <= maxSlots; slot += 1) {
    for (const item of sorted) {
      if (toSlots(item.weight) >= slot) cycle.push(item.workspaceId);
    }
  }
  return cycle;
}

test("scheduler weights reference the canonical workspace catalog exactly once", () => {
  assert.equal(workspaceConfig.schema, "autodev-workspaces-v1");
  const workspaceIds = new Set(
    workspaceConfig.workspaces.map((workspace) => workspace.id)
  );
  assert.equal(workspaceIds.size, workspaceConfig.workspaces.length);
  assert.ok(Array.isArray(config.repositories));
  assert.equal(config.repositories.length, workspaceConfig.workspaces.length);
  const scheduledIds = new Set<string>();
  for (const entry of config.repositories) {
    assert.match(entry.workspaceId, /^[^/\s]+\/[^/\s]+$/u);
    assert.equal(workspaceIds.has(entry.workspaceId), true);
    assert.equal(scheduledIds.has(entry.workspaceId), false);
    scheduledIds.add(entry.workspaceId);
    assert.equal(Number.isFinite(entry.weight), true);
    assert.ok(entry.weight >= 0);
  }
  assert.deepEqual(scheduledIds, workspaceIds);
});

test("workspace IDs participate in deterministic scheduler weighting", () => {
  const cycle = weightedCycle([
    { workspaceId: "SimulatorLife/low", weight: 0.001 },
    { workspaceId: "SimulatorLife/high", weight: 0.002 }
  ]);
  assert.deepEqual(cycle, [
    "SimulatorLife/high",
    "SimulatorLife/low",
    "SimulatorLife/high"
  ]);
});

test("existing scheduled policy remains structurally valid", () => {
  assert.ok(Array.isArray(config.agents) && config.agents.length > 0);
  assert.ok(Array.isArray(config.prompts) && config.prompts.length > 0);
  assert.ok(config.agentPools?.followUps);
  for (const agent of config.agents) {
    assert.equal(Number.isFinite(agent.weight), true);
    assert.ok(Array.isArray(agent.category) && agent.category.length > 0);
    for (const category of agent.category)
      assert.equal(TASK_CATEGORIES.has(category), true);
  }
  for (const prompt of config.prompts) {
    assert.equal(TASK_CATEGORIES.has(prompt.category), true);
    assert.equal(
      prompt.promptRepository ?? "SimulatorLife/AutoDev",
      "SimulatorLife/AutoDev"
    );
    assert.match(prompt.path, /^\.rulesync\/commands\/[^/]+\.md$/u);
    assert.ok(
      Number.isInteger(prompt.complexity) &&
        prompt.complexity >= 1 &&
        prompt.complexity <= 3
    );
    assert.equal(Number.isFinite(prompt.weight), true);
  }
});
