import assert from "node:assert/strict";
import test from "node:test";

import { runMain } from "@simulatorlife/autodev-runtime/cli";

/**
 * What a caller is told when they get a command wrong.
 *
 * These paths are the CLI's most-used failure modes and used to be its least
 * informative. Every family declared its accepted values twice -- once as a
 * TypeScript union, once as a chain of `!==` comparisons in the dispatcher --
 * and the hand-typed `--help` string spelled them a third time. Nothing tied
 * the three together, which is why the messages could only ever name the value
 * the caller got wrong: the lists were already written down, three times, and
 * none of them reached the message.
 */

/** The rejection's message, without the `Error: ` prefix `String` prepends. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `runMain` with the CLI's own argument separator and returns stdout. */
async function capture(argv: string[]): Promise<string> {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk).trimEnd());
    return true;
  }) as typeof process.stdout.write;
  try {
    await runMain(argv);
  } finally {
    process.stdout.write = originalWrite;
  }
  return output.join("\n");
}

/**
 * The `--help` rows, as `command -> advertised subcommands`.
 *
 * Parsed by indentation rather than a pattern: the rows are exactly two spaces
 * deep, and a regex over them trips `security/detect-unsafe-regex` for no gain.
 */
function advertisedCommands(help: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of help.split("\n")) {
    if (!line.startsWith("  ") || line.startsWith("   ")) continue;
    const parts = line.trim().split(" ");
    const name = parts.at(0);
    if (name === undefined) continue;
    const choices = parts.slice(1).join(" ");
    rows.set(name, choices.length > 0 ? choices.split("|") : []);
  }
  return rows;
}

/** Backends that satisfy every family, so dispatch is reached without side effects. */
const STUBS = {
  router: {
    run: () => 0,
    ensure: () => 0,
    status: () => ({
      state: "running" as const,
      endpoint: "http://127.0.0.1:4100",
      pid: 1
    })
  },
  provider: { start: () => 0 },
  hook: { run: () => 0 },
  repo: { bootstrap: () => 0 },
  install: { install: () => 0 }
};

test("a command invoked without its subcommand names the values it accepts", () => {
  // The most likely mistake a caller makes, and the one the CLI answered worst.
  // Five of the six families were reachable with their subcommand omitted, and
  // each fell past its own dispatch to a top-level catch-all that reported it as
  // "not implemented in this migration slice" -- false for every command it
  // named, because `--help` listed them all -- then told the caller to "complete
  // the owning subsystem migration", which is not something a caller can do.
  for (const [command, label, expected] of [
    ["render", "render target", "agents, contract, mcp, or catalog"],
    ["router", "router command", "run, ensure, or status"],
    ["provider", "provider", "claude, minimax, copilot, or antigravity"],
    [
      "hook",
      "hook",
      "session-start, subagent-start, root-delegation, or skill-read"
    ],
    ["repo", "repo subcommand", "bootstrap"]
  ] as const) {
    assert.throws(
      () => runMain([command], STUBS),
      (error: unknown) => {
        const message = messageOf(error);
        assert.doesNotMatch(
          message,
          /migration slice|owning subsystem/u,
          `${command} is still reported as an unfinished migration`
        );
        assert.equal(message, `${label} requires one of: ${expected}`);
        return true;
      },
      `${command} accepted a missing subcommand`
    );
  }
});

test("an unusable value reports what was accepted, not just what was typed", () => {
  for (const [command, label] of [
    ["render", "render target"],
    ["router", "router command"],
    ["provider", "provider"],
    ["hook", "hook"],
    ["repo", "repo subcommand"]
  ] as const) {
    assert.throws(
      () => runMain([command, "definitely-not-a-command"], STUBS),
      (error: unknown) => {
        const message = messageOf(error);
        assert.equal(
          message,
          `unsupported ${label}: definitely-not-a-command (expected one of: ${acceptedList(command)})`
        );
        // The old wording buried the failure behind an implementation placeholder.
        assert.doesNotMatch(message, /\(missing\)/u);
        return true;
      },
      `${command} accepted an invented value`
    );
  }
});

