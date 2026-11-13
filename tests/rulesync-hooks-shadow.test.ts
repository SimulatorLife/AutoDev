import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  generateRepositoryRulesync,
  renderCodexUserHooks,
  writeCodexUserHooks
} from "@simulatorlife/autodev-runtime/platform/install-materializer";
import { parse } from "smol-toml";

type JsonObject = Record<string, unknown>;
type Hook = JsonObject & { type?: string; command?: string };

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(repositoryRoot, ".rulesync");
const hookSourcePath = join(sourceRoot, "hooks.jsonc");
const portableConfigPath = join(repositoryRoot, "config/config.autodev.toml");
const targets = [
  "codexcli",
  "claudecode",
  "copilot",
  "antigravity-cli"
] as const;
const hookPaths: Record<(typeof targets)[number], string> = {
  codexcli: ".codex/hooks.json",
  claudecode: ".claude/settings.json",
  copilot: ".github/hooks/copilot-hooks.json",
  "antigravity-cli": ".agents/hooks.json"
};
const sourceCommands = [
  "node ~/.codex/src/hooks/session-start.ts",
  "node ~/.codex/src/hooks/subagent-start.ts",
  "node ~/.codex/src/hooks/block-ccc-cli.ts",
  "node ~/.codex/src/hooks/skill-read-telemetry.ts"
];
/**
 * The root-delegation bootstrap names Codex's spawn tools and code-mode
 * `exec` cells, so only the hosts that route through AutoDev's Codex roots
 * run it. Shared, it put about 8 KB of Codex-only instructions into every
 * Claude Code prompt.
 */
const rootDelegation = "node ~/.codex/src/hooks/root-delegation.ts";

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}
function asObject(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}
function hooksAt(value: unknown): Record<string, Hook[]> {
  const result: Record<string, Hook[]> = {};
  for (const [key, entries] of Object.entries(asObject(value)))
    result[key] = (entries as unknown[]).map(asObject) as Hook[];
  return result;
}
function commands(config: JsonObject): string[] {
  return Object.values(hooksAt(config.hooks)).flatMap((entries) =>
    entries
      .filter((hook) => hook.type === "command")
      .map((hook) => String(hook.command))
  );
}
function groupedCommands(events: JsonObject): string[] {
  return Object.values(hooksAt(events)).flatMap((groups) =>
    groups.flatMap((group) => {
      const hooks = group.hooks;
      return Array.isArray(hooks)
        ? hooks
            .map(asObject)
            .filter((hook) => hook.type === "command")
            .map((hook) => String(hook.command))
        : [];
    })
  );
}
function generate(target: string, outputRoot: string): void {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "rulesync",
      "generate",
      "--input-roots",
      sourceRoot,
      "--targets",
      target,
      "--features",
      "hooks",
      "--output-roots",
      outputRoot,
      "--delete",
      "--silent"
    ],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 }
  );
  assert.equal(
    result.status,
    0,
    `Rulesync ${target} hook generation failed:\nSTDOUT=${result.stdout}\nSTDERR=${result.stderr}`
  );
}
function generatedFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files.push(relative(root, path).split("/").join("/"));
    }
  };
  visit(root);
  return files.sort();
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "autodev-rulesync-hooks-"));
const outputs = Object.fromEntries(
  targets.map((target) => [target, join(temporaryRoot, target)])
) as Record<(typeof targets)[number], string>;
const portableBefore = readFileSync(portableConfigPath);
for (const target of targets) generate(target, outputs[target]);
test.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function document(target: (typeof targets)[number]): JsonObject {
  return readJson(join(outputs[target], hookPaths[target]));
}

test("Rulesync hook source is the canonical four-section command subset", () => {
  const source = readJson(hookSourcePath);
  assert.deepEqual(
    Object.keys(source).sort(),
    ["claudecode", "codexcli", "copilot", "hooks"].sort()
  );
  assert.deepEqual(Object.keys(asObject(source.hooks)).sort(), [
    "preToolUse",
    "sessionStart",
    "subagentStart"
  ]);
  // The bootstrap is no host's in common: Codex and Copilot run it, Claude
  // Code never does.
  for (const target of ["codexcli", "copilot"])
    assert.deepEqual(
      commands(asObject(source[target])).filter(
        (command) => command === rootDelegation
      ),
      [rootDelegation],
      target
    );
  assert.equal(
    "beforeSubmitPrompt" in asObject(asObject(source.claudecode).hooks),
    false
  );
  assert.doesNotMatch(
    readFileSync(hookSourcePath, "utf8"),
    /prevent_idle_sleep/
  );
  assert.deepEqual(commands(source), sourceCommands);
});

