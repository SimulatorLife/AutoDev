import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Attribute = JsonObject;
type AttributeLocation = [string, Attribute[]];

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const schemaPath = join(
  repositoryRoot,
  "tests/fixtures/otel/autodev-attributes-schema.json"
);
const contractPath = join(
  repositoryRoot,
  "tests/fixtures/otel/autodev-attributes-emission-contract.json"
);
const existingFixturePath = join(
  repositoryRoot,
  "tests/fixtures/otel/collector-forwarded-otlp.json"
);
const expectedKeys = [
  "autodev.role",
  "autodev.workspace",
  "autodev.provider",
  "autodev.model",
  "autodev.spawn.mechanism",
  "autodev.skill",
  "autodev.mcp.server"
] as const;
const resourceKeys = new Set([
  "autodev.role",
  "autodev.workspace",
  "autodev.provider",
  "autodev.model"
]);
const eventKeys = new Set([
  "autodev.spawn.mechanism",
  "autodev.skill",
  "autodev.mcp.server"
]);

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}
function object(value: Json | undefined): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected JSON object");
  return value;
}
function array(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) throw new Error("expected JSON array");
  return value;
}
function attributes(value: Json | undefined): Attribute[] {
  return array(value).map((entry) => object(entry));
}
function attributeMap(entries: Attribute[]): Map<string, Json | undefined> {
  return new Map(entries.map((entry) => [String(entry.key), entry.value]));
}
function attributeLocations(value: Json, path = ""): AttributeLocation[] {
  if (Array.isArray(value))
    return value.flatMap((child, index) =>
      attributeLocations(child, `${path}[${index}]`)
    );
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const current = path ? `${path}.${key}` : key;
    return key === "attributes" && Array.isArray(child)
      ? ([[current, attributes(child)]] as AttributeLocation[])
      : attributeLocations(child, current);
  });
}
function signalLocations(
  container: JsonObject,
  signal: string
): Map<string, Attribute[]> {
  return new Map(attributeLocations(container[signal] ?? {}));
}
function addedKeys(before: Attribute[], after: Attribute[]): string[] {
  const beforeKeys = new Set(attributeMap(before).keys());
  return [...attributeMap(after).keys()].filter((key) => !beforeKeys.has(key));
}
function isResourceLocation(location: string): boolean {
  return (
    location.includes(".resource.") ||
    location.startsWith("resource.") ||
    location.endsWith(".resource.attributes") ||
    (location.includes("resourceLogs[") &&
      location.includes("resource.attributes")) ||
    (location.includes("resourceSpans[") &&
      location.includes("resource.attributes")) ||
    (location.includes("resourceMetrics[") &&
      location.includes("resource.attributes"))
  );
}
function stringified(value: Json | undefined): string {
  return JSON.stringify(value) ?? String(value);
}

const schema = readJson(schemaPath);
const contract = readJson(contractPath);
const crossReference = object(contract.schema_cross_reference);
const before = object(contract.before);
const after = object(contract.after);
const omission = object(object(contract.examples).unknown_optional_omitted);

test("emission contract metadata and ordered cross-references match the schema", () => {
  assert.equal(
    contract.contract_version,
    "autodev-otel-attributes-emission-v1"
  );
  assert.equal(contract.schema_version, schema.schema_version);
  assert.equal(contract.namespace_prefix, "autodev");
  assert.equal(contract.compatibility, "additive-optional");
  assert.equal(contract.emission, "opt-in");
  assert.equal(crossReference.schema_version, schema.schema_version);
  assert.equal(crossReference.namespace_prefix, "autodev");
  assert.equal(crossReference.compatibility, "additive-optional");
  assert.equal(crossReference.emission, "opt-in");
  const schemaKeys = attributes(schema.attributes).map((entry) =>
    String(entry.key)
  );
  assert.deepEqual(crossReference.ordered_keys, expectedKeys);
  assert.deepEqual(crossReference.ordered_keys, schemaKeys);
  assert.deepEqual(
    attributes(crossReference.mappings).map((entry) => String(entry.key)),
    expectedKeys
  );
});

test("emission scope and signal cross-references match the canonical schema", () => {
  const schemaEntries = attributes(schema.attributes);
  const schemaScope = Object.fromEntries(
    schemaEntries.map((entry) => [String(entry.key), entry.scope])
  );
  const schemaSignals = Object.fromEntries(
    schemaEntries.map((entry) => [String(entry.key), entry.signals])
  );
  assert.deepEqual(crossReference.scope_by_key, schemaScope);
  assert.deepEqual(crossReference.signals_by_key, schemaSignals);
  const mappings = attributes(crossReference.mappings);
  for (const [index, expectedKey] of expectedKeys.entries()) {
    assert.equal(mappings[index]?.scope, schemaScope[expectedKey!]);
    assert.deepEqual(mappings[index]?.signals, schemaSignals[expectedKey!]);
  }
});

