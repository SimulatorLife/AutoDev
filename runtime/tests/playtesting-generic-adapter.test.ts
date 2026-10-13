import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAYTESTS_ADAPTER_BINDING_SCHEMA,
  PLAYTESTS_PROTOCOL_VERSION,
  playtestManifestHash,
  type PlaytestAdapterBinding
} from "@simulatorlife/autodev-core";

import {
  createGenericAdapter,
  GenericAdapterError,
  protocolMethodFor
} from "../src/playtesting/generic-adapter.ts";

const OBSERVATION_SCHEMA = { type: "object", properties: { room: {} } };
const ACTION_SCHEMA = { type: "object", properties: { move: {} } };
const EVENT_SCHEMA = { type: "object", properties: { tick: {} } };

function binding(
  overrides: Partial<PlaytestAdapterBinding> = {}
): PlaytestAdapterBinding {
  return {
    schema: PLAYTESTS_ADAPTER_BINDING_SCHEMA,
    schemaVersion: 1,
    tier: "declarative",
    entry: "adapter.js",
    factory: "createGame",
    bindings: {
      capabilities: { export: "capabilities" },
      reset: { export: "reset" },
      observe: { export: "observe" },
      legalActions: { export: "legalActions" },
      step: { export: "step" },
      outcome: { export: "outcome" }
    },
    ...overrides
  } as PlaytestAdapterBinding;
}

function game(): Record<string, unknown> {
  return {
    capabilities: () => ({}),
    reset: ({ seed }: { seed: string }) => ({ seed }),
    observe: () => ({ room: "atrium" }),
    legalActions: () => ["north", "south"],
    step: ({ action }: { action: string }) => ({ took: action }),
    outcome: () => ({ kind: "loss" })
  };
}

async function adapterFor(
  overrides: Partial<PlaytestAdapterBinding> = {},
  target: Record<string, unknown> = game()
) {
  return createGenericAdapter({
    binding: binding(overrides),
    loadEntry: () => target,
    engineBuild: "fixture-build-1",
    modes: ["headless"],
    scenarioIds: ["tutorial"],
    observationSchema: OBSERVATION_SCHEMA,
    actionSchema: ACTION_SCHEMA,
    eventSchema: EVENT_SCHEMA,
    rngVersion: "pcg32"
  });
}

test("capability digests are derived from the game's own schemas", async () => {
  const adapter = await adapterFor();
  const capabilities = adapter.capabilities;
  assert.equal(capabilities.protocolVersion, PLAYTESTS_PROTOCOL_VERSION);
  assert.equal(capabilities.observationSchemaHash, playtestManifestHash(OBSERVATION_SCHEMA));
  assert.equal(capabilities.actionSchemaHash, playtestManifestHash(ACTION_SCHEMA));
  assert.equal(capabilities.eventSchemaHash, playtestManifestHash(EVENT_SCHEMA));
  // A hand-written adapter stores these beside the schemas they describe and
  // drifts when a schema is edited. Nothing here is declared, only derived.
  assert.equal(adapter.binding.bindings.capabilities !== undefined, true);
});

test("an unbound optional method is advertised as unavailable, not hidden", async () => {
  const adapter = await adapterFor();
  const optional = adapter.capabilities.optionalOperations;
  // The game bound six methods; the seven it did not are named so the Runtime
  // discovers the gap at negotiation rather than mid-run.
  assert.equal(optional.length, 7);
  assert.ok(optional.includes("game.fork" as never));
  assert.ok(optional.includes("game.captureFrame" as never));
  assert.equal(optional.includes("game.step" as never), false);
});

