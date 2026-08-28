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
from typing import Any
from urllib.parse import urlsplit

HOST = "127.0.0.1"
PORT = 4000
MODEL = "claude-subscription"
AUTH_TOKEN = os.environ.get("LITELLM_API_KEY", "")
PROJECT_ROOT = "/Users/henrykirk/Desktop/RacingGame"
CLAUDE_TIMEOUT_SECONDS = float(os.environ.get("CLAUDE_CODE_BRIDGE_TIMEOUT_SECONDS", "300"))
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


def prompt_from_input(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return json.dumps(value, ensure_ascii=False)
    parts: list[str] = []
    for item in value:
        if isinstance(item, str):
            parts.append(item)
            continue
        if not isinstance(item, dict):
            parts.append(json.dumps(item, ensure_ascii=False))
            continue
        role = item.get("role", "user")
        content = item.get("content", "")
        if isinstance(content, list):
            content = "\n".join(
                str(part.get("text", part)) if isinstance(part, dict) else str(part)
                for part in content
            )
        parts.append(f"[{role}]\n{content}")
    return "\n\n".join(parts)


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


def claude_cli_args(prompt: str, model: str, effort: str) -> list[str]:
    return [
        CLI,
        "-p",
        prompt,
        "--model",
        model,
        "--effort",
        effort,
        "--disallowed-tools",
        ",".join(DISALLOWED_CLAUDE_TOOLS),
        "--permission-mode",
        os.environ.get("CLAUDE_CODE_PERMISSION_MODE", "acceptEdits"),
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--no-session-persistence",
    ]


def resolve_cwd(request: dict[str, Any], prompt: str) -> str:
    for key in ("cwd", "project_root", "working_directory"):
        val = request.get(key)
        if isinstance(val, str) and os.path.isdir(val):
            return val
    meta = request.get("metadata")
    if isinstance(meta, dict):
        for key in ("cwd", "project_root", "working_directory"):
            val = meta.get(key)
            if isinstance(val, str) and os.path.isdir(val):
                return val
    match = re.search(r"(?:Working directory:|cwd:|in directory:?)\s*([/\w.-]+)", prompt, re.IGNORECASE)
    if match:
        candidate = match.group(1).strip()
        if os.path.isdir(candidate):
            return candidate
    if os.path.isdir(PROJECT_ROOT):
        return PROJECT_ROOT
    return os.getcwd()


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


def run_claude_stream(prompt: str, model: str = DEFAULT_CLAUDE_MODEL, effort: str = DEFAULT_CLAUDE_EFFORT, cwd: str = PROJECT_ROOT):
    process = subprocess.Popen(
        claude_cli_args(prompt, model, effort),
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
    result: dict[str, Any] = {}
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
                delta = nested_text(value) if event_type == "stream_event" else ""
                if event_type == "assistant":
                    full_text = text_from_content(value.get("message", {}).get("content", []))
                    delta = full_text[len(emitted):] if full_text.startswith(emitted) else full_text
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
                if result.get("is_error"):
                    message = str(result.get("result", "Claude CLI returned an error"))
                    raise_classified_claude_error(message)
                    raise RuntimeError(message)
                if return_code != 0:
                    detail = "\n".join(stderr_lines)[-4000:]
                    raise RuntimeError(f"Claude CLI exited {return_code}: {detail}")
                final_text = str(result.get("result", emitted))
                if final_text and final_text != emitted:
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


def response_payload(model: str, text: str, metadata: dict[str, Any], response_id: str | None = None) -> dict[str, Any]:
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
        "output": [{"id": f"msg_{secrets.token_hex(10)}", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]}],
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
            prompt = prompt_from_input(request.get("input", ""))
            cwd = resolve_cwd(request, prompt)
            print(f"claude request model={claude_model} effort={claude_effort} cwd={cwd}", flush=True)
            if not request.get("stream"):
                text = ""
                metadata: dict[str, Any] = {}
                for kind, value, _ in run_claude_stream(prompt, claude_model, claude_effort, cwd=cwd):
                    if kind == "delta":
                        text += value
                    elif kind == "complete":
                        text, metadata = value
                payload = response_payload(request.get("model", MODEL), text, metadata)
                print(f"claude-cli result chars={len(text)} model_usage={metadata.get('modelUsage', {})}", flush=True)
                self.send_json(200, payload)
                return

            response_id = f"resp_{secrets.token_hex(12)}"
            item_id = f"msg_{secrets.token_hex(10)}"
            initial = {"id": response_id, "object": "response", "created_at": int(time.time()), "model": request.get("model", MODEL), "status": "in_progress", "output": []}
            text = ""
            metadata: dict[str, Any] = {}

            def start_stream() -> None:
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
                self.send_sse("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": {"id": item_id, "type": "message", "role": "assistant", "status": "in_progress", "content": []}})
                self.send_sse("response.content_part.added", {"type": "response.content_part.added", "item_id": item_id, "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})

            for kind, value, _ in run_claude_stream(prompt, claude_model, claude_effort, cwd=cwd):
                if kind == "delta":
                    start_stream()
                    text += value
                    self.send_sse("response.output_text.delta", {"type": "response.output_text.delta", "item_id": item_id, "delta": value, "content_index": 0, "output_index": 0})
                elif kind == "heartbeat":
                    if stream_headers_sent:
                        self.send_heartbeat()
                elif kind == "complete":
                    text, metadata = value

            start_stream()
            payload = response_payload(request.get("model", MODEL), text, metadata, response_id)
            self.send_sse("response.output_text.done", {"type": "response.output_text.done", "item_id": item_id, "text": text, "content_index": 0, "output_index": 0})
            self.send_sse("response.content_part.done", {"type": "response.content_part.done", "item_id": item_id, "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": text, "annotations": []}})
            self.send_sse("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": payload["output"][0]})
            self.send_sse("response.completed", {"type": "response.completed", "response": payload})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            print("client disconnected; Claude request cancelled", flush=True)
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