test("before and after mappings preserve every signal, location, and existing value", () => {
  for (const signal of ["logs", "traces", "metrics"]) {
    const beforeLocations = signalLocations(before, signal);
    const afterLocations = signalLocations(after, signal);
    assert.deepEqual(
      [...afterLocations.keys()].sort(),
      [...beforeLocations.keys()].sort(),
      signal
    );
    for (const [location, beforeAttributes] of beforeLocations) {
      const afterAttributes = afterLocations.get(location);
      assert.ok(afterAttributes, `${signal}/${location}`);
      const afterMap = attributeMap(afterAttributes);
      for (const [key, value] of attributeMap(beforeAttributes)) {
        assert.equal(afterMap.has(key), true, `${signal}/${location}/${key}`);
        assert.deepEqual(
          afterMap.get(key),
          value,
          `${signal}/${location}/${key}`
        );
      }
    }
  }
});

test("only the frozen AutoDev keys are added by the after mapping", () => {
  const allAdded = new Set<string>();
  for (const signal of ["logs", "traces", "metrics"]) {
    const beforeLocations = signalLocations(before, signal);
    const afterLocations = signalLocations(after, signal);
    for (const [location, beforeAttributes] of beforeLocations) {
      const afterAttributes = afterLocations.get(location);
      assert.ok(afterAttributes);
      for (const key of addedKeys(beforeAttributes, afterAttributes)) {
        assert.equal(
          key.startsWith("autodev."),
          true,
          `${signal}/${location}/${key}`
        );
        assert.equal(
          (expectedKeys as readonly string[]).includes(key),
          true,
          key
        );
        allAdded.add(key);
      }
    }
  }
  assert.deepEqual([...allAdded].sort(), [...expectedKeys].sort());
});

test("resource and event AutoDev keys stay in their respective attribute scopes", () => {
  for (const signal of ["logs", "traces", "metrics"])
    for (const [location, entries] of signalLocations(after, signal)) {
      const map = attributeMap(entries);
      for (const key of resourceKeys)
        if (map.has(key))
          assert.equal(
            isResourceLocation(location),
            true,
            `${signal}/${location}/${key}`
          );
      for (const key of eventKeys)
        if (map.has(key))
          assert.equal(
            isResourceLocation(location),
            false,
            `${signal}/${location}/${key}`
          );
    }
});

test("unknown optional values produce no AutoDev keys", () => {
  for (const side of ["before", "after"] as const)
    for (const signal of ["logs", "traces", "metrics"]) {
      for (const [location, entries] of signalLocations(
        omission[side] as JsonObject,
        signal
      )) {
        const keys = [...attributeMap(entries).keys()].filter(
          (key) => key === "autodev" || key.startsWith("autodev.")
        );
        assert.deepEqual(keys, [], `${side}/${signal}/${location}`);
      }
    }
  for (const [location, entries] of signalLocations(after, "traces"))
    if (location.includes("spans[3]")) {
      assert.deepEqual(
        [...attributeMap(entries).keys()].filter((key) =>
          key.startsWith("autodev.")
        ),
        [],
        location
      );
    }
  for (const [location, entries] of signalLocations(after, "logs"))
    if (location.includes("logRecords[6]")) {
      assert.deepEqual(
        [...attributeMap(entries).keys()].filter((key) =>
          key.startsWith("autodev.")
        ),
        [],
        location
      );
    }
});

test("AutoDev attributes are categorical and never carry prompt content", () => {
  const secret = "do-not-store-this-collector-forwarded-secret";
  for (const signal of ["logs", "traces", "metrics"])
    for (const [location, entries] of signalLocations(after, signal)) {
      for (const [key, value] of attributeMap(entries))
        if (key.startsWith("autodev.")) {
          assert.equal(
            stringified(value).includes(secret),
            false,
            `${signal}/${location}/${key}`
          );
          assert.ok(
            stringified(value).length <= 64,
            `${signal}/${location}/${key}`
          );
        }
    }
  for (const [location, entries] of signalLocations(after, "logs"))
    if (location.includes("logRecords[1]")) {
      const map = attributeMap(entries);
      assert.deepEqual(map.get("event.name"), {
        stringValue: "codex.user_prompt"
      });
      assert.equal(map.has("prompt_text"), true);
      assert.equal(map.has("prompt_length"), true);
      assert.deepEqual(
        [...map.keys()].filter((key) => key.startsWith("autodev.")),
        [],
        location
      );
    }
});

test("runtime emission remains opt-in and the existing Collector fixture is undecorated", () => {
  assert.equal(contract.emission, "opt-in");
  assert.notEqual(contract.emission, "always-on");
  const runtime = object(contract.runtime_emission);
  assert.equal(runtime.flag, "AUTODEV_OTEL_ATTRIBUTES");
  assert.equal(runtime.version, "v1");
  assert.equal(runtime.default, false);
  assert.equal(runtime.mutates, false);
  assert.equal(runtime.helper, "autodevEnrichOtlpPayload");
  for (const [location, entries] of attributeLocations(
    readJson(existingFixturePath)
  )) {
    assert.deepEqual(
      [...attributeMap(entries).keys()].filter(
        (key) => key === "autodev" || key.startsWith("autodev.")
      ),
      [],
      location
    );
  }
});
