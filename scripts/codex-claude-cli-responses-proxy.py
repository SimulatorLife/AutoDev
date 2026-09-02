#!/usr/bin/env python3
"""Local OpenAI Responses adapter backed by the authenticated Claude CLI.

The Claude CLI is run in stream-json mode so a slow or rate-limited upstream
request cannot look like a dead Codex task.  The adapter keeps the CLI's
OAuth-only environment and translates its text deltas into Responses SSE.
"""

from __future__ import annotations

import json
import os
import queue
import re
import secrets
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

HOST = "127.0.0.1"
PORT = 4000
MODEL = "claude-subscription"
AUTH_TOKEN = os.environ.get("LITELLM_API_KEY", "")
PROJECT_ROOT = os.environ.get("CODEX_PROJECT_ROOT")
# Match the router and Antigravity bridge's long-running turn budget. Operators
# can still choose a shorter/longer limit through the environment, but a
# default five-minute ceiling made legitimate tool-heavy subagent turns look
# like premature transport failures.
CLAUDE_TIMEOUT_SECONDS = float(os.environ.get("CLAUDE_CODE_BRIDGE_TIMEOUT_SECONDS", "900"))
CLI = "/Users/henrykirk/.local/bin/claude"
DEFAULT_CLAUDE_MODEL = "sonnet"
DEFAULT_CLAUDE_EFFORT = "medium"
# Claude Code's Agent tool (Task in older releases) is the recursive boundary.
# Keep it unavailable for every request sent through this gateway; the parent
# Codex process remains responsible for orchestration.
DISALLOWED_CLAUDE_TOOLS = ("Agent", "Task")


class ClaudeRateLimitError(RuntimeError):
    """Claude rejected the request because an account/session limit applies."""


class ClaudeOverloadedError(RuntimeError):
    """Claude temporarily reported capacity pressure."""


class WorkspaceResolutionError(RuntimeError):
    """The request had no usable structured workspace and no explicit operator override."""


# Recognized Claude identifier shapes (the CLI accepts these). Anything
# that does not match a Claude-shaped identifier or a known family alias
# collapses to DEFAULT_CLAUDE_MODEL so the CLI never receives an
# unexpected value.
_CLAUDE_MODEL_PATTERN = re.compile(r"^claude-[A-Za-z0-9][A-Za-z0-9.-]*$")
_CLAUDE_FAMILY_NAMES = frozenset({"sonnet", "opus", "haiku"})
_CLAUDE_EFFORT_LEVELS = frozenset({"low", "medium", "high", "xhigh", "max"})


def model_metadata() -> dict[str, Any]:
    """Return the model shape expected by current Codex model discovery."""
    return {
        "slug": MODEL,
        "apply_patch_tool_type": "freeform",
        "base_instructions": "You are a bounded external-provider Codex agent.",
        "display_name": "Claude Code subscription",
        "description": "Claude Code OAuth subscription through the local bridge.",
        "default_reasoning_level": DEFAULT_CLAUDE_EFFORT,
        "default_reasoning_summary": "none",
        "default_verbosity": "low",
        "supported_reasoning_levels": [
            {"effort": level, "description": f"Claude Code {level} reasoning"}
            for level in ("low", "medium", "high")
        ],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": True,
        "priority": 1,
        "additional_speed_tiers": [],
        "service_tiers": [],
        "availability_nux": None,
        "upgrade": None,
        "context_window": 200000,
        "max_context_window": 200000,
        "model_messages": {"instructions_template": "You are a bounded external-provider Codex agent."},
        "input_modalities": ["text"],
        "experimental_supported_tools": [],
        "support_verbosity": False,
        "supports_parallel_tool_calls": False,
        "supports_search_tool": False,
        "tool_mode": "code_mode_only",
        "truncation_policy": {"mode": "tokens", "limit": 10000},
        "use_responses_lite": True,
        "multi_agent_version": "v1",
        "node_repl_auto_review_required": False,
        "node_repl_disabled": True,
        "include_apps_usage_instructions": False,
        "include_plugin_usage_instructions": False,
        "include_skills_usage_instructions": False,
        "comp_hash": "local-claude-bridge",
        "effective_context_window_percent": 95,
    }


