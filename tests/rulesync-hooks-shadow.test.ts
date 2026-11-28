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

import { CODEX_HOST_ARGUMENT } from "@simulatorlife/autodev-runtime/hooks/hook-payload";
import {
  generateRepositoryRulesync,
  writeCodexUserHooks
} from "@simulatorlife/autodev-runtime/platform/install-materializer";
import { parse } from "smol-toml";

import { compareText } from "./support/ordering.ts";

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

/**
The canonical hook declarations, read from `.rulesync/hooks.jsonc`.

The canonical source owns the event inventory, the matchers, and the
commands, so the expectations below are derived from it instead of
restating it: a matcher edited in the canonical source must not need a
matching edit in this file.
*/
const canonicalHooks = (() => {
  const source = JSON.parse(readFileSync(hookSourcePath, "utf8")) as JsonObject;
  const hooks = asObject(source.hooks);
  const events: Record<string, { matcher?: string; command: string }[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    events[event] = (groups as unknown[]).map((group) => {
      const entry = asObject(group);
      return {
        ...(typeof entry.matcher === "string" && { matcher: entry.matcher }),
        command: String(entry.command)
      };
    });
  }
  return events;
})();

/**
The canonical hook commands, in declaration order.
*/
const sourceCommands = Object.values(canonicalHooks).flatMap((groups) =>
  groups.map((group) => group.command)
);

/**
The canonical hook events, lowercased for comparison across clients.
*/
const canonicalEvents = Object.keys(canonicalHooks).map((event) =>
  event.toLowerCase()
);

/**
The canonical events a client cannot receive.

Each entry is a limitation of the pinned RuleSync projection. Copilot
drops the session-start matcher; Antigravity does not support prompt-submit
or session-end in its native hook surface.
*/
const unsupportedEvents: Record<(typeof targets)[number], readonly string[]> = {
  codexcli: [],
  claudecode: [],
  copilot: ["sessionstart"],
  "antigravity-cli": ["beforesubmitprompt", "sessionend"]
};

function canonicalEventName(event: string): string {
  if (event === "UserPromptSubmit" || event === "userPromptSubmitted") {
    return "beforesubmitprompt";
  }
  if (event === "agentStop") return "stop";
  return event.toLowerCase();
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}
function asObject(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}
function hooksAt(value: unknown): Record<string, Hook[]> {
  const result: Record<string, Hook[]> = {};
  const entries = Object.entries(asObject(value));
  for (const [key, groups] of entries)
    result[key] = (groups as unknown[]).map(asObject) as Hook[];
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
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files.push(relative(root, path).replaceAll("/", "/"));
    }
  };
  visit(root);
  return files.sort(compareText);
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

