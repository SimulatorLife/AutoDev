"""Contract tests for the Phase 3 `autodev.*` semantic attribute schema.

These tests validate `tests/fixtures/otel/autodev-attributes-schema.json`
against the in-repo slice described in
docs/AUTODEV_PLATFORM_MIGRATION.md ("Phase 3 -- Insert OpenTelemetry
Collector as OTLP ingress", "Then" -- "Define AutoDev semantic attributes
under an `autodev.*` namespace"): the seven suggested migration keys
(`autodev.role`, `autodev.workspace`, `autodev.provider`, `autodev.model`,
`autodev.spawn.mechanism`, `autodev.skill`, `autodev.mcp.server`) get a
frozen, additive-only attribute *contract* -- names, type, cardinality, scope, and signal applicability -- with an opt-in router-side emitter behind the AUTODEV_OTEL_ATTRIBUTES=v1 env flag (default: flag unset, no emission).

This slice does not touch `config/otel/collector.yaml`, router code, or the
existing `tests/fixtures/otel/collector-forwarded-otlp.json` fixture; it only
asserts that fixture does not yet contain any `autodev.*` attribute, which is
exactly what "additive, opt-in only" means.
"""

import json
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO_ROOT / "tests/fixtures/otel/autodev-attributes-schema.json"
EXISTING_OTLP_FIXTURE_PATH = REPO_ROOT / "tests/fixtures/otel/collector-forwarded-otlp.json"

EXPECTED_SCHEMA_VERSION = "autodev-otel-attributes-v1"
EXPECTED_NAMESPACE_PREFIX = "autodev"
EXPECTED_COMPATIBILITY = "additive-optional"
EXPECTED_EMISSION = "opt-in"

EXPECTED_KEYS = (
    "autodev.role",
    "autodev.workspace",
    "autodev.provider",
    "autodev.model",
    "autodev.spawn.mechanism",
    "autodev.skill",
    "autodev.mcp.server",
)

# scope: "resource" for the session-level identity attributes, "event" for
# the per-occurrence attribution attributes, per the Phase 3 slice.
EXPECTED_SCOPE_BY_KEY = {
    "autodev.role": "resource",
    "autodev.workspace": "resource",
    "autodev.provider": "resource",
    "autodev.model": "resource",
    "autodev.spawn.mechanism": "event",
    "autodev.skill": "event",
    "autodev.mcp.server": "event",
}

VALID_SIGNALS = {"logs", "traces", "metrics"}
VALID_SCOPES = {"resource", "event"}

# Existing unprefixed attribute keys already emitted today (drawn from the
# Phase 3 Collector-forwarded OTLP fixture). The new autodev.* keys must not
# collide with any of these literal wire key strings.
EXISTING_UNPREFIXED_KEYS = (
    "service.name",
    "service.version",
    "mcp_servers",
    "event.name",
    "conversation.id",
    "model",
    "prompt_length",
    "prompt_text",
    "duration_ms",
    "tool",
    "tool_origin",
    "call_id",
    "status",
    "event.kind",
    "input_token_count",
    "output_token_count",
    "cached_token_count",
    "reasoning_token_count",
    "tool_token_count",
    "server_name",
    "error.type",
    "workspace_id",
    "source",
    "skill",
    "invoke_type",
    "hook_name",
    "handler_type",
)


def _load_schema():
    return json.loads(SCHEMA_PATH.read_text())


def _iter_attribute_keys(node):
    """Recursively collect every OTLP attribute 'key' string in a fixture."""
    keys = []
    if isinstance(node, dict):
        if "key" in node and isinstance(node.get("key"), str):
            keys.append(node["key"])
        for value in node.values():
            keys.extend(_iter_attribute_keys(value))
    elif isinstance(node, list):
        for item in node:
            keys.extend(_iter_attribute_keys(item))
    return keys


class AutodevAttributesSchemaFileTests(unittest.TestCase):
    def test_schema_file_exists(self):
        self.assertTrue(SCHEMA_PATH.is_file(), msg=f"missing {SCHEMA_PATH}")

    def test_schema_file_is_valid_json(self):
        _load_schema()  # must not raise


class AutodevAttributesSchemaContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = _load_schema()
        cls.attributes = cls.schema["attributes"]
        cls.by_key = {attr["key"]: attr for attr in cls.attributes}

    def test_schema_version_is_pinned(self):
        self.assertEqual(self.schema["schema_version"], EXPECTED_SCHEMA_VERSION)

    def test_namespace_prefix_is_autodev(self):
        self.assertEqual(self.schema["namespace_prefix"], EXPECTED_NAMESPACE_PREFIX)

    def test_top_level_compatibility_is_additive_optional(self):
        self.assertEqual(self.schema["compatibility"], EXPECTED_COMPATIBILITY)

    def test_top_level_emission_is_not_wired(self):
        self.assertEqual(self.schema["emission"], EXPECTED_EMISSION)

    def test_exact_key_set(self):
        self.assertEqual(set(self.by_key.keys()), set(EXPECTED_KEYS))

    def test_no_duplicate_keys(self):
        keys = [attr["key"] for attr in self.attributes]
        self.assertEqual(
            len(keys),
            len(set(keys)),
            msg="autodev.* attribute keys must be unique within the schema",
        )

    def test_each_key_uses_autodev_prefix(self):
        for key in self.by_key:
            with self.subTest(key=key):
                self.assertTrue(
                    key == "autodev" or key.startswith("autodev."),
                    msg=f"{key!r} does not use the autodev. namespace prefix",
                )

    def test_each_attribute_declares_matching_prefix_field(self):
        for key, attr in self.by_key.items():
            with self.subTest(key=key):
                self.assertEqual(attr["prefix"], "autodev")

    def test_all_attributes_are_string_type(self):
        for key, attr in self.by_key.items():
            with self.subTest(key=key):
                self.assertEqual(attr["type"], "string")

    def test_all_attributes_are_single_cardinality(self):
        for key, attr in self.by_key.items():
            with self.subTest(key=key):
                self.assertEqual(attr["cardinality"], "single")

    def test_scope_matches_resource_or_event_split(self):
        for key, expected_scope in EXPECTED_SCOPE_BY_KEY.items():
            with self.subTest(key=key):
                self.assertIn(self.by_key[key]["scope"], VALID_SCOPES)
                self.assertEqual(self.by_key[key]["scope"], expected_scope)

    def test_resource_scope_keys_are_exactly_role_workspace_provider_model(self):
        resource_keys = {
            key for key, attr in self.by_key.items() if attr["scope"] == "resource"
        }
        self.assertEqual(
            resource_keys,
            {"autodev.role", "autodev.workspace", "autodev.provider", "autodev.model"},
        )

    def test_event_scope_keys_are_exactly_spawn_skill_mcp_server(self):
        event_keys = {
            key for key, attr in self.by_key.items() if attr["scope"] == "event"
        }
        self.assertEqual(
            event_keys,
            {"autodev.spawn.mechanism", "autodev.skill", "autodev.mcp.server"},
        )

    def test_every_attribute_declares_explicit_non_empty_signals(self):
        for key, attr in self.by_key.items():
            with self.subTest(key=key):
                signals = attr["signals"]
                self.assertIsInstance(signals, list)
                self.assertTrue(signals, msg=f"{key} must declare at least one applicable signal")
                self.assertTrue(
                    set(signals).issubset(VALID_SIGNALS),
                    msg=f"{key} declares an unknown signal in {signals!r}",
                )
                self.assertEqual(
                    len(signals),
                    len(set(signals)),
                    msg=f"{key} lists duplicate signals in {signals!r}",
                )

    def test_all_attributes_are_optional(self):
        for key, attr in self.by_key.items():
            with self.subTest(key=key):
                self.assertTrue(attr["optional"], msg=f"{key} must be optional/additive")

    def test_all_attributes_are_additive_compatibility(self):
        for key, attr in self.by_key.items():
            with self.subTest(key=key):
                self.assertEqual(attr["compatibility"], "additive")

    def test_no_attribute_carries_prompt_content(self):
        for key, attr in self.by_key.items():
            with self.subTest(key=key):
                self.assertFalse(
                    attr["prompt_content"],
                    msg=f"{key} must never carry prompt/response content",
                )

    def test_every_attribute_has_a_description(self):
        for key, attr in self.by_key.items():
            with self.subTest(key=key):
                self.assertIsInstance(attr.get("description"), str)
                self.assertTrue(attr["description"].strip())

    def test_no_collision_with_existing_unprefixed_attribute_keys(self):
        collisions = set(self.by_key.keys()) & set(EXISTING_UNPREFIXED_KEYS)
        self.assertEqual(
            collisions,
            set(),
            msg=f"autodev.* keys must not collide with existing unprefixed keys: {collisions}",
        )

class ExistingOtlpFixtureHasNoAutodevAttributesYetTests(unittest.TestCase):
    def test_existing_fixture_exists(self):
        self.assertTrue(
            EXISTING_OTLP_FIXTURE_PATH.is_file(),
            msg=f"missing {EXISTING_OTLP_FIXTURE_PATH}",
        )

    def test_existing_fixture_has_no_autodev_prefixed_keys(self):
        fixture = json.loads(EXISTING_OTLP_FIXTURE_PATH.read_text())
        keys = _iter_attribute_keys(fixture)
        autodev_keys = [key for key in keys if key.startswith("autodev.") or key == "autodev"]
        self.assertEqual(
            autodev_keys,
            [],
            msg=(
                "the existing Collector-forwarded OTLP fixture must remain free of "
                "autodev.* attributes until emission is actually wired in a later slice"
            ),
        )


if __name__ == "__main__":
    unittest.main()