def resolve_claude_model(requested: Any) -> str:
    if not isinstance(requested, str):
        return DEFAULT_CLAUDE_MODEL
    candidate = requested.strip()
    if not candidate:
        return DEFAULT_CLAUDE_MODEL
    lowered = candidate.lower()
    if lowered.startswith("claude-subscription") or lowered.startswith("anthropic."):
        return DEFAULT_CLAUDE_MODEL
    if lowered in _CLAUDE_FAMILY_NAMES:
        return lowered
    if _CLAUDE_MODEL_PATTERN.match(candidate):
        return candidate
    return DEFAULT_CLAUDE_MODEL


def resolve_claude_effort(requested: Any) -> str:
    if not isinstance(requested, str):
        return DEFAULT_CLAUDE_EFFORT
    candidate = requested.strip().lower()
    return candidate if candidate in _CLAUDE_EFFORT_LEVELS else DEFAULT_CLAUDE_EFFORT


def requested_effort(request: dict[str, Any]) -> Any:
    reasoning = request.get("reasoning")
    if isinstance(reasoning, dict) and "effort" in reasoning:
        return reasoning["effort"]
    for key in ("model_reasoning_effort", "reasoning_effort"):
        if key in request:
            return request[key]
    return None


# Router-generated request header naming the agent role this bridge is serving.
# The router builds its outbound headers from scratch, so an inbound client can
# never claim to be the orchestrator.
AGENT_ROLE_HEADER = "x-autodev-agent-role"
ORCHESTRATOR_AGENT_ROLE = "orchestrator"

# Bridge role prompts are shared verbatim with the other provider bridges and
# with the root delegation hook. The installed hook copy keeps the AutoDev
# `scripts/` subtree beneath it; a checkout has the prompts beside this file.
_PROMPT_DIRECTORIES = (
    Path(__file__).resolve().parent / "scripts" / "codex" / "prompts",
    Path(__file__).resolve().parent / "codex" / "prompts",
)


def load_bridge_prompt(name: str) -> str:
    for directory in _PROMPT_DIRECTORIES:
        prompt = directory / f"{name}.md"
        if prompt.is_file():
            return prompt.read_text(encoding="utf-8").strip()
    searched = ", ".join(str(directory) for directory in _PROMPT_DIRECTORIES)
    raise RuntimeError(f"Bridge prompt {name!r} was not found in any of: {searched}")


LEAF_BRIDGE_INSTRUCTIONS = load_bridge_prompt("leaf")
ORCHESTRATOR_BRIDGE_INSTRUCTIONS = load_bridge_prompt("orchestrator")


def resolve_agent_role(headers: Any) -> str | None:
    """The agent role the router assigned to this request, or None if it sent none."""
    if headers is None or not hasattr(headers, "get"):
        return None
    value = headers.get(AGENT_ROLE_HEADER)
    return value.strip().lower() if isinstance(value, str) and value.strip() else None


def is_orchestrator_role(role: Any) -> bool:
    return role == ORCHESTRATOR_AGENT_ROLE


def bridge_instructions(role: Any) -> str:
    """Role instructions for this turn.

    The root orchestrator must never receive the leaf policy: telling the parent
    it is a bounded leaf that cannot spawn child agents suppresses exactly the
    delegation the root turn exists to perform. Anything that is not explicitly
    the orchestrator is treated as a leaf.
    """
    return ORCHESTRATOR_BRIDGE_INSTRUCTIONS if is_orchestrator_role(role) else LEAF_BRIDGE_INSTRUCTIONS


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return json.dumps(content, ensure_ascii=False)
    return "\n".join(
        str(part.get("text", part)) if isinstance(part, dict) else str(part)
        for part in content
    )


