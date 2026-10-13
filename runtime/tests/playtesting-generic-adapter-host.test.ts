import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  PLAYTESTS_ADAPTER_BINDING_SCHEMA,
  PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES,
  PLAYTESTS_PROTOCOL_VERSION,
  playtestManifestHash,
  type PlaytestAdapterBinding
} from "@simulatorlife/autodev-core";

import { PlaytestAdapterClient } from "../src/playtesting/adapter-client.ts";
import { startGenericAdapterHost } from "../src/playtesting/generic-adapter-host.ts";

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

/**
 * Results conform to the protocol the Runtime client validates. A toy payload
 * would be rejected by the client before the host were exercised, which would
 * make this round trip prove nothing.
 */
function game(): Record<string, unknown> {
  return {
    capabilities: () => ({ lie: true }),
    reset: () => ({
      episodeId: "episode-1",
      revision: 0,
      // Provenance, not a bare "fresh" flag: the Runtime records how the RNG
      // was seeded so a later counterfactual knows whether it can be replayed.
      rngProvenance: {
        algorithm: "pcg32",
        version: "1",
        initialStateHash: "b".repeat(64),
        reproducible: true
      }
    }),
    observe: ({ episodeId }: { episodeId: string }) => ({
      episodeId,
      revision: 0,
      observation: { room: "atrium" },
      turnContext: null,
      frame: null
    }),
    legalActions: ({ episodeId }: { episodeId: string }) => ({
      episodeId,
      revision: 0,
      actions: [
        { actionId: "north", description: "Go north.", features: {} },
        { actionId: "south", description: "Go south.", features: {} }
      ]
    }),
    step: ({ episodeId }: { episodeId: string }) => ({
      episodeId,
      revision: 0,
      applied: true
    }),
    outcome: ({ episodeId }: { episodeId: string }) => ({
      episodeId,
      revision: 0,
      kind: "loss"
    })
  };
}

const EPISODE = { episodeId: "episode-1", expectedRevision: 0 };

interface Connected {
  readonly client: PlaytestAdapterClient;
  readonly host: Awaited<ReturnType<typeof startGenericAdapterHost>>;
  /** Runtime writes here; the host reads it. */
  readonly clientToHost: PassThrough;
  /** Host writes here; the Runtime client reads it. */
  readonly hostToClient: PassThrough;
}

/**
 * Connect the Runtime's real client to the generic host over a pipe pair.
 *
 * Using the production client is the point: a host that only satisfies its own
 * tests can be subtly incompatible with the state machine it must satisfy.
 */
async function connect(
  overrides: Partial<PlaytestAdapterBinding> = {},
  target: Record<string, unknown> = game()
): Promise<Connected> {
  const clientToHost = new PassThrough();
  const hostToClient = new PassThrough();
  const host = await startGenericAdapterHost({
    binding: binding(overrides),
    loadEntry: () => target,
    engineBuild: "fixture-build-1",
    modes: ["headless"],
    scenarioIds: ["tutorial"],
    observationSchema: OBSERVATION_SCHEMA,
    actionSchema: ACTION_SCHEMA,
    eventSchema: EVENT_SCHEMA,
    input: clientToHost,
    output: hostToClient
  });
  const client = new PlaytestAdapterClient({
    // The client writes requests into the pipe the host reads, and reads
    // replies from the pipe the host writes.
    stdin: clientToHost,
    stdout: hostToClient,
    stderr: new PassThrough(),
    onExit: () => {}
  });
  void host.serve();
  return { client, host, clientToHost, hostToClient };
}

test("the Runtime client negotiates against the generic host", async () => {
  const { client } = await connect();
  const capabilities = await client.negotiateCapabilities();
  assert.equal(capabilities.protocolVersion, PLAYTESTS_PROTOCOL_VERSION);
  // Digests are derived from the game's schemas even though the game bound its
  // own `capabilities` returning a lie. A bound function must not overwrite
  // what AutoDev computed.
  assert.equal(
    capabilities.observationSchemaHash,
    playtestManifestHash(OBSERVATION_SCHEMA)
  );
  assert.equal(
    capabilities.actionSchemaHash,
    playtestManifestHash(ACTION_SCHEMA)
  );
  assert.equal(
    capabilities.eventSchemaHash,
    playtestManifestHash(EVENT_SCHEMA)
  );
  client.close();
});

test("a bound method is callable through the real client", async () => {
  const { client } = await connect();
  await client.negotiateCapabilities();
  const result = await client.call("game.observe", EPISODE);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.ok ? (result.result as { observation: unknown }).observation : null,
    { room: "atrium" }
  );
  const actions = await client.call("game.legalActions", EPISODE);
  assert.deepEqual(
    actions.ok
      ? (actions.result as { actions: { actionId: string }[] }).actions.map(
          (action) => action.actionId
        )
      : null,
    ["north", "south"]
  );
  client.close();
});

test("an unbound method fails the call instead of returning a default", async () => {
  const { client } = await connect();
  await client.negotiateCapabilities();
  const result = await client.call("game.fork", EPISODE);
  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? null : result.code,
    PLAYTESTS_ADAPTER_APPLICATION_ERROR_CODES.unsupportedCapability
  );
  client.close();
});

test("an unknown protocol method is refused by name", async () => {
  const { client } = await connect();
  await client.negotiateCapabilities();
  const result = await client.call(
    "game.definitelyNotAMethod" as never,
    EPISODE
  );
  assert.equal(result.ok, false);
  client.close();
});

test("a game-emitted notification reaches the client's listener", async () => {
  const { client, host } = await connect();
  // The client binds its episode identity from the call that opens one, which
  // is `game.reset` — and that call is only legal after negotiation.
  await client.negotiateCapabilities();
  // `game.reset` opens an episode and returns its id; the params are the
  // frozen execution identity, not an ad-hoc episode id.
  const opened = await client.call("game.reset", {
    seed: "seed-1",
    scenarioId: "tutorial",
    approvedVariantHash: "c".repeat(64)
  });
  assert.equal(opened.ok ? true : `${opened.code} ${opened.message}`, true);
  const seen: { method: string }[] = [];
  client.onNotification((notification) => {
    seen.push({ method: notification.method });
  });
  // The client validates an event against its own episode identity, revision
  // and sequence, so a loosely shaped notification would be rejected before the
  // listener ever saw it.
  host.notify("game.event", {
    episodeId: "episode-1",
    revision: 0,
    eventSequence: 1,
    event: {
      eventId: "e-1",
      type: "move",
      step: 1,
      revision: 0,
      phaseId: null,
      actor: "player",
      fields: { direction: "north" }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    { seen, diagnostics: client.getDiagnostics() },
    { seen: [{ method: "game.event" }], diagnostics: [] }
  );
  client.close();
});

test("a malformed request is answered rather than dropped", async () => {
  const { client, clientToHost, hostToClient } = await connect();
  await client.negotiateCapabilities();
  // A client that sends an invalid line must get an answer; silence here would
  // leave a real Runtime waiting on a request that will never complete.
  const response = new Promise<string>((resolve) => {
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (text.includes("-32700") || text.includes("-32600")) {
        resolve(text);
      }
    };
    hostToClient.on("data", onData);
  });
  clientToHost.write("{not json\n");
  const answered = await Promise.race([
    response,
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 500))
  ]);
  assert.match(answered, /-32700|-32600/u);
  client.close();
});