import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_NAV_GROUPS,
  CANONICAL_NAVIGATION,
  canonicalNavGroupOf,
  isCanonicalNavGroupId,
  isCanonicalNavSection,
  isOpenTelemetrySpanId,
  isOpenTelemetryTraceId,
  isSandboxMode,
  isSkillEligibleForRole,
  navOrderOf,
  SANDBOX_MODES,
  validateAgentDefinition
} from "../src/index.ts";

test("CANONICAL_NAV_GROUPS defines Configure/Observe/Operate with exact 14 sections in canonical order", () => {
  // The grouped definition is the single source of truth.
  assert.deepEqual(
    CANONICAL_NAV_GROUPS.map((group) => group.id),
    ["Configure", "Observe", "Operate"]
  );

  // This definition is the source of truth for resource grouping and route
  // ownership. The target Console contract places Playtesting in Observe.
  assert.deepEqual(CANONICAL_NAV_GROUPS[0]?.sections, [
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
    "Playtesting",
    "Memory"
  ]);
  assert.deepEqual(CANONICAL_NAV_GROUPS[2]?.sections, ["Workspaces", "GitHub"]);

  // The flattened list is derived from the grouped definition.
  const expected = [
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
    "Memory",
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

test("SANDBOX_MODES is the one place the sandbox vocabulary is written", () => {
  // `SandboxMode` is derived from this list, so the guard accepts exactly what
  // the type admits. A consumer that validates with `isSandboxMode` therefore
  // cannot end up narrower than the type (rejecting a mode it should allow) or
  // wider (accepting one it should not) -- which is what a hand-written
  // `=== "read-only" || ...` chain in a consumer allowed to happen silently.
  assert.ok(SANDBOX_MODES.length > 0, "the vocabulary must not be empty");
  assert.equal(
    new Set(SANDBOX_MODES).size,
    SANDBOX_MODES.length,
    "the vocabulary must not repeat a mode"
  );
  for (const mode of SANDBOX_MODES) {
    assert.equal(isSandboxMode(mode), true, `${mode} must validate`);
  }
});

test("isSandboxMode fails fast on anything outside the vocabulary", () => {
  // Near-misses matter more than nonsense here: a drifted mode reaching the UI
  // renders as a confident novel policy name rather than an error.
  for (const invalid of [
    "",
    "Read-Only",
    "READ-ONLY",
    "workspace_write",
    "workspaceWrite",
    "workspace-write ",
    "anything-goes",
    null,
    undefined,
    0,
    false,
    {},
    ["read-only"]
  ]) {
    assert.equal(
      isSandboxMode(invalid),
      false,
      `${JSON.stringify(invalid) ?? String(invalid)} must be rejected`
    );
  }
});
