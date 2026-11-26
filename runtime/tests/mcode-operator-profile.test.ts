/**
Standalone MiniMax Code operator profile enrollment.

The operator profile (`~/.minimax`) is read by the MiniMax Code desktop app
and the standalone `mcode` CLI, and it belongs to the operator. Enrollment
therefore merges the canonical RuleSync projection into it and never
replaces what the operator wrote. The expectations are derived from one
rendering of the canonical sources, not from a copy of their content.

The concerns are kept apart:

- merge correctness: canonical content is present and operator content is
  preserved byte for byte where enrollment has no business;
- reconciliation: enrollment is idempotent, reports drift, and retires only
  AutoDev's own former contributions;
- operator authority: an operator choice enrollment would have to override is
  reported as a conflict and left alone;
- isolation: the operator profile and the managed profile never overlap.
*/

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  enrollMcodeOperatorProfile,
  MCODE_GLOBAL_INSTRUCTIONS_MAX_BYTES,
  type McodeProfileArtifacts,
  mergeOperatorInstructions,
  OPERATOR_ENROLLMENT_RECORD,
  reconcileMcodeProfiles,
  renderMcodeProfileArtifacts
} from "../src/platform/mcode-profile.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const OPERATOR_INSTRUCTIONS = "Prefer short answers.\n";
const OPERATOR_ALLOW = {
  tool_name: "bash",
  matcher: { kind: "command", pattern: "curl:*" }
};
const OPERATOR_DENY = {
  tool_name: "bash",
  matcher: { kind: "command", pattern: "shutdown *" }
};
const OPERATOR_HOOK = {
  matcher: "bash",
  hooks: [{ type: "command", command: "/usr/local/bin/operator-audit" }]
};
const OPERATOR_MCP = `${JSON.stringify({
  mcpServers: {
    "cocoindex-code": {
      command: "bash",
      args: ["-lc", 'exec "$HOME/.codex/hooks/run-autodev-mcp.sh" cocoindex-code']
    }
  }
})}\n`;

const renderings = new Map<string, McodeProfileArtifacts>();

/**
One rendering of the canonical sources per home, shared by every test.
*/
function artifactsFor(home: string): McodeProfileArtifacts {
  let artifacts = renderings.get(home);
  if (!artifacts) {
    artifacts = renderMcodeProfileArtifacts({ repositoryRoot: REPO_ROOT, home });
    renderings.set(home, artifacts);
  }
  return artifacts;
}

interface Fixture {
  readonly home: string;
  readonly autodevHome: string;
  readonly operatorProfile: string;
  readonly managedProfile: string;
  readonly record: string;
}

