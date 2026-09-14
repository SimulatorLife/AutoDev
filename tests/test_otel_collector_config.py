"""Contract tests for the Phase 3 OpenTelemetry Collector fixture.

These tests validate `config/otel/collector.version` and
`config/otel/collector.yaml` against the contract-only slice described in
docs/AUTODEV_PLATFORM_MIGRATION.md ("Phase 3 -- Insert OpenTelemetry
Collector as OTLP ingress"): an inactive OTLP HTTP receiver on
127.0.0.1:4318 forwarding logs/traces/metrics pipelines to an
otlphttp/autodev exporter targeting http://127.0.0.1:4100 with JSON
encoding. No generic backend, no live process wiring, and no tee adapter
belong in this slice.

Only the Python standard library is used -- no third-party YAML parser --
so a small indentation-based YAML subset loader is implemented below,
scoped to the mapping/list/scalar shapes this fixture actually uses.
"""

import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
VERSION_PATH = REPO_ROOT / "config/otel/collector.version"
CONFIG_PATH = REPO_ROOT / "config/otel/collector.yaml"

EXPECTED_VERSION = "v0.160.0"
EXPECTED_RECEIVER_ENDPOINT = "127.0.0.1:4318"
EXPECTED_EXPORTER_ENDPOINT = "http://127.0.0.1:4100"
EXPECTED_EXPORTER_NAME = "otlphttp/autodev"
EXPECTED_PIPELINES = ("traces", "metrics", "logs")

# Settings/sections that would indicate this contract-only slice has grown
# scope it explicitly must not have yet (a generic backend, live process
# wiring, or a tee adapter fanning out to more than one exporter).
UNSUPPORTED_TOP_LEVEL_SECTIONS = ("processors", "extensions", "connectors")
UNSUPPORTED_SERVICE_SECTIONS = ("extensions", "telemetry")


def _parse_scalar(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    if value == "true":
        return True
    if value == "false":
        return False
    try:
        return int(value)
    except ValueError:
        return value


def _parse_inline_list(value):
    inner = value[1:-1].strip()
    if not inner:
        return []
    return [_parse_scalar(item.strip()) for item in inner.split(",")]


def _tokenize(text):
    tokens = []
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)
        if stripped == "-" or stripped.startswith("- "):
            value = stripped[1:].strip()
            tokens.append((indent, True, None, value))
            continue
        if ":" not in stripped:
            raise ValueError(f"Cannot parse YAML line: {raw_line!r}")
        key, _, rest = stripped.partition(":")
        tokens.append((indent, False, key.strip(), rest.strip()))
    return tokens


def _parse_block(tokens, index, indent):
    is_list = tokens[index][1]
    result = [] if is_list else {}
    while index < len(tokens) and tokens[index][0] == indent and tokens[index][1] == is_list:
        _, _, key, value = tokens[index]
        index += 1
        if value == "":
            if index < len(tokens) and tokens[index][0] > indent:
                child, index = _parse_block(tokens, index, tokens[index][0])
            else:
                child = {}
        elif value.startswith("[") and value.endswith("]"):
            child = _parse_inline_list(value)
        else:
            child = _parse_scalar(value)
        if is_list:
            result.append(child)
        else:
            result[key] = child
    return result, index


def load_minimal_yaml(text):
    """Parse the small indentation-based YAML subset this fixture uses."""
    tokens = _tokenize(text)
    if not tokens:
        return {}
    value, index = _parse_block(tokens, 0, tokens[0][0])
    if index != len(tokens):
        raise ValueError("Unconsumed YAML content while parsing fixture")
    return value


class OtelCollectorVersionTests(unittest.TestCase):
    def test_version_file_exists(self):
        self.assertTrue(VERSION_PATH.is_file(), msg=f"missing {VERSION_PATH}")

    def test_version_pins_exact_audited_build(self):
        contents = VERSION_PATH.read_text().strip()
        self.assertEqual(contents, EXPECTED_VERSION)

    def test_version_file_is_single_line(self):
        contents = VERSION_PATH.read_text()
        self.assertEqual(
            contents.strip().splitlines(),
            [EXPECTED_VERSION],
            msg="collector.version must contain exactly the pinned version",
        )


class OtelCollectorConfigStructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw_text = CONFIG_PATH.read_text()
        cls.config = load_minimal_yaml(cls.raw_text)

    def test_config_file_exists(self):
        self.assertTrue(CONFIG_PATH.is_file(), msg=f"missing {CONFIG_PATH}")

    def test_top_level_sections_are_receivers_exporters_service_only(self):
        self.assertEqual(set(self.config.keys()), {"receivers", "exporters", "service"})

    def test_no_unsupported_top_level_sections(self):
        for section in UNSUPPORTED_TOP_LEVEL_SECTIONS:
            with self.subTest(section=section):
                self.assertNotIn(
                    section,
                    self.config,
                    msg=(
                        f"contract-only slice must not add a {section!r} "
                        "section (no generic backend / live wiring yet)"
                    ),
                )

    def test_receiver_is_otlp_http_only(self):
        receivers = self.config["receivers"]
        self.assertEqual(set(receivers.keys()), {"otlp"})
        protocols = receivers["otlp"]["protocols"]
        self.assertEqual(set(protocols.keys()), {"http"})

    def test_receiver_endpoint_is_localhost_4318(self):
        endpoint = self.config["receivers"]["otlp"]["protocols"]["http"]["endpoint"]
        self.assertEqual(endpoint, EXPECTED_RECEIVER_ENDPOINT)

    def test_exactly_one_exporter_named_otlphttp_autodev(self):
        exporters = self.config["exporters"]
        self.assertEqual(
            set(exporters.keys()),
            {EXPECTED_EXPORTER_NAME},
            msg="only a single otlphttp/autodev exporter belongs in this slice (no generic backend, no tee)",
        )

    def test_exporter_targets_existing_autodev_receiver(self):
        exporter = self.config["exporters"][EXPECTED_EXPORTER_NAME]
        self.assertEqual(exporter["endpoint"], EXPECTED_EXPORTER_ENDPOINT)

    def test_exporter_uses_json_encoding(self):
        exporter = self.config["exporters"][EXPECTED_EXPORTER_NAME]
        self.assertEqual(
            exporter["encoding"],
            "json",
            msg="the existing AutoDev receiver parses OTLP JSON, not protobuf",
        )

    def test_service_has_pipelines_section_only(self):
        service = self.config["service"]
        self.assertEqual(set(service.keys()), {"pipelines"})
        for section in UNSUPPORTED_SERVICE_SECTIONS:
            with self.subTest(section=section):
                self.assertNotIn(section, service)

    def test_all_three_pipelines_present(self):
        pipelines = self.config["service"]["pipelines"]
        self.assertEqual(set(pipelines.keys()), set(EXPECTED_PIPELINES))

    def test_each_pipeline_wires_otlp_receiver_to_autodev_exporter(self):
        pipelines = self.config["service"]["pipelines"]
        for name in EXPECTED_PIPELINES:
            with self.subTest(pipeline=name):
                pipeline = pipelines[name]
                self.assertEqual(set(pipeline.keys()), {"receivers", "exporters"})
                self.assertEqual(pipeline["receivers"], ["otlp"])
                self.assertEqual(pipeline["exporters"], [EXPECTED_EXPORTER_NAME])

    def test_no_processors_referenced_by_any_pipeline(self):
        pipelines = self.config["service"]["pipelines"]
        for name, pipeline in pipelines.items():
            with self.subTest(pipeline=name):
                self.assertNotIn("processors", pipeline)


if __name__ == "__main__":
    unittest.main()