/** The values each command family accepts, spelled the way the CLI prints them. */
function acceptedList(command: string): string {
  switch (command) {
    case "render": {
      return "agents, contract, mcp, or catalog";
    }
    case "router": {
      return "run, ensure, or status";
    }
    case "provider": {
      return "claude, minimax, copilot, or antigravity";
    }
    case "hook": {
      return "session-start, subagent-start, root-delegation, or skill-read";
    }
    case "repo": {
      return "bootstrap";
    }
    default: {
      throw new Error(`no accepted list for ${command}`);
    }
  }
}

test("an unknown command lists the families instead of blaming a migration", () => {
  assert.throws(
    () => runMain(["definitely-not-a-command"], STUBS),
    (error: unknown) => {
      assert.equal(
        messageOf(error),
        "unsupported command: definitely-not-a-command (expected one of: check, render, router, provider, hook, repo, or install)"
      );
      return true;
    }
  );
});

test("help advertises exactly what each command accepts", async () => {
  // The help text was a hand-typed literal repeating the subcommands a third
  // time, with nothing tying it to the validators -- which is how `render` could
  // be listed here while the catch-all called it unimplemented. This asserts
  // the link through the real dispatch path: a value the help shows must not be
  // rejected as unsupported, and a value it does not show must be.
  const rows = advertisedCommands(await capture(["--", "--help"]));
  assert.deepEqual(
    [...rows.keys()],
    ["check", "render", "router", "provider", "hook", "repo", "install"]
  );

  for (const [command, choices] of rows) {
    for (const choice of choices) {
      let failure: unknown;
      try {
        await runMain([command, choice], STUBS);
      } catch (error: unknown) {
        failure = error;
      }
      assert.doesNotMatch(
        failure === undefined ? "" : messageOf(failure),
        /unsupported |requires one of/u,
        `--help advertises '${command} ${choice}' but dispatch rejects it`
      );
    }
    // A value the help does not show is still a rejection -- but only for a
    // family that selects on one. `check` and `install` take no subcommand, and
    // `install` forwards its arguments, so neither has a set to be outside of.
    if (choices.length > 0)
      assert.throws(
        () => runMain([command, "not-advertised"], STUBS),
        /unsupported |requires one of/u,
        `${command} accepted an unadvertised value`
      );
  }
});

test("help shows required and optional arguments for every render target", async () => {
  const help = await capture(["--", "--help"]);
  for (const [target, required, optional] of [
    [
      "agents",
      "--mcp-source <toml> --output-dir <dir>",
      "[--source-dir <dir>] [--prompt-dir <dir>] [--check]"
    ],
    [
      "contract",
      "--output <file>",
      "[--source-dir <dir>] [--root-config <file>] [--contract <file>] [--check]"
    ],
    ["mcp", "--mcp-source <toml> --output <file>", "[--check]"],
    [
      "catalog",
      "--routing-config <file> --catalogs-dir <dir> --output <file>",
      "[--check]"
    ]
  ] as const) {
    assert.ok(
      help.includes(`    ${target} ${required}\n      ${optional}`),
      `help omits ${target} arguments`
    );
  }
  assert.match(
    help,
    /Defaults \(checkout-relative\): --source-dir agents\/roles,[\s\S]*--contract config\/execution-contract\.json\./u
  );
  assert.match(
    help,
    /--mcp-source expects Codex TOML generated from the RuleSync MCP catalog/u
  );
});

test("help discloses the provider and hook vocabularies", async () => {
  // Both families used to render a bare `<name>`, so their accepted values were
  // discoverable only by running a command and reading the error.
  const help = await capture(["--", "--help"]);
  assert.match(help, / {2}provider claude\|minimax\|copilot\|antigravity/u);
  assert.match(
    help,
    / {2}hook session-start\|subagent-start\|root-delegation\|skill-read/u
  );
  assert.doesNotMatch(help, / {2}provider <name>/u);
  assert.doesNotMatch(help, / {2}hook <name>/u);
});
