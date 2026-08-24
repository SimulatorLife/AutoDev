import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const TASK_CATEGORIES = new Set(['code', 'merging', 'regressions']);
const WEIGHT_SCALE = 1000;

const config = JSON.parse(await readFile(new URL('../.github/workflows/weights.json', import.meta.url), 'utf8'));

function toSlots(weight) {
  return Math.max(1, Math.round(weight * WEIGHT_SCALE));
}

function weightedCycle(items) {
  const sorted = [...items].filter((item) => item.weight > 0).sort((a, b) => a.name.localeCompare(b.name));
  const maxSlots = Math.max(...sorted.map((item) => toSlots(item.weight)), 0);
  const cycle = [];
  for (let slot = 1; slot <= maxSlots; slot += 1) {
    for (const item of sorted) {
      if (toSlots(item.weight) >= slot) cycle.push(item.name);
    }
  }
  return cycle;
}

test('weights define valid, unique organization repositories', () => {
  assert.ok(Array.isArray(config.repositories));
  assert.ok(config.repositories.length > 0);
  const names = new Set();
  for (const repository of config.repositories) {
    assert.match(repository.name, /^[^/\s]+\/[^/\s]+$/);
    assert.equal(names.has(repository.name), false);
    names.add(repository.name);
    assert.equal(Number.isFinite(repository.weight), true);
  }
});

test('repository weights participate in deterministic routing', () => {
  const cycle = weightedCycle([
    { name: 'SimulatorLife/low', weight: 0.001 },
    { name: 'SimulatorLife/high', weight: 0.002 },
  ]);
  assert.deepEqual(cycle, [
    'SimulatorLife/high',
    'SimulatorLife/low',
    'SimulatorLife/high',
  ]);
});

test('existing scheduled policy remains structurally valid', () => {
  assert.ok(Array.isArray(config.agents) && config.agents.length > 0);
  assert.ok(Array.isArray(config.prompts) && config.prompts.length > 0);
  assert.ok(config.agentPools?.followUps);
  for (const agent of config.agents) {
    assert.equal(Number.isFinite(agent.weight), true);
    assert.ok(Array.isArray(agent.category) && agent.category.length > 0);
    for (const category of agent.category) assert.equal(TASK_CATEGORIES.has(category), true);
  }
  for (const prompt of config.prompts) {
    assert.equal(TASK_CATEGORIES.has(prompt.category), true);
    assert.equal(prompt.scope, 'autodev');
    assert.match(prompt.path, /^\.agents\/prompts\/[^/]+\.md$/u);
    assert.ok(Number.isInteger(prompt.complexity) && prompt.complexity >= 1 && prompt.complexity <= 3);
    assert.equal(Number.isFinite(prompt.weight), true);
  }
});
