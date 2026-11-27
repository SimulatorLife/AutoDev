/**
MiniMax Code profile materialization.

The profile is a projection of the canonical `.rulesync/` sources, produced
by stock RuleSync targets. The expectations here are therefore derived from
those canonical sources rather than from a copy of their content: a test
that restates the instructions, the hook inventory or the deny list would
break on every ordinary edit to the canonical source and would hide a real
regression behind a content change.

The four concerns are kept apart:

- projection correctness: the profile carries the canonical content;
- installation reconciliation: materialization is idempotent and reports
  drift, and it removes what it supersedes;
- security invariants: the profile never answers a tool call itself and
  never exposes a server beyond the role;
- provider acceptance: the artifacts are in the shape MiniMax Code reads.
*/

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseJsoncObject } from "@simulatorlife/autodev-data/files";

import { extractHookToolCall } from "../src/hooks/hook-payload.ts";
import {
  materializeMcodeProfile,
  renderMcodeProfileArtifacts,
  toMcodeHookMatcher,
  toMcodePermissionEntry
} from "../src/platform/mcode-profile.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const collator = new Intl.Collator();
const CANONICAL_ROOT = path.join(REPO_ROOT, ".rulesync");

interface McodePermissionDocument {
  readonly version: number;
  readonly allow: readonly unknown[];
  readonly deny: readonly {
    readonly tool_name: string;
    readonly matcher: {
      readonly kind: string;
      readonly pattern?: string;
      readonly actions?: readonly string[];
    };
  }[];
  readonly ask: readonly unknown[];
}

interface McodeHookGroup {
  readonly matcher?: string;
  readonly hooks: readonly {
    readonly type: string;
    readonly command: string;
  }[];
}

interface McodeHooksDocument {
  readonly enabled?: boolean;
  readonly hooks?: Record<string, readonly McodeHookGroup[]>;
}

function readHooksDocument(profileDirectory: string): McodeHooksDocument {
  return JSON.parse(
    readFileSync(path.join(profileDirectory, "hooks.json"), "utf8")
  ) as McodeHooksDocument;
}

/**
The body of the canonical rule source, with its frontmatter removed.

RuleSync projects the body verbatim and prepends a preamble of its own, so
the body is what the profile has to carry.
*/
function canonicalRuleBody(): string {
  const source = readFileSync(
    path.join(CANONICAL_ROOT, "rules", "overview.md"),
    "utf8"
  );
  const frontmatterEnd = source.indexOf("\n---\n", 4);
  assert.notEqual(
    frontmatterEnd,
    -1,
    "the canonical rule source has no closing frontmatter"
  );
  return source.slice(frontmatterEnd + 5).trim();
}

/**
The canonical hook declarations, keyed by their source event name.
*/
function canonicalHooks(): Record<
  string,
  readonly { readonly matcher?: string; readonly command: string }[]
> {
  const source = parseJsoncObject(
    readFileSync(path.join(CANONICAL_ROOT, "hooks.jsonc"), "utf8"),
    ".rulesync/hooks.jsonc"
  );
  const hooks = source.hooks;
  assert.ok(hooks && typeof hooks === "object", "the canonical hooks exist");
  return hooks as Record<
    string,
    readonly { readonly matcher?: string; readonly command: string }[]
  >;
}

/**
The canonical deny patterns MiniMax Code can express.

A rule that names an MCP server is left out: MiniMax Code matches a rule
by exact tool name and cannot express "every tool of one MCP server", so
those rules stay with the canonical role contract.
*/
function canonicalDenyPatterns(home: string): Set<string> {
  const source = parseJsoncObject(
    readFileSync(path.join(CANONICAL_ROOT, "permissions.jsonc"), "utf8"),
    ".rulesync/permissions.jsonc"
  );
  const permission = source.permission;
  assert.ok(
    permission && typeof permission === "object",
    "the canonical permission map exists"
  );
  const patterns = new Set<string>();
  for (const [category, rules] of Object.entries(
    permission as Record<string, Record<string, string>>
  )) {
    if (category.startsWith("mcp")) continue;
    for (const [pattern, decision] of Object.entries(rules)) {
      if (decision !== "deny") continue;
      patterns.add(
        pattern.startsWith("~/") ? path.join(home, pattern.slice(2)) : pattern
      );
    }
  }
  return patterns;
}

// ---------------------------------------------------------------------------
// Projection correctness
// ---------------------------------------------------------------------------

