"""Contract tests for the Phase 3 `autodev.*` emission mapping.

These tests validate `tests/fixtures/otel/autodev-attributes-emission-contract.json`
against the in-repo slice described in docs/AUTODEV_PLATFORM_MIGRATION.md
("Phase 3 -- Insert OpenTelemetry Collector as OTLP ingress", "Then" -- "Define
AutoDev semantic attributes under an `autodev.*` namespace"):
- Resource-scope keys (autodev.role, autodev.workspace, autodev.provider, autodev.model)
  go only into resource.attributes;
- Event-scope keys (autodev.spawn.mechanism, autodev.skill, autodev.mcp.server)
  go only into event/span/log/datapoint attributes;
- Output preserves all existing keys and adds only autodev.* keys;
- Unknown optional values produce no autodev key;
- Schema key and order cross-reference strictly matches
  `tests/fixtures/otel/autodev-attributes-schema.json`;
- No prompt content is ever carried by autodev.* attributes;
- Emission is opt-in: the router-side helper in scripts/codex-model-router.mjs only runs when AUTODEV_OTEL_ATTRIBUTES=v1.
"""

import json
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO_ROOT / "tests/fixtures/otel/autodev-attributes-schema.json"
CONTRACT_PATH = REPO_ROOT / "tests/fixtures/otel/autodev-attributes-emission-contract.json"
EXISTING_OTLP_FIXTURE_PATH = REPO_ROOT / "tests/fixtures/otel/collector-forwarded-otlp.json"

EXPECTED_SCHEMA_VERSION = "autodev-otel-attributes-v1"
EXPECTED_CONTRACT_VERSION = "autodev-otel-attributes-emission-v1"
EXPECTED_NAMESPACE_PREFIX = "autodev"
EXPECTED_COMPATIBILITY = "additive-optional"
EXPECTED_EMISSION = "opt-in"

EXPECTED_ORDERED_KEYS = (
    "autodev.role",
    "autodev.workspace",
    "autodev.provider",
    "autodev.model",
    "autodev.spawn.mechanism",
    "autodev.skill",
    "autodev.mcp.server",
)

EXPECTED_RESOURCE_SCOPE_KEYS = {
    "autodev.role",
    "autodev.workspace",
    "autodev.provider",
    "autodev.model",
}

EXPECTED_EVENT_SCOPE_KEYS = {
    "autodev.spawn.mechanism",
    "autodev.skill",
    "autodev.mcp.server",
}


def _load_json(path: Path):
    return json.loads(path.read_text())


def _extract_attribute_map(attributes_list):
    """Convert an OTLP attributes list [{'key': k, 'value': v}] to a dict {k: v}."""
    result = {}
    for attr in attributes_list:
        key = attr["key"]
        result[key] = attr.get("value")
    return result


