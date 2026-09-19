import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

type YamlScalar = string | number | boolean;
type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };
type Token = {
  indent: number;
  isList: boolean;
  key: string | null;
  value: string;
};
type CollectorAsset = { name: string; sha256: string };
type CollectorManifest = {
  schema: string;
  version: string;
  assets: Record<string, CollectorAsset>;
};

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const versionPath = join(repositoryRoot, "config/otel/collector.version");
const configPath = join(repositoryRoot, "config/otel/collector.yaml");
const artifactsPath = join(
  repositoryRoot,
  "config/otel/collector-artifacts.json"
);

const EXPECTED_VERSION = "v0.160.0";
const EXPECTED_RECEIVER_ENDPOINT = "127.0.0.1:4318";
const EXPECTED_EXPORTER_ENDPOINT = "http://127.0.0.1:4100";
const EXPECTED_EXPORTER_NAME = "otlp_http/autodev";
const EXPECTED_PIPELINES = ["traces", "metrics", "logs"] as const;
const UNSUPPORTED_TOP_LEVEL_SECTIONS = [
  "processors",
  "extensions",
  "connectors"
] as const;
const UNSUPPORTED_SERVICE_SECTIONS = ["extensions"] as const;

function parseScalar(value: string): YamlScalar {
  if (
    value.length >= 2 &&
    value[0] === value.at(-1) &&
    (value[0] === '"' || value[0] === "'")
  )
    return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && value !== "" ? parsed : value;
}

function parseInlineList(value: string): YamlValue[] {
  const inner = value.slice(1, -1).trim();
  return inner ? inner.split(",").map((item) => parseScalar(item.trim())) : [];
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const rawLine of text.split("\n")) {
    const commentIndex = rawLine.indexOf("#");
    const line = (
      commentIndex === -1 ? rawLine : rawLine.slice(0, commentIndex)
    ).trimEnd();
    if (!line.trim()) continue;
    const stripped = line.trimStart();
    const indent = line.length - stripped.length;
    if (stripped === "-" || stripped.startsWith("- ")) {
      tokens.push({
        indent,
        isList: true,
        key: null,
        value: stripped.slice(1).trim()
      });
      continue;
    }
    const separator = stripped.indexOf(":");
    if (separator === -1) throw new Error(`Cannot parse YAML line: ${rawLine}`);
    tokens.push({
      indent,
      isList: false,
      key: stripped.slice(0, separator).trim(),
      value: stripped.slice(separator + 1).trim()
    });
  }
  return tokens;
}

function parseBlock(
  tokens: Token[],
  start: number,
  indent: number
): [YamlValue, number] {
  const first = tokens[start];
  if (!first) throw new Error("Cannot parse empty YAML block");
  const isList = first.isList;
  const result: YamlValue[] | Record<string, YamlValue> = isList ? [] : {};
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token || token.indent !== indent || token.isList !== isList) break;
    index += 1;
    let child: YamlValue;
    if (token.value === "") {
      if (index < tokens.length && (tokens[index]?.indent ?? 0) > indent) {
        [child, index] = parseBlock(tokens, index, tokens[index]!.indent);
      } else child = {};
    } else if (token.value.startsWith("[") && token.value.endsWith("]"))
      child = parseInlineList(token.value);
    else child = parseScalar(token.value);
    if (isList) (result as YamlValue[]).push(child);
    else (result as Record<string, YamlValue>)[token.key ?? ""] = child;
  }
  return [result, index];
}

function loadMinimalYaml(text: string): YamlValue {
  const tokens = tokenize(text);
  if (tokens.length === 0) return {};
  const [value, index] = parseBlock(tokens, 0, tokens[0]!.indent);
  if (index !== tokens.length)
    throw new Error("Unconsumed YAML content while parsing fixture");
  return value;
}

function asMap(value: YamlValue | undefined): Record<string, YamlValue> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected YAML mapping");
  return value;
}

function asList(value: YamlValue | undefined): YamlValue[] {
  if (!Array.isArray(value)) throw new Error("expected YAML list");
  return value;
}

