import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  "node ~/.codex/src/hooks/root-delegation.ts",
  "node ~/.codex/src/hooks/block-ccc-cli.ts",
  "node ~/.codex/src/hooks/skill-read-telemetry.ts"
];

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
  assert.deepEqual(Object.keys(source), ["hooks"]);
  assert.deepEqual(Object.keys(asObject(source.hooks)).sort(), [
    "beforeSubmitPrompt",
    "preToolUse",
    "sessionStart",
    "subagentStart"
  ]);
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
    join(repositoryRoot, "src/platform/install-materializer.ts"),
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
    "antigravity-cli": new Set(
      groupedCommands(asObject(document("antigravity-cli").rulesync))
    )
  };
  const expected: Record<(typeof targets)[number], Set<string>> = {
    codexcli: new Set(),
    claudecode: new Set(),
    copilot: new Set(
      sourceCommands.filter(
        (command) => command !== "node ~/.codex/src/hooks/root-delegation.ts"
      )
    ),
    "antigravity-cli": new Set(
      sourceCommands.filter(
        (command) =>
          ![
            "node ~/.codex/src/hooks/block-ccc-cli.ts",
            "node ~/.codex/src/hooks/skill-read-telemetry.ts"
          ].includes(command)
      )
    )
  };
  for (const target of targets)
    assert.deepEqual(
      new Set(
        sourceCommands.filter((command) => !projected[target].has(command))
      ),
      expected[target],
      target
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

test("configured Rulesync generation writes hooks alongside skills", () => {
  const output = mkdtempSync(join(temporaryRoot, "configured-"));
  try {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "rulesync",
        "generate",
        "--config",
        "rulesync.jsonc",
        "--output-roots",
        output,
        "--delete",
        "--silent"
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 }
    );
    assert.equal(result.status, 0, result.stderr);
    for (const target of targets)
      assert.equal(existsSync(join(output, hookPaths[target])), true, target);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("Codex and Claude carry every hook with matcher and status metadata", () => {
  const source = hooksAt(readJson(hookSourcePath).hooks);
  for (const target of ["codexcli", "claudecode"] as const) {
    const hooks = hooksAt(document(target).hooks);
    assert.deepEqual(
      Object.keys(hooks).sort(),
      ["PreToolUse", "SessionStart", "SubagentStart", "UserPromptSubmit"].sort()
    );
    assert.deepEqual(groupedCommands(hooks), sourceCommands);
    const targetPromptHooks = Array.isArray(hooks.UserPromptSubmit?.[0]?.hooks)
      ? (hooks.UserPromptSubmit[0].hooks as unknown[])
      : [];
    assert.equal(
      asObject(targetPromptHooks[0]).statusMessage,
      source.beforeSubmitPrompt?.[0]?.statusMessage
    );
    assert.equal(
      hooks.PreToolUse?.[0]?.matcher,
      source.preToolUse?.[0]?.matcher
    );
  }
});

test("Copilot and Antigravity retain their documented parity limits", () => {
  const copilot = document("copilot");
  assert.deepEqual(Object.keys(asObject(copilot.hooks)), [
    "userPromptSubmitted"
  ]);
  assert.deepEqual(commands(copilot), [
    "node ~/.codex/src/hooks/root-delegation.ts"
  ]);
  const antigravity = document("antigravity-cli");
  assert.deepEqual(Object.keys(asObject(antigravity.rulesync)), ["PreToolUse"]);
  assert.deepEqual(groupedCommands(asObject(antigravity.rulesync)), [
    "node ~/.codex/src/hooks/block-ccc-cli.ts",
    "node ~/.codex/src/hooks/skill-read-telemetry.ts"
  ]);
});