def _iter_attributes_with_location(obj, path=""):
    """Recursively yield (location_path, attr_dict) for every attribute list found."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            current_path = f"{path}.{k}" if path else k
            if k == "attributes" and isinstance(v, list):
                yield current_path, v
            else:
                yield from _iter_attributes_with_location(v, current_path)
    elif isinstance(obj, list):
        for idx, item in enumerate(obj):
            yield from _iter_attributes_with_location(item, f"{path}[{idx}]")


class AutodevAttributesEmissionContractFileTests(unittest.TestCase):
    def test_contract_file_exists(self):
        self.assertTrue(CONTRACT_PATH.is_file(), msg=f"missing {CONTRACT_PATH}")

    def test_contract_file_is_valid_json(self):
        contract = _load_json(CONTRACT_PATH)
        self.assertIsInstance(contract, dict)


class AutodevAttributesEmissionSchemaCrossReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = _load_json(SCHEMA_PATH)
        cls.contract = _load_json(CONTRACT_PATH)
        cls.cross_ref = cls.contract["schema_cross_reference"]

    def test_contract_metadata_matches_schema(self):
        self.assertEqual(self.contract["contract_version"], EXPECTED_CONTRACT_VERSION)
        self.assertEqual(self.contract["schema_version"], self.schema["schema_version"])
        self.assertEqual(self.contract["schema_version"], EXPECTED_SCHEMA_VERSION)
        self.assertEqual(self.contract["namespace_prefix"], EXPECTED_NAMESPACE_PREFIX)
        self.assertEqual(self.contract["compatibility"], EXPECTED_COMPATIBILITY)
        self.assertEqual(self.contract["emission"], EXPECTED_EMISSION)

    def test_cross_reference_section_metadata(self):
        self.assertEqual(self.cross_ref["schema_version"], self.schema["schema_version"])
        self.assertEqual(self.cross_ref["namespace_prefix"], EXPECTED_NAMESPACE_PREFIX)
        self.assertEqual(self.cross_ref["compatibility"], EXPECTED_COMPATIBILITY)
        self.assertEqual(self.cross_ref["emission"], EXPECTED_EMISSION)

    def test_schema_key_order_cross_reference_strictly_matches(self):
        schema_keys = [attr["key"] for attr in self.schema["attributes"]]
        contract_keys = self.cross_ref["ordered_keys"]
        self.assertEqual(
            contract_keys,
            list(EXPECTED_ORDERED_KEYS),
            msg="contract ordered_keys must match the canonical 7 migration keys in order",
        )
        self.assertEqual(
            contract_keys,
            schema_keys,
            msg="contract ordered_keys must strictly match autodev-attributes-schema.json key order",
        )

    def test_mappings_key_order_strictly_matches_schema(self):
        mapping_keys = [m["key"] for m in self.cross_ref["mappings"]]
        self.assertEqual(
            mapping_keys,
            list(EXPECTED_ORDERED_KEYS),
            msg="cross_reference mappings list must follow exact schema key order",
        )

    def test_scope_cross_reference_matches_schema(self):
        schema_scope = {attr["key"]: attr["scope"] for attr in self.schema["attributes"]}
        contract_scope = self.cross_ref["scope_by_key"]
        self.assertEqual(contract_scope, schema_scope)
        for key, mapping in zip(self.cross_ref["ordered_keys"], self.cross_ref["mappings"]):
            self.assertEqual(mapping["scope"], schema_scope[key])

    def test_signals_cross_reference_matches_schema(self):
        schema_signals = {attr["key"]: attr["signals"] for attr in self.schema["attributes"]}
        contract_signals = self.cross_ref["signals_by_key"]
        self.assertEqual(contract_signals, schema_signals)
        for key, mapping in zip(self.cross_ref["ordered_keys"], self.cross_ref["mappings"]):
            self.assertEqual(mapping["signals"], schema_signals[key])


class AutodevAttributesExactAdditiveMappingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = _load_json(CONTRACT_PATH)
        cls.before = cls.contract["before"]
        cls.after = cls.contract["after"]

    def test_all_three_signals_present_in_before_and_after(self):
        for signal in ("logs", "traces", "metrics"):
            self.assertIn(signal, self.before)
            self.assertIn(signal, self.after)

    def test_all_existing_keys_and_values_preserved_in_after(self):
        for signal in ("logs", "traces", "metrics"):
            before_locs = dict(_iter_attributes_with_location(self.before[signal]))
            after_locs = dict(_iter_attributes_with_location(self.after[signal]))

            self.assertEqual(
                set(before_locs.keys()),
                set(after_locs.keys()),
                msg=f"attribute locations in {signal} must be preserved",
            )

            for loc, before_attrs in before_locs.items():
                after_attrs = after_locs[loc]
                before_map = _extract_attribute_map(before_attrs)
                after_map = _extract_attribute_map(after_attrs)

                for k, v in before_map.items():
                    with self.subTest(signal=signal, location=loc, key=k):
                        self.assertIn(
                            k,
                            after_map,
                            msg=f"Existing key {k!r} at {loc} was removed in 'after'",
                        )
                        self.assertEqual(
                            after_map[k],
                            v,
                            msg=f"Existing key {k!r} at {loc} changed value: before={v!r}, after={after_map[k]!r}",
                        )

    def test_only_autodev_keys_added_in_after(self):
        for signal in ("logs", "traces", "metrics"):
            before_locs = dict(_iter_attributes_with_location(self.before[signal]))
            after_locs = dict(_iter_attributes_with_location(self.after[signal]))

            for loc, before_attrs in before_locs.items():
                after_attrs = after_locs[loc]
                before_keys = set(_extract_attribute_map(before_attrs).keys())
                after_keys = set(_extract_attribute_map(after_attrs).keys())

                added_keys = after_keys - before_keys
                for key in added_keys:
                    with self.subTest(signal=signal, location=loc, key=key):
                        self.assertTrue(
                            key.startswith("autodev."),
                            msg=f"Non-autodev key {key!r} was added at {loc}",
                        )
                        self.assertIn(
                            key,
                            EXPECTED_ORDERED_KEYS,
                            msg=f"Key {key!r} added at {loc} is not in the frozen schema keys",
                        )

    def test_all_seven_schema_keys_are_covered_in_after(self):
        all_added_keys = set()
        for signal in ("logs", "traces", "metrics"):
            before_locs = dict(_iter_attributes_with_location(self.before[signal]))
            after_locs = dict(_iter_attributes_with_location(self.after[signal]))
            for loc, before_attrs in before_locs.items():
                after_attrs = after_locs[loc]
                before_keys = set(_extract_attribute_map(before_attrs).keys())
                after_keys = set(_extract_attribute_map(after_attrs).keys())
                all_added_keys.update(after_keys - before_keys)

        self.assertEqual(
            all_added_keys,
            set(EXPECTED_ORDERED_KEYS),
            msg="Every one of the 7 frozen autodev.* keys must be exercised in the emission contract fixture",
        )


class AutodevAttributesScopeIsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = _load_json(CONTRACT_PATH)
        cls.after = cls.contract["after"]

    def test_resource_scope_keys_only_in_resource_attributes(self):
        for signal in ("logs", "traces", "metrics"):
            for loc, attrs in _iter_attributes_with_location(self.after[signal]):
                attr_map = _extract_attribute_map(attrs)
                is_resource_loc = ".resource." in loc or loc.startswith("resource.") or loc.endswith(".resource.attributes") or "resourceLogs[" in loc and "resource.attributes" in loc or "resourceSpans[" in loc and "resource.attributes" in loc or "resourceMetrics[" in loc and "resource.attributes" in loc
                for key in EXPECTED_RESOURCE_SCOPE_KEYS:
                    if key in attr_map:
                        with self.subTest(signal=signal, location=loc, key=key):
                            self.assertTrue(
                                is_resource_loc,
                                msg=f"Resource-scope key {key!r} appeared outside resource.attributes at {loc}",
                            )

    def test_event_scope_keys_only_in_event_attributes(self):
        for signal in ("logs", "traces", "metrics"):
            for loc, attrs in _iter_attributes_with_location(self.after[signal]):
                attr_map = _extract_attribute_map(attrs)
                is_resource_loc = "resource.attributes" in loc
                for key in EXPECTED_EVENT_SCOPE_KEYS:
                    if key in attr_map:
                        with self.subTest(signal=signal, location=loc, key=key):
                            self.assertFalse(
                                is_resource_loc,
                                msg=f"Event-scope key {key!r} appeared inside resource.attributes at {loc}",
                            )


class AutodevAttributesUnknownOptionalValuesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = _load_json(CONTRACT_PATH)
        cls.omission_example = cls.contract["examples"]["unknown_optional_omitted"]

    def test_omission_example_before_and_after_have_no_autodev_keys(self):
        for example_side in ("before", "after"):
            for signal in ("logs", "traces", "metrics"):
                for loc, attrs in _iter_attributes_with_location(self.omission_example[example_side][signal]):
                    attr_map = _extract_attribute_map(attrs)
                    autodev_keys = [k for k in attr_map if k.startswith("autodev.") or k == "autodev"]
                    with self.subTest(side=example_side, signal=signal, location=loc):
                        self.assertEqual(
                            autodev_keys,
                            [],
                            msg=f"Unknown optional values must produce no autodev key, found {autodev_keys} at {loc}",
                        )

    def test_unattributed_records_in_full_after_fixture_produce_no_autodev_keys(self):
        after_traces = self.contract["after"]["traces"]
        for loc, attrs in _iter_attributes_with_location(after_traces):
            if "spans[3]" in loc:  # internal_unattributed_step
                attr_map = _extract_attribute_map(attrs)
                autodev_keys = [k for k in attr_map if k.startswith("autodev.")]
                self.assertEqual(
                    autodev_keys,
                    [],
                    msg=f"Unattributed span at {loc} must not have autodev keys",
                )

        after_logs = self.contract["after"]["logs"]
        for loc, attrs in _iter_attributes_with_location(after_logs):
            if "logRecords[6]" in loc:  # tool_result
                attr_map = _extract_attribute_map(attrs)
                autodev_keys = [k for k in attr_map if k.startswith("autodev.")]
                self.assertEqual(
                    autodev_keys,
                    [],
                    msg=f"Unattributed log record at {loc} must not have autodev keys",
                )


class AutodevAttributesNoPromptContentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = _load_json(CONTRACT_PATH)
        cls.after = cls.contract["after"]

    def test_no_autodev_attribute_contains_prompt_content(self):
        prompt_secret = "do-not-store-this-collector-forwarded-secret"
        for signal in ("logs", "traces", "metrics"):
            for loc, attrs in _iter_attributes_with_location(self.after[signal]):
                attr_map = _extract_attribute_map(attrs)
                for key, val_obj in attr_map.items():
                    if key.startswith("autodev."):
                        val = val_obj.get("stringValue", "")
                        self.assertNotIn(
                            prompt_secret,
                            str(val),
                            msg=f"Prompt secret leaked into {key} at {loc}",
                        )
                        self.assertLessEqual(
                            len(str(val)),
                            64,
                            msg=f"autodev.* attribute {key} value must be a short categorical identifier, got {val!r}",
                        )

    def test_user_prompt_record_preserves_prompt_and_adds_no_autodev_keys(self):
        after_logs = self.contract["after"]["logs"]
        for loc, attrs in _iter_attributes_with_location(after_logs):
            if "logRecords[1]" in loc:  # codex.user_prompt
                attr_map = _extract_attribute_map(attrs)
                self.assertEqual(attr_map.get("event.name"), {"stringValue": "codex.user_prompt"})
                self.assertIn("prompt_text", attr_map)
                self.assertIn("prompt_length", attr_map)
                autodev_keys = [k for k in attr_map if k.startswith("autodev.")]
                self.assertEqual(
                    autodev_keys,
                    [],
                    msg="user_prompt record must not be decorated with autodev keys",
                )


class AutodevAttributesNoRuntimeEmissionIsOptInTests(unittest.TestCase):
    def test_contract_declares_emission_opt_in_only(self):
        # The Phase 3 in-repo slice adds an opt-in router-side emitter behind
        # AUTODEV_OTEL_ATTRIBUTES=v1; the contract says "opt-in", never
        # "always-on", so the helper never runs on the default ingestion path.
        contract = _load_json(CONTRACT_PATH)
        self.assertEqual(contract["emission"], "opt-in")
        self.assertNotEqual(contract["emission"], "always-on")

    def test_contract_advertises_opt_in_runtime_metadata(self):
        # The contract must tell future readers HOW the helper is gated, so
        # there is no ambiguity between "emission wired" and "emission wired
        # behind an env flag".
        contract = _load_json(CONTRACT_PATH)
        runtime = contract.get("runtime_emission") or {}
        self.assertEqual(runtime.get("flag"), "AUTODEV_OTEL_ATTRIBUTES")
        self.assertEqual(runtime.get("version"), "v1")
        self.assertEqual(runtime.get("default"), False)
        self.assertEqual(runtime.get("mutates"), False)
        self.assertEqual(runtime.get("helper"), "autodevEnrichOtlpPayload")

    def test_collector_forwarded_otlp_fixture_has_no_autodev_keys(self):
        existing_fixture = _load_json(EXISTING_OTLP_FIXTURE_PATH)
        for loc, attrs in _iter_attributes_with_location(existing_fixture):
            attr_map = _extract_attribute_map(attrs)
            autodev_keys = [k for k in attr_map if k.startswith("autodev.") or k == "autodev"]
            self.assertEqual(
                autodev_keys,
                [],
                msg=f"collector-forwarded-otlp.json must have no autodev keys, found {autodev_keys} at {loc}",
            )


if __name__ == "__main__":
    unittest.main()
