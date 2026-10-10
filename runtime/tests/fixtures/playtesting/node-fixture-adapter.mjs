#!/usr/bin/env node
/* Controlled test adapter only; it is not an approved target game. */
import { createHash } from "node:crypto";
import readline from "node:readline";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]));
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256Hex(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

const OBSERVATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { room: { type: "string" } },
  required: ["room"]
};
const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { actionId: { type: "string" } },
  required: ["actionId"]
};
const EVENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { kind: { type: "string" } },
  required: ["kind"]
};
const CAPABILITIES = {
  protocolVersion: 1,
  schemaHashAlgorithm: "sha256-canonical-json-v1",
  engineBuild: "node-fixture-1.0.0",
  modes: ["headless"],
  scenarioIds: ["tutorial"],
  observationSchema: OBSERVATION_SCHEMA,
  actionSchema: ACTION_SCHEMA,
  eventSchema: EVENT_SCHEMA,
  observationSchemaHash: sha256Hex(OBSERVATION_SCHEMA),
  actionSchemaHash: sha256Hex(ACTION_SCHEMA),
  eventSchemaHash: sha256Hex(EVENT_SCHEMA),
  optionalOperations: ["game.invariants"],
  quotas: {
    maxMessageBytes: 65536,
    maxQueuedRequests: 8,
    ordinaryCallTimeoutMs: 2000,
    resetReplayTimeoutMs: 5000
  },
  deterministic: {
    seededRuns: true,
    rngVersion: "fixture-rng-v1",
    traceReplayable: false
  }
};

let activeEpisodeId = "";
let revision = 0;
let eventSequence = 0;

function send(envelope) {
  process.stdout.write(JSON.stringify(envelope) + "\n");
}

function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function sendApplicationError(id, code, message, category, disposition) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data: { category, retryable: false, episodeDisposition: disposition }
    }
  });
}

function handle(request) {
  const { id, method, params } = request;
  switch (method) {
    case "game.capabilities": {
      if (params.protocolVersion !== 1) {
        sendApplicationError(id, -32004, "unsupported protocol version", "unsupported_capability", "unchanged");
        return;
      }
      send({ jsonrpc: "2.0", id, result: CAPABILITIES });
      return;
    }
    case "game.reset": {
      activeEpisodeId = "fixture-episode-1";
      revision = 0;
      eventSequence = 0;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          episodeId: activeEpisodeId,
          revision,
          rngProvenance: {
            algorithm: "pcg",
            version: "fixture-rng-v1",
            initialStateHash: "a".repeat(64),
            reproducible: true
          }
        }
      });
      return;
    }
    case "game.observe": {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          episodeId: activeEpisodeId,
          revision,
          observation: { room: "start" },
          turnContext: null,
          frame: null
        }
      });
      return;
    }
    case "game.legalActions": {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          episodeId: activeEpisodeId,
          revision,
          actions: [
            { actionId: "advance", description: "Advance" },
            { actionId: "wait", description: "Wait" }
          ]
        }
      });
      return;
    }
    case "game.step": {
      if (params.episodeId !== activeEpisodeId) {
        sendApplicationError(id, -32001, "unsupported episode", "unsupported_scenario", "unchanged");
        return;
      }
      if (params.expectedRevision !== revision) {
        sendApplicationError(id, -32002, "stale revision", "stale_revision", "unchanged");
        return;
      }
      if (params.actionId !== "advance" && params.actionId !== "wait") {
        sendApplicationError(id, -32003, "illegal action", "illegal_action", "unchanged");
        return;
      }
      revision += 1;
      eventSequence += 1;
      const eventId = "evt-" + String(eventSequence);
      sendNotification("game.event", {
        episodeId: activeEpisodeId,
        revision,
        eventSequence,
        event: {
          eventId,
          type: "step-applied",
          phaseId: "race",
          step: eventSequence,
          revision,
          actor: "player",
          fields: { actionId: params.actionId }
        }
      });
      send({
        jsonrpc: "2.0",
        id,
        result: {
          episodeId: activeEpisodeId,
          revision,
          acceptedActionId: params.actionId,
          eventIds: [eventId],
          terminal: false
        }
      });
      return;
    }
    case "game.outcome": {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          episodeId: activeEpisodeId,
          revision,
          state: "terminal",
          outcome: "completed",
          metrics: {},
          missingReasons: []
        }
      });
      return;
    }
    case "game.invariants": {
      send({
        jsonrpc: "2.0",
        id,
        result: { episodeId: activeEpisodeId, revision, witnesses: [] }
      });
      return;
    }
    case "game.cancel": {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          requestId: params.requestId,
          acknowledged: true,
          episodeDisposition: "unknown"
        }
      });
      return;
    }
    default: {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "method not found" }
      });
    }
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  if (line.length === 0) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stderr.write("node fixture received malformed JSON\n");
    process.exitCode = 1;
    return;
  }
  handle(request);
});
input.on("close", () => process.exit(0));