test("failed RuleSync profile generation disposes its temporary output", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-mcode-failed-"));
  const previous = process.env.TMPDIR;
  try {
    process.env.TMPDIR = root;
    assert.throws(
      () =>
        renderMcodeProfileArtifacts({
          repositoryRoot: path.join(root, "missing-checkout")
        }),
      /missing-rulesync/u
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the MiniMax Code profile instructions carry the canonical rules", () => {
  const artifacts = renderMcodeProfileArtifacts({
    repositoryRoot: REPO_ROOT,
    home: "/Users/example"
  });
  const body = canonicalRuleBody();
  assert.ok(body, "the canonical rule body is present");
  // RuleSync prepends a preamble of its own and projects the canonical body
  // verbatim, so the body has to be the tail of the generated instructions.
  assert.ok(
    artifacts.agentsMd.trimEnd().endsWith(body),
    "the profile instructions do not end with the canonical rule body"
  );
  assert.match(artifacts.agentsMd, /^# /u);
});

test("the MiniMax Code profile hooks carry the canonical hook declarations", () => {
  const artifacts = renderMcodeProfileArtifacts({
    repositoryRoot: REPO_ROOT,
    home: "/Users/example"
  });
  const hooks = JSON.parse(artifacts.hooksJson) as McodeHooksDocument;
  assert.ok(hooks.hooks, "the profile carries hooks");
  const canonical = canonicalHooks();

  // RuleSync projects the shared events into Claude's native dialect.
  const eventKey = (event: string) =>
    event === "UserPromptSubmit" ? "beforesubmitprompt" : event.toLowerCase();
  const profileEvents = Object.keys(hooks.hooks).map(eventKey);
  assert.deepEqual(
    profileEvents.sort((left, right) => collator.compare(left, right)),
    Object.keys(canonical)
      .map((event) => event.toLowerCase())
      .sort((left, right) => collator.compare(left, right))
  );

  for (const [event, groups] of Object.entries(hooks.hooks)) {
    const canonicalEntry = Object.entries(canonical).find(
      ([name]) => name.toLowerCase() === eventKey(event)
    );
    assert.ok(canonicalEntry, `the canonical source declares ${event}`);
    const canonicalGroups = canonicalEntry[1];
    assert.equal(groups.length, canonicalGroups.length, event);
    for (const [index, group] of groups.entries()) {
      const canonicalGroup = canonicalGroups[index];
      assert.ok(canonicalGroup, `${event}/${index}`);
      assert.equal(group.hooks.length, 1, `${event}/${index}`);
      assert.equal(group.hooks[0]?.type, "command", `${event}/${index}`);
      assert.equal(
        group.hooks[0]?.command,
        /\/hooks\/(?:session-start\.ts|native-session\.ts (?:prompt|stop|end))$/u.test(
          canonicalGroup.command
        )
          ? canonicalGroup.command + " --client=mcode"
          : canonicalGroup.command,
        `${event}/${index}`
      );
    }
  }
});

test("the MiniMax Code profile permissions carry the canonical deny rules", () => {
  const home = "/Users/example";
  const artifacts = renderMcodeProfileArtifacts({
    repositoryRoot: REPO_ROOT,
    home
  });
  const permissions = JSON.parse(
    artifacts.permissionJson
  ) as McodePermissionDocument;
  const projected = new Set(
    permissions.deny
      .map((entry) => entry.matcher.pattern)
      .filter((pattern): pattern is string => typeof pattern === "string")
  );
  assert.deepEqual(
    projected,
    canonicalDenyPatterns(home),
    "the profile deny list does not match the canonical deny rules"
  );
});

// ---------------------------------------------------------------------------
// Security invariants
// ---------------------------------------------------------------------------

test("the MiniMax Code profile denies without ever answering a tool call", () => {
  const artifacts = renderMcodeProfileArtifacts({
    repositoryRoot: REPO_ROOT,
    home: "/Users/example"
  });
  const permissions = JSON.parse(
    artifacts.permissionJson
  ) as McodePermissionDocument;
  // A MiniMax Code allow rule answers a tool call without asking the ACP
  // client, which would take the role contract out of the decision.
  assert.deepEqual(permissions.allow, []);
  assert.deepEqual(permissions.ask, []);
  // A rule that names an MCP server cannot be expressed, so the server stays
  // with the canonical role contract rather than with the profile.
  assert.deepEqual(
    permissions.deny
      .filter((entry) => entry.tool_name.startsWith("mcp"))
      .map((entry) => entry.tool_name),
    []
  );
});

test("managed MiniMax profile reconciliation cannot touch the operator profile", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-mcode-home-"));
  try {
    const operatorProfile = path.join(home, ".minimax");
    mkdirSync(operatorProfile);
    const nativeMcp = path.join(operatorProfile, "mcp.json");
    const original = '{"mcpServers":{"operator-owned":{}}}\n';
    writeFileSync(nativeMcp, original);
    const alias = path.join(home, "alias");
    symlinkSync(operatorProfile, alias, "dir");

    for (const profileDirectory of [
      operatorProfile,
      home,
      path.join(operatorProfile, "nested"),
      alias,
      path.join(alias, "not-created")
    ]) {
      for (const check of [true, false]) {
        assert.throws(
          () =>
            materializeMcodeProfile({
              repositoryRoot: REPO_ROOT,
              profileDirectory,
              home,
              check
            }),
          /overlaps the operator profile/u
        );
      }
    }
    assert.equal(readFileSync(nativeMcp, "utf8"), original);
    assert.equal(existsSync(path.join(operatorProfile, "AGENTS.md")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the MiniMax Code profile holds no MCP configuration", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-mcode-home-"));
  const profileDirectory = path.join(home, "providers", "mcode");
  try {
    materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home
    });
    // The role's authorized MCP servers are injected into the ACP session, and
    // a profile-level list would expose servers to roles that do not hold
    // them.
    assert.equal(existsSync(path.join(profileDirectory, "mcp.json")), false);
    assert.equal(
      existsSync(path.join(profileDirectory, "permissions.json")),
      false
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Installation reconciliation
// ---------------------------------------------------------------------------

test("the MiniMax Code profile materialization is idempotent and reports drift", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-mcode-home-"));
  const profileDirectory = path.join(home, "providers", "mcode");
  try {
    materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home
    });
    const second = materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home
    });
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.drifted, []);

    writeFileSync(path.join(profileDirectory, "hooks.json"), "{}\n");
    const drift = materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home,
      check: true
    });
    assert.deepEqual(drift.drifted, [
      path.join(profileDirectory, "hooks.json")
    ]);

    const repaired = materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home
    });
    assert.deepEqual(repaired.drifted, []);
    assert.deepEqual(repaired.written, [
      path.join(profileDirectory, "hooks.json")
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the MiniMax Code profile removes the superseded projection files", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-mcode-home-"));
  const profileDirectory = path.join(home, "providers", "mcode");
  try {
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(profileDirectory, "mcp.json"),
      `${JSON.stringify({ mcpServers: { playwright: { command: "npx" } } })}\n`
    );
    writeFileSync(
      path.join(profileDirectory, "permissions.json"),
      `${JSON.stringify({ permission: { bash: { "*": "allow" } } })}\n`
    );
    const result = materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home
    });
    assert.equal(existsSync(path.join(profileDirectory, "mcp.json")), false);
    assert.equal(
      existsSync(path.join(profileDirectory, "permissions.json")),
      false
    );
    assert.equal(result.removed.length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the MiniMax Code profile links the operator's own configuration", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-mcode-home-"));
  const profileDirectory = path.join(home, "providers", "mcode");
  try {
    const operatorProfile = path.join(home, ".minimax");
    mkdirSync(path.join(operatorProfile, "auth"), {
      recursive: true,
      mode: 0o700
    });
    writeFileSync(
      path.join(operatorProfile, "config.yaml"),
      "defaultModel: minimax/MiniMax-M3\n"
    );
    materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home
    });
    assert.equal(
      readFileSync(path.join(profileDirectory, "config.yaml"), "utf8"),
      "defaultModel: minimax/MiniMax-M3\n"
    );
    assert.equal(existsSync(path.join(profileDirectory, "auth")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a stale operator link is replaced instead of left pointing elsewhere", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-mcode-home-"));
  const profileDirectory = path.join(home, "providers", "mcode");
  try {
    const operatorProfile = path.join(home, ".minimax");
    mkdirSync(operatorProfile, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(operatorProfile, "config.yaml"), "model: one\n");
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
    symlinkSync(
      path.join(home, "elsewhere.yaml"),
      path.join(profileDirectory, "config.yaml")
    );
    materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home
    });
    assert.equal(
      readFileSync(path.join(profileDirectory, "config.yaml"), "utf8"),
      "model: one\n"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Provider acceptance
// ---------------------------------------------------------------------------

test("the MiniMax Code hooks document is in the shape MiniMax Code reads", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-mcode-home-"));
  const profileDirectory = path.join(home, "providers", "mcode");
  try {
    materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home
    });
    const hooks = readHooksDocument(profileDirectory);
    // MiniMax Code keeps user hooks off unless the document enables them.
    assert.equal(hooks.enabled, true);
    assert.ok(hooks.hooks);
    for (const [event, groups] of Object.entries(hooks.hooks)) {
      for (const group of groups) {
        assert.ok(Array.isArray(group.hooks), event);
        for (const handler of group.hooks) {
          assert.equal(handler.type, "command", event);
          assert.ok(handler.command.length > 0, event);
        }
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the projected MiniMax Code hooks match only MiniMax Code tool names", () => {
  const artifacts = renderMcodeProfileArtifacts({
    repositoryRoot: REPO_ROOT,
    home: "/Users/example"
  });
  const hooks = JSON.parse(artifacts.hooksJson) as McodeHooksDocument;
  assert.ok(hooks.hooks);
  const matchers = Object.values(hooks.hooks).flatMap((groups) =>
    groups.map((group) => group.matcher)
  );
  assert.ok(matchers.length > 0);
  for (const matcher of matchers) {
    if (matcher === undefined) continue;
    assert.ok(matcher);
    // MiniMax Code rejects a matcher that carries an inline flag, and
    // matches a plain tool-name list exactly.
    assert.doesNotMatch(matcher, /\(\?/u);
    if (matcher === ".*") continue;
    for (const part of matcher.split("|")) {
      assert.match(part, /^[A-Za-z0-9_.:/-]+$/u);
    }
  }
});

test("the rendered MiniMax Code artifacts are stable across renders", () => {
  const first = renderMcodeProfileArtifacts({
    repositoryRoot: REPO_ROOT,
    home: "/Users/example"
  });
  const second = renderMcodeProfileArtifacts({
    repositoryRoot: REPO_ROOT,
    home: "/Users/example"
  });
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// Unit tests of the translation, on controlled inputs
// ---------------------------------------------------------------------------

test("Claude permission rules translate into MiniMax Code's native v2 rules", () => {
  const home = "/Users/example";
  assert.deepEqual(toMcodePermissionEntry("Bash(exit 1)", home), {
    tool_name: "bash",
    matcher: { kind: "command", pattern: "exit 1" }
  });
  assert.deepEqual(toMcodePermissionEntry("Bash", home), {
    tool_name: "bash",
    matcher: { kind: "tool" }
  });
  assert.deepEqual(toMcodePermissionEntry("Read(~/.config/**)", home), {
    tool_name: "read",
    matcher: {
      kind: "path",
      pattern: "/Users/example/.config/**",
      actions: ["read"]
    }
  });
  assert.deepEqual(toMcodePermissionEntry("WebFetch", home), {
    tool_name: "web_fetch",
    matcher: { kind: "tool" }
  });
  // MiniMax Code matches a rule by exact tool name and cannot express
  // "every tool of one MCP server", so a server selector stays with the
  // canonical role contract.
  for (const unsupported of [
    "mcp__playwright",
    "constructor",
    "__proto__",
    "toString"
  ]) {
    assert.equal(toMcodePermissionEntry(unsupported, home), null);
  }
});

test("canonical hook matchers are projected onto MiniMax Code's tool names", () => {
  // MiniMax Code rejects a matcher that carries an inline flag, so the
  // canonical declarations are resolved against the canonical tool vocabulary
  // and re-emitted as a MiniMax Code tool-name list.
  assert.equal(toMcodeHookMatcher(".*"), ".*");
  assert.equal(toMcodeHookMatcher("(?i)^write[_ -]?to[_ -]?file$"), "write");
  assert.equal(toMcodeHookMatcher("(?i)read[_ -]?file|read"), "read");
  assert.equal(
    toMcodeHookMatcher("(?i)^(apply[_ -]?patch|write[_ -]?to[_ -]?file)$"),
    "apply_patch|write"
  );
  // A matcher that names no canonical tool cannot be projected.
  assert.equal(toMcodeHookMatcher("(?i)not_a_tool"), null);
});

test("a MiniMax Code tool name is translated into the canonical hook dialect", () => {
  const previous = process.env.AUTODEV_PROVIDER;
  process.env.AUTODEV_PROVIDER = "mcode";
  try {
    assert.equal(
      extractHookToolCall({ tool_name: "write", tool_input: {} })?.toolName,
      "write_to_file"
    );
    assert.equal(
      extractHookToolCall({ tool_name: "edit", tool_input: {} })?.toolName,
      "replace_file_content"
    );
    assert.equal(
      extractHookToolCall({ tool_name: "read", tool_input: {} })?.toolName,
      "read_file"
    );
    assert.equal(
      extractHookToolCall({ tool_name: "bash", tool_input: {} })?.toolName,
      "bash"
    );
  } finally {
    if (previous === undefined) delete process.env.AUTODEV_PROVIDER;
    else process.env.AUTODEV_PROVIDER = previous;
  }

  // Another provider keeps its own tool names.
  process.env.AUTODEV_PROVIDER = "codex";
  try {
    assert.equal(
      extractHookToolCall({ tool_name: "write", tool_input: {} })?.toolName,
      "write"
    );
  } finally {
    delete process.env.AUTODEV_PROVIDER;
  }
});