function withFixture(run: (fixture: Fixture) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-mcode-operator-"));
  const home = path.join(root, "home");
  const autodevHome = path.join(home, ".autodev");
  mkdirSync(home);
  try {
    run({
      home,
      autodevHome,
      operatorProfile: path.join(home, ".minimax"),
      managedProfile: path.join(autodevHome, "providers", "mcode"),
      record: path.join(autodevHome, OPERATOR_ENROLLMENT_RECORD)
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedOperatorProfile(fixture: Fixture): void {
  const profile = fixture.operatorProfile;
  mkdirSync(path.join(profile, "auth"), { recursive: true });
  writeFileSync(path.join(profile, "AGENTS.md"), OPERATOR_INSTRUCTIONS);
  writeFileSync(path.join(profile, "config.yaml"), "defaultModel: minimax/MiniMax-M3\n");
  writeFileSync(path.join(profile, "auth", "token"), "secret\n");
  writeFileSync(path.join(profile, "mcp.json"), OPERATOR_MCP);
  writeFileSync(
    path.join(profile, "permission.json"),
    `${JSON.stringify({ version: 2, allow: [OPERATOR_ALLOW], deny: [OPERATOR_DENY], ask: [] })}\n`
  );
  writeFileSync(
    path.join(profile, "hooks.json"),
    `${JSON.stringify({ enabled: true, hooks: { PreToolUse: [OPERATOR_HOOK] } })}\n`
  );
}

function enroll(fixture: Fixture, isCheck = false) {
  return enrollMcodeOperatorProfile({
    repositoryRoot: REPO_ROOT,
    managedProfileDirectory: fixture.managedProfile,
    enrollmentRecord: fixture.record,
    home: fixture.home,
    check: isCheck,
    artifacts: artifactsFor(fixture.home)
  });
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function hookGroups(profile: string): Record<string, unknown[]> {
  return readJson(path.join(profile, "hooks.json")).hooks as Record<string, unknown[]>;
}

// ---------------------------------------------------------------------------
// Merge correctness
// ---------------------------------------------------------------------------

test("enrollment adds the canonical projection and preserves operator state", () => {
  withFixture((fixture) => {
    seedOperatorProfile(fixture);
    const artifacts = artifactsFor(fixture.home);
    const result = enroll(fixture);
    assert.deepEqual(result.conflicts, []);
    const profile = fixture.operatorProfile;

    const instructions = readFileSync(path.join(profile, "AGENTS.md"), "utf8");
    assert.ok(instructions.startsWith(OPERATOR_INSTRUCTIONS.trimEnd()));
    assert.ok(instructions.includes(artifacts.agentsMd.trimEnd()));

    const hooks = readJson(path.join(profile, "hooks.json"));
    assert.equal(hooks.enabled, true);
    const groups = hookGroups(profile);
    assert.deepEqual(groups.PreToolUse?.[0], OPERATOR_HOOK);
    for (const [event, canonical] of Object.entries(artifacts.hooks)) {
      for (const group of canonical as unknown[]) {
        assert.ok(
          groups[event]?.some((entry) => JSON.stringify(entry) === JSON.stringify(group)),
          `canonical ${event} hook enrolled`
        );
      }
    }

    const permission = readJson(path.join(profile, "permission.json"));
    assert.deepEqual(permission.allow, [OPERATOR_ALLOW]);
    assert.deepEqual(permission.ask, []);
    assert.deepEqual(permission.deny, [OPERATOR_DENY, ...artifacts.deny]);
    assert.ok(artifacts.deny.length > 0, "the canonical source denies something");

    // Model configuration, credentials and MCP registrations are the
    // operator's and are not reconciled here.
    assert.equal(readFileSync(path.join(profile, "mcp.json"), "utf8"), OPERATOR_MCP);
    assert.equal(
      readFileSync(path.join(profile, "config.yaml"), "utf8"),
      "defaultModel: minimax/MiniMax-M3\n"
    );
    assert.equal(readFileSync(path.join(profile, "auth", "token"), "utf8"), "secret\n");
  });
});

test("an operator profile with no AutoDev files gains the canonical ones", () => {
  withFixture((fixture) => {
    mkdirSync(fixture.operatorProfile);
    const artifacts = artifactsFor(fixture.home);
    const result = enroll(fixture);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(hookGroups(fixture.operatorProfile), artifacts.hooks);
    assert.deepEqual(
      readJson(path.join(fixture.operatorProfile, "permission.json")),
      { version: 2, allow: [], ask: [], deny: artifacts.deny }
    );
    assert.equal(existsSync(path.join(fixture.operatorProfile, "mcp.json")), false);
  });
});

test("the canonical rules block is replaced in place, keeping operator text around it", () => {
  const first = mergeOperatorInstructions("Before.\n", "rules v1\n");
  const withAfter = `${first}After.\n`;
  const second = mergeOperatorInstructions(withAfter, "rules v2\n");
  assert.ok(second.startsWith("Before.\n\n"));
  assert.ok(second.endsWith("After.\n"));
  assert.ok(second.includes("rules v2"));
  assert.ok(!second.includes("rules v1"));
  assert.equal(mergeOperatorInstructions(second, "rules v2\n"), second);
});

test("an absent operator profile is not created", () => {
  withFixture((fixture) => {
    const result = enroll(fixture);
    assert.equal(result.profileDirectory, null);
    assert.equal(existsSync(fixture.operatorProfile), false);
    assert.equal(existsSync(fixture.record), false);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

test("enrollment is idempotent and reports drift in check mode", () => {
  withFixture((fixture) => {
    seedOperatorProfile(fixture);
    const before = enroll(fixture, true);
    assert.ok(before.drifted.length > 0);
    assert.deepEqual(before.written, []);
    assert.equal(
      readFileSync(path.join(fixture.operatorProfile, "AGENTS.md"), "utf8"),
      OPERATOR_INSTRUCTIONS,
      "check mode never writes"
    );

    enroll(fixture);
    const second = enroll(fixture);
    assert.deepEqual(second.written, []);
    assert.deepEqual(enroll(fixture, true).drifted, []);

    writeFileSync(
      path.join(fixture.operatorProfile, "hooks.json"),
      `${JSON.stringify({ enabled: true, hooks: { PreToolUse: [OPERATOR_HOOK] } })}\n`
    );
    assert.deepEqual(enroll(fixture, true).drifted, [
      path.join(fixture.operatorProfile, "hooks.json")
    ]);
  });
});

test("reconciliation retires only AutoDev's former contributions", () => {
  withFixture((fixture) => {
    seedOperatorProfile(fixture);
    // The record holds each contribution as JSON with sorted keys.
    const staleHook = {
      hooks: [{ command: "~/.autodev/hooks/run-autodev-hook.sh retired.ts", type: "command" }],
      matcher: "bash"
    };
    const staleDeny = {
      matcher: { kind: "command", pattern: "retired *" },
      tool_name: "bash"
    };
    writeFileSync(
      path.join(fixture.operatorProfile, "hooks.json"),
      `${JSON.stringify({ enabled: true, hooks: { PreToolUse: [OPERATOR_HOOK, staleHook] } })}\n`
    );
    writeFileSync(
      path.join(fixture.operatorProfile, "permission.json"),
      `${JSON.stringify({ version: 2, allow: [], deny: [OPERATOR_DENY, staleDeny], ask: [] })}\n`
    );
    mkdirSync(path.dirname(fixture.record), { recursive: true });
    writeFileSync(
      fixture.record,
      `${JSON.stringify({
        version: 1,
        hooks: { PreToolUse: [JSON.stringify(staleHook)] },
        deny: [JSON.stringify(staleDeny)]
      })}\n`
    );

    enroll(fixture);
    const groups = hookGroups(fixture.operatorProfile);
    assert.deepEqual(groups.PreToolUse?.[0], OPERATOR_HOOK);
    assert.ok(!JSON.stringify(groups).includes("retired.ts"));
    const deny = readJson(path.join(fixture.operatorProfile, "permission.json"))
      .deny as unknown[];
    assert.deepEqual(deny[0], OPERATOR_DENY);
    assert.ok(!JSON.stringify(deny).includes("retired *"));
  });
});

// ---------------------------------------------------------------------------
// Operator authority
// ---------------------------------------------------------------------------

test("operator choices enrollment would override are reported, not changed", () => {
  withFixture((fixture) => {
    seedOperatorProfile(fixture);
    const profile = fixture.operatorProfile;
    const disabledHooks = `${JSON.stringify({ enabled: false, hooks: {} })}\n`;
    const foreignPermission = `${JSON.stringify({ version: 1, rules: [] })}\n`;
    const oversized = `${"x".repeat(MCODE_GLOBAL_INSTRUCTIONS_MAX_BYTES)}\n`;
    writeFileSync(path.join(profile, "hooks.json"), disabledHooks);
    writeFileSync(path.join(profile, "permission.json"), foreignPermission);
    writeFileSync(path.join(profile, "AGENTS.md"), oversized);

    const result = enroll(fixture);
    assert.equal(result.conflicts.length, 3);
    assert.equal(readFileSync(path.join(profile, "hooks.json"), "utf8"), disabledHooks);
    assert.equal(
      readFileSync(path.join(profile, "permission.json"), "utf8"),
      foreignPermission
    );
    assert.equal(readFileSync(path.join(profile, "AGENTS.md"), "utf8"), oversized);
  });
});

test("dormant operator hooks and unreadable documents are left alone", () => {
  withFixture((fixture) => {
    seedOperatorProfile(fixture);
    const profile = fixture.operatorProfile;
    const dormant = `${JSON.stringify({ hooks: { PreToolUse: [OPERATOR_HOOK] } })}\n`;
    writeFileSync(path.join(profile, "hooks.json"), dormant);
    writeFileSync(path.join(profile, "permission.json"), "{ not json");

    const result = enroll(fixture);
    assert.equal(result.conflicts.length, 2);
    assert.equal(readFileSync(path.join(profile, "hooks.json"), "utf8"), dormant);
    assert.equal(readFileSync(path.join(profile, "permission.json"), "utf8"), "{ not json");
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

test("enrollment refuses a managed profile that overlaps the operator profile", () => {
  withFixture((fixture) => {
    seedOperatorProfile(fixture);
    const alias = path.join(fixture.home, "alias");
    symlinkSync(fixture.operatorProfile, alias, "dir");
    for (const managedProfileDirectory of [
      fixture.operatorProfile,
      path.join(fixture.operatorProfile, "providers", "mcode"),
      fixture.home,
      path.join(alias, "mcode")
    ]) {
      assert.throws(
        () =>
          enrollMcodeOperatorProfile({
            repositoryRoot: REPO_ROOT,
            managedProfileDirectory,
            enrollmentRecord: fixture.record,
            home: fixture.home,
            artifacts: artifactsFor(fixture.home)
          }),
        /overlaps the operator profile/u
      );
    }
    assert.throws(
      () =>
        reconcileMcodeProfiles({
          repositoryRoot: REPO_ROOT,
          autodevHome: fixture.operatorProfile,
          home: fixture.home
        }),
      /overlaps the operator profile/u
    );
    assert.throws(
      () =>
        enrollMcodeOperatorProfile({
          repositoryRoot: REPO_ROOT,
          managedProfileDirectory: fixture.managedProfile,
          enrollmentRecord: path.join(alias, "record.json"),
          home: fixture.home,
          artifacts: artifactsFor(fixture.home)
        }),
      /outside the operator profile/u
    );
    assert.equal(
      readFileSync(path.join(fixture.operatorProfile, "AGENTS.md"), "utf8"),
      OPERATOR_INSTRUCTIONS
    );
  });
});

test("both profiles reconcile from one rendering and then verify clean", () => {
  withFixture((fixture) => {
    seedOperatorProfile(fixture);
    const first = reconcileMcodeProfiles({
      repositoryRoot: REPO_ROOT,
      autodevHome: fixture.autodevHome,
      home: fixture.home
    });
    assert.ok(first.managed.written.length > 0);
    assert.ok(first.operator.written.length > 0);
    assert.deepEqual(first.operator.conflicts, []);
    const check = reconcileMcodeProfiles({
      repositoryRoot: REPO_ROOT,
      autodevHome: fixture.autodevHome,
      home: fixture.home,
      check: true
    });
    assert.deepEqual(check.managed.drifted, []);
    assert.deepEqual(check.operator.drifted, []);
    // The managed profile still holds no MCP list, and the operator's is untouched.
    assert.equal(existsSync(path.join(fixture.managedProfile, "mcp.json")), false);
    assert.equal(
      readFileSync(path.join(fixture.operatorProfile, "mcp.json"), "utf8"),
      OPERATOR_MCP
    );
  });
});
