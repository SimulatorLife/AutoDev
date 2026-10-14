/**
 * `autodev playtest conformance` against real game checkouts.
 *
 * Each case builds an integration directory the way a game would, then proves
 * the conformance report distinguishes a game that runs from one that cannot.
 * The assertions are on the report rather than on console text, because the
 * report is what an onboarding gate would branch on.
 */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PLAYTESTS_ADAPTER_BINDING_SCHEMA } from "@simulatorlife/autodev-core";

import {
  checkPlaytestIntegration,
  initPlaytestIntegration,
  PLAYTESTS_BINDING_FILE
} from "../../runtime/src/cli/playtest.ts";
import {
  formatConformanceReport,
  runPlaytestConformance
} from "../../runtime/src/cli/playtest-conformance.ts";

const WORKING_GAME = `
export function createGame() {
  let revision = 0;
  return {
    reset: () => ({
      episodeId: "conformance-episode-1",
      revision: 0,
      rngProvenance: {
        algorithm: "pcg32",
        version: "1",
        initialStateHash: "b".repeat(64),
        reproducible: true
      }
    }),
    observe: () => ({
      episodeId: "conformance-episode-1",
      revision,
      observation: { room: "atrium" },
      turnContext: null,
      frame: null
    }),
    legalActions: () => ({
      episodeId: "conformance-episode-1",
      revision,
      actions: [{ actionId: "north", description: "Go north.", features: {} }]
    }),
    step: () => ({
      episodeId: "conformance-episode-1",
      revision: ++revision,
      acceptedActionId: "north",
      eventIds: [],
      terminal: false
    }),
    outcome: () => ({
      episodeId: "conformance-episode-1",
      revision,
      state: "terminal",
      outcome: null,
      metrics: {},
      evaluations: [],
      missingReasons: []
    })
  };
}
`;

function checkout(entryModule: string | null): {
  readonly root: string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "autodev-playtest-conformance-")
  );
  assert.equal(initPlaytestIntegration(root), 0);
  if (entryModule !== null) {
    writeFileSync(
      path.join(root, ".autodev", "adapter.js"),
      entryModule,
      "utf8"
    );
  }
  return {
    root: realpathSync(root),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function setBinding(root: string, overrides: Record<string, unknown>): void {
  const file = path.join(root, ".autodev", PLAYTESTS_BINDING_FILE);
  const binding = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    file,
    `${JSON.stringify({ ...binding, ...overrides }, null, 2)}\n`,
    "utf8"
  );
}

test("a game whose declarations actually run passes conformance", async () => {
  const fixture = checkout(WORKING_GAME);
  try {
    const report = await runPlaytestConformance(fixture.root);
    assert.equal(report.ok, true, formatConformanceReport(report));
    assert.equal(report.tier, "declarative");
    // The episode really ran against the game's own code, so the episode id is
    // the one the game issued.
    assert.equal(report.episodeId, "conformance-episode-1");
    // Every method an episode needs, each exercised exactly once.
    assert.deepEqual(report.methodsExercised, [
      "reset",
      "observe",
      "legalActions",
      "step",
      "outcome"
    ]);
    assert.match(formatConformanceReport(report), /conformance passed/u);
  } finally {
    fixture.cleanup();
  }
});

test("a declared entry that does not exist is named, not left to the first batch", async () => {
  const fixture = checkout(null);
  try {
    // `check` accepts this integration: the binding is well formed and every
    // digest matches. Nothing in the files proves the entry module is there.
    const report = await runPlaytestConformance(fixture.root);
    assert.equal(report.ok, false);
    assert.equal(report.failures[0]?.stage, "entry");
    // The message names the file the operator has to write.
    assert.match(formatConformanceReport(report), /adapter\.js/u);
  } finally {
    fixture.cleanup();
  }
});

test("a missing factory export is named at the stage it happened", async () => {
  const fixture = checkout("export const notTheFactory = 1;\n");
  try {
    const report = await runPlaytestConformance(fixture.root);
    assert.equal(report.ok, false);
    assert.equal(report.failures[0]?.stage, "entry");
    assert.match(formatConformanceReport(report), /factory named/u);
  } finally {
    fixture.cleanup();
  }
});

