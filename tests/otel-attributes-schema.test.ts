import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schemaPath = join(repositoryRoot, 'tests/fixtures/otel/autodev-attributes-schema.json');
const existingFixturePath = join(repositoryRoot, 'tests/fixtures/otel/collector-forwarded-otlp.json');
const expectedKeys = [
  'autodev.role', 'autodev.workspace', 'autodev.provider', 'autodev.model',
  'autodev.spawn.mechanism', 'autodev.skill', 'autodev.mcp.server',
] as const;
const expectedScope: Record<string, 'resource' | 'event'> = {
  'autodev.role': 'resource', 'autodev.workspace': 'resource', 'autodev.provider': 'resource', 'autodev.model': 'resource',
  'autodev.spawn.mechanism': 'event', 'autodev.skill': 'event', 'autodev.mcp.server': 'event',
};
const validSignals = new Set(['logs', 'traces', 'metrics']);
const existingKeys = new Set([
  'service.name', 'service.version', 'mcp_servers', 'event.name', 'conversation.id', 'model', 'prompt_length', 'prompt_text',
  'duration_ms', 'tool', 'tool_origin', 'call_id', 'status', 'event.kind', 'input_token_count', 'output_token_count',
  'cached_token_count', 'reasoning_token_count', 'tool_token_count', 'server_name', 'error.type', 'workspace_id', 'source',
  'skill', 'invoke_type', 'hook_name', 'handler_type',
]);

function readJson(path: string): JsonObject { return JSON.parse(readFileSync(path, 'utf8')) as JsonObject; }
function object(value: Json | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected JSON object');
  return value;
}
function array(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) throw new Error('expected JSON array');
  return value;
}
function attributeEntries(value: Json | undefined): JsonObject[] { return array(value).map((entry) => object(entry)); }
function attributeKeys(value: Json): string[] {
  if (Array.isArray(value)) return value.flatMap(attributeKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === 'key' && typeof child === 'string' ? [child] : []),
    ...attributeKeys(child),
  ]);
}

const schema = readJson(schemaPath);
const attributes = attributeEntries(schema.attributes);
const byKey = Object.fromEntries(attributes.map((entry) => [String(entry.key), entry]));

test('AutoDev attribute schema file exists and is valid JSON', () => {
  assert.equal(existsSync(schemaPath), true);
  assert.equal(typeof schema, 'object');
});

test('AutoDev attribute schema metadata and exact keys are pinned', () => {
  assert.equal(schema.schema_version, 'autodev-otel-attributes-v1');
  assert.equal(schema.namespace_prefix, 'autodev');
  assert.equal(schema.compatibility, 'additive-optional');
  assert.equal(schema.emission, 'opt-in');
  assert.deepEqual(Object.keys(byKey), [...expectedKeys]);
  assert.equal(new Set(Object.keys(byKey)).size, attributes.length);
});

test('AutoDev attributes have typed, scoped, optional, additive definitions', () => {
  for (const key of expectedKeys) {
    const entry = byKey[key];
    assert.ok(entry, key);
    assert.equal(key.startsWith('autodev.'), true);
    assert.equal(entry.prefix, 'autodev');
    assert.equal(entry.type, 'string');
    assert.equal(entry.cardinality, 'single');
    assert.equal(entry.scope, expectedScope[key]);
    assert.equal(entry.optional, true);
    assert.equal(entry.compatibility, 'additive');
    assert.equal(entry.prompt_content, false);
    assert.equal(typeof entry.description, 'string');
    assert.ok(String(entry.description).trim());
    const signals = array(entry.signals).map(String);
    assert.ok(signals.length > 0);
    assert.equal(signals.every((signal) => validSignals.has(signal)), true);
    assert.equal(new Set(signals).size, signals.length);
  }
  assert.deepEqual(Object.keys(byKey).filter((key) => byKey[key]?.scope === 'resource').sort(), ['autodev.model', 'autodev.provider', 'autodev.role', 'autodev.workspace']);
  assert.deepEqual(Object.keys(byKey).filter((key) => byKey[key]?.scope === 'event').sort(), ['autodev.mcp.server', 'autodev.skill', 'autodev.spawn.mechanism']);
});

test('AutoDev attribute names do not collide with existing unprefixed keys', () => {
  assert.deepEqual(Object.keys(byKey).filter((key) => existingKeys.has(key)), []);
});

test('existing Collector-forwarded fixture remains free of AutoDev attributes', () => {
  assert.equal(existsSync(existingFixturePath), true);
  assert.deepEqual(attributeKeys(readJson(existingFixturePath)).filter((key) => key === 'autodev' || key.startsWith('autodev.')), []);
});