test("Rulesync hook source is the canonical command subset", () => {
  const source = readJson(hookSourcePath);
  // One declaration for every target: the shared block is the whole surface,
  // and no target carries an override of its own.
  assert.deepEqual(Object.keys(source).sort(compareText), ["hooks"]);
  assert.ok(canonicalEvents.length > 0);
  assert.deepEqual(
    Object.keys(asObject(source.hooks))
      .map((event) => event.toLowerCase())
      .sort(compareText),
    [...canonicalEvents].sort(compareText)
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
  const codexDocument = document("codexcli");
  const claudeDocument = document("claudecode");
  const copilotDocument = document("copilot");
  const antigravityDocument = document("antigravity-cli");
  const codexHooks = asObject(codexDocument.hooks);
  const claudeHooks = asObject(claudeDocument.hooks);
  const antigravityRulesync = asObject(antigravityDocument.rulesync);
  const projected = {
    codexcli: new Set(groupedCommands(codexHooks)),
    claudecode: new Set(groupedCommands(claudeHooks)),
    copilot: new Set(commands(copilotDocument)),
    "antigravity-cli": new Set([
      ...groupedCommands(antigravityRulesync),
      ...commands({
        hooks: {
          SessionStart: antigravityRulesync.SessionStart,
          Stop: antigravityRulesync.Stop
        }
      })
    ])
  };
  const targetEvents: Record<(typeof targets)[number], Set<string>> = {
    codexcli: new Set(Object.keys(codexHooks)),
    claudecode: new Set(Object.keys(claudeHooks)),
    copilot: new Set(Object.keys(asObject(copilotDocument.hooks))),
    "antigravity-cli": new Set(Object.keys(antigravityRulesync))
  };
  for (const target of targets) {
    const expectedCommands = Object.entries(canonicalHooks)
      .filter(
        ([event]) => !unsupportedEvents[target].includes(event.toLowerCase())
      )
      .flatMap(([, groups]) => groups.map((group) => group.command));
    assert.deepEqual(projected[target], new Set(expectedCommands), target);
    const native = Array.from(targetEvents[target], canonicalEventName);
    assert.deepEqual(
      [...native].sort(compareText),
      canonicalEvents
        .filter((event) => !unsupportedEvents[target].includes(event))
        .sort(compareText),
      `${target} native events`
    );
  }
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
  const repository = mkdtempSync(join(temporaryRoot, "install-"));
  const codexHome = join(repository, "codex-home");
  try {
    cpSync(sourceRoot, join(repository, ".rulesync"), { recursive: true });
    cpSync(
      join(repositoryRoot, "rulesync.jsonc"),
      join(repository, "rulesync.jsonc")
    );
    symlinkSync(
      join(repositoryRoot, "node_modules"),
      join(repository, "node_modules")
    );
    mkdirSync(join(repository, ".codex"), { recursive: true });
    writeFileSync(join(repository, ".codex", "hooks.json"), "{}");

    generateRepositoryRulesync(repository);
    generateRepositoryRulesync(repository, { check: true });
    writeCodexUserHooks(repository, codexHome);

    assert.equal(existsSync(join(repository, ".codex", "hooks.json")), false);
    const projectTargets = targets.filter((name) => name !== "codexcli");
    for (const target of projectTargets)
      assert.equal(
        existsSync(join(repository, hookPaths[target])),
        true,
        target
      );
    const installed = join(codexHome, "hooks.json");
    assert.equal(lstatSync(installed).isFile(), true);
    // The installed document carries the canonical hook commands, each
    // marked as running under AutoDev's Codex projection.
    const installedHooks = asObject(readJson(installed).hooks);
    const installedCommands = groupedCommands(installedHooks);
    const marked = (projected: readonly string[]) =>
      new Set(projected.map((command) => `${command} ${CODEX_HOST_ARGUMENT}`));
    assert.deepEqual(new Set(installedCommands), marked(sourceCommands));
    assert.equal(new Set(installedCommands).size, installedCommands.length);
    const projectedCodexHooks = asObject(document("codexcli").hooks);
    assert.deepEqual(
      new Set(installedCommands),
      marked(groupedCommands(projectedCodexHooks))
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("Codex and Claude retain expected native hook projections without deprecated memory capture", () => {
  const source = hooksAt(readJson(hookSourcePath).hooks);
  const codex = hooksAt(document("codexcli").hooks);
  assert.deepEqual(
    Object.keys(codex).map(canonicalEventName).sort(compareText),
    [...canonicalEvents].sort(compareText)
  );
  assert.deepEqual(new Set(groupedCommands(codex)), new Set(sourceCommands));
  const claude = hooksAt(document("claudecode").hooks);
  assert.deepEqual(
    Object.keys(claude).map(canonicalEventName).sort(compareText),
    [...canonicalEvents].sort(compareText)
  );
  assert.deepEqual(new Set(groupedCommands(claude)), new Set(sourceCommands));
  assert.equal(codex.PreToolUse?.[0]?.matcher, source.preToolUse?.[0]?.matcher);
});

test("Copilot and Antigravity retain their documented parity limits", () => {
  // The projected matchers and commands are the canonical ones, so a matcher
  // or command edited in the canonical source does not need a matching edit
  // here.
  const canonicalPreToolUse = canonicalHooks.preToolUse ?? [];
  const copilot = document("copilot");
  const copilotHooks = hooksAt(copilot.hooks);
  assert.deepEqual(
    Object.keys(copilotHooks).map(canonicalEventName).sort(compareText),
    canonicalEvents
      .filter((event) => !unsupportedEvents.copilot.includes(event))
      .sort(compareText)
  );
  assert.deepEqual(
    copilotHooks.preToolUse?.map((hook) => [hook.matcher, hook.command]),
    canonicalPreToolUse.map((group) => [group.matcher, group.command])
  );
  const antigravity = document("antigravity-cli");
  assert.deepEqual(
    Object.keys(asObject(antigravity.rulesync))
      .map(canonicalEventName)
      .sort(compareText),
    canonicalEvents
      .filter((event) => !unsupportedEvents["antigravity-cli"].includes(event))
      .sort(compareText)
  );
  assert.deepEqual(
    groupedCommands(asObject(antigravity.rulesync)),
    canonicalPreToolUse.map((group) => group.command)
  );
  assert.deepEqual(asObject(antigravity.rulesync).SessionStart, [
    {
      type: "command",
      command: canonicalHooks.sessionStart?.[0]?.command
    }
  ]);
  assert.deepEqual(
    (asObject(antigravity.rulesync).PreToolUse as unknown[]).map((entry) => {
      const group = asObject(entry);
      return [
        group.matcher,
        (group.hooks as unknown[]).map((hook) => asObject(hook).command)
      ];
    }),
    canonicalPreToolUse.map((group) => [group.matcher, [group.command]])
  );
});

test("run-autodev-hook.sh executes TypeScript hooks under a minimal PATH", () => {
  const sandbox = mkdtempSync(join(temporaryRoot, "hook-wrapper-"));
  const codexHome = join(sandbox, "codex-home");
  mkdirSync(join(codexHome, "src", "hooks"), { recursive: true });
  writeFileSync(
    join(codexHome, "src", "hooks", "echo-ts-hook.ts"),
    [
      'import { readFileSync } from "node:fs";',
      "const stdinText: string = readFileSync(0, 'utf8');",
      "console.log(JSON.stringify({ argv: process.argv.slice(2), stdinText }));"
    ].join("\n")
  );
  try {
    const result = spawnSync(
      "/bin/sh",
      [
        join(repositoryRoot, "scripts", "run-autodev-hook.sh"),
        "~/.codex/src/hooks/echo-ts-hook.ts",
        "--flag"
      ],
      {
        input: "hello",
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: process.env.HOME ?? sandbox,
          CODEX_HOME: codexHome,
          AUTODEV_NODE_BIN: process.execPath
        }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      argv: ["--flag"],
      stdinText: "hello"
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
