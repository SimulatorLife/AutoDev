#!/usr/bin/env python3
"""Local OpenAI Responses adapter backed by the authenticated Claude CLI.

The Claude CLI is run in stream-json mode so a slow or rate-limited upstream
request cannot look like a dead Codex task.  The adapter keeps the CLI's
OAuth-only environment and translates its text deltas into Responses SSE.
"""

from __future__ import annotations

import json
import math
import os
import queue
import re
import secrets
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

HOST = os.environ.get("CLAUDE_BRIDGE_HOST", "127.0.0.1")
# Overridable so a second instance can be exercised without taking the port out
# from under the running service, matching the MiniMax and Antigravity proxies.
# The launchd service sets neither and keeps the default.
PORT = int(os.environ.get("CLAUDE_BRIDGE_PORT", "4000"))
MODEL = "claude-subscription"
AUTH_TOKEN = os.environ.get("LITELLM_API_KEY", "")
PROJECT_ROOT = os.environ.get("CODEX_PROJECT_ROOT")
# Match the router and Antigravity bridge's long-running turn budget. Operators
# can still choose a shorter/longer limit through the environment, but a
# default five-minute ceiling made legitimate tool-heavy subagent turns look
# like premature transport failures.
CLAUDE_TIMEOUT_SECONDS = float(os.environ.get("CLAUDE_CODE_BRIDGE_TIMEOUT_SECONDS", "900"))
CLI = os.environ.get("CLAUDE_BIN", os.path.expanduser("~/.local/bin/claude"))
DEFAULT_CLAUDE_MODEL = "sonnet"
DEFAULT_CLAUDE_EFFORT = "medium"
# Claude Code's Agent tool (Task in older releases) is the recursive boundary.
# Keep it unavailable for every request sent through this gateway; the parent
# Codex process remains responsible for orchestration.
DISALLOWED_CLAUDE_TOOLS = ("Agent", "Task")

# Tools that reach *outside* this turn's own agent tree, to other Claude
# sessions running on the same machine. Denied for every role, orchestrator
# included: an AutoDev turn's blast radius is its own workspace and its own
# children, and one orchestrator reaching another orchestrator's agents is
# outside it in both directions.
#
# Measured on Claude Code 2.1.260, a `-p` print-mode process -- which is the
# only way this bridge ever starts the CLI -- does not register on the peer
# socket bus at all, so these tools are not available to it today and denying
# them changes nothing now. That is exactly why it is worth pinning: the
# isolation currently rests on an undocumented property of print mode, and a
# future release that exposes peer messaging headlessly would silently widen
# every bridged agent's reach. An unknown name in --disallowed-tools is inert,
# so this costs nothing while that property holds.
CROSS_SESSION_CLAUDE_TOOLS = ("SendMessage", "ListAgents")

# Claude Code runs behind the Responses bridge rather than loading Codex's TOML
# role file. Keep the browser role's MCP contract here too: otherwise a native
# Codex child sees Playwright while a browser-tester routed to Claude silently
# falls back to shell-only investigation. The prefixed names are the tool names
# Claude Code assigns to an MCP server's tools.
PLAYWRIGHT_AGENT_ROLES = frozenset({"browser-tester", "smart"})
PLAYWRIGHT_COMMAND = "pnpm"
PLAYWRIGHT_ARGS = ("exec", "playwright-mcp")
PLAYWRIGHT_DISALLOWED_TOOLS = tuple(
    f"mcp__playwright__{name}"
    for name in (
        "browser_drop",
        "browser_evaluate",
        "browser_file_upload",
        "browser_navigate_back",
        "browser_network_request",
        "browser_run_code_unsafe",
    )
)


# Provider limit vocabulary. These literals mirror
# scripts/codex/lib/provider-limits.mjs exactly, and
# tests/provider-limits.test.mjs reads this file as text to assert they still
# do: the router reads what this bridge writes, so the two must not drift.
LIMIT_HEADER_CLASS = "x-autodev-limit-class"
LIMIT_HEADER_TYPE = "x-autodev-limit-type"
LIMIT_HEADER_RESETS_AT = "x-autodev-limit-resets-at"
LIMIT_HEADER_SOURCE = "x-autodev-limit-source"
# `reported` means Claude itself said so -- a rate_limit_event carrying a
# status. `inferred` means this bridge matched free text, which is a hint worth
# acting on but not evidence: only `reported` corroborates a long hard cooldown
# in the router.
LIMIT_SOURCE_REPORTED = "reported"
LIMIT_SOURCE_INFERRED = "inferred"
INCOMPLETE_REASON_PROVIDER_LIMIT = "provider_limit"
INCOMPLETE_REASON_TIMEOUT = "provider_timeout"
INCOMPLETE_REASON_INTERRUPTED = "provider_interrupted"
# The upstream closed the connection while the provider was in the middle of
# executing a tool that spawns sub-agents (Claude: Agent / Task). Mirrors the
# JS-side INCOMPLETE_REASON_CLIENT_DISCONNECTED in scripts/codex/lib/provider-limits.mjs;
# the provider-limits test asserts both sides agree so they cannot drift.
INCOMPLETE_REASON_CLIENT_DISCONNECTED = "client_disconnected"
HARD_LIMIT_CLASSES = ("quota_exhausted", "session_limit")


class ClaudeRateLimitError(RuntimeError):
    """Claude rejected the request because an account/session limit applies.

    Carries the limit structurally as well as in the message: the router needs
    the class and the real reset time to decide how long to stop routing here,
    and re-deriving either by matching this message's prose is exactly the
    guessing this field set exists to end.
    """

    def __init__(
        self,
        message: str,
        limit_class: str = "session_limit",
        limit_type: str | None = None,
        resets_at: str | None = None,
        source: str = LIMIT_SOURCE_INFERRED,
    ) -> None:
        super().__init__(message)
        self.limit_class = limit_class
        self.limit_type = limit_type
        self.resets_at = resets_at
        self.source = source

    @property
    def limit(self) -> dict[str, Any]:
        return {
            "limit_class": self.limit_class,
            "limit_type": self.limit_type,
            "resets_at": self.resets_at,
            "source": self.source,
        }


class ClaudeOverloadedError(RuntimeError):
    """Claude temporarily reported capacity pressure."""


class WorkspaceResolutionError(RuntimeError):
    """The request had no usable structured workspace and no explicit operator override."""


class AmbiguousWorkspaceError(WorkspaceResolutionError):
    """More than one workspace in the turn metadata exists on this host."""

    def __init__(self, candidates: list[str]) -> None:
        self.candidates = candidates
        super().__init__(
            f"turn metadata lists {len(candidates)} workspaces that exist on this host "
            f"({', '.join(candidates)}) and does not say which is active; refusing to let key "
            "order decide which repository this turn edits. Set CODEX_PROJECT_ROOT to pin one."
        )


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
# with the root delegation hook. One relative path covers both layouts: this
# file sits beside `codex/prompts/` in a checkout (`scripts/`) and again in the
# installed copy (`$CODEX_HOME/hooks/`).
_PROMPT_DIRECTORY = Path(__file__).resolve().parent / "codex" / "prompts"
_ORCHESTRATION_SKILL = _PROMPT_DIRECTORY.parent / "skills" / "orchestration" / "SKILL.md"
_CODE_SEARCH_PROMPT = _PROMPT_DIRECTORY / "code-search.md"
_ROLE_PROMPT_DIRECTORY = _PROMPT_DIRECTORY / "roles"


def load_bridge_prompt(name: str) -> str:
    prompt = _PROMPT_DIRECTORY / f"{name}.md"
    if not prompt.is_file():
        raise RuntimeError(f"Bridge prompt {name!r} was not found at: {prompt}")
    return prompt.read_text(encoding="utf-8").strip()


