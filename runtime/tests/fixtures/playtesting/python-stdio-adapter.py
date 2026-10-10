#!/usr/bin/env python3
"""Controlled Python protocol fixture; not an approved target game."""
import hashlib
import json
import sys


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


OBSERVATION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"room": {"type": "string"}},
    "required": ["room"],
}
ACTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"actionId": {"type": "string"}},
    "required": ["actionId"],
}
EVENT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"kind": {"type": "string"}},
    "required": ["kind"],
}
CAPABILITIES = {
    "protocolVersion": 1,
    "schemaHashAlgorithm": "sha256-canonical-json-v1",
    "engineBuild": "python-fixture-1.0.0",
    "modes": ["headless"],
    "scenarioIds": ["tutorial"],
    "observationSchema": OBSERVATION_SCHEMA,
    "actionSchema": ACTION_SCHEMA,
    "eventSchema": EVENT_SCHEMA,
    "observationSchemaHash": sha256_hex(OBSERVATION_SCHEMA),
    "actionSchemaHash": sha256_hex(ACTION_SCHEMA),
    "eventSchemaHash": sha256_hex(EVENT_SCHEMA),
    "optionalOperations": [],
    "quotas": {
        "maxMessageBytes": 65536,
        "maxQueuedRequests": 8,
        "ordinaryCallTimeoutMs": 2000,
        "resetReplayTimeoutMs": 5000,
    },
    "deterministic": {
        "seededRuns": True,
        "rngVersion": "fixture-rng-v1",
        "traceReplayable": False,
    },
}

state = {"episodeId": "", "revision": 0, "eventSequence": 0}


def send(envelope):
    sys.stdout.write(json.dumps(envelope, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def send_notification(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


def send_application_error(request_id, code, message, category, disposition):
    send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": code,
                "message": message,
                "data": {
                    "category": category,
                    "retryable": False,
                    "episodeDisposition": disposition,
                },
            },
        }
    )


def handle(request):
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params", {})

    if method == "game.capabilities":
        if params.get("protocolVersion") != 1:
            send_application_error(
                request_id,
                -32004,
                "unsupported protocol version",
                "unsupported_capability",
                "unchanged",
            )
            return
        send({"jsonrpc": "2.0", "id": request_id, "result": CAPABILITIES})
        return
    if method == "game.reset":
        state.update({"episodeId": "fixture-episode-py-1", "revision": 0, "eventSequence": 0})
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "episodeId": state["episodeId"],
                    "revision": state["revision"],
                    "rngProvenance": {
                        "algorithm": "pcg",
                        "version": "fixture-rng-v1",
                        "initialStateHash": "a" * 64,
                        "reproducible": True,
                    },
                },
            }
        )
        return
    if method == "game.observe":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "episodeId": state["episodeId"],
                    "revision": state["revision"],
                    "observation": {"room": "start"},
                    "turnContext": None,
                    "frame": None,
                },
            }
        )
        return
    if method == "game.legalActions":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "episodeId": state["episodeId"],
                    "revision": state["revision"],
                    "actions": [
                        {"actionId": "advance", "description": "Advance"},
                        {"actionId": "wait", "description": "Wait"},
                    ],
                },
            }
        )
        return
    if method == "game.step":
        if params.get("episodeId") != state["episodeId"]:
            send_application_error(
                request_id, -32001, "unsupported episode", "unsupported_scenario", "unchanged"
            )
            return
        if params.get("expectedRevision") != state["revision"]:
            send_application_error(
                request_id, -32002, "stale revision", "stale_revision", "unchanged"
            )
            return
        if params.get("actionId") not in {"advance", "wait"}:
            send_application_error(
                request_id, -32003, "illegal action", "illegal_action", "unchanged"
            )
            return
        state["revision"] += 1
        state["eventSequence"] += 1
        event_id = "evt-" + str(state["eventSequence"])
        send_notification(
            "game.event",
            {
                "episodeId": state["episodeId"],
                "revision": state["revision"],
                "eventSequence": state["eventSequence"],
                "event": {
                    "eventId": event_id,
                    "type": "step-applied",
                    "phaseId": "race",
                    "step": state["eventSequence"],
                    "revision": state["revision"],
                    "actor": "player",
                    "fields": {"actionId": params.get("actionId")},
                },
            },
        )
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "episodeId": state["episodeId"],
                    "revision": state["revision"],
                    "acceptedActionId": params.get("actionId"),
                    "eventIds": [event_id],
                    "terminal": False,
                },
            }
        )
        return
    if method == "game.outcome":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "episodeId": state["episodeId"],
                    "revision": state["revision"],
                    "state": "terminal",
                    "outcome": "completed",
                    "metrics": {},
                    "missingReasons": [],
                },
            }
        )
        return
    if method == "game.cancel":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "requestId": params.get("requestId"),
                    "acknowledged": True,
                    "episodeDisposition": "unknown",
                },
            }
        )
        return
    send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": "method not found"},
        }
    )


for raw_line in sys.stdin:
    line = raw_line.rstrip("\n")
    if not line:
        continue
    try:
        request = json.loads(line)
    except json.JSONDecodeError:
        sys.stderr.write("python fixture received malformed JSON\n")
        sys.exit(1)
    handle(request)
