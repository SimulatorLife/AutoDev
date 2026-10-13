/**
 * `autodev playtest init --scaffold` for a game that cannot onboard
 * declaratively.
 *
 * The invariant under test is that a generated scaffold is *honest*: it claims
 * no capability it does not have. A stub returning a well-shaped empty result
 * would pass conformance and produce episodes that measure nothing the game
 * did, which is the failure the declarative tier exists to prevent.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runPlaytestConformance } from "../../runtime/src/cli/playtest-conformance.ts";
import {
  dispatchPlaytestCommand,
  PLAYTESTS_BINDING_FILE,
  PLAYTESTS_CONFIG_FILE,
  PLAYTESTS_OBSERVATION_FILE,
  PLAYTESTS_RUBRIC_FILE
} from "../../runtime/src/cli/playtest.ts";
import {
  PLAYTESTS_SCAFFOLD_BODY_COUNT,
  scaffoldAdapterModule,
  scaffoldBinding
} from "../../runtime/src/cli/playtest-scaffold.ts";

function checkout(): {
  readonly root: string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "autodev-playtest-scaffold-")
  );
  return {
    root: realpathSync(root),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test("a scaffold is onboarded by one command, not three", () => {
  const fixture = checkout();
  try {
    assert.equal(
      dispatchPlaytestCommand("init", [
        "--scaffold",
        "--checkout-root",
        fixture.root
      ]),
      0
    );
    // Every manifest the rest of the pipeline reads, so a game does not have to
    // discover that it also needed a plain `init`.
    for (const name of [
      PLAYTESTS_CONFIG_FILE,
      PLAYTESTS_OBSERVATION_FILE,
      PLAYTESTS_RUBRIC_FILE,
      PLAYTESTS_BINDING_FILE,
      "adapter.js"
    ]) {
      assert.ok(
        existsSync(path.join(fixture.root, ".autodev", name)),
        `${name} must exist after --scaffold`
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("the scaffold declares the tier that says AutoDev wrote the bodies", () => {
  const fixture = checkout();
  try {
    dispatchPlaytestCommand("init", [
      "--scaffold",
      "--checkout-root",
      fixture.root
    ]);
    const binding = JSON.parse(
      readFileSync(
        path.join(fixture.root, ".autodev", PLAYTESTS_BINDING_FILE),
        "utf8"
      )
    ) as { tier: string; factory: string; bindings: Record<string, unknown> };
    // A reviewer reading this can tell the bodies were generated rather than
    // declared. Claiming `declarative` here would be a lie about provenance.
    assert.equal(binding.tier, "generated-scaffold");
    assert.equal(binding.factory, "createGame");
    assert.equal(
      Object.keys(binding.bindings).length,
      PLAYTESTS_SCAFFOLD_BODY_COUNT
    );
  } finally {
    fixture.cleanup();
  }
});

test("every generated body throws rather than returning a plausible empty result", async () => {
  const fixture = checkout();
  try {
    dispatchPlaytestCommand("init", [
      "--scaffold",
      "--checkout-root",
      fixture.root
    ]);
    const report = await runPlaytestConformance(fixture.root);
    assert.equal(report.ok, false);
    // The first unimplemented body is named, with the file to edit.
    const first = report.failures[0];
    assert.equal(first?.stage, "reset");
    assert.match(first!.message, /implement it against your engine/u);
    // Nothing was silently reported as observed.
    assert.equal(report.episodeId, null);
  } finally {
    fixture.cleanup();
  }
});

test("a scaffold does not overwrite a game already implementing", () => {
  const fixture = checkout();
  try {
    dispatchPlaytestCommand("init", [
      "--scaffold",
      "--checkout-root",
      fixture.root
    ]);
    const modulePath = path.join(fixture.root, ".autodev", "adapter.js");
    writeEditedWork(modulePath);
    const before = readFileSync(modulePath, "utf8");

    // A second --scaffold must not replace work in progress with fresh stubs.
    assert.equal(
      dispatchPlaytestCommand("init", [
        "--scaffold",
        "--checkout-root",
        fixture.root
      ]),
      1
    );
    assert.equal(readFileSync(modulePath, "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});

test("--factory names the export the binding looks for", () => {
  const fixture = checkout();
  try {
    dispatchPlaytestCommand("init", [
      "--scaffold",
      "--factory",
      "makeGame",
      "--checkout-root",
      fixture.root
    ]);
    const binding = JSON.parse(
      readFileSync(
        path.join(fixture.root, ".autodev", PLAYTESTS_BINDING_FILE),
        "utf8"
      )
    ) as { factory: string };
    assert.equal(binding.factory, "makeGame");
    const module = readFileSync(
      path.join(fixture.root, ".autodev", "adapter.js"),
      "utf8"
    );
    assert.match(module, /export function makeGame\(\)/u);
  } finally {
    fixture.cleanup();
  }
});

test("a factory name that is not an identifier falls back rather than writing broken code", () => {
  const fixture = checkout();
  try {
    dispatchPlaytestCommand("init", [
      "--scaffold",
      "--factory",
      "not an identifier",
      "--checkout-root",
      fixture.root
    ]);
    const binding = JSON.parse(
      readFileSync(
        path.join(fixture.root, ".autodev", PLAYTESTS_BINDING_FILE),
        "utf8"
      )
    ) as { factory: string };
    assert.equal(binding.factory, "createGame");
  } finally {
    fixture.cleanup();
  }
});

test("the generated module and binding agree on the factory", () => {
  // The two files are written separately but must describe one game: a binding
  // naming a factory the module does not export is a game that cannot load, and
  // it would only be discovered as a first-batch timeout.
  const module = scaffoldAdapterModule({
    factory: "makeGame",
    fileName: "adapter.js"
  });
  const binding = JSON.parse(
    scaffoldBinding({ factory: "makeGame", fileName: "adapter.js" })
  ) as {
    factory: string;
    entry: string;
    bindings: Record<string, { export: string }>;
  };
  assert.match(
    module,
    new RegExp(`export function ${binding.factory}\\(\\)`, "u")
  );
  for (const reference of Object.values(binding.bindings)) {
    assert.match(module, new RegExp(`\\b${reference.export}\\(`, "u"));
  }
});

/** A game that has started implementing, whose work must not be replaced. */
function writeEditedWork(modulePath: string): void {
  writeFileSync(
    modulePath,
    "export function createGame() { return { reset: () => ({ /* mine */ }) }; }\n",
    "utf8"
  );
}