def prompt_from_input(value: Any, instructions: str = LEAF_BRIDGE_INSTRUCTIONS) -> str:
    if isinstance(value, str):
        task = value
    elif not isinstance(value, list):
        task = json.dumps(value, ensure_ascii=False)
    else:
        user_items = [
            item for item in value
            if isinstance(item, dict) and item.get("role") == "user"
        ]
        items = user_items or [
            item for item in value
            if not isinstance(item, dict) or item.get("role") not in {"developer", "system"}
        ]
        task = "\n\n".join(
            item if isinstance(item, str) else content_text(item.get("content", item.get("text", "")))
            if isinstance(item, dict) else json.dumps(item, ensure_ascii=False)
            for item in items
        )
    return f"{instructions}\n\nDelegated task:\n{task}"


def claude_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for key in (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        # These authenticate only the local router-to-bridge hop; never pass
        # them through to the OAuth-authenticated Claude CLI subprocess.
        "LITELLM_API_KEY",
        "LITELLM_MASTER_KEY",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ):
        environment.pop(key, None)
    if not environment.get("CLAUDE_CODE_OAUTH_TOKEN"):
        raise RuntimeError("CLAUDE_CODE_OAUTH_TOKEN is not available to the Claude bridge")
    return environment


def text_from_content(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    return "".join(
        str(block.get("text", ""))
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    )


def nested_text(event: dict[str, Any]) -> str:
    inner = event.get("event")
    if not isinstance(inner, dict):
        return ""
    delta = inner.get("delta")
    if isinstance(delta, dict) and delta.get("type") == "text_delta":
        return str(delta.get("text", ""))
    return ""


def emit_once(text: str, key: str, seen: set[str]) -> str:
    if key in seen:
        return ""
    seen.add(key)
    return f"{text}\n"


def activity_from_event(event: dict[str, Any], seen: set[str]) -> str:
    """Progress text for one Claude CLI event, or "" when it carries none.

    Claude reports far more than its final answer: reasoning, the tools it
    reaches for, and its own task summaries. Without this the parent sees a
    silent gap between the delegation and the result. Reasoning text is
    appended verbatim; discrete lines are reported once each.
    """
    event_type = event.get("type")
    if event_type == "stream_event":
        inner = event.get("event")
        if not isinstance(inner, dict):
            return ""
        if inner.get("type") == "content_block_delta":
            delta = inner.get("delta")
            if isinstance(delta, dict) and delta.get("type") == "thinking_delta":
                return str(delta.get("thinking", ""))
            return ""
        if inner.get("type") == "content_block_start":
            block = inner.get("content_block")
            if isinstance(block, dict) and block.get("type") == "tool_use":
                name = str(block.get("name") or "a tool")
                return emit_once(f"Claude is using {name}.", f"tool:{block.get('id')}", seen)
        return ""
    if event_type == "system" and event.get("subtype") == "task_summary":
        detail = event.get("detail")
        if isinstance(detail, str) and detail.strip():
            return emit_once(detail.strip(), f"summary:{event.get('uuid')}", seen)
    return ""


def read_stream(process: subprocess.Popen[str], events: queue.Queue[tuple[str, Any]]) -> None:
    try:
        assert process.stdout is not None
        for line in process.stdout:
            try:
                events.put(("json", json.loads(line)))
            except json.JSONDecodeError:
                events.put(("stderr", line.strip()))
    finally:
        events.put(("stdout_done", None))


def read_stderr(process: subprocess.Popen[str], events: queue.Queue[tuple[str, Any]]) -> None:
    assert process.stderr is not None
    for line in process.stderr:
        events.put(("stderr", line.strip()))
    events.put(("stderr_done", None))


def claude_cli_args(prompt: str, model: str, effort: str, agent_role: Any = None) -> list[str]:
    codex_home = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
    additional_dirs = tuple(
        directory
        for directory in os.environ.get("CLAUDE_CODE_ADDITIONAL_DIRS", codex_home).split(os.pathsep)
        if directory
    )
    orchestrator = is_orchestrator_role(agent_role)
    # Delegation is the root orchestrator's job, so it keeps the Agent tool the
    # recursion boundary removes from every leaf role.
    subagent_boundary = [] if orchestrator else ["--disallowed-tools", ",".join(DISALLOWED_CLAUDE_TOOLS)]
    return [
        CLI,
        "-p",
        prompt,
        "--model",
        model,
        "--effort",
        effort,
        *subagent_boundary,
        "--permission-mode",
        # The parent explicitly authorizes runtime diagnostics outside the
        # workspace. Role instructions remain read-only; this mode prevents
        # Claude Code's interactive approval gate from hiding those reads or
        # localhost checks behind an approval request the parent cannot answer.
        os.environ.get("CLAUDE_CODE_PERMISSION_MODE", "bypassPermissions"),
        "--append-system-prompt",
        bridge_instructions(agent_role),
        "--add-dir",
        *additional_dirs,
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--no-session-persistence",
        "--include-hook-events",
        "--no-chrome"
    ]


_WORKSPACE_KEYS = ("cwd", "project_root", "working_directory")


def _parse_turn_metadata_json(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _turn_metadata_from(header_value: Any, client_metadata: Any) -> dict[str, Any] | None:
    """Canonical Codex transport carries turn metadata as the
    `x-codex-turn-metadata` request header (forwarded by the model router);
    callers that cannot set custom headers may instead embed the same JSON at
    `client_metadata["x-codex-turn-metadata"]` in the body.
    """
    from_header = _parse_turn_metadata_json(header_value)
    if from_header is not None:
        return from_header
    if isinstance(client_metadata, dict):
        embedded = client_metadata.get("x-codex-turn-metadata")
        if isinstance(embedded, dict):
            return embedded
        return _parse_turn_metadata_json(embedded)
    return None


def _turn_metadata_header(headers: Any) -> Any:
    if headers is None or not hasattr(headers, "get"):
        return None
    return headers.get("X-Codex-Turn-Metadata") or headers.get("x-codex-turn-metadata")


def _workspace_path_from_entry(entry: Any) -> str | None:
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        for key in (*_WORKSPACE_KEYS, "path"):
            value = entry.get(key)
            if isinstance(value, str):
                return value
    return None


def _resolve_workspace_from_turn_metadata(turn_metadata: Any) -> str | None:
    """Resolve the workspace from the canonical ``workspaces`` map in turn
    metadata.

    Codex's canonical transport keys the ``workspaces`` map by the absolute
    repo/workspace path (the source inserts ``repo_root`` as the map key);
    each value carries only git metadata. We therefore try each map key as
    an absolute path candidate first, and only fall back to inspecting the
    value's structured path fields (``cwd``/``project_root``/``working_directory``/``path``)
    when no key is a directory that exists on this host. The caller does not
    tell us which workspace is "active", so the first valid candidate wins.
    """
    workspaces = turn_metadata.get("workspaces") if isinstance(turn_metadata, dict) else None
    if not isinstance(workspaces, dict):
        return None
    for key in workspaces:
        if isinstance(key, str) and os.path.isdir(key):
            return key
    for entry in workspaces.values():
        candidate = _workspace_path_from_entry(entry)
        if isinstance(candidate, str) and os.path.isdir(candidate):
            return candidate
    return None


def resolve_cwd(request: dict[str, Any], headers: Any = None) -> str:
    """Resolve the workspace directory from structured request fields only.

    Task prose is never consulted. If the request omits a valid structured
    `cwd`/`project_root`/`working_directory` (top-level, in `metadata`, or in
    `x-codex-turn-metadata` workspaces), this fails closed instead of
    silently defaulting to an unrelated repository: it falls back to an
    explicit `CODEX_PROJECT_ROOT` operator override if one is configured, and
    otherwise raises.
    """
    meta = request.get("metadata")
    for key in _WORKSPACE_KEYS:
        val = request.get(key)
        if isinstance(val, str) and os.path.isdir(val):
            return val
    if isinstance(meta, dict):
        for key in _WORKSPACE_KEYS:
            val = meta.get(key)
            if isinstance(val, str) and os.path.isdir(val):
                return val
    turn_metadata = _turn_metadata_from(
        _turn_metadata_header(headers),
        request.get("client_metadata"),
    )
    workspace_path = _resolve_workspace_from_turn_metadata(turn_metadata)
    if workspace_path:
        return workspace_path
    if PROJECT_ROOT:
        if os.path.isdir(PROJECT_ROOT):
            return PROJECT_ROOT
        raise WorkspaceResolutionError(
            f"CODEX_PROJECT_ROOT={PROJECT_ROOT!r} is set but is not a directory"
        )
    present = sorted(
        key
        for key in _WORKSPACE_KEYS
        if key in request or (isinstance(meta, dict) and key in meta)
    )
    if turn_metadata is not None:
        present.append("x-codex-turn-metadata")
    raise WorkspaceResolutionError(
        "request omitted a valid structured cwd/project_root/working_directory "
        "(top-level, metadata, or x-codex-turn-metadata workspaces) and "
        "CODEX_PROJECT_ROOT is not set; refusing to guess a workspace instead "
        "of silently landing an unrelated parent in this repository "
        f"(present but invalid keys: {present or 'none'})"
    )


def rate_limit_event_error(event: dict[str, Any]) -> ClaudeRateLimitError | None:
    rate_info = event.get("rate_limit_info", {})
    if not isinstance(rate_info, dict):
        return None
    status = rate_info.get("status")
    if not status or status == "allowed":
        return None
    limit_type = rate_info.get("rateLimitType", "session")
    message = f"Claude rate limit ({limit_type}): status is {status}"
    resets_at = rate_info.get("resetsAt")
    if resets_at:
        message += f" (resets at {resets_at})"
    return ClaudeRateLimitError(message)


def classify_claude_error(message: Any, error_code: Any = None) -> type[RuntimeError] | None:
    text = str(message or "")
    if error_code == "rate_limit" or re.search(r"rate.?limit|weekly.?limit|quota|credit|session.?limit|too many requests", text, re.IGNORECASE):
        return ClaudeRateLimitError
    if error_code == "overloaded_error" or re.search(r"overload|high.?demand|capacity", text, re.IGNORECASE):
        return ClaudeOverloadedError
    return None


def raise_classified_claude_error(message: Any, error_code: Any = None) -> None:
    error_type = classify_claude_error(message, error_code)
    if error_type is not None:
        raise error_type(str(message))


def run_claude_stream(prompt: str, model: str = DEFAULT_CLAUDE_MODEL, effort: str = DEFAULT_CLAUDE_EFFORT, cwd: str = ".", agent_role: Any = None):
    process = subprocess.Popen(
        claude_cli_args(prompt, model, effort, agent_role),
        cwd=cwd,
        env=claude_environment(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    events: queue.Queue[tuple[str, Any]] = queue.Queue()
    threading.Thread(target=read_stream, args=(process, events), daemon=True).start()
    threading.Thread(target=read_stderr, args=(process, events), daemon=True).start()
    emitted = ""
    assistant_snapshot = ""
    saw_stream_text = False
    result: dict[str, Any] = {}
    activity_keys: set[str] = set()
    stderr_lines: list[str] = []
    deadline = time.monotonic() + CLAUDE_TIMEOUT_SECONDS
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                process.kill()
                process.wait()
                raise subprocess.TimeoutExpired(process.args, CLAUDE_TIMEOUT_SECONDS)
            try:
                kind, value = events.get(timeout=min(remaining, 2.0))
            except queue.Empty:
                # Keep intermediary proxies and the Codex client from treating
                # a slow upstream turn as a dead connection.
                yield ("heartbeat", None, None)
                continue
            if kind == "json" and isinstance(value, dict):
                event_type = value.get("type")
                if event_type == "rate_limit_event":
                    rate_limit_error = rate_limit_event_error(value)
                    if rate_limit_error is not None:
                        raise rate_limit_error
                    continue
                if value.get("is_api_error_message") or value.get("error") in ("rate_limit", "overloaded_error"):
                    err_msg = text_from_content(value.get("message", {}).get("content", [])) or value.get("error") or "Claude API error"
                    raise_classified_claude_error(err_msg, value.get("error"))
                activity = activity_from_event(value, activity_keys)
                if activity:
                    yield ("activity", activity, value)
                delta = nested_text(value) if event_type == "stream_event" else ""
                if delta:
                    # With --include-partial-messages Claude emits both the
                    # canonical stream_event text deltas and assistant events
                    # containing a full message snapshot. The latter must not
                    # be forwarded after a stream delta or the same text is
                    # rendered twice by the downstream Responses client.
                    if not saw_stream_text and assistant_snapshot:
                        if emitted.endswith(delta):
                            delta = ""
                        elif delta.startswith(assistant_snapshot):
                            delta = delta[len(assistant_snapshot):]
                    saw_stream_text = True
                if event_type == "assistant":
                    full_text = text_from_content(value.get("message", {}).get("content", []))
                    if saw_stream_text:
                        delta = ""
                    elif full_text.startswith(assistant_snapshot):
                        delta = full_text[len(assistant_snapshot):]
                    elif full_text == assistant_snapshot or emitted.endswith(full_text):
                        delta = ""
                    else:
                        delta = full_text
                    assistant_snapshot = full_text
                if delta:
                    emitted += delta
                    yield ("delta", delta, value)
                if event_type == "result":
                    result = value
                    if result.get("is_error"):
                        message = str(result.get("result", "Claude CLI returned an error"))
                        raise_classified_claude_error(message)
                        raise RuntimeError(message)
                continue
            if kind == "stderr" and value:
                stderr_lines.append(str(value))
            if kind == "stdout_done":
                return_code = process.wait()
                if "result" not in result:
                    raise RuntimeError("Claude CLI exited without a terminal result event")
                if result.get("is_error"):
                    message = str(result.get("result", "Claude CLI returned an error"))
                    raise_classified_claude_error(message)
                    raise RuntimeError(message)
                if return_code != 0:
                    detail = "\n".join(stderr_lines)[-4000:]
                    raise RuntimeError(f"Claude CLI exited {return_code}: {detail}")
                final_text = str(result.get("result", emitted))
                if final_text and final_text != emitted and not emitted.endswith(final_text):
                    suffix = final_text[len(emitted):] if final_text.startswith(emitted) else final_text
                    if suffix:
                        emitted += suffix
                        yield ("delta", suffix, result)
                yield ("complete", (emitted, result), None)
                return
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def message_item(text: str, item_id: str | None = None) -> dict[str, Any]:
    return {
        "id": item_id or f"msg_{secrets.token_hex(10)}",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def response_payload(
    model: str,
    text: str,
    metadata: dict[str, Any],
    response_id: str | None = None,
    output: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    response_id = response_id or f"resp_{secrets.token_hex(12)}"
    usage = metadata.get("usage", {})
    input_tokens = int(usage.get("input_tokens", 0))
    output_tokens = int(usage.get("output_tokens", 0))
    return {
        "id": response_id,
        "object": "response",
        "created_at": int(time.time()),
        "model": model,
        "status": "completed",
        "output": output if output is not None else [message_item(text)],
        "output_text": text,
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens, "total_tokens": input_tokens + output_tokens},
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "CodexClaudeBridge/1.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        print(format % args, flush=True)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path in ("/health", "/health/liveliness"):
            self.send_json(200, {"status": "ok"})
        elif path == "/v1/models":
            model = model_metadata()
            self.send_json(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "anthropic"}], "models": [model]})
        else:
            self.send_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})

    def send_sse(self, event_name: str, payload: dict[str, Any]) -> None:
        body = f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()
        self.wfile.write(body)
        self.wfile.flush()

    def send_heartbeat(self) -> None:
        self.wfile.write(b": claude-bridge keep-alive\n\n")
        self.wfile.flush()

    def do_POST(self) -> None:
        if self.path != "/v1/responses":
            self.send_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})
            return
        if AUTH_TOKEN and self.headers.get("Authorization") != f"Bearer {AUTH_TOKEN}":
            self.send_json(401, {"error": {"message": "invalid local gateway key", "type": "authentication_error"}})
            return
        stream_headers_sent = False
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
            claude_model = resolve_claude_model(request.get("model"))
            claude_effort = resolve_claude_effort(requested_effort(request))
            # The router classifies the turn; only it can tell this bridge that
            # it is serving the root orchestrator rather than a delegated leaf.
            agent_role = resolve_agent_role(self.headers)
            prompt = prompt_from_input(request.get("input", ""), bridge_instructions(agent_role))
            cwd = resolve_cwd(request, self.headers)
            role_label = "orchestrator" if is_orchestrator_role(agent_role) else "leaf"
            print(f"claude request model={claude_model} effort={claude_effort} role={role_label} cwd={cwd}", flush=True)
            if not request.get("stream"):
                text = ""
                metadata: dict[str, Any] = {}
                for kind, value, _ in run_claude_stream(prompt, claude_model, claude_effort, cwd=cwd, agent_role=agent_role):
                    if kind == "delta":
                        text += value
                    elif kind == "complete":
                        text, metadata = value
                payload = response_payload(request.get("model", MODEL), text, metadata)
                print(f"claude-cli result chars={len(text)} model_usage={metadata.get('modelUsage', {})}", flush=True)
                self.send_json(200, payload)
                return

            response_id = f"resp_{secrets.token_hex(12)}"
            reasoning_id = f"rs_{secrets.token_hex(12)}"
            item_id = f"msg_{secrets.token_hex(10)}"
            initial = {"id": response_id, "object": "response", "created_at": int(time.time()), "model": request.get("model", MODEL), "status": "in_progress", "output": []}
            text = ""
            reasoning_text = ""
            metadata: dict[str, Any] = {}

            def start_stream() -> None:
                """Commit to the SSE response.

                Held back until Claude has produced real output (reasoning, a
                tool call, or answer text) so a provider that fails before doing
                any work is still reported as an HTTP status the router can fall
                back on.
                """
                nonlocal stream_headers_sent
                if stream_headers_sent:
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                stream_headers_sent = True
                self.close_connection = True
                self.send_sse("response.created", {"type": "response.created", "response": initial})
                self.send_sse("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {"id": reasoning_id, "type": "reasoning", "status": "in_progress", "summary": [], "content": []}})
                self.send_sse("response.reasoning_summary_part.added", {"type": "response.reasoning_summary_part.added", "item_id": reasoning_id, "output_index": 0, "summary_index": 0, "part": {"type": "summary_text", "text": ""}})
                self.send_sse("response.output_item.added", {"type": "response.output_item.added", "output_index": 1, "item": {"id": item_id, "type": "message", "role": "assistant", "status": "in_progress", "content": []}})
                self.send_sse("response.content_part.added", {"type": "response.content_part.added", "item_id": item_id, "output_index": 1, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})

            for kind, value, _ in run_claude_stream(prompt, claude_model, claude_effort, cwd=cwd, agent_role=agent_role):
                if kind == "delta":
                    start_stream()
                    text += value
                    self.send_sse("response.output_text.delta", {"type": "response.output_text.delta", "item_id": item_id, "delta": value, "content_index": 0, "output_index": 1})
                elif kind == "activity":
                    start_stream()
                    reasoning_text += value
                    self.send_sse("response.reasoning_summary_text.delta", {"type": "response.reasoning_summary_text.delta", "item_id": reasoning_id, "output_index": 0, "summary_index": 0, "delta": value})
                elif kind == "heartbeat":
                    if stream_headers_sent:
                        self.send_heartbeat()
                elif kind == "complete":
                    text, metadata = value

            start_stream()
            completed_reasoning = {"id": reasoning_id, "type": "reasoning", "status": "completed", "summary": [{"type": "summary_text", "text": reasoning_text}], "content": []}
            completed_message = message_item(text, item_id)
            payload = response_payload(request.get("model", MODEL), text, metadata, response_id, [completed_reasoning, completed_message])
            self.send_sse("response.reasoning_summary_text.done", {"type": "response.reasoning_summary_text.done", "item_id": reasoning_id, "output_index": 0, "summary_index": 0, "text": reasoning_text})
            self.send_sse("response.reasoning_summary_part.done", {"type": "response.reasoning_summary_part.done", "item_id": reasoning_id, "output_index": 0, "summary_index": 0, "part": {"type": "summary_text", "text": reasoning_text}})
            self.send_sse("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": completed_reasoning})
            self.send_sse("response.output_text.done", {"type": "response.output_text.done", "item_id": item_id, "text": text, "content_index": 0, "output_index": 1})
            self.send_sse("response.content_part.done", {"type": "response.content_part.done", "item_id": item_id, "output_index": 1, "content_index": 0, "part": {"type": "output_text", "text": text, "annotations": []}})
            self.send_sse("response.output_item.done", {"type": "response.output_item.done", "output_index": 1, "item": completed_message})
            self.send_sse("response.completed", {"type": "response.completed", "response": payload})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            print("client disconnected; Claude request cancelled", flush=True)
        except WorkspaceResolutionError as exc:
            print(f"Claude workspace resolution failed: {exc}", flush=True)
            try:
                self.send_json(400, {"error": {"message": str(exc), "type": "invalid_request_error"}})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        except ClaudeRateLimitError as exc:
            print(f"Claude rate limit: {exc}", flush=True)
            try:
                if stream_headers_sent:
                    self.send_sse("response.failed", {"type": "response.failed", "response": {"id": response_id, "status": "failed", "error": {"message": str(exc), "type": "rate_limit_error"}}})
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                else:
                    self.send_json(429, {"error": {"message": str(exc), "type": "rate_limit_error"}})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        except ClaudeOverloadedError as exc:
            print(f"Claude overloaded: {exc}", flush=True)
            try:
                if stream_headers_sent:
                    self.send_sse("response.failed", {"type": "response.failed", "response": {"id": response_id, "status": "failed", "error": {"message": str(exc), "type": "overloaded_error"}}})
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                else:
                    self.send_json(503, {"error": {"message": str(exc), "type": "overloaded_error"}})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        except subprocess.TimeoutExpired:
            if stream_headers_sent:
                self.send_sse("response.failed", {"type": "response.failed", "response": {"id": response_id, "status": "failed", "error": {"message": "Claude CLI timed out", "type": "timeout_error"}}})
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            else:
                self.send_json(504, {"error": {"message": "Claude CLI timed out", "type": "timeout_error"}})
        except Exception as exc:
            print(f"Claude upstream failure: {exc}", flush=True)
            try:
                if stream_headers_sent:
                    self.send_sse("response.failed", {"type": "response.failed", "response": {"id": response_id, "status": "failed", "error": {"message": str(exc), "type": "upstream_error"}}})
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                else:
                    self.send_json(502, {"error": {"message": str(exc), "type": "upstream_error"}})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