def load_role_prompt(role: str) -> str:
    prompt = _ROLE_PROMPT_DIRECTORY / f"{role}.md"
    if not prompt.is_file():
        raise RuntimeError(f"Role prompt {role!r} was not found at: {prompt}")
    return prompt.read_text(encoding="utf-8").strip()


LEAF_BRIDGE_INSTRUCTIONS = load_bridge_prompt("leaf")
ORCHESTRATOR_BRIDGE_INSTRUCTIONS = load_bridge_prompt("orchestrator")
_CONTRACT_FILE = _PROMPT_DIRECTORY.parent / "execution-contract.json"
try:
    EXECUTION_CONTRACT = json.loads(_CONTRACT_FILE.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    raise RuntimeError(f"execution contract could not be loaded from {_CONTRACT_FILE}: {exc}") from exc
# Replaces the Claude CLI's own default system prompt rather than appending to
# it, so bridge turns are governed only by AutoDev policy. See system_prompt().
BASE_SYSTEM_PROMPT = load_bridge_prompt("base")


# Router-generated headers that let this bridge report the subagents the Claude
# CLI spawns inside its own runtime. Claude's `Agent` tool runs the child agent
# in-process, so no request for it ever reaches the model router: without a
# report, an orchestrator turn served here shows zero subagents in /status and
# the dashboard, which is indistinguishable from a provider that refused to
# delegate. The router supplies the watchlist, the endpoint, and the request id
# that correlates the report; the request id is a router-generated UUID this
# bridge only learns by serving the request, so presenting it is also what
# authorizes the report. Mirrors scripts/codex/lib/agent-events.mjs.
REQUEST_ID_HEADER = "x-autodev-request-id"
SUBAGENT_SPAWN_TOOLS_HEADER = "x-autodev-subagent-spawn-tools"
AGENT_EVENTS_URL_HEADER = "x-autodev-agent-events-url"
AGENT_EVENTS_TIMEOUT_SECONDS = 5.0


class AgentEventReporter:
    """Posts subagent spawns observed in the Claude CLI stream to the router."""

    def __init__(self, url: str, request_id: str, spawn_tools: frozenset[str]) -> None:
        self.url = url
        self.request_id = request_id
        self.spawn_tools = spawn_tools

    def is_spawn_tool(self, name: Any) -> bool:
        return isinstance(name, str) and name in self.spawn_tools

    def report_spawn_async(self, tool: str, role: str | None = None, status: str = "started") -> None:
        """Report without blocking the stream loop on an HTTP round trip."""
        threading.Thread(target=self.report_spawn, args=(tool, role, status), daemon=True).start()

    def report_spawn(self, tool: str, role: str | None = None, status: str = "started") -> None:
        """Best effort by design: telemetry must never fail a model turn, so a
        transport error or non-2xx reply costs a count rather than the turn."""
        self.post([{"type": "subagent_spawn", "tool": tool, "role": role, "status": status, "count": 1}])

    def report_spawn_tools_unavailable_async(self, available: Any) -> None:
        threading.Thread(target=self.report_spawn_tools_unavailable, args=(available,), daemon=True).start()

    def report_spawn_tools_unavailable(self, available: Any) -> None:
        """Report that the CLI offered no delegation tool at all.

        A workspace can remove the tool from under an orchestrator turn: a
        project `.claude/settings.json` listing `Agent` under
        `permissions.deny` strips it whatever this bridge allows, and the turn
        then quietly does the work itself. Zero spawns reads exactly like a
        provider that chose not to delegate, so the absence is its own report.
        """
        names = [name for name in (available or []) if isinstance(name, str)]
        self.post([{
            "type": "subagent_tools_unavailable",
            "expected": sorted(self.spawn_tools),
            # Bounded and name-only: a tool inventory fingerprints the
            # workspace, and the router needs only enough to name the gap.
            "available": names[:100],
        }])

    def post(self, events: list[dict[str, Any]]) -> None:
        body = json.dumps({"requestId": self.request_id, "events": events}).encode()
        request = Request(self.url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(request, timeout=AGENT_EVENTS_TIMEOUT_SECONDS) as response:
                if response.status < 200 or response.status >= 300:
                    raise URLError(f"HTTP {response.status}")
        except (URLError, OSError, ValueError) as exc:
            # Best effort by design: preserve the model turn, but leave a
            # credential-free loss record so missing child telemetry is visible.
            print(json.dumps({
                "schema": "autodev-agent-telemetry-v1",
                "event": "report_lost",
                "requestId": self.request_id,
                "reason": str(exc),
            }), flush=True)


def resolve_agent_event_reporter(headers: Any) -> AgentEventReporter | None:
    """A reporter for this request, or None when the router asked for none."""
    if headers is None or not hasattr(headers, "get"):
        return None

    def value(name: str) -> str | None:
        raw = headers.get(name)
        return raw.strip() if isinstance(raw, str) and raw.strip() else None

    url = value(AGENT_EVENTS_URL_HEADER)
    request_id = value(REQUEST_ID_HEADER)
    tools = value(SUBAGENT_SPAWN_TOOLS_HEADER)
    if not url or not request_id or not tools:
        return None
    spawn_tools = frozenset(tool.strip() for tool in tools.split(",") if tool.strip())
    return AgentEventReporter(url, request_id, spawn_tools) if spawn_tools else None


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
    key = "orchestrator" if is_orchestrator_role(role) else (str(role).lower() if role else "default")
    contract = EXECUTION_CONTRACT.get("roles", {}).get(key) or EXECUTION_CONTRACT["roles"]["default"]
    expected = ", ".join(contract.get("mcp", [])) or "none declared"
    base = ORCHESTRATOR_BRIDGE_INSTRUCTIONS if is_orchestrator_role(role) else LEAF_BRIDGE_INSTRUCTIONS
    canonical = ""
    if is_orchestrator_role(role) and _ORCHESTRATION_SKILL.is_file():
        canonical = f"\n\n## Canonical orchestration skill\n\n{_ORCHESTRATION_SKILL.read_text(encoding='utf-8').strip()}"
    code_search = ""
    if "lsp" in contract.get("mcp", []) and "cocoindex-code" in contract.get("mcp", []) and _CODE_SEARCH_PROMPT.is_file():
        code_search = f"\n\n{_CODE_SEARCH_PROMPT.read_text(encoding='utf-8').strip()}"
    role_key = "orchestrator" if is_orchestrator_role(role) else (str(role).lower() if role else "default")
    if not (_ROLE_PROMPT_DIRECTORY / f"{role_key}.md").is_file():
        role_key = "default"
    role_prompt = load_role_prompt(role_key)
    return (f"{base}{canonical}{code_search}\n\n## Effective role contract\n\n"
            f"{role_prompt}\n\n"
            f"Expected MCP/tool capabilities: {expected}. If a required capability is unavailable, "
            "report that fact instead of silently substituting a different workflow.")


def system_prompt(role: Any, cwd: str) -> str:
    """The complete system prompt for one bridge turn.

    `--system-prompt` replaces the Claude CLI's default prompt outright, which
    also drops the per-machine sections it would otherwise inject (working
    directory, platform, git status). The workspace the bridge resolved from
    structured request metadata is therefore stated here: without it the agent
    starts a turn not knowing which repository it is in. Role policy comes last
    so it is the most recent instruction the model reads.
    """
    return (
        f"{BASE_SYSTEM_PROMPT}\n\n"
        "## Workspace\n\n"
        f"Working directory: {cwd}\n"
        f"Platform: {sys.platform}\n\n"
        f"{bridge_instructions(role)}"
    )


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return json.dumps(content, ensure_ascii=False)
    return "\n".join(
        str(part.get("text", part)) if isinstance(part, dict) else str(part)
        for part in content
    )


# Stage 0 diagnostic, enabled with AUTODEV_LOG_TOOLS=1.
#
# The design for bridging delegation into Codex's own spawn tool rests on one
# unverified claim: that the router's outbound tool flattening actually puts a
# `multi_agent_v1__*` entry in front of this bridge, and that Codex sends the
# matching `function_call_output` back in a shape this bridge can pair up. Both
# are cheap to observe and expensive to guess wrong, so observe them first.
# This is scaffolding -- it comes out once the spawn bridge is built.
LOG_TOOLS = os.environ.get("AUTODEV_LOG_TOOLS") == "1"


def _tool_names(tools: Any) -> list[str]:
    names: list[str] = []
    for tool in tools if isinstance(tools, list) else []:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if not isinstance(name, str):
            function = tool.get("function")
            name = function.get("name") if isinstance(function, dict) else None
        if isinstance(name, str):
            names.append(name)
    return names


def log_inbound_request(request: Any, headers: Any) -> None:
    """Record what Codex offered and what the router said about this turn."""
    if not LOG_TOOLS:
        return
    tools = request.get("tools")
    routing = {
        key: value
        for key, value in headers.items()
        if key.lower().startswith(("x-autodev-", "x-codex-"))
    }
    print(f"[stage0] tool_names={sorted(_tool_names(tools))}", flush=True)
    print(f"[stage0] routing_headers={json.dumps(routing, sort_keys=True)}", flush=True)
    for tool in tools if isinstance(tools, list) else []:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if isinstance(name, str) and name.startswith("multi_agent_v1"):
            print(f"[stage0] spawn_tool={json.dumps(tool, sort_keys=True)}", flush=True)
    for item in request.get("input") or []:
        if isinstance(item, dict) and item.get("type") in ("function_call", "function_call_output"):
            print(f"[stage0] input_item={json.dumps(item, sort_keys=True)[:2000]}", flush=True)


# --- Driving Codex's own spawner from this bridge ----------------------------
#
# Children spawned inside the Claude CLI are invisible to Codex: no Codex thread
# exists, so the app has nothing to render and the router only learns of them
# through the /v1/agent-events side channel. Asking Codex to spawn instead gives
# a real, clickable session and routes the child back through the router like
# any other `autodev/<role>` request.
#
# Codex runs these models in *code mode*: the request carries no `tools` array,
# and the whole tool surface is one `exec` tool -- declared `"type": "custom"`
# inside an `additional_tools` input item -- whose payload is raw JavaScript
# evaluated in a V8 isolate. The spawner is reached from inside that script and
# is never named in the request. This mirrors
# scripts/codex/lib/codex-spawn-tools.mjs; tests/provider-limits.test.mjs style
# parity checks read both files as text, so the literals must not drift.
SPAWN_TOOL = "multi_agent_v1__spawn_agent"
EXEC_TOOL = "exec"
SPAWN_YIELD_MS = 60000

# Delegation is dispatched, not awaited: a spawn returns as soon as Codex has
# created the child (observed at 0.1-0.8s for a batch) and Codex tracks it from
# there. The CLI is told so explicitly, because a model that believes it must
# collect the results will otherwise sit and poll for output that never comes
# back through this channel.
SPAWN_DISPATCH_NOTICE = (
    "Dispatched {count} subagent(s): {roles}. They are running now and are tracked by the "
    "orchestration layer, not by you. End your turn now with a brief statement of what you "
    "delegated -- do not wait for them, and do not do their work yourself. On your next turn, "
    "consume terminal child results and close each known child handle immediately; the parent "
    "session's capacity is not released by completion alone."
)


def build_spawn_script(children: list[dict[str, Any]], yield_time_ms: int = SPAWN_YIELD_MS, recover_parent_id: str | None = None) -> str:
    """The JavaScript body for one spawn batch.

    One `Promise.allSettled` rather than a call per child keeps a wide fan-out
    to a single tool call, and mirrors the shape Codex's own GPT-served turns
    produce. A rejected child is returned as readable output instead of erasing
    siblings that were created. The role must travel as `agent_type`: `agent`
    is accepted and silently ignored, and the child comes back generic instead
    of the role that was asked for.
    """
    if not children:
        raise ValueError("build_spawn_script requires at least one child")
    tasks = []
    for child in children:
        agent_type = child.get("agent_type")
        message = child.get("message") or ""
        # json.dumps is the escaping: the script is source text, and a prompt
        # containing quotes or newlines would otherwise end the string literal.
        if isinstance(agent_type, str) and agent_type.strip():
            tasks.append(f"{{ agent_type: {json.dumps(agent_type.strip())}, message: {json.dumps(message)} }}")
        else:
            tasks.append(f"{{ message: {json.dumps(message)} }}")
    recovery = []
    if isinstance(recover_parent_id, str) and recover_parent_id.strip():
        recovery = [
            f"const recoveryParentId = {json.dumps(recover_parent_id.strip())};",
            'const recoveryTerminal = new Set(["completed", "errored", "interrupted", "shutdown", "not_found"]);',
            'const recoveryObjects = (value, seen = new Set()) => { if (!value || typeof value !== "object" || seen.has(value)) return []; seen.add(value); const found = [value]; if (Array.isArray(value)) for (const item of value) found.push(...recoveryObjects(item, seen)); else for (const item of Object.values(value)) found.push(...recoveryObjects(item, seen)); return found; };',
            'const recoveryParse = (value) => { if (value && typeof value === "object") return value; if (typeof value !== "string") return null; try { return JSON.parse(value); } catch { return null; } };',
            'const recoverOwnedTerminalChildren = async () => { if (typeof tools.mcp__codex_app__read_thread !== "function") return; let history; try { history = await tools.mcp__codex_app__read_thread({ threadId: recoveryParentId, turnLimit: 20, includeOutputs: false, maxOutputCharsPerItem: 2000 }); } catch { return; } const parsed = [history, ...(history?.content ?? [])].flatMap((value) => { const object = recoveryParse(value?.text ?? value); return object ? [object] : []; }); const calls = recoveryObjects(parsed).filter((item) => item?.type === "collabAgentToolCall" && item.senderThreadId === recoveryParentId && Array.isArray(item.receiverThreadIds)); const childIds = [...new Set(calls.flatMap((item) => item.receiverThreadIds.filter((id) => typeof id === "string" && id.trim())))]; if (typeof tools.multi_agent_v1__wait_agent !== "function" || typeof tools.multi_agent_v1__close_agent !== "function") return; for (const childId of childIds) { let waited; try { waited = await tools.multi_agent_v1__wait_agent({ targets: [childId], timeout_ms: 30000 }); } catch { continue; } const status = waited?.status?.[childId]; const terminal = typeof status === "string" ? recoveryTerminal.has(status) : Boolean(status && typeof status === "object" && Object.keys(status).some((key) => recoveryTerminal.has(key))); if (!terminal) continue; try { await tools.multi_agent_v1__close_agent({ target: childId }); text(JSON.stringify({ recovery_status: "closed", child_id: childId, previous_status: status })); } catch { } } };',
            'await recoverOwnedTerminalChildren();',
        ]
    return "\n".join([
        f"// @exec: {json.dumps({'yield_time_ms': yield_time_ms}, separators=(',', ':'))}",
        *recovery,
        f"const tasks = [{', '.join(tasks)}];",
        f"const out = await Promise.allSettled(tasks.map((t) => tools.{SPAWN_TOOL}(t)));",
        'out.forEach((result) => text(JSON.stringify(result.status === "fulfilled" ? { spawn_status: "created", ...(result.value && typeof result.value === "object" ? result.value : {}) } : { spawn_status: "rejected", agent_id: null, error: String(result.reason?.message ?? result.reason) })));',
        "",
    ])


def exec_tool_call_events(item_id: str, call_id: str, source: str, output_index: int) -> list[tuple[str, dict[str, Any]]]:
    """The SSE events for one `exec` call, emitted atomically.

    The whole script is known before the first event is written. A partially
    written call is worse than none: the router's mid-stream backstop
    reconstructs `output` from the items it saw and would hand Codex a script
    that is valid JavaScript but truncated.
    """
    base = {"id": item_id, "type": "custom_tool_call", "call_id": call_id, "name": EXEC_TOOL}
    completed = {**base, "input": source, "status": "completed"}
    return [
        ("response.output_item.added", {"type": "response.output_item.added", "output_index": output_index, "item": {**base, "input": "", "status": "in_progress"}}),
        ("response.custom_tool_call_input.delta", {"type": "response.custom_tool_call_input.delta", "item_id": item_id, "output_index": output_index, "delta": source}),
        ("response.custom_tool_call_input.done", {"type": "response.custom_tool_call_input.done", "item_id": item_id, "output_index": output_index, "input": source}),
        ("response.output_item.done", {"type": "response.output_item.done", "output_index": output_index, "item": completed}),
    ], completed


# Codex conversations with a turn in flight, so the MCP shim's out-of-band HTTP
# call can find the turn it belongs to. Keyed by the router's session id; a turn
# the router could not identify never registers, because two unrelated Codex
# conversations would otherwise share one entry.
SPAWN_SESSIONS: dict[str, dict[str, Any]] = {}
SPAWN_SESSIONS_LOCK = threading.Lock()
UNIDENTIFIED_SESSION_SCOPE = "process-fallback"


def can_hold_spawn_session(session_key: Any, session_scope: Any) -> bool:
    return isinstance(session_key, str) and bool(session_key.strip()) and session_scope != UNIDENTIFIED_SESSION_SCOPE


def open_spawn_session(session_key: str, *, orchestrator: bool) -> None:
    with SPAWN_SESSIONS_LOCK:
        SPAWN_SESSIONS[session_key] = {"orchestrator": orchestrator, "children": []}


def close_spawn_session(session_key: str) -> list[dict[str, Any]]:
    with SPAWN_SESSIONS_LOCK:
        entry = SPAWN_SESSIONS.pop(session_key, None)
    return list(entry["children"]) if entry else []


def record_spawn_request(session_key: str, children: list[dict[str, Any]]) -> tuple[bool, str]:
    """Record one delegation request against an in-flight turn.

    Returns (accepted, message-for-the-model). A refusal is deliberately a
    readable sentence rather than a transport error. Missing session state is
    an admission failure with no child to close; only a bounded leaf may be
    told to do the work directly.
    """
    with SPAWN_SESSIONS_LOCK:
        entry = SPAWN_SESSIONS.get(session_key)
        if entry is None:
            return False, "Delegation is unavailable in this session; no child was created. Do not retry blindly or take over delegated scopes. Report the unavailable delegation path."
        if not entry["orchestrator"]:
            return False, "This is a bounded leaf turn and may not delegate. Do the work directly."
        accepted = []
        for child in children:
            message = child.get("message")
            if not isinstance(message, str) or not message.strip():
                continue
            agent_type = child.get("agent_type")
            accepted.append({
                "agent_type": agent_type.strip() if isinstance(agent_type, str) and agent_type.strip() else None,
                "message": message,
            })
        if not accepted:
            return False, "Every child needs a non-empty `message`. Nothing was dispatched."
        entry["children"].extend(accepted)
    roles = ", ".join(sorted({c["agent_type"] or "default" for c in accepted}))
    return True, SPAWN_DISPATCH_NOTICE.format(count=len(accepted), roles=roles)


def prompt_from_input(value: Any) -> str:
    """The delegated task text alone.

    Role policy reaches the CLI through the system prompt, so repeating it here
    would state the same instructions twice with the untrusted task text between
    them.
    """
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
    return f"Delegated task:\n{task}"


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
    # Claude Code ships its own skill catalogue, none of which is AutoDev
    # policy. A bridge turn is governed by the role prompts and the target
    # repository's own skills, so the bundled set is dead weight in the context
    # window and a second, unversioned source of instructions.
    environment["CLAUDE_CODE_DISABLE_BUNDLED_SKILLS"] = "1"
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


class ToolUseAccumulator:
    """Reassembles streamed `tool_use` blocks into completed calls.

    Claude opens a tool_use block with an empty `input` and streams the
    arguments as `input_json_delta` fragments, so `content_block_start` carries
    the tool name but never the arguments. A completed block is also the point
    at which the tool actually runs -- a block the stream abandons was never
    invoked -- so blocks are emitted on `content_block_stop`, with the
    accumulated arguments parsed back into `input`.
    """

    def __init__(self) -> None:
        self._open: dict[Any, tuple[dict[str, Any], list[str]]] = {}

    def feed(self, event: dict[str, Any]) -> dict[str, Any] | None:
        if event.get("type") != "stream_event":
            return None
        inner = event.get("event")
        if not isinstance(inner, dict):
            return None
        index = inner.get("index")
        inner_type = inner.get("type")
        if inner_type == "content_block_start":
            block = inner.get("content_block")
            if isinstance(block, dict) and block.get("type") == "tool_use":
                self._open[index] = (block, [])
            return None
        if inner_type == "content_block_delta":
            delta = inner.get("delta")
            if isinstance(delta, dict) and delta.get("type") == "input_json_delta" and index in self._open:
                self._open[index][1].append(str(delta.get("partial_json", "")))
            return None
        if inner_type != "content_block_stop" or index not in self._open:
            return None
        block, fragments = self._open.pop(index)
        try:
            arguments = json.loads("".join(fragments))
        except json.JSONDecodeError:
            arguments = None
        return {**block, "input": arguments if isinstance(arguments, dict) else block.get("input")}


def subagent_role_from_input(block: dict[str, Any]) -> str | None:
    """The child agent type an `Agent`/`Task` call names, when it names one."""
    payload = block.get("input")
    if not isinstance(payload, dict):
        return None
    for key in ("subagent_type", "agent_type", "agent"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


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


def mcp_config_for_role(role: Any = None, spawn_session: str | None = None) -> str | None:
    """Return bridge-owned MCP servers needed by this role.

    The Claude CLI accepts an inline JSON string with ``--mcp-config``. Do not
    write a shared ``~/.claude`` setting: that would expose a browser server to
    unrelated sessions and would leave the provider dependent on mutable user
    state. Without ``--strict-mcp-config`` these entries augment the project's
    own servers.
    """
    servers: dict[str, Any] = {}
    contract_key = "orchestrator" if is_orchestrator_role(role) else (str(role).lower() if role else "default")
    role_contract = EXECUTION_CONTRACT.get("roles", {}).get(contract_key) or EXECUTION_CONTRACT["roles"]["default"]
    if "lsp" in role_contract.get("mcp", []):
        servers["lsp"] = {
            "command": "bash",
            "args": ["-lc", 'exec "${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh" lsp'],
        }
    if "cocoindex-code" in role_contract.get("mcp", []):
        servers["cocoindex-code"] = {
            "command": "ccc",
            "args": ["mcp"],
        }
    if role in PLAYWRIGHT_AGENT_ROLES:
        servers["playwright"] = {
            "command": PLAYWRIGHT_COMMAND,
            "args": list(PLAYWRIGHT_ARGS),
        }
    if is_orchestrator_role(role) and spawn_session:
        shim = os.path.join(os.path.dirname(os.path.abspath(__file__)), "codex", "lib", "spawn-shim-mcp.mjs")
        servers["autodev_spawn"] = {
            "command": os.environ.get("AUTODEV_NODE_BIN", "node"),
            "args": [shim],
            "env": {
                "AUTODEV_BRIDGE_URL": f"http://{HOST}:{PORT}",
                "AUTODEV_BRIDGE_TOKEN": AUTH_TOKEN,
                "AUTODEV_SPAWN_SESSION": spawn_session,
            },
        }
    return json.dumps({"mcpServers": servers}) if servers else None


def spawn_shim_mcp_config(session_key: str) -> str:
    """The MCP server config for the Codex delegation shim.

    Kept as a narrow helper for callers/tests that need to inspect the shim
    entry; normal CLI construction uses :func:`mcp_config_for_role` so a
    browser role can receive Playwright in the same invocation.
    """
    return mcp_config_for_role("orchestrator", session_key)  # type: ignore[return-value]


def claude_cli_args(prompt: str, model: str, effort: str, agent_role: Any = None, cwd: str = ".", spawn_session: str | None = None) -> list[str]:
    codex_home = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
    configured_dirs = [
        directory
        for directory in os.environ.get("CLAUDE_CODE_ADDITIONAL_DIRS", codex_home).split(os.pathsep)
        if directory
    ]
    # Workspace-local skills and policy are part of the target contract. Expose
    # the workspace's .agents tree to Claude without making it a global user
    # registry or guessing from task prose.
    workspace_agents = os.path.join(cwd, ".agents") if cwd else ""
    if workspace_agents and os.path.isdir(workspace_agents) and workspace_agents not in configured_dirs:
        configured_dirs.append(workspace_agents)
    additional_dirs = tuple(configured_dirs)
    orchestrator = is_orchestrator_role(agent_role)
    # Delegation is the root orchestrator's job, so it keeps the delegation tool
    # the recursion boundary removes from every leaf role -- but *which* tool it
    # keeps depends on whether this turn can reach Codex's own spawner.
    #
    # With the shim available, Claude's own `Agent` tool is denied to the
    # orchestrator too. That is the entire point: a child spawned inside this
    # CLI is invisible to Codex and to the app, so leaving `Agent` in place
    # would just offer a second, worse door that the model would sometimes
    # choose. Without a session to hold, the shim cannot work and `Agent` stays
    # as the fallback -- an invisible child still beats no delegation at all.
    # Cross-session reach is denied in every case: see CROSS_SESSION_CLAUDE_TOOLS.
    shim_available = orchestrator and bool(spawn_session)
    if orchestrator and not shim_available:
        denied = list(CROSS_SESSION_CLAUDE_TOOLS)
    else:
        denied = [*DISALLOWED_CLAUDE_TOOLS, *CROSS_SESSION_CLAUDE_TOOLS]
    contract_key = "orchestrator" if orchestrator else (str(agent_role).lower() if agent_role else "default")
    role_contract = EXECUTION_CONTRACT.get("roles", {}).get(contract_key) or EXECUTION_CONTRACT["roles"]["default"]
    if role_contract.get("readOnly"):
        # Prompt text is not an enforcement boundary. Read-only roles must not
        # receive shell or file-mutating Claude tools even when the bridge uses
        # a non-interactive permission mode.
        denied.extend(["Bash", "Edit", "Write", "NotebookEdit"])
    if agent_role in PLAYWRIGHT_AGENT_ROLES:
        denied.extend(PLAYWRIGHT_DISALLOWED_TOOLS)
    subagent_boundary = ["--disallowed-tools", ",".join(denied)]
    mcp_config = mcp_config_for_role(agent_role, spawn_session if shim_available else None)
    if mcp_config:
        subagent_boundary += ["--mcp-config", mcp_config]
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
        # Replace rather than append: appending leaves Claude Code's own
        # default prompt in force, which carries harness guidance (including a
        # standing instruction not to spawn agents unless asked) that competes
        # with the role policy this bridge is responsible for.
        "--system-prompt",
        system_prompt(agent_role, cwd),
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
    when no key is a directory that exists on this host.

    The caller does not tell us which workspace is "active", so two or more
    resolvable workspaces is an ambiguity, not a choice. Taking the first --
    which is what this used to do -- lets JSON key order decide which
    repository a coding agent edits, and key order carries no meaning. Mirrors
    ``resolveWorkspaceFromTurnMetadata`` in scripts/codex/lib/resolve-workspace.mjs.
    """
    workspaces = turn_metadata.get("workspaces") if isinstance(turn_metadata, dict) else None
    if not isinstance(workspaces, dict):
        return None
    from_keys = [key for key in workspaces if isinstance(key, str) and os.path.isdir(key)]
    if len(from_keys) > 1:
        raise AmbiguousWorkspaceError(from_keys)
    if from_keys:
        return from_keys[0]
    from_values: list[str] = []
    for entry in workspaces.values():
        candidate = _workspace_path_from_entry(entry)
        if isinstance(candidate, str) and os.path.isdir(candidate) and candidate not in from_values:
            from_values.append(candidate)
    if len(from_values) > 1:
        raise AmbiguousWorkspaceError(from_values)
    return from_values[0] if from_values else None


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
    try:
        workspace_path = _resolve_workspace_from_turn_metadata(turn_metadata)
    except AmbiguousWorkspaceError:
        # An explicit operator override is the documented way to pin one repo
        # per bridge, so it settles an ambiguity rather than being shadowed.
        if PROJECT_ROOT and os.path.isdir(PROJECT_ROOT):
            return PROJECT_ROOT
        raise
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


def normalize_resets_at(value: Any) -> str | None:
    """Normalize a reset time to ISO-8601 UTC.

    Claude states it as epoch seconds, epoch milliseconds, or an ISO string
    depending on release. Anything unparseable is dropped rather than guessed:
    the router stops routing to this provider until the time we hand it, so a
    wrong reset time is worse than no reset time.
    """
    if value is None or value == "":
        return None
    millis: float | None = None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        # Seconds and milliseconds are told apart by magnitude; a seconds value
        # large enough to be ambiguous would be in the year 33658.
        millis = float(value) if value > 1e11 else float(value) * 1000.0
    elif isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        if trimmed.isdigit():
            numeric = float(trimmed)
            millis = numeric if numeric > 1e11 else numeric * 1000.0
        else:
            try:
                parsed = datetime.fromisoformat(trimmed.replace("Z", "+00:00"))
            except ValueError:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            millis = parsed.timestamp() * 1000.0
    if millis is None:
        return None
    try:
        moment = datetime.fromtimestamp(millis / 1000.0, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


CLI_LIMIT_PATTERNS = (
    ("quota_exhausted", "quota", r"quota (?:exceeded|exhausted)|out of (?:credit|quota)|insufficient (?:credit|quota|fund)|billing|usage limit reached|weekly limit"),
    ("session_limit", "session", r"session limit|concurrent session|session capacity"),
    ("throttled", "rate", r"rate.?limit|too many requests|429"),
)
RESETS_AT_PATTERN = r"reset(?:s|ting)?(?: at| on| in)?[:\s]+([0-9TZ:.\-+ ]{4,40})"


def classify_cli_limit(message: Any, exit_code: Any = None) -> dict[str, Any] | None:
    """Best-effort classification of a CLI failure message.

    Always reports `inferred`. This reads free text, and a keyword in an error
    string must not be able to take a provider out for the hard-cooldown
    window; it is enough to pick a better HTTP status and a retry hint.
    """
    text = str(message or "")
    if not text.strip():
        return None
    for limit_class, limit_type, pattern in CLI_LIMIT_PATTERNS:
        if not re.search(pattern, text, re.IGNORECASE):
            continue
        resets_match = re.search(RESETS_AT_PATTERN, text, re.IGNORECASE)
        return {
            "limit_class": limit_class,
            "limit_type": limit_type,
            "resets_at": normalize_resets_at(resets_match.group(1).strip()) if resets_match else None,
            "source": LIMIT_SOURCE_INFERRED,
            "exit_code": exit_code if isinstance(exit_code, int) else None,
        }
    return None


def limit_response_headers(limit: dict[str, Any] | None) -> dict[str, str]:
    """Response headers describing a limit; absent fields are omitted."""
    if not limit or not limit.get("limit_class"):
        return {}
    headers = {LIMIT_HEADER_CLASS: limit["limit_class"]}
    if limit.get("limit_type"):
        headers[LIMIT_HEADER_TYPE] = limit["limit_type"]
    if limit.get("resets_at"):
        headers[LIMIT_HEADER_RESETS_AT] = limit["resets_at"]
    headers[LIMIT_HEADER_SOURCE] = LIMIT_SOURCE_REPORTED if limit.get("source") == LIMIT_SOURCE_REPORTED else LIMIT_SOURCE_INFERRED
    return headers


def retry_after_seconds_from_limit(limit: dict[str, Any] | None, now: float | None = None) -> int | None:
    """Seconds until the limit's stated reset, or None when it stated none."""
    resets_at = (limit or {}).get("resets_at")
    if not resets_at:
        return None
    try:
        moment = datetime.fromisoformat(str(resets_at).replace("Z", "+00:00"))
    except ValueError:
        return None
    reference = time.time() if now is None else now
    return max(1, math.ceil(moment.timestamp() - reference))


def limit_payload(limit: dict[str, Any] | None) -> dict[str, Any] | None:
    """The wire shape of a limit.

    Used identically for `incomplete_details.provider_limit` and for
    `error.limit` on a non-streamed failure, so the router reads one shape
    wherever it finds it.
    """
    if not limit or not limit.get("limit_class"):
        return None
    return {
        "class": limit["limit_class"],
        "type": limit.get("limit_type"),
        "resets_at": limit.get("resets_at"),
        "source": limit.get("source") or LIMIT_SOURCE_INFERRED,
    }


def incomplete_details(reason: str, limit: dict[str, Any] | None = None) -> dict[str, Any]:
    details: dict[str, Any] = {"reason": reason}
    payload = limit_payload(limit)
    if payload:
        details["provider_limit"] = payload
    return details


def truncation_notice(provider: str | None = None, limit: dict[str, Any] | None = None, reason: str = INCOMPLETE_REASON_PROVIDER_LIMIT) -> str:
    """The sentence appended to a truncated turn's text.

    The consumer is a model deciding what to do next, so it has to say plainly
    that the work is partial: a partial answer read as a complete one is worse
    than a failure.
    """
    who = f"The {provider} provider" if provider else "The provider"
    limit_class = (limit or {}).get("limit_class")
    if limit_class == "capacity":
        cause = "was over capacity"
    elif reason == INCOMPLETE_REASON_TIMEOUT:
        cause = "timed out"
    elif reason == INCOMPLETE_REASON_INTERRUPTED:
        cause = "stopped unexpectedly"
    elif reason == INCOMPLETE_REASON_CLIENT_DISCONNECTED:
        cause = "was disconnected mid-delegation"
    elif limit_class == "session_limit":
        cause = "reached its session limit"
    elif limit_class == "throttled":
        cause = "was rate limited"
    else:
        cause = "ran out of usage"
    resets = f" Usage resets at {limit['resets_at']}." if (limit or {}).get("resets_at") else ""
    return f"\n\n[Incomplete: {who} {cause} and this turn stopped here. Everything above is work that finished; nothing after it ran.{resets}]"


def terminal_incomplete_events(
    response_id: str,
    item_id: str,
    reasoning_id: str,
    text: str = "",
    reasoning_text: str = "",
    reason: str = INCOMPLETE_REASON_PROVIDER_LIMIT,
    limit: dict[str, Any] | None = None,
    provider: str | None = None,
    response: dict[str, Any] | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    """Ordered terminal events closing a turn that was cut short.

    Mirrors the success path this bridge already emits, so a consumer needs no
    special case beyond reading `status`. Returns (event_name, payload) pairs
    for the caller to send in order before writing `data: [DONE]`.
    """
    notice = truncation_notice(provider, limit, reason)
    final_text = f"{text}{notice}"
    completed_reasoning = {"id": reasoning_id, "type": "reasoning", "status": "incomplete", "summary": [{"type": "summary_text", "text": reasoning_text}], "content": []}
    completed_message = {"id": item_id, "type": "message", "role": "assistant", "status": "incomplete", "content": [{"type": "output_text", "text": final_text, "annotations": []}]}
    payload = dict(response or {"id": response_id, "object": "response", "created_at": int(time.time()), "output": []})
    payload.update({
        "id": response_id,
        "status": "incomplete",
        "incomplete_details": incomplete_details(reason, limit),
        "output": [completed_reasoning, completed_message],
        "output_text": final_text,
    })
    return [
        # The notice goes out as a delta first so a client rendering the stream
        # live sees it in place, not only in the terminal snapshot.
        ("response.output_text.delta", {"type": "response.output_text.delta", "item_id": item_id, "delta": notice, "content_index": 0, "output_index": 1}),
        ("response.reasoning_summary_text.done", {"type": "response.reasoning_summary_text.done", "item_id": reasoning_id, "output_index": 0, "summary_index": 0, "text": reasoning_text}),
        ("response.reasoning_summary_part.done", {"type": "response.reasoning_summary_part.done", "item_id": reasoning_id, "output_index": 0, "summary_index": 0, "part": {"type": "summary_text", "text": reasoning_text}}),
        ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": completed_reasoning}),
        ("response.output_text.done", {"type": "response.output_text.done", "item_id": item_id, "text": final_text, "content_index": 0, "output_index": 1}),
        ("response.content_part.done", {"type": "response.content_part.done", "item_id": item_id, "output_index": 1, "content_index": 0, "part": {"type": "output_text", "text": final_text, "annotations": []}}),
        ("response.output_item.done", {"type": "response.output_item.done", "output_index": 1, "item": completed_message}),
        ("response.completed", {"type": "response.completed", "response": payload}),
    ]


def rate_limit_event_error(event: dict[str, Any]) -> ClaudeRateLimitError | None:
    """Build a structured error from Claude's own rate_limit_event.

    This is the one place a Claude limit is *reported* rather than inferred, so
    it is the only path that hands the router a reset time it will trust.
    """
    rate_info = event.get("rate_limit_info", {})
    if not isinstance(rate_info, dict):
        return None
    status = rate_info.get("status")
    if not status or status == "allowed":
        return None
    limit_type = rate_info.get("rateLimitType", "session")
    resets_at = normalize_resets_at(rate_info.get("resetsAt"))
    # A rejected weekly or billing window is exhaustion until it resets; a
    # rejected session window is a session limit; anything else is throttling
    # that clears on its own.
    if re.search(r"week|month|quota|billing|credit", str(limit_type), re.IGNORECASE):
        limit_class = "quota_exhausted"
    elif status == "rejected":
        limit_class = "session_limit"
    else:
        limit_class = "throttled"
    message = f"Claude rate limit ({limit_type}): status is {status}"
    if resets_at:
        message += f" (resets at {resets_at})"
    return ClaudeRateLimitError(message, limit_class=limit_class, limit_type=str(limit_type), resets_at=resets_at, source=LIMIT_SOURCE_REPORTED)


def classify_claude_error(message: Any, error_code: Any = None) -> type[RuntimeError] | None:
    text = str(message or "")
    if error_code == "rate_limit" or re.search(r"rate.?limit|weekly.?limit|quota|credit|session.?limit|too many requests", text, re.IGNORECASE):
        return ClaudeRateLimitError
    if error_code == "overloaded_error" or re.search(r"overload|high.?demand|capacity", text, re.IGNORECASE):
        return ClaudeOverloadedError
    return None


def raise_classified_claude_error(message: Any, error_code: Any = None) -> None:
    error_type = classify_claude_error(message, error_code)
    if error_type is None:
        return
    if error_type is ClaudeRateLimitError:
        # An error message is free text, so whatever it yields stays `inferred`
        # and cannot trigger a long hard cooldown downstream.
        limit = classify_cli_limit(message) or {}
        raise ClaudeRateLimitError(
            str(message),
            limit_class=limit.get("limit_class", "throttled"),
            limit_type=limit.get("limit_type"),
            resets_at=limit.get("resets_at"),
            source=LIMIT_SOURCE_INFERRED,
        )
    raise error_type(str(message))


def run_claude_stream(prompt: str, model: str = DEFAULT_CLAUDE_MODEL, effort: str = DEFAULT_CLAUDE_EFFORT, cwd: str = ".", agent_role: Any = None, spawn_session: str | None = None):
    process = subprocess.Popen(
        claude_cli_args(prompt, model, effort, agent_role, cwd, spawn_session),
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
    tool_uses = ToolUseAccumulator()
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
                # The init event is the CLI stating which tools this turn
                # actually has. It is the only place the absence of the
                # delegation tool is observable: a denied tool is simply not
                # in the list, and nothing later mentions it.
                if event_type == "system" and isinstance(value.get("tools"), list):
                    yield ("tools", value["tools"], value)
                block = tool_uses.feed(value)
                if block is not None:
                    yield ("tool_use", block, value)
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
    status: str = "completed",
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
        "status": status,
        "output": output if output is not None else [message_item(text)],
        "output_text": text,
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens, "total_tokens": input_tokens + output_tokens},
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "CodexClaudeBridge/1.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        print(format % args, flush=True)

    def send_json(self, status: int, payload: dict[str, Any], extra_headers: dict[str, str] | None = None) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, str(value))
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

    def send_incomplete(
        self,
        *,
        response_id: str,
        item_id: str,
        reasoning_id: str,
        text: str,
        reasoning_text: str,
        reason: str,
        limit: dict[str, Any] | None,
        model: str,
        metadata: dict[str, Any],
    ) -> None:
        """Close a stream the turn could not finish, carrying the work it did.

        The alternative -- a bare `response.failed` -- throws away every token
        the model already produced and already sent to this client, leaving the
        parent with an error string in place of a partial result it could act
        on. The turn is still reported as not completed: `status` is
        "incomplete" and `incomplete_details` says why, so the router still
        counts it as a provider failure and cools the provider.
        """
        payload = response_payload(model, text, metadata, response_id, [], status="incomplete")
        for name, event in terminal_incomplete_events(
            response_id,
            item_id,
            reasoning_id,
            text=text,
            reasoning_text=reasoning_text,
            reason=reason,
            limit=limit,
            provider="claude",
            response=payload,
        ):
            self.send_sse(name, event)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def send_limit_json(self, status: int, message: str, error_type: str, limit: dict[str, Any] | None) -> None:
        """A pre-stream failure, with the limit stated structurally.

        Sent before any output, so the router can still fall back to another
        provider on the HTTP status -- and now knows from the headers how long
        this one is actually out for, rather than guessing from the message.
        """
        headers = limit_response_headers(limit)
        retry_after = retry_after_seconds_from_limit(limit)
        if retry_after is not None:
            headers["Retry-After"] = str(retry_after)
        body: dict[str, Any] = {"error": {"message": message, "type": error_type}}
        payload = limit_payload(limit)
        if payload:
            body["error"]["limit"] = payload
        self.send_json(status, body, headers)

    def spawn_request_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        try:
            parsed = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def handle_spawn_attach(self) -> None:
        """Tell the shim whether this turn may delegate at all.

        The shim asks before offering the tool, so a leaf turn -- or a turn with
        no in-flight session, which means the CLI outlived its request -- simply
        does not see a delegation tool rather than seeing one that fails.
        """
        body = self.spawn_request_body()
        session_key = body.get("session")
        with SPAWN_SESSIONS_LOCK:
            entry = SPAWN_SESSIONS.get(session_key) if isinstance(session_key, str) else None
            allowed = bool(entry and entry["orchestrator"])
        self.send_json(200, {"spawnAllowed": allowed})

    def handle_spawn_call(self) -> None:
        body = self.spawn_request_body()
        session_key = body.get("session")
        children = body.get("children")
        if not isinstance(session_key, str) or not isinstance(children, list):
            self.send_json(400, {"error": "Malformed delegation request."})
            return
        accepted, message = record_spawn_request(session_key, children)
        self.send_json(200 if accepted else 409, {"text": message} if accepted else {"error": message})

    def do_POST(self) -> None:
        # The shim runs as a child of the CLI this bridge started, so it reaches
        # the bridge over the same loopback port the router uses, behind the
        # same bearer check.
        if self.path in ("/v1/bridge-spawn/attach", "/v1/bridge-spawn/call"):
            if AUTH_TOKEN and self.headers.get("Authorization") != f"Bearer {AUTH_TOKEN}":
                self.send_json(401, {"error": "invalid local gateway key"})
                return
            if self.path.endswith("/attach"):
                self.handle_spawn_attach()
            else:
                self.handle_spawn_call()
            return
        if self.path != "/v1/responses":
            self.send_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})
            return
        if AUTH_TOKEN and self.headers.get("Authorization") != f"Bearer {AUTH_TOKEN}":
            self.send_json(401, {"error": {"message": "invalid local gateway key", "type": "authentication_error"}})
            return
        stream_headers_sent = False
        spawn_session: str | None = None
        # Hoisted above the try: a turn cut short still owes its caller the work
        # it finished, and the handlers below cannot flush what they cannot see.
        response_id = f"resp_{secrets.token_hex(12)}"
        reasoning_id = f"rs_{secrets.token_hex(12)}"
        item_id = f"msg_{secrets.token_hex(10)}"
        request_model = MODEL
        text = ""
        reasoning_text = ""
        metadata: dict[str, Any] = {}
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
            request_model = request.get("model", MODEL)
            claude_model = resolve_claude_model(request.get("model"))
            claude_effort = resolve_claude_effort(requested_effort(request))
            # The router classifies the turn; only it can tell this bridge that
            # it is serving the root orchestrator rather than a delegated leaf.
            agent_role = resolve_agent_role(self.headers)
            agent_events = resolve_agent_event_reporter(self.headers)
            log_inbound_request(request, self.headers)
            # Router-generated identity of the Codex conversation. Delegation
            # through Codex needs it so the shim's out-of-band call can find the
            # turn it belongs to; a turn the router could not identify holds no
            # session and falls back to the CLI's own delegation tool.
            session_header = self.headers.get("x-autodev-session-id")
            session_scope = self.headers.get("x-autodev-session-scope")
            spawn_session = session_header if can_hold_spawn_session(session_header, session_scope) else None
            if spawn_session:
                open_spawn_session(spawn_session, orchestrator=is_orchestrator_role(agent_role))

            def note_tool_use(block: dict[str, Any]) -> None:
                name = block.get("name")
                if agent_events is not None and agent_events.is_spawn_tool(name):
                    agent_events.report_spawn_async(str(name), subagent_role_from_input(block))

            def note_available_tools(tools: Any) -> None:
                """Report an orchestrator turn that was handed no way to delegate.

                The bridge keeps the delegation tool for the orchestrator, but a
                project `.claude/settings.json` listing `Agent` under
                `permissions.deny` removes it anyway, and `bypassPermissions`
                does not override a deny. The turn then does everything itself
                and reports zero subagents, which is indistinguishable from a
                provider that chose not to delegate.
                """
                if agent_events is None or not is_orchestrator_role(agent_role):
                    return
                names = [name for name in tools if isinstance(name, str)]
                if any(agent_events.is_spawn_tool(name) for name in names):
                    return
                print(
                    f"claude orchestrator has no delegation tool in {cwd}: expected one of "
                    f"{sorted(agent_events.spawn_tools)}; check permissions.deny in that "
                    "workspace's .claude/settings.json",
                    flush=True,
                )
                agent_events.report_spawn_tools_unavailable_async(names)

            prompt = prompt_from_input(request.get("input", ""))
            cwd = resolve_cwd(request, self.headers)
            role_label = "orchestrator" if is_orchestrator_role(agent_role) else "leaf"
            print(f"claude request model={claude_model} effort={claude_effort} role={role_label} cwd={cwd}", flush=True)
            if not request.get("stream"):
                for kind, value, _ in run_claude_stream(prompt, claude_model, claude_effort, cwd=cwd, agent_role=agent_role, spawn_session=spawn_session):
                    if kind == "tools":
                        note_available_tools(value)
                    elif kind == "delta":
                        text += value
                    elif kind == "tool_use":
                        note_tool_use(value)
                    elif kind == "complete":
                        text, metadata = value
                output_items = [message_item(text)]
                spawn_children = close_spawn_session(spawn_session) if spawn_session else []
                if spawn_children:
                    _, spawn_item = exec_tool_call_events(
                        f"ctc_{secrets.token_hex(12)}",
                        f"call_{secrets.token_hex(12)}",
                        build_spawn_script(spawn_children, recover_parent_id=spawn_session),
                        len(output_items),
                    )
                    output_items.append(spawn_item)
                    print(f"claude delegating {len(spawn_children)} subagent(s) through Codex", flush=True)
                payload = response_payload(request_model, text, metadata, output=output_items)
                print(f"claude-cli result chars={len(text)} model_usage={metadata.get('modelUsage', {})}", flush=True)
                self.send_json(200, payload)
                return

            initial = {"id": response_id, "object": "response", "created_at": int(time.time()), "model": request_model, "status": "in_progress", "output": []}

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

            for kind, value, _ in run_claude_stream(prompt, claude_model, claude_effort, cwd=cwd, agent_role=agent_role, spawn_session=spawn_session):
                if kind == "tools":
                    note_available_tools(value)
                elif kind == "delta":
                    start_stream()
                    text += value
                    self.send_sse("response.output_text.delta", {"type": "response.output_text.delta", "item_id": item_id, "delta": value, "content_index": 0, "output_index": 1})
                elif kind == "tool_use":
                    note_tool_use(value)
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
            # Delegation the turn asked for, collected out-of-band by the shim
            # while Claude ran. Emitted as one `exec` call after the message:
            # Codex runs the script, creates the children itself, and they
            # become real sessions the app can show -- which is the whole reason
            # this path exists.
            spawn_children = close_spawn_session(spawn_session) if spawn_session else []
            output_items = [completed_reasoning, completed_message]
            spawn_events: list[tuple[str, dict[str, Any]]] = []
            if spawn_children:
                spawn_item_id = f"ctc_{secrets.token_hex(12)}"
                spawn_call_id = f"call_{secrets.token_hex(12)}"
                spawn_events, spawn_item = exec_tool_call_events(
                    spawn_item_id, spawn_call_id, build_spawn_script(spawn_children, recover_parent_id=spawn_session), len(output_items)
                )
                output_items.append(spawn_item)
                print(f"claude delegating {len(spawn_children)} subagent(s) through Codex", flush=True)
            payload = response_payload(request_model, text, metadata, response_id, output_items)
            self.send_sse("response.reasoning_summary_text.done", {"type": "response.reasoning_summary_text.done", "item_id": reasoning_id, "output_index": 0, "summary_index": 0, "text": reasoning_text})
            self.send_sse("response.reasoning_summary_part.done", {"type": "response.reasoning_summary_part.done", "item_id": reasoning_id, "output_index": 0, "summary_index": 0, "part": {"type": "summary_text", "text": reasoning_text}})
            self.send_sse("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": completed_reasoning})
            self.send_sse("response.output_text.done", {"type": "response.output_text.done", "item_id": item_id, "text": text, "content_index": 0, "output_index": 1})
            self.send_sse("response.content_part.done", {"type": "response.content_part.done", "item_id": item_id, "output_index": 1, "content_index": 0, "part": {"type": "output_text", "text": text, "annotations": []}})
            self.send_sse("response.output_item.done", {"type": "response.output_item.done", "output_index": 1, "item": completed_message})
            for event_name, event_payload in spawn_events:
                self.send_sse(event_name, event_payload)
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
                    self.send_incomplete(
                        response_id=response_id,
                        item_id=item_id,
                        reasoning_id=reasoning_id,
                        text=text,
                        reasoning_text=reasoning_text,
                        reason=INCOMPLETE_REASON_PROVIDER_LIMIT,
                        limit=exc.limit,
                        model=request_model,
                        metadata=metadata,
                    )
                else:
                    self.send_limit_json(429, str(exc), "rate_limit_error", exc.limit)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        except ClaudeOverloadedError as exc:
            print(f"Claude overloaded: {exc}", flush=True)
            # Capacity pressure is a limit of a kind, but a transient one: it is
            # never a hard class, so it can only ever shorten routing here.
            capacity = {"limit_class": "capacity", "limit_type": "capacity", "resets_at": None, "source": LIMIT_SOURCE_INFERRED}
            try:
                if stream_headers_sent:
                    self.send_incomplete(
                        response_id=response_id,
                        item_id=item_id,
                        reasoning_id=reasoning_id,
                        text=text,
                        reasoning_text=reasoning_text,
                        reason=INCOMPLETE_REASON_INTERRUPTED,
                        limit=capacity,
                        model=request_model,
                        metadata=metadata,
                    )
                else:
                    self.send_limit_json(503, str(exc), "overloaded_error", capacity)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        except subprocess.TimeoutExpired:
            if stream_headers_sent:
                self.send_incomplete(
                    response_id=response_id,
                    item_id=item_id,
                    reasoning_id=reasoning_id,
                    text=text,
                    reasoning_text=reasoning_text,
                    reason=INCOMPLETE_REASON_TIMEOUT,
                    limit=None,
                    model=request_model,
                    metadata=metadata,
                )
            else:
                self.send_json(504, {"error": {"message": "Claude CLI timed out", "type": "timeout_error"}})
        except Exception as exc:
            print(f"Claude upstream failure: {exc}", flush=True)
            try:
                if stream_headers_sent:
                    self.send_incomplete(
                        response_id=response_id,
                        item_id=item_id,
                        reasoning_id=reasoning_id,
                        text=text,
                        reasoning_text=reasoning_text,
                        reason=INCOMPLETE_REASON_INTERRUPTED,
                        limit=None,
                        model=request_model,
                        metadata=metadata,
                    )
                else:
                    self.send_json(502, {"error": {"message": str(exc), "type": "upstream_error"}})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        finally:
            # The registry must not outlive the turn on any path. A stale entry
            # would accept a delegation from a CLI that outlived its request and
            # attach it to nothing, and on a reused session key it would attach
            # it to the *next* turn. `spawn_session` is bound before the try, so
            # a failure before that point leaves nothing to clean up.
            if locals().get("spawn_session"):
                close_spawn_session(spawn_session)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
