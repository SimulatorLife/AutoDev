import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = JSON.parse(await readFile(new URL('../.github/workflows/weights.json', import.meta.url), 'utf8'));
const expectedRepositories = new Set([
  'SimulatorLife/3DSpider',
  'SimulatorLife/AutoDev',
  'SimulatorLife/Colourful-Life',
  'SimulatorLife/GMLoop',
  'SimulatorLife/RacingGame',
]);

test('routing inventory includes every current SimulatorLife repository', () => {
  assert.deepEqual(new Set(config.repositories.map((repository) => repository.name)), expectedRepositories);
});

test('repository base branches are explicit', () => {
  for (const repository of config.repositories) {
    assert.match(repository.baseBranch, /^[A-Za-z0-9._/-]+$/u, repository.name);
  }
  assert.equal(config.repositories.find((repository) => repository.name === 'SimulatorLife/Colourful-Life')?.baseBranch, 'master');
});
