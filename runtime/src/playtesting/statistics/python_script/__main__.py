"""JSON-RPC entry point for the AutoDev Playtesting statistics worker.

Runtime spawns this module via ``python -m python_script`` against the
isolated project at ``runtime/src/playtesting/statistics``. The contract
is one JSON-RPC 2.0 envelope per call on stdin/stdout; stderr is reserved
for log lines.

Supported methods
-----------------
* ``statistics.bootstrap``  -> Paired percentile bootstrap. Required
  params: ``array`` (array of numbers). Optional params: ``resamples``
  (default 100000), ``confidenceLevel`` (default 0.95), ``seed``
  (default 42). Result keys: ``interval``.
* ``statistics.multipletests`` -> Family-wise multiplicity adjustment.
  Required params: ``pvalues`` (array). Optional params: ``alpha``
  (default 0.05), ``method`` (default ``fdr_bh``).
* ``statistics.manifest``  -> Library-version manifest + expected §4
  fixture intervals. No required params.

Errors
------
* Input-validation errors map to JSON-RPC ``-32602`` (invalid params).
* Library-drift errors (the lockfile was bypassed) map to ``-32603``
  (internal error) with ``data.category = "library-drift"``.
* Any unexpected error maps to ``-32603`` with ``data.category =
  "internal-error"``. No PII is ever included in error data.
"""

from __future__ import annotations

import json
import sys
import traceback

from .analysis import (
    DEFAULT_CONFIDENCE_LEVEL,
    DEFAULT_RESAMPLES,
    DEFAULT_SEED,
    StatisticInputError,
    expected_fixture_intervals,
    multiplicity_adjusted_pvalues,
    paired_percentile_bootstrap,
)
from .library_versions import assert_library_pins, library_tag

JSONRPC_VERSION = "2.0"
INPUT_ERROR_CODE = -32602
INTERNAL_ERROR_CODE = -32603

MAX_LINE_BYTES = 1 * 1024 * 1024
ENCODING = "utf-8"

# Sentinel: when stdin is empty we cannot derive an id, so emit ``None``
# (which is JSON-RPC's "response not tied to a request").
_NO_ID = None


def _emit(message: dict) -> None:
    """Encode and write a single JSON-RPC envelope to stdout."""
    encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(encoded)
    sys.stdout.write("\n")
    sys.stdout.flush()


def _success(request_id, result: dict) -> dict:
    return {"jsonrpc": JSONRPC_VERSION, "id": request_id, "result": result}


def _error(request_id, code: int, message: str, **data) -> dict:
    body = {"code": code, "message": message}
    if data:
        body["data"] = data
    return {"jsonrpc": JSONRPC_VERSION, "id": request_id, "error": body}


def _read_envelope(stream) -> dict:
    raw = stream.readline()
    if not raw:
        raise EOFError("Empty stdin; expected one JSON-RPC envelope.")
    if len(raw) > MAX_LINE_BYTES:
        raise ValueError(
            f"JSON-RPC envelope exceeded {MAX_LINE_BYTES} bytes; refused to parse."
        )
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Malformed JSON-RPC envelope: {exc.msg}.") from exc
    if not isinstance(parsed, dict):
        raise ValueError("JSON-RPC envelope must decode to an object.")
    return parsed


def _handle_bootstrap(params: dict) -> dict:
    if not isinstance(params, dict):
        raise StatisticInputError("bootstrap params must be an object.")
    array = params.get("array")
    if array is None:
        raise StatisticInputError("bootstrap params.array is required.")
    resamples = int(params.get("resamples", DEFAULT_RESAMPLES))
    confidence_level = float(params.get("confidenceLevel", DEFAULT_CONFIDENCE_LEVEL))
    seed = int(params.get("seed", DEFAULT_SEED))
    interval = paired_percentile_bootstrap(
        array,
        resamples=resamples,
        confidence_level=confidence_level,
        seed=seed,
    )
    return {"interval": interval.to_dict()}


def _handle_multipletests(params: dict) -> dict:
    if not isinstance(params, dict):
        raise StatisticInputError("multipletests params must be an object.")
    pvalues = params.get("pvalues")
    if pvalues is None:
        raise StatisticInputError("multipletests params.pvalues is required.")
    alpha = float(params.get("alpha", 0.05))
    method = str(params.get("method", "fdr_bh"))
    result = multiplicity_adjusted_pvalues(pvalues, alpha=alpha, method=method)
    return {"multipletests": result.to_dict()}


def _handle_manifest(_params) -> dict:
    return {
        "libraryVersion": library_tag(),
        "expectedFixtures": expected_fixture_intervals(),
    }


DISPATCH = {
    "statistics.bootstrap": _handle_bootstrap,
    "statistics.multipletests": _handle_multipletests,
    "statistics.manifest": _handle_manifest,
}


def _dispatch(envelope: dict) -> dict:
    if envelope.get("jsonrpc") != JSONRPC_VERSION:
        raise ValueError("Envelope must declare jsonrpc=2.0.")
    request_id = envelope.get("id")
    method = envelope.get("method")
    params = envelope.get("params") or {}
    if not isinstance(method, str) or not method:
        raise StatisticInputError("JSON-RPC method must be a non-empty string.")
    handler = DISPATCH.get(method)
    if handler is None:
        # Stable method-not-found error so callers can distinguish.
        raise ValueError(f"Unknown JSON-RPC method: {method!r}.")
    result = handler(params)
    return _success(request_id, result)


def main() -> int:
    # Verify the resolved libraries match pyproject.toml before any work.
    try:
        assert_library_pins()
    except RuntimeError as exc:
        sys.stderr.write("statistics-worker: " + str(exc) + "\n")
        sys.stderr.flush()
        _emit(_error(_NO_ID, INTERNAL_ERROR_CODE, str(exc), category="library-drift"))
        return 0  # we still emit a structured error envelope

    envelope = None
    try:
        envelope = _read_envelope(sys.stdin)
        response = _dispatch(envelope)
    except StatisticInputError as exc:
        _emit(_error(envelope.get("id") if envelope is not None else _NO_ID,
                     INPUT_ERROR_CODE, str(exc), category="invalid-input"))
    except (EOFError, ValueError) as exc:
        _emit(_error(envelope.get("id") if envelope is not None else _NO_ID,
                     INPUT_ERROR_CODE, str(exc), category="invalid-envelope"))
    except Exception:  # last-resort error path
        sys.stderr.write("statistics-worker unexpected error:\n" + traceback.format_exc())
        sys.stderr.flush()
        _emit(_error(_NO_ID, INTERNAL_ERROR_CODE, "Internal statistics error.", category="internal-error"))
    else:
        _emit(response)
    return 0


if __name__ == "__main__":
    sys.exit(main())