test("determinism is declared from the binding, not assumed", async () => {
  const withoutRng = await adapterFor();
  // No seeded-RNG entry point means AutoDev cannot restore engine RNG for a
  // counterfactual. Claiming otherwise would make a rerun look reproducible.
  assert.equal(withoutRng.capabilities.deterministic.seededRuns, false);
  assert.equal(withoutRng.capabilities.deterministic.rngVersion, null);
  assert.equal(withoutRng.capabilities.deterministic.traceReplayable, false);

  const withRng = await adapterFor(
    { seededRng: { export: "restoreRng" } },
    { ...game(), restoreRng: () => undefined }
  );
  assert.equal(withRng.capabilities.deterministic.seededRuns, true);
  assert.equal(withRng.capabilities.deterministic.rngVersion, "pcg32");
  // The reference must still resolve; declaring it without providing it would
  // advertise a capability the game cannot honour.
  await assert.rejects(
    createGenericAdapter({
      binding: binding({ seededRng: { export: "notThere" } }),
      loadEntry: () => game(),
      engineBuild: "b",
      modes: ["headless"],
      scenarioIds: ["tutorial"],
      observationSchema: OBSERVATION_SCHEMA,
      actionSchema: ACTION_SCHEMA,
      eventSchema: EVENT_SCHEMA
    }),
    (error: unknown) => {
      assert.ok(error instanceof GenericAdapterError);
      assert.equal(error.code, "unresolved-binding");
      assert.match(error.message, /seededRng/u);
      return true;
    }
  );
});

test("dispatch reaches the game's declared function", async () => {
  const adapter = await adapterFor();
  assert.deepEqual(await adapter.invoke("observe", {}), { room: "atrium" });
  assert.deepEqual(await adapter.invoke("legalActions", {}), ["north", "south"]);
  assert.deepEqual(await adapter.invoke("step", { action: "north" }), {
    took: "north"
  });
  assert.deepEqual(await adapter.invoke("reset", { seed: "s1" }), { seed: "s1" });
});

test("an unbound method is refused by name rather than answered from a default", async () => {
  const adapter = await adapterFor();
  await assert.rejects(adapter.invoke("fork", {}), (error: unknown) => {
    assert.ok(error instanceof GenericAdapterError);
    assert.equal(error.code, "unbound-method");
    assert.match(error.message, /game\.fork/u);
    // The refusal names the method so the game knows what to declare.
    assert.match(error.message, /will not answer it with a default/u);
    return true;
  });
});

test("a nested binding path reaches into a returned namespace", async () => {
  const adapter = await adapterFor(
    {
      bindings: {
        ...binding().bindings,
        observe: { export: "game", path: "world.observe" }
      }
    },
    { ...game(), game: { world: { observe: () => ({ room: "atrium" }) } } }
  );
  assert.deepEqual(await adapter.invoke("observe", {}), { room: "atrium" });
});

test("a broken reference fails before any episode starts", async () => {
  // The reference exists but is not callable: a broken declaration, reported
  // at construction rather than as a transport failure later.
  await assert.rejects(
    adapterFor(
      {
        bindings: { ...binding().bindings, observe: { export: "observe" } }
      },
      { ...game(), observe: "not-a-function" }
    ),
    (error: unknown) => {
      assert.ok(error instanceof GenericAdapterError);
      assert.equal(error.code, "unresolved-binding");
      assert.match(error.message, /game\.observe|observe/u);
      return true;
    }
  );
});

test("a missing required binding is refused before the entry is loaded", async () => {
  let loaded = false;
  await assert.rejects(
    createGenericAdapter({
      binding: binding({
        bindings: { capabilities: { export: "capabilities" } }
      }),
      loadEntry: () => {
        loaded = true;
        return game();
      },
      engineBuild: "b",
      modes: ["headless"],
      scenarioIds: ["tutorial"],
      observationSchema: OBSERVATION_SCHEMA,
      actionSchema: ACTION_SCHEMA,
      eventSchema: EVENT_SCHEMA
    }),
    (error: unknown) => {
      assert.ok(error instanceof GenericAdapterError);
      assert.equal(error.code, "unresolved-binding");
      return true;
    }
  );
  assert.equal(loaded, false, "a broken declaration must not run game code");
});

test("a bound function that throws is reported as a game failure", async () => {
  const adapter = await adapterFor(
    {},
    {
      ...game(),
      observe: () => {
        throw new Error("world not ready");
      }
    }
  );
  await assert.rejects(adapter.invoke("observe", {}), (error: unknown) => {
    assert.ok(error instanceof GenericAdapterError);
    assert.equal(error.code, "factory-error");
    assert.match(error.message, /game\.observe/u);
    assert.match(error.message, /world not ready/u);
    return true;
  });
});

test("a protocol method name is derived from its binding name", () => {
  assert.equal(protocolMethodFor("legalActions"), "game.legalActions");
  assert.equal(protocolMethodFor("captureFrame"), "game.captureFrame");
});