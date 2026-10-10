import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PlaytestAdapterClient,
  type PlaytestAdapterExit,
  PlaytestAdapterProtocolError,
  type PlaytestAdapterStreams
} from "../src/playtesting/adapter-client.ts";

const fixturesDir = fileURLToPath(
  new URL("fixtures/playtesting/", import.meta.url)
);

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

type FakeAdapter = {
  readonly streams: PlaytestAdapterStreams;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly sentLines: () => readonly string[];
  readonly sentEnvelopes: () => readonly Record<string, unknown>[];
  readonly fireExit: (cause: PlaytestAdapterExit) => void;
};

/**
 * A controllable fake adapter: the test pushes raw bytes into stdout/
 * stderr to simulate the far side of the pipe, and reads whatever the
 * client wrote to stdin back out as parsed JSON-RPC envelopes. This lets
 * tests exercise exact byte-level framing (partial lines, oversized lines,
 * malformed JSON) without a real process.
 */
function fakeAdapter(): FakeAdapter {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  let buffer = "";
  const stdin = new PassThrough();
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      written.push(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  let exitListener: ((cause: PlaytestAdapterExit) => void) | null = null;
  const streams: PlaytestAdapterStreams = {
    stdin,
    stdout,
    stderr,
    onExit: (listener) => {
      exitListener = listener;
    }
  };
  return {
    streams,
    stdout,
    stderr,
    sentLines: () => written,
    sentEnvelopes: () =>
      written.map((line) => JSON.parse(line) as Record<string, unknown>),
    fireExit: (cause) => exitListener?.(cause)
  };
}

/** Write one JSON-RPC envelope as one LF-terminated line on the fake stdout. */
function send(adapter: FakeAdapter, envelope: Record<string, unknown>): void {
  adapter.stdout.write(JSON.stringify(envelope) + "\n");
}

function capabilitiesResult(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const fixture = readFixture("golden-capabilities-response.json") as {
    result: Record<string, unknown>;
  };
  return { ...fixture.result, ...overrides };
}

function respondCapabilities(
  adapter: FakeAdapter,
  overrides: Record<string, unknown> = {}
): void {
  const [request] = adapter.sentEnvelopes().slice(-1);
  const id = request?.id as string;
  send(adapter, { jsonrpc: "2.0", id, result: capabilitiesResult(overrides) });
}

async function resetFixtureEpisode(
  adapter: FakeAdapter,
  client: PlaytestAdapterClient,
  episodeId = "fixture-episode-1"
): Promise<void> {
  const resetPromise = client.call("game.reset", {
    seed: "fixture-seed",
    scenarioId: "tutorial",
    approvedVariantHash: "a".repeat(64)
  });
  await wait(5);
  const sent = adapter.sentEnvelopes().at(-1)!;
  send(adapter, {
    jsonrpc: "2.0",
    id: String(sent.id),
    result: {
      episodeId,
      revision: 0,
      rngProvenance: {
        algorithm: "pcg",
        version: "fixture-rng-v1",
        initialStateHash: "b".repeat(64),
        reproducible: true
      }
    }
  });
  const result = await resetPromise;
  assert.equal(result.ok, true);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function counterMintId(start = 0): () => string {
  let n = start;
  return () => "req-" + (n++).toString().padStart(4, "0");
}

test("golden fixture: outbound game.capabilities matches the documented envelope shape", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: () => "req-0001"
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  const golden = readFixture("golden-capabilities-request.json") as Record<
    string,
    unknown
  >;
  assert.deepEqual(adapter.sentEnvelopes()[0], golden);
  respondCapabilities(adapter);
  const result = await negotiated;
  assert.equal(result.protocolVersion, 1);
  client.close();
});

test("golden fixture: outbound game.step binds expectedRevision and the step response round-trips", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId(1)
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter);
  await negotiated;

  const stepPromise = client.step({
    episodeId: "fixture-episode-1",
    actionId: "advance",
    expectedRevision: 0
  });
  await wait(10);
  const sent = adapter.sentEnvelopes().at(-1)!;
  const goldenRequest = readFixture("golden-step-request.json") as Record<
    string,
    unknown
  >;
  assert.equal(sent.method, goldenRequest.method);
  assert.deepEqual(sent.params, goldenRequest.params);

  const goldenResponse = readFixture("golden-step-response.json") as {
    result: Record<string, unknown>;
  };
  send(adapter, {
    jsonrpc: "2.0",
    id: sent.id as string,
    result: goldenResponse.result
  });
  const result = await stepPromise;
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.result, goldenResponse.result);
  }
  client.close();
});

test("partial line buffering: a line split across chunks is parsed once complete", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: () => "req-0001"
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  const envelope = JSON.stringify({
    jsonrpc: "2.0",
    id: "req-0001",
    result: capabilitiesResult()
  });
  const splitPoint = Math.floor(envelope.length / 2);
  adapter.stdout.write(envelope.slice(0, splitPoint));
  await wait(5);
  assert.equal(client.getState(), "capabilities");
  adapter.stdout.write(envelope.slice(splitPoint) + "\n");
  const result = await negotiated;
  assert.equal(result.protocolVersion, 1);
  client.close();
});

test("reordered replies: a response to the second request can arrive before the first", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId()
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter);
  await negotiated;

  const first = client.call("game.observe", {
    episodeId: "fixture-episode-1",
    expectedRevision: 0
  });
  const second = client.call("game.legalActions", {
    episodeId: "fixture-episode-1",
    expectedRevision: 0
  });
  await wait(10);
  const sentAll = adapter.sentEnvelopes();
  const firstSent = sentAll.at(-2)!;
  const secondSent = sentAll.at(-1)!;

  send(adapter, {
    jsonrpc: "2.0",
    id: secondSent.id as string,
    result: {
      episodeId: "fixture-episode-1",
      revision: 0,
      actions: [{ actionId: "advance" }]
    }
  });
  send(adapter, {
    jsonrpc: "2.0",
    id: firstSent.id as string,
    result: {
      episodeId: "fixture-episode-1",
      revision: 0,
      observation: { room: "start" },
      turnContext: null,
      frame: null
    }
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  client.close();
});

test("outstanding request ceiling: the 33rd concurrent request is rejected with a quota error", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId()
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter, {
    quotas: {
      maxMessageBytes: 65_536,
      maxQueuedRequests: 32,
      ordinaryCallTimeoutMs: 2000,
      resetReplayTimeoutMs: 5000
    }
  });
  await negotiated;

  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < 32; i += 1) {
    pending.push(
      client.call("game.observe", {
        episodeId: "fixture-episode-1",
        expectedRevision: 0
      })
    );
  }
  const overflow = await client.call("game.observe", {
    episodeId: "fixture-episode-1",
    expectedRevision: 0
  });
  assert.equal(overflow.ok, false);
  if (!overflow.ok) {
    assert.equal(overflow.code, -32_005);
    assert.equal(overflow.disposition, "queue-full");
  }
  const diagnostics = client.getDiagnostics();
  assert.ok(diagnostics.some((entry) => entry.kind === "queue-full"));
  client.close();
  await Promise.allSettled(pending);
});

test("request ids are never reused after a response settles", async () => {
  const adapter = fakeAdapter();
  const ids = ["req-cap", "req-observe", "req-observe"];
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: () => ids.shift() ?? "req-observe"
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter);
  await negotiated;
  const pending = client.call("game.observe", {
    episodeId: "fixture-episode-1",
    expectedRevision: 0
  });
  await wait(10);
  const sent = adapter.sentEnvelopes().at(-1)!;
  send(adapter, {
    jsonrpc: "2.0",
    id: String(sent.id),
    result: {
      episodeId: "fixture-episode-1",
      revision: 0,
      observation: { room: "start" },
      turnContext: null,
      frame: null
    }
  });
  assert.equal((await pending).ok, true);
  const reused = await client.call("game.observe", {
    episodeId: "fixture-episode-1",
    expectedRevision: 0
  });
  assert.equal(reused.ok, false);
  assert.equal(client.getState(), "failClosed");
  client.close();
});

test("stderr and diagnostics remain bounded under a noisy adapter", () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams);
  adapter.stderr.write(Buffer.from("x\n".repeat(5000)));
  assert.ok(client.getStderrTail().length <= 64);
  assert.ok(client.getStderrTail().every((line) => line.length <= 4096));
  assert.ok(client.getDiagnostics().length <= 2048);
  assert.equal(client.getDiagnostics().at(-1)?.kind, "diagnostic-overflow");
  client.close();
});

test("timeout: an unanswered request resolves as a quota timeout using the adapter-narrowed deadline", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId()
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter, {
    quotas: {
      maxMessageBytes: 65_536,
      maxQueuedRequests: 8,
      ordinaryCallTimeoutMs: 50,
      resetReplayTimeoutMs: 5000
    }
  });
  await negotiated;

  const result = await client.call("game.observe", {
    episodeId: "fixture-episode-1",
    expectedRevision: 0
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, -32_005);
    assert.equal(result.disposition, "unknown");
  }
  client.close();
});

test("cancel: a late reply to a canceled id is recorded as a diagnostic, not a new completion", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId()
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter);
  await negotiated;

  const original = client.call("game.observe", {
    episodeId: "fixture-episode-1",
    expectedRevision: 0
  });
  await wait(10);
  const observeSent = adapter.sentEnvelopes().at(-1)!;
  const observeId = observeSent.id as string;

  const cancelPromise = client.cancel(observeId);
  await wait(10);
  const cancelSent = adapter.sentEnvelopes().at(-1)!;
  assert.equal(cancelSent.method, "game.cancel");
  assert.deepEqual(cancelSent.params, { requestId: observeId });

  send(adapter, {
    jsonrpc: "2.0",
    id: cancelSent.id as string,
    result: {
      requestId: observeId,
      acknowledged: true,
      episodeDisposition: "unknown"
    }
  });
  const cancelResult = await cancelPromise;
  assert.equal(cancelResult.ok, true);

  const originalResult = await original;
  assert.equal(originalResult.ok, false);
  if (!originalResult.ok) {
    assert.equal(originalResult.disposition, "unknown");
  }

  send(adapter, {
    jsonrpc: "2.0",
    id: observeId,
    result: {
      episodeId: "fixture-episode-1",
      revision: 0,
      observation: { room: "late" },
      turnContext: null,
      frame: null
    }
  });
  await wait(10);
  assert.equal(client.getState(), "ready");
  client.close();
});

test("EOF with an incomplete trailing line preserves stderr and fails every in-flight request closed", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId()
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter);
  await negotiated;

  const pending = client.call("game.observe", {
    episodeId: "fixture-episode-1",
    expectedRevision: 0
  });
  await wait(10);
  adapter.stderr.write("fixture: fatal engine error\n");
  adapter.stdout.write('{"jsonrpc":"2.0","id":"req-trailing","resu');
  adapter.fireExit({ code: 1, signal: null, stderrTail: [] });

  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.disposition, "unknown");
  }
  assert.equal(client.getState(), "failClosed");
  assert.equal(
    client.getUnterminatedLineBytes().toString("utf8"),
    '{"jsonrpc":"2.0","id":"req-trailing","resu'
  );
  assert.ok(client.getStderrTail().includes("fixture: fatal engine error"));
  assert.ok(client.getDiagnostics().some((entry) => entry.kind === "eof"));
});

test("duplicate response id fails the transport closed and settles all other in-flight requests", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId()
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter);
  await negotiated;

  const pending = client.call("game.observe", {
    episodeId: "fixture-episode-1",
    expectedRevision: 0
  });
  await wait(10);
  const sent = adapter.sentEnvelopes().at(-1)!;
  const envelope = {
    jsonrpc: "2.0",
    id: sent.id as string,
    result: {
      episodeId: "fixture-episode-1",
      revision: 0,
      observation: {},
      turnContext: null,
      frame: null
    }
  };
  send(adapter, envelope);
  send(adapter, envelope);

  const result = await pending;
  assert.equal(result.ok, true);
  await wait(10);
  assert.equal(client.getState(), "failClosed");
  assert.ok(
    client.getDiagnostics().some((entry) => entry.kind === "duplicate-id")
  );
});

test("wrong protocol version in the response envelope fails the transport closed", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: () => "req-0001"
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  adapter.stdout.write('{"jsonrpc":"1.0","id":"req-0001","result":{}}\n');
  await assert.rejects(
    negotiated,
    (error: unknown) => error instanceof PlaytestAdapterProtocolError
  );
  assert.equal(client.getState(), "failClosed");
  assert.ok(
    client.getDiagnostics().some((entry) => entry.kind === "wrong-version")
  );
});

test("a wrong capability protocolVersion number is rejected even with an otherwise valid envelope", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: () => "req-0001"
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  send(adapter, {
    jsonrpc: "2.0",
    id: "req-0001",
    result: capabilitiesResult({ protocolVersion: 2 })
  });
  await assert.rejects(
    negotiated,
    (error: unknown) =>
      error instanceof PlaytestAdapterProtocolError && error.code === -32_004
  );
});

test("capability schemas must match the negotiated canonical SHA-256 hashes", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: () => "req-0001"
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter, { observationSchemaHash: "f".repeat(64) });
  await assert.rejects(
    negotiated,
    (error: unknown) =>
      error instanceof PlaytestAdapterProtocolError && error.code === -32_004
  );
  assert.equal(client.getState(), "failClosed");
  assert.ok(
    client
      .getDiagnostics()
      .some((entry) => entry.message.includes("schema hash"))
  );
});

test("a JSON-RPC batch array is rejected and fails the transport closed", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: () => "req-0001"
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  adapter.stdout.write("[]\n");
  await assert.rejects(negotiated);
  assert.equal(client.getState(), "failClosed");
});

test("an oversized line (over 1 MiB) is rejected without being parsed", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: () => "req-0001"
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  const padding = "a".repeat(1_048_577);
  const oversized = JSON.stringify({
    jsonrpc: "2.0",
    id: "req-0001",
    result: { pad: padding }
  });
  adapter.stdout.write(oversized + "\n");
  await assert.rejects(negotiated);
  assert.equal(client.getState(), "failClosed");
  assert.ok(
    client.getDiagnostics().some((entry) => entry.kind === "oversized")
  );
});

test("stale revision: an adapter-rejected expectedRevision is relayed without retry", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId()
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter);
  await negotiated;

  const stepPromise = client.step({
    episodeId: "fixture-episode-1",
    actionId: "advance",
    expectedRevision: 0
  });
  await wait(10);
  const sent = adapter.sentEnvelopes().at(-1)!;
  assert.equal(sent.method, "game.step");
  assert.equal((sent.params as Record<string, unknown>).expectedRevision, 0);
  send(adapter, {
    jsonrpc: "2.0",
    id: sent.id as string,
    error: {
      code: -32_002,
      message: "stale revision",
      data: {
        category: "stale-revision",
        retryable: false,
        episodeDisposition: "unchanged"
      }
    }
  });
  const result = await stepPromise;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, -32_002);
    assert.equal(result.disposition, "unchanged");
  }
  const sentAgain = adapter
    .sentEnvelopes()
    .filter((entry) => entry.method === "game.step");
  assert.equal(sentAgain.length, 1, "a stale revision must never be retried");
  client.close();
});

test("the documented error envelope for stale revision matches the golden fixture", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId(1)
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  send(adapter, {
    jsonrpc: "2.0",
    id: "req-0001",
    result: capabilitiesResult()
  });
  await negotiated;

  const stepPromise = client.step({
    episodeId: "fixture-episode-1",
    actionId: "advance",
    expectedRevision: 0
  });
  await wait(10);
  const golden = readFixture("golden-error-stale-revision.json") as Record<
    string,
    unknown
  >;
  send(adapter, golden);
  const result = await stepPromise;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, -32_002);
    assert.deepEqual(result.data, {
      category: "stale-revision",
      retryable: false,
      episodeDisposition: "unchanged"
    });
  }
  client.close();
});

test("unsupported optional capability: calling an unadvertised optional method is rejected locally", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: () => "req-0001"
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter, { optionalOperations: [] });
  await negotiated;

  const result = await client.call("game.snapshot", {
    episodeId: "fixture-episode-1",
    expectedRevision: 0
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, -32_004);
    assert.equal(result.disposition, "unsupported-capability");
  }
  assert.equal(
    adapter.sentEnvelopes().some((entry) => entry.method === "game.snapshot"),
    false
  );
  client.close();
});

test("notification ordering: an out-of-order event sequence fails the transport closed", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId()
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter);
  await negotiated;
  await resetFixtureEpisode(adapter, client);

  const received: unknown[] = [];
  client.onNotification((event) => received.push(event));

  const event = (eventSequence: number) => ({
    jsonrpc: "2.0",
    method: "game.event",
    params: {
      episodeId: "fixture-episode-1",
      revision: eventSequence,
      eventSequence,
      event: {
        eventId: "evt-" + String(eventSequence),
        type: "step-applied",
        phaseId: "race",
        step: eventSequence,
        revision: eventSequence,
        actor: "player",
        fields: {}
      }
    }
  });
  send(adapter, event(1));
  send(adapter, event(1));
  await wait(10);

  assert.equal(received.length, 1);
  assert.equal(client.getState(), "failClosed");
  assert.ok(
    client
      .getDiagnostics()
      .some(
        (entry) =>
          entry.kind === "malformed" && entry.message.includes("Out-of-order")
      )
  );
  client.close();
});

test("the golden game.event notification fixture is accepted and ordered", async () => {
  const adapter = fakeAdapter();
  const client = new PlaytestAdapterClient(adapter.streams, {
    mintId: counterMintId()
  });
  const negotiated = client.negotiateCapabilities(5000);
  await wait(10);
  respondCapabilities(adapter);
  await negotiated;
  await resetFixtureEpisode(adapter, client);

  const received: { sequence: number | null }[] = [];
  client.onNotification((event) => received.push(event));
  const golden = readFixture("golden-event-notification.json") as Record<
    string,
    unknown
  >;
  send(adapter, golden);
  await wait(10);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.sequence, 1);
  client.close();
});

test("real Node fixture process: capability negotiation, step with event, and outcome round-trip", async () => {
  const child = spawn(
    process.execPath,
    [join(fixturesDir, "node-fixture-adapter.mjs")],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  const streams: PlaytestAdapterStreams = {
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    onExit: (listener) => {
      child.once("exit", (code, signal) =>
        listener({ code, signal, stderrTail: [] })
      );
    }
  };
  const client = new PlaytestAdapterClient(streams);
  try {
    const capabilities = await client.negotiateCapabilities(5000);
    assert.equal(capabilities.engineBuild, "node-fixture-1.0.0");

    const reset = await client.call("game.reset", {
      seed: "1",
      scenarioId: "tutorial",
      approvedVariantHash: "a".repeat(64)
    });
    assert.equal(reset.ok, true);

    const events: unknown[] = [];
    client.onNotification((event) => events.push(event));

    const step = await client.step({
      episodeId: "fixture-episode-1",
      actionId: "advance",
      expectedRevision: 0
    });
    assert.equal(step.ok, true);
    if (step.ok) {
      assert.deepEqual(step.result, {
        episodeId: "fixture-episode-1",
        revision: 1,
        acceptedActionId: "advance",
        terminal: false,
        eventIds: ["evt-1"]
      });
    }
    assert.equal(events.length, 1);

    const outcome = await client.call("game.outcome", {
      episodeId: "fixture-episode-1",
      expectedRevision: 1
    });
    assert.equal(outcome.ok, true);
  } finally {
    client.close();
    child.kill();
  }
});

test("real Python fixture process: capability negotiation and a legal step round-trip in a second host language", async () => {
  const child = spawn(
    "python3",
    [join(fixturesDir, "python-stdio-adapter.py")],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  const streams: PlaytestAdapterStreams = {
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    onExit: (listener) => {
      child.once("exit", (code, signal) =>
        listener({ code, signal, stderrTail: [] })
      );
    }
  };
  const client = new PlaytestAdapterClient(streams);
  try {
    const capabilities = await client.negotiateCapabilities(5000);
    assert.equal(capabilities.engineBuild, "python-fixture-1.0.0");
    const reset = await client.call("game.reset", {
      seed: "42",
      scenarioId: "tutorial",
      approvedVariantHash: "a".repeat(64)
    });
    assert.equal(reset.ok, true);

    const step = await client.step({
      episodeId: "fixture-episode-py-1",
      actionId: "advance",
      expectedRevision: 0
    });
    assert.equal(step.ok, true);
    if (step.ok) {
      assert.deepEqual(step.result, {
        episodeId: "fixture-episode-py-1",
        revision: 1,
        acceptedActionId: "advance",
        terminal: false,
        eventIds: ["evt-1"]
      });
    }
  } finally {
    client.close();
    child.kill();
  }
});
