#!/usr/bin/env python3
"""Render native Codex role configs from the shared prompt composition.

Codex role TOML has no prompt-file include primitive. The tracked role files
therefore contain only role configuration plus explicit base/leaf/role prompt
markers; this renderer materializes the complete developer instructions that
native child threads actually receive.

Role TOMLs declare only per-role MCP settings (``enabled``, approval, tool
filters). How each server launches is declared once, in
``.rulesync/mcp.jsonc``; the renderer copies those launch keys from the Codex
projection Rulesync generates from it (``--mcp-source``).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import tomllib
from pathlib import Path

BASE_MARKER = "{{AUTODEV_BASE_PROMPT}}"
LEAF_MARKER = "{{AUTODEV_LEAF_PROMPT}}"
CODE_SEARCH_MARKER = "{{AUTODEV_CODE_SEARCH_PROMPT}}"
ROLE_MARKER = "{{AUTODEV_ROLE_PROMPT}}"
# The keys that say how a server launches, as opposed to per-role settings.
LAUNCH_KEYS = ("command", "args", "url")
MCP_TABLE_HEADER = re.compile(r'^\[mcp_servers\.(?:"(?P<quoted>[^"]+)"|(?P<bare>[A-Za-z0-9_-]+))\]\s*$', re.MULTILINE)


def validate_mcp_servers(config: dict, source: Path) -> None:
    """Reject MCP entries that declare neither a valid stdio nor a valid
    streamable HTTP transport.

    An entry with only ``enabled = ...`` and no ``command``/``url`` is not a
    server declaration at all -- it is a stub that silently does nothing at
    runtime. Every entry (enabled or not) must be a real, launchable server so
    a disabled role-local override still documents how that server would run.
    """
    for name, server in config.get("mcp_servers", {}).items():
        if not isinstance(server, dict):
            raise RuntimeError(f"{source}: mcp_servers.{name} must be a table")
        has_command = isinstance(server.get("command"), str) and bool(server["command"])
        has_args = isinstance(server.get("args"), list) and bool(server["args"])
        is_valid_stdio = has_command and has_args
        has_url = isinstance(server.get("url"), str) and server["url"].startswith(("http://", "https://"))
        is_valid_http = has_url and server.get("transport") == "streamable_http"
        if not (is_valid_stdio or is_valid_http):
            raise RuntimeError(
                f"{source}: mcp_servers.{name} has neither a valid stdio transport "
                "(command + args) nor a valid streamable HTTP transport "
                '(url + transport = "streamable_http")'
            )


def load_mcp_servers(path: Path) -> dict:
    """The MCP servers in the Codex projection of ``.rulesync/mcp.jsonc``."""
    try:
        servers = tomllib.loads(path.read_text(encoding="utf-8")).get("mcp_servers")
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise RuntimeError(f"unable to read MCP source {path}: {error}") from error
    if not isinstance(servers, dict) or not servers:
        raise RuntimeError(f"MCP source declares no mcp_servers: {path}")
    return servers


def fill_launch_keys(text: str, mcp_servers: dict, source: Path) -> str:
    """Insert each role MCP table's launch keys from the generated servers.

    A key the role sets itself is left alone. A role naming a server that
    ``.rulesync/mcp.jsonc`` does not declare is an error rather than a stub.
    JSON strings and string arrays are valid TOML values, so ``json.dumps``
    renders them.
    """
    role_servers = tomllib.loads(text).get("mcp_servers", {})

    def with_launch_keys(match: re.Match) -> str:
        name = match.group("quoted") or match.group("bare")
        generated = mcp_servers.get(name)
        if not isinstance(generated, dict):
            raise RuntimeError(f"{source}: mcp_servers.{name} is not declared in .rulesync/mcp.jsonc")
        role_server = role_servers.get(name, {})
        lines = [
            f"{key} = {json.dumps(generated[key])}"
            for key in LAUNCH_KEYS
            if key in generated and key not in role_server
        ]
        if "url" in generated and "transport" not in role_server:
            # Codex's role loader requires an explicit transport for a URL
            # server; the user-level projection leaves it to inference.
            lines.append('transport = "streamable_http"')
        return "\n".join([match.group(0), *lines])

    return MCP_TABLE_HEADER.sub(with_launch_keys, text)


def validate_reasoning_effort(config: dict, source: Path) -> None:
    """Reject configurations with reasoning effort unsupported by MiniMax-M3.

    MiniMax-M3 supports only 'none' or 'high' reasoning effort. Role configs
    must not set unsupported levels like 'medium' or 'low'.
    """
    effort = config.get("model_reasoning_effort")
    if effort is not None and effort not in ("none", "high"):
        raise RuntimeError(
            f"{source}: unsupported model_reasoning_effort '{effort}'; "
            "MiniMax-M3 supports only 'none' or 'high' reasoning effort"
        )


def read_prompt(path: Path, label: str) -> str:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RuntimeError(f"unable to read {label} prompt {path}: {error}") from error
    if '"""' in text:
        raise RuntimeError(f"{label} prompt contains TOML multiline-string delimiter: {path}")
    return text


def render_role(
    source: Path,
    output: Path,
    prompt_dir: Path,
    base: str,
    leaf: str,
    code_search: str,
    mcp_servers: dict,
) -> None:
    text = source.read_text(encoding="utf-8")
    if any(text.count(marker) != 1 for marker in (BASE_MARKER, LEAF_MARKER, ROLE_MARKER)):
        raise RuntimeError(
            f"{source} must contain exactly one {BASE_MARKER}, {LEAF_MARKER}, and {ROLE_MARKER}"
        )
    if text.count(CODE_SEARCH_MARKER) > 1:
        raise RuntimeError(f"{source} must contain at most one {CODE_SEARCH_MARKER}")
    role_prompt = read_prompt(prompt_dir / "roles" / f"{source.stem}.md", f"{source.stem} role")
    rendered = (
        text.replace(BASE_MARKER, base)
        .replace(LEAF_MARKER, leaf)
        .replace(CODE_SEARCH_MARKER, code_search)
        .replace(ROLE_MARKER, role_prompt)
    )
    if any(marker in rendered for marker in (BASE_MARKER, LEAF_MARKER, CODE_SEARCH_MARKER, ROLE_MARKER)):
        raise RuntimeError(f"unrendered prompt marker remains in {source}")
    try:
        rendered = fill_launch_keys(rendered, mcp_servers, source)
        rendered_config = tomllib.loads(rendered)
    except tomllib.TOMLDecodeError as error:
        raise RuntimeError(f"rendered role config is invalid TOML: {source}: {error}") from error
    validate_mcp_servers(rendered_config, source)
    validate_reasoning_effort(rendered_config, source)

    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{source.name}.", suffix=".tmp", dir=output.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(rendered)
        os.chmod(temporary_name, 0o644)
        os.replace(temporary_name, output)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def render_directory(source_dir: Path, prompt_dir: Path, output_dir: Path, mcp_source: Path) -> list[Path]:
    mcp_servers = load_mcp_servers(mcp_source)
    base = read_prompt(prompt_dir / "base.md", "base")
    leaf = read_prompt(prompt_dir / "leaf.md", "leaf")
    code_search = read_prompt(prompt_dir / "code-search.md", "code search")
    # The root orchestrator has a capability-only TOML declaration used by
    # the execution-contract builder, not a native child role config.
    sources = sorted(source for source in source_dir.glob("*.toml") if source.stem != "orchestrator")
    if not sources:
        raise RuntimeError(f"no role TOML files found under {source_dir}")
    rendered = []
    for source in sources:
        output = output_dir / source.name
        render_role(source, output, prompt_dir, base, leaf, code_search, mcp_servers)
        rendered.append(output)
    return rendered


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--prompt-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--mcp-source",
        type=Path,
        required=True,
        help="Codex config.toml that Rulesync generated from .rulesync/mcp.jsonc.",
    )
    args = parser.parse_args()
    try:
        rendered = render_directory(args.source_dir, args.prompt_dir, args.output_dir, args.mcp_source)
    except (OSError, RuntimeError) as error:
        parser.error(str(error))
    print(f"rendered {len(rendered)} native role configs into {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
