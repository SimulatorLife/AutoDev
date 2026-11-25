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

import { extractHookToolCall } from "../src/hooks/hook-payload.ts";
import {
  materializeMcodeProfile,
  renderMcodeProfileArtifacts,
  toMcodeHookMatcher,
  toMcodePermissionEntry
} from "../src/platform/mcode-profile.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

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

function readPermissionDocument(profileDirectory: string): McodePermissionDocument {
  return JSON.parse(
    readFileSync(path.join(profileDirectory, "permission.json"), "utf8")
  ) as McodePermissionDocument;
}

test("the MiniMax Code profile carries the canonical RuleSync artifacts", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-mcode-home-"));
  const profileDirectory = path.join(home, "providers", "mcode");
  try {
    const result = materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home
    });
    assert.deepEqual(result.drifted, []);
    assert.equal(result.written.length, 3);

    // The profile instructions are the same projection the repository tracks,
    // so a session in any workspace reads the canonical instructions.
    assert.equal(
      readFileSync(path.join(profileDirectory, "AGENTS.md"), "utf8"),
      readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8")
    );

    // The hooks document is the native MiniMax Code user hook envelope: the
    // document enables the hooks, and every event carries the Claude group
    // shape MiniMax Code parses.
    const hooks = JSON.parse(
      readFileSync(path.join(profileDirectory, "hooks.json"), "utf8")
    ) as {
      enabled?: boolean;
      hooks?: Record<
        string,
        { matcher?: string; hooks: { type: string; command: string }[] }[]
      >;
    };
    assert.equal(hooks.enabled, true);
    assert.ok(hooks.hooks);
    assert.ok(hooks.hooks.SessionStart);
    assert.ok(hooks.hooks.PreToolUse);
    for (const groups of Object.values(hooks.hooks)) {
      for (const group of groups) {
        assert.ok(Array.isArray(group.hooks));
        for (const handler of group.hooks) {
          assert.equal(handler.type, "command");
          assert.match(handler.command, /run-autodev-hook\.sh/u);
        }
      }
    }

    // The permission document is MiniMax Code's native v2 shape and carries
    // the canonical deny list only: an allow rule would answer a tool call
    // without asking the ACP client and take the role contract out of the
    // decision.
    const permissions = readPermissionDocument(profileDirectory);
    assert.equal(permissions.version, 2);
    assert.deepEqual(permissions.allow, []);
    assert.deepEqual(permissions.ask, []);
    assert.ok(
      permissions.deny.some(
        (entry) =>
          entry.tool_name === "bash" &&
          entry.matcher.kind === "command" &&
          entry.matcher.pattern === "rm -rf *"
      )
    );
    assert.ok(
      permissions.deny.some(
        (entry) =>
          entry.tool_name === "read" &&
          entry.matcher.kind === "path" &&
          entry.matcher.pattern === path.join(home, ".ssh", "**") &&
          entry.matcher.actions?.includes("read")
      )
    );

    // The profile holds no MCP configuration: the role's authorized servers
    // are injected into the ACP session, and a profile-level list would
    // expose servers beyond the role.
    assert.equal(existsSync(path.join(profileDirectory, "mcp.json")), false);
    assert.equal(existsSync(path.join(profileDirectory, "permissions.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(drift.drifted, [path.join(profileDirectory, "hooks.json")]);

    const repaired = materializeMcodeProfile({
      repositoryRoot: REPO_ROOT,
      profileDirectory,
      home
    });
    assert.deepEqual(repaired.drifted, []);
    assert.deepEqual(repaired.written, [path.join(profileDirectory, "hooks.json")]);
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
    assert.equal(existsSync(path.join(profileDirectory, "permissions.json")), false);
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
    mkdirSync(path.join(operatorProfile, "auth"), { recursive: true, mode: 0o700 });
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

test("Claude permission rules translate into MiniMax Code's native v2 rules", () => {
  const home = "/Users/example";
  assert.deepEqual(toMcodePermissionEntry("Bash(rm -rf *)", home), {
    tool_name: "bash",
    matcher: { kind: "command", pattern: "rm -rf *" }
  });
  assert.deepEqual(toMcodePermissionEntry("Bash", home), {
    tool_name: "bash",
    matcher: { kind: "tool" }
  });
  assert.deepEqual(toMcodePermissionEntry("Read(~/.ssh/**)", home), {
    tool_name: "read",
    matcher: {
      kind: "path",
      pattern: "/Users/example/.ssh/**",
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
  assert.equal(toMcodePermissionEntry("mcp__playwright", home), null);
});

test("canonical hook matchers are projected onto MiniMax Code's tool names", () => {
  // MiniMax Code rejects a matcher that carries an inline flag, so the
  // canonical declarations are resolved against the canonical tool vocabulary
  // and re-emitted as a MiniMax Code tool-name list.
  assert.equal(toMcodeHookMatcher(".*"), ".*");
  assert.equal(
    toMcodeHookMatcher(
      "(?i)^(apply[_ -]?patch|view[_ -]?image|write[_ -]?to[_ -]?file|replace[_ -]?file[_ -]?content|multi[_ -]?replace[_ -]?file[_ -]?content)$"
    ),
    "apply_patch|edit|write"
  );
  assert.equal(
    toMcodeHookMatcher("(?i)exec[_ -]?command|run[_ -]?command|bash"),
    "bash"
  );
  assert.equal(
    toMcodeHookMatcher(
      "(?i)^(apply[_ -]?patch|exec[_ -]?command|execute[_ -]?command|unified[_ -]?exec|write[_ -]?stdin|shell|bash|sh|zsh|run[_ -]?command|call[_ -]?mcp[_ -]?tool|write[_ -]?to[_ -]?file|replace[_ -]?file[_ -]?content|multi[_ -]?replace[_ -]?file[_ -]?content)$"
    ),
    "apply_patch|bash|edit|write"
  );
  // A matcher that names no canonical tool cannot be projected.
  assert.equal(toMcodeHookMatcher("(?i)not_an_auto_dev_tool"), null);
});

test("the projected MiniMax Code hooks match only MiniMax Code tool names", () => {
  const artifacts = renderMcodeProfileArtifacts({
    repositoryRoot: REPO_ROOT,
    home: "/Users/example"
  });
  const hooks = JSON.parse(artifacts.hooksJson) as {
    hooks: Record<string, { matcher?: string }[]>;
  };
  const matchers = Object.values(hooks.hooks).flatMap((groups) =>
    groups.map((group) => group.matcher)
  );
  assert.ok(matchers.length > 0);
  for (const matcher of matchers) {
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
  assert.match(first.agentsMd, /# Additional Conventions/u);
  assert.match(first.hooksJson, /"enabled": true/u);
  assert.match(first.permissionJson, /"version": 2/u);
});

test("a stale operator link is replaced instead of left pointing elsewhere", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-mcode-home-"));
  const profileDirectory = path.join(home, "providers", "mcode");
  try {
    const operatorProfile = path.join(home, ".minimax");
    mkdirSync(operatorProfile, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(operatorProfile, "config.yaml"), "model: one\n");
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
    symlinkSync(path.join(home, "elsewhere.yaml"), path.join(profileDirectory, "config.yaml"));
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
