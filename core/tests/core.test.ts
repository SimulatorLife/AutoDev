import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_POLICIES,
  CANONICAL_NAV_GROUPS,
  CANONICAL_NAVIGATION,
  CANONICAL_SECTION_PURPOSE,
  canonicalNavGroupOf,
  canonicalSectionPurpose,
  isApprovalPolicy,
  isCanonicalNavGroupId,
  isCanonicalNavSection,
  isOpenTelemetrySpanId,
  isOpenTelemetryTraceId,
  isSkillEligibleForRole,
  navOrderOf,
  validateAgentDefinition
} from "../src/index.ts";

test("CANONICAL_NAV_GROUPS defines Configure/Observe/Operate with exact 15 sections in canonical order", () => {
  // The grouped definition is the single source of truth.
  assert.deepEqual(
    CANONICAL_NAV_GROUPS.map((group) => group.id),
    ["Configure", "Observe", "Operate"]
  );

  // This definition is the source of truth for resource grouping and route
  // ownership. The target Console contract places Playtesting in Observe.
  assert.deepEqual(CANONICAL_NAV_GROUPS[0]?.sections, [
    "Overview",
    "Agents",
    "Providers",
    "MCPs",
    "Skills",
    "Hooks",
    "Prompts",
    "Permissions",
    "Tools"
  ]);
  assert.deepEqual(CANONICAL_NAV_GROUPS[1]?.sections, [
    "Usage",
    "Evaluations",
    "Playtesting"
  ]);
  assert.deepEqual(CANONICAL_NAV_GROUPS[2]?.sections, ["Workspaces", "GitHub"]);

  // The flattened list is derived from the grouped definition.
  const expected = [
    "Overview",
    "Agents",
    "Providers",
    "MCPs",
    "Skills",
    "Hooks",
    "Prompts",
    "Permissions",
    "Tools",
    "Usage",
    "Evaluations",
    "Playtesting",
    "Workspaces",
    "GitHub"
  ] as const;
  assert.deepEqual(CANONICAL_NAVIGATION, expected);
  assert.equal(CANONICAL_NAVIGATION.length, 14);

  for (const [index, element] of expected.entries()) {
    const section = element!;
    assert.equal(isCanonicalNavSection(section), true);
    assert.equal(navOrderOf(section), index);
    const group = canonicalNavGroupOf(section);
    assert.ok(group, `Every section must belong to a canonical group.`);
  }
  assert.equal(isCanonicalNavSection("Projects"), false);
  assert.equal(isCanonicalNavSection("Organizations"), false);
  assert.equal(isCanonicalNavSection("Environments"), false);

  // Group membership is mutually exclusive and covers every canonical section.
  const seen = new Set<string>();
  for (const group of CANONICAL_NAV_GROUPS) {
    for (const section of group.sections) {
      assert.ok(
        !seen.has(section),
        `${section} must not appear in more than one canonical group.`
      );
      seen.add(section);
    }
  }
  assert.equal(seen.size, CANONICAL_NAVIGATION.length);

  for (const id of ["Configure", "Observe", "Operate"] as const) {
    assert.equal(isCanonicalNavGroupId(id), true);
  }
  assert.equal(isCanonicalNavGroupId("Dashboard"), false);
  assert.equal(isCanonicalNavGroupId("Settings"), false);
});

test("every canonical resource says what it is for, in one sentence", () => {
  // A resource's purpose is a property of the resource, so it lives beside the
  // navigation that lists it. That is what stops a page from stating its own:
  // the sentence was a prop on thirteen pages and on none of the seven render
  // paths of the fourteenth, which is how Playtesting came to be the one
  // surface whose header named a resource without saying what it owns.
  assert.deepEqual(
    Object.keys(CANONICAL_SECTION_PURPOSE).sort(),
    [...CANONICAL_NAVIGATION].sort()
  );

  const sentences = new Set<string>();
  for (const section of CANONICAL_NAVIGATION) {
    const purpose = canonicalSectionPurpose(section);
    assert.ok(
      purpose.length > 0,
      `${section} must say what it is for: a header that names a resource ` +
        "without saying what it owns leaves the operator to guess."
    );
    assert.ok(
      purpose.endsWith("."),
      `${section}'s purpose is a sentence, so it ends with a full stop.`
    );
    assert.equal(
      purpose,
      purpose.trim(),
      `${section}'s purpose carries no leading or trailing whitespace.`
    );
    assert.ok(
      purpose.length <= 140,
      `${section}'s purpose is ${String(purpose.length)} characters: it is a ` +
        "line under the title, not a paragraph beside it."
    );
    assert.equal(
      sentences.has(purpose),
      false,
      `${section} must not share its purpose sentence with another resource.`
    );
    sentences.add(purpose);
  }
});

test("validateAgentDefinition validates required fields", () => {
  const invalid = validateAgentDefinition({});
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length >= 2);

  const valid = validateAgentDefinition({
    id: "orchestrator",
    role: "orchestrator",
    kind: "orchestrator"
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);
});

test("isSkillEligibleForRole checks role list accurately", () => {
  const list = [
    { skill: "orchestration", roles: ["orchestrator", "worker"] },
    { skill: "debug", roles: ["smart"] }
  ];
  assert.equal(
    isSkillEligibleForRole("orchestration", "orchestrator", list),
    true
  );
  assert.equal(
    isSkillEligibleForRole("orchestration", "explorer", list),
    false
  );
  assert.equal(isSkillEligibleForRole("unknown", "orchestrator", list), false);
});

test("OpenTelemetry trace and span identifiers require valid non-zero W3C ids", () => {
  assert.equal(
    isOpenTelemetryTraceId("0123456789abcdef0123456789abcdef"),
    true
  );
  assert.equal(isOpenTelemetryTraceId("0".repeat(32)), false);
  assert.equal(isOpenTelemetryTraceId("not-a-trace-id"), false);
  assert.equal(isOpenTelemetrySpanId("0123456789abcdef"), true);
  assert.equal(isOpenTelemetrySpanId("0".repeat(16)), false);
  assert.equal(isOpenTelemetrySpanId("offline_012345"), false);
  assert.equal(isOpenTelemetrySpanId(null), false);
});

test("APPROVAL_POLICIES is the one place the approval vocabulary is written", () => {
  assert.deepEqual([...APPROVAL_POLICIES], ["never", "on-request"]);
  for (const policy of APPROVAL_POLICIES) {
    assert.equal(isApprovalPolicy(policy), true, `${policy} must validate`);
  }
});

test("isApprovalPolicy fails fast on anything outside the vocabulary", () => {
  for (const invalid of [
    "",
    "always",
    "on-demand",
    "Never",
    "ON_REQUEST",
    null,
    undefined,
    0,
    false,
    {},
    ["never"]
  ]) {
    assert.equal(
      isApprovalPolicy(invalid),
      false,
      `${JSON.stringify(invalid) ?? String(invalid)} must be rejected`
    );
  }
});