const config = asMap(loadMinimalYaml(readFileSync(configPath, "utf8")));

describe("OpenTelemetry Collector fixture", () => {
  test("version file exists and pins one audited build", () => {
    assert.equal(existsSync(versionPath), true, `missing ${versionPath}`);
    const contents = readFileSync(versionPath, "utf8");
    assert.equal(contents.trim(), EXPECTED_VERSION);
    assert.deepEqual(contents.trim().split("\n"), [EXPECTED_VERSION]);
  });

  test("platform artifact manifest matches the pinned version", () => {
    const manifest = JSON.parse(
      readFileSync(artifactsPath, "utf8")
    ) as CollectorManifest;
    assert.equal(manifest.schema, "autodev-otel-collector-artifacts-v1");
    assert.equal(manifest.version, EXPECTED_VERSION);
    assert.deepEqual(Object.keys(manifest.assets).sort(), [
      "darwin/amd64",
      "darwin/arm64",
      "linux/amd64",
      "linux/arm64"
    ]);
    for (const asset of Object.values(manifest.assets)) {
      assert.match(
        asset.name,
        new RegExp(
          String.raw`^otelcol_${EXPECTED_VERSION.slice(1)}_.*\.tar\.gz$`
        )
      );
      assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    }
  });
});

describe("OpenTelemetry Collector config structure", () => {
  test("top-level sections are receivers, exporters, and service only", () => {
    assert.deepEqual(Object.keys(config).sort(), [
      "exporters",
      "receivers",
      "service"
    ]);
  });

  test("unsupported top-level sections are absent", () => {
    for (const section of UNSUPPORTED_TOP_LEVEL_SECTIONS)
      assert.equal(Object.hasOwn(config, section), false, section);
  });

  test("receiver is OTLP HTTP only and listens on localhost:4318", () => {
    const receivers = asMap(config.receivers);
    assert.deepEqual(Object.keys(receivers), ["otlp"]);
    const otlp = asMap(receivers.otlp);
    const protocols = asMap(otlp.protocols);
    assert.deepEqual(Object.keys(protocols), ["http"]);
    assert.equal(asMap(protocols.http).endpoint, EXPECTED_RECEIVER_ENDPOINT);
  });

  test("exactly one exporter targets the AutoDev receiver with JSON encoding", () => {
    const exporters = asMap(config.exporters);
    assert.deepEqual(Object.keys(exporters), [EXPECTED_EXPORTER_NAME]);
    const exporter = asMap(exporters[EXPECTED_EXPORTER_NAME]!);
    assert.equal(exporter.endpoint, EXPECTED_EXPORTER_ENDPOINT);
    assert.equal(exporter.encoding, "json");
  });

  test("service has pipelines and telemetry sections only", () => {
    const service = asMap(config.service);
    assert.deepEqual(Object.keys(service).sort(), ["pipelines", "telemetry"]);
    for (const section of UNSUPPORTED_SERVICE_SECTIONS)
      assert.equal(Object.hasOwn(service, section), false, section);
    assert.deepEqual(asMap(asMap(service.telemetry).metrics), {
      level: "none"
    });
  });

  test("all three pipelines wire the OTLP receiver to the AutoDev exporter", () => {
    const pipelines = asMap(asMap(config.service).pipelines);
    assert.deepEqual(
      Object.keys(pipelines).sort(),
      [...EXPECTED_PIPELINES].sort()
    );
    for (const name of EXPECTED_PIPELINES) {
      const pipeline = asMap(pipelines[name]!);
      assert.deepEqual(Object.keys(pipeline).sort(), [
        "exporters",
        "receivers"
      ]);
      assert.deepEqual(asList(pipeline.receivers), ["otlp"]);
      assert.deepEqual(asList(pipeline.exporters), [EXPECTED_EXPORTER_NAME]);
      assert.equal(
        Object.hasOwn(pipeline, "processors"),
        false,
        `${name} must not declare processors`
      );
    }
  });
});