test("a method returning a loosely shaped result fails at that method", async () => {
  const fixture = checkout(
    WORKING_GAME.replace(
      'observe: () => ({\n      episodeId: "conformance-episode-1",\n      revision,\n      observation: { room: "atrium" },\n      turnContext: null,\n      frame: null\n    }),',
      'observe: () => ({ room: "atrium" }),'
    )
  );
  try {
    const report = await runPlaytestConformance(fixture.root);
    assert.equal(report.ok, false);
    // The failure names observe rather than reporting that "an episode failed",
    // which is the difference between an actionable message and a puzzle.
    assert.ok(
      report.failures.some((entry) => entry.stage === "observe"),
      `expected an observe failure, got ${JSON.stringify(report.failures)}`
    );
    assert.deepEqual(
      report.methodsExercised,
      ["reset"],
      "a failed observation must stop the episode before legal actions or step"
    );
  } finally {
    fixture.cleanup();
  }
});

test(
  "a game factory that never resolves fails within the conformance deadline",
  { timeout: 20_000 },
  async () => {
    const fixture = checkout(
      "export async function createGame() { await new Promise(() => {}); }\n"
    );
    try {
      const report = await runPlaytestConformance(fixture.root);
      assert.equal(report.ok, false);
      assert.equal(report.failures[0]?.stage, "entry");
      assert.match(report.failures[0]?.message ?? "", /deadline/u);
    } finally {
      fixture.cleanup();
    }
  }
);

test(
  "an adapter method that never resolves cannot extend the conformance deadline",
  { timeout: 20_000 },
  async () => {
    const entry = WORKING_GAME.replace(
      "reset: () => ({",
      "reset: () => new Promise(() => {}),\n    unusedResetShape: () => ({"
    );
    const fixture = checkout(entry);
    try {
      const report = await runPlaytestConformance(fixture.root);
      assert.equal(report.ok, false);
      assert.equal(report.failures[0]?.stage, "reset");
      assert.match(report.failures[0]?.message ?? "", /deadline/u);
    } finally {
      fixture.cleanup();
    }
  }
);

test("a game that advertises no legal action is reported as unable to advance", async () => {
  const fixture = checkout(
    WORKING_GAME.replace(
      'actions: [{ actionId: "north", description: "Go north.", features: {} }]',
      "actions: []"
    )
  );
  try {
    const report = await runPlaytestConformance(fixture.root);
    assert.equal(report.ok, false);
    assert.match(formatConformanceReport(report), /no legal actions/u);
  } finally {
    fixture.cleanup();
  }
});

test("an entry outside the approved checkout is refused", async () => {
  const fixture = checkout(WORKING_GAME);
  try {
    setBinding(fixture.root, { entry: "../../etc/passwd" });
    const report = await runPlaytestConformance(fixture.root);
    assert.equal(report.ok, false);
    assert.match(
      formatConformanceReport(report),
      /must resolve inside the approved checkout/u
    );
  } finally {
    fixture.cleanup();
  }
});

test("a checkout with no integration directory says so", async () => {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "autodev-playtest-empty-")
  );
  try {
    const report = await runPlaytestConformance(realpathSync(root));
    assert.equal(report.ok, false);
    assert.equal(report.failures[0]?.stage, "integration-directory");
    assert.match(formatConformanceReport(report), /playtest init/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a binding that declares an invalid RNG version is caught here too", async () => {
  const fixture = checkout(WORKING_GAME);
  try {
    setBinding(fixture.root, { rngVersion: "" });
    const report = await runPlaytestConformance(fixture.root);
    // The same rule `check` enforces, proven through the runtime that owns it,
    // so a binding edited between the two gates cannot pass both.
    assert.equal(report.ok, false);
    assert.match(formatConformanceReport(report), /rngVersion/u);
  } finally {
    fixture.cleanup();
  }
});

test("the binding schema is still required, so a renamed file is reported", async () => {
  const fixture = checkout(WORKING_GAME);
  try {
    setBinding(fixture.root, {
      schema: PLAYTESTS_ADAPTER_BINDING_SCHEMA,
      tier: "not-a-tier"
    });
    const report = await runPlaytestConformance(fixture.root);
    assert.equal(report.ok, false);
    assert.equal(report.failures[0]?.stage, "entry");
  } finally {
    fixture.cleanup();
  }
});
test("conformance is the gate check cannot be, on a game check accepts", async () => {
  const fixture = checkout(null);
  try {
    // The integration is internally consistent: every manifest parses, every
    // digest matches, the binding is well formed and fully required. `check`
    // therefore passes it, and would let it be approved.
    const checkReport = checkPlaytestIntegration(fixture.root);
    assert.deepEqual(
      checkReport.problems.filter((problem) => problem.severity === "error"),
      [],
      "check must accept an integration whose files are self-consistent"
    );
    // The same checkout cannot run, because nothing in the files says the
    // entry module exists. This is the difference between the two gates.
    const conformance = await runPlaytestConformance(fixture.root);
    assert.equal(conformance.ok, false);
  } finally {
    fixture.cleanup();
  }
});