test("portable config keeps hooks in Rulesync and install uses typed materialization", () => {
  const portable = parse(readFileSync(portableConfigPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(Object.hasOwn(portable, "hooks"), false);
  assert.doesNotMatch(
    readFileSync(hookSourcePath, "utf8"),
    /prevent_idle_sleep/
  );
  assert.match(
    readFileSync(join(repositoryRoot, "rulesync.jsonc"), "utf8"),
    /"hooks"/
  );
  assert.match(
    readFileSync(join(repositoryRoot, "scripts", "install.sh"), "utf8"),
    /src\/cli\/install\.ts/
  );
  const materializer = readFileSync(
    join(repositoryRoot, "runtime/src/platform/install-materializer.ts"),
    "utf8"
  );
  assert.match(materializer, /config\.autodev\.toml/);
  assert.match(materializer, /runCompose/);
});

test("target projections preserve their documented command losses", () => {
  const projected = {
    codexcli: new Set(groupedCommands(asObject(document("codexcli").hooks))),
    claudecode: new Set(
      groupedCommands(asObject(document("claudecode").hooks))
    ),
    copilot: new Set(commands(document("copilot"))),
    "antigravity-cli": new Set([
      ...groupedCommands(asObject(document("antigravity-cli").rulesync)),
      ...commands({
        hooks: {
          SessionStart: asObject(document("antigravity-cli").rulesync)
            .SessionStart
        }
      })
    ])
  };
  const expected: Record<(typeof targets)[number], Set<string>> = {
    codexcli: new Set(),
    claudecode: new Set(),
    copilot: new Set(["node ~/.codex/src/hooks/session-start.ts"]),
    "antigravity-cli": new Set(["node ~/.codex/src/hooks/subagent-start.ts"])
  };
  assert.equal(projected.codexcli.has(rootDelegation), true);
  assert.equal(projected.copilot.has(rootDelegation), true);
  assert.equal(projected.claudecode.has(rootDelegation), false);
  assert.equal(projected["antigravity-cli"].has(rootDelegation), false);
  for (const target of targets)
    assert.deepEqual(
      new Set(
        sourceCommands.filter((command) => !projected[target].has(command))
      ),
      expected[target],
      target
    );

  const targetEvents: Record<(typeof targets)[number], Set<string>> = {
    codexcli: new Set(Object.keys(asObject(document("codexcli").hooks))),
    claudecode: new Set(Object.keys(asObject(document("claudecode").hooks))),
    copilot: new Set(Object.keys(asObject(document("copilot").hooks))),
    "antigravity-cli": new Set(
      Object.keys(asObject(document("antigravity-cli").rulesync))
    )
  };
  const expectedNativeEvents: Record<(typeof targets)[number], Set<string>> = {
    codexcli: new Set([
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "SubagentStart",
      "UserPromptSubmit"
    ]),
    claudecode: new Set([
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "SubagentStart"
    ]),
    copilot: new Set(["subagentStart", "userPromptSubmitted", "preToolUse"]),
    "antigravity-cli": new Set(["SessionStart", "PreToolUse"])
  };
  for (const target of targets)
    assert.deepEqual(
      targetEvents[target],
      expectedNativeEvents[target],
      `${target} native events`
    );
});

test("generation writes one hook file per target and leaves the portable source unchanged", () => {
  assert.deepEqual(readFileSync(portableConfigPath), portableBefore);
  for (const target of targets)
    assert.deepEqual(
      generatedFiles(outputs[target]),
      [hookPaths[target]],
      target
    );
});

test("install projects Codex hooks once, at user level only", () => {
  // Codex loads $CODEX_HOME/hooks.json and the project's .codex/hooks.json;
  // a projection in both ran every hook twice in this repository.
  const repo = mkdtempSync(join(temporaryRoot, "install-"));
  const codexHome = join(repo, "codex-home");
  try {
    cpSync(sourceRoot, join(repo, ".rulesync"), { recursive: true });
    cpSync(
      join(repositoryRoot, "rulesync.jsonc"),
      join(repo, "rulesync.jsonc")
    );
    symlinkSync(
      join(repositoryRoot, "node_modules"),
      join(repo, "node_modules")
    );
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(join(repo, ".codex", "hooks.json"), "{}");

    generateRepositoryRulesync(repo);
    generateRepositoryRulesync(repo, { check: true });
    writeCodexUserHooks(repo, codexHome);

    assert.equal(existsSync(join(repo, ".codex", "hooks.json")), false);
    for (const target of targets.filter((name) => name !== "codexcli"))
      assert.equal(existsSync(join(repo, hookPaths[target])), true, target);
    const installed = join(codexHome, "hooks.json");
    assert.equal(lstatSync(installed).isFile(), true);
    assert.equal(readFileSync(installed, "utf8"), renderCodexUserHooks(repo));
    const installedCommands = groupedCommands(
      asObject(readJson(installed).hooks)
    );
    assert.equal(new Set(installedCommands).size, installedCommands.length);
    assert.deepEqual(
      new Set(installedCommands),
      new Set(groupedCommands(asObject(document("codexcli").hooks)))
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Codex and Claude get native memory capture without adding a Copilot hook", () => {
  const source = hooksAt(readJson(hookSourcePath).hooks);
  const codex = hooksAt(document("codexcli").hooks);
  assert.deepEqual(
    Object.keys(codex).sort(),
    [
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "SubagentStart",
      "UserPromptSubmit"
    ].sort()
  );
  assert.deepEqual(
    groupedCommands(codex).filter(
      (command) => !sourceCommands.includes(command)
    ),
    [rootDelegation, "node ~/.codex/src/hooks/memory-session-end.ts"]
  );
  const claude = hooksAt(document("claudecode").hooks);
  assert.deepEqual(
    Object.keys(claude).sort(),
    ["PreToolUse", "SessionEnd", "SessionStart", "SubagentStart"].sort()
  );
  const claudeMemoryCapture =
    "AUTODEV_MEMORY_HOOK_PROVIDER=claude-code node ~/.codex/src/hooks/memory-session-end.ts";
  assert.deepEqual(groupedCommands(claude), [
    ...sourceCommands,
    claudeMemoryCapture
  ]);
  const sessionEndHook = claude.SessionEnd?.[0]?.hooks;
  assert.ok(Array.isArray(sessionEndHook));
  assert.deepEqual(asObject(sessionEndHook[0]), {
    type: "command",
    command: claudeMemoryCapture,
    timeout: 60
  });
  const targetPromptHooks = Array.isArray(codex.UserPromptSubmit?.[0]?.hooks)
    ? (codex.UserPromptSubmit[0].hooks as unknown[])
    : [];
  assert.equal(
    asObject(targetPromptHooks[0]).statusMessage,
    hooksAt(asObject(readJson(hookSourcePath).codexcli).hooks)
      .beforeSubmitPrompt?.[0]?.statusMessage
  );
  assert.equal(codex.PreToolUse?.[0]?.matcher, source.preToolUse?.[0]?.matcher);
});

test("Copilot and Antigravity retain their documented parity limits", () => {
  const copilot = document("copilot");
  const copilotHooks = hooksAt(copilot.hooks);
  assert.deepEqual(Object.keys(copilotHooks), [
    "subagentStart",
    "preToolUse",
    "userPromptSubmitted"
  ]);
  assert.deepEqual(commands(copilot), [
    "node ~/.codex/src/hooks/subagent-start.ts",
    "node ~/.codex/src/hooks/block-ccc-cli.ts",
    "node ~/.codex/src/hooks/skill-read-telemetry.ts",
    "node ~/.codex/src/hooks/root-delegation.ts"
  ]);
  assert.deepEqual(
    copilotHooks.subagentStart?.map((hook) => hook.command),
    ["node ~/.codex/src/hooks/subagent-start.ts"]
  );
  assert.deepEqual(
    copilotHooks.userPromptSubmitted?.map((hook) => hook.command),
    ["node ~/.codex/src/hooks/root-delegation.ts"]
  );
  assert.deepEqual(
    copilotHooks.preToolUse?.map((hook) => [hook.matcher, hook.command]),
    [
      [
        "(?i)exec[_ -]?command|bash",
        "node ~/.codex/src/hooks/block-ccc-cli.ts"
      ],
      [
        "(?i)read[_ -]?file|read|exec[_ -]?command|bash",
        "node ~/.codex/src/hooks/skill-read-telemetry.ts"
      ]
    ]
  );
  const antigravity = document("antigravity-cli");
  assert.deepEqual(Object.keys(asObject(antigravity.rulesync)), [
    "SessionStart",
    "PreToolUse"
  ]);
  assert.deepEqual(groupedCommands(asObject(antigravity.rulesync)), [
    "node ~/.codex/src/hooks/block-ccc-cli.ts",
    "node ~/.codex/src/hooks/skill-read-telemetry.ts"
  ]);
  assert.deepEqual(asObject(antigravity.rulesync).SessionStart, [
    { type: "command", command: "node ~/.codex/src/hooks/session-start.ts" }
  ]);
  assert.deepEqual(
    (asObject(antigravity.rulesync).PreToolUse as unknown[]).map((entry) => {
      const group = asObject(entry);
      return [
        group.matcher,
        (group.hooks as unknown[]).map((hook) => asObject(hook).command)
      ];
    }),
    [
      [
        "(?i)exec[_ -]?command|bash",
        ["node ~/.codex/src/hooks/block-ccc-cli.ts"]
      ],
      [
        "(?i)read[_ -]?file|read|exec[_ -]?command|bash",
        ["node ~/.codex/src/hooks/skill-read-telemetry.ts"]
      ]
    ]
  );
});
