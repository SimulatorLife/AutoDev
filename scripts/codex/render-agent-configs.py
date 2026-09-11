#!/usr/bin/env python3
"""Render native Codex role configs from the shared prompt composition.

Codex role TOML has no prompt-file include primitive. The tracked role files
therefore contain only role configuration plus explicit base/leaf/role prompt
markers; this renderer materializes the complete developer instructions that
native child threads actually receive.
"""

from __future__ import annotations

import argparse
import os
import tempfile
import tomllib
from pathlib import Path

BASE_MARKER = "{{AUTODEV_BASE_PROMPT}}"
LEAF_MARKER = "{{AUTODEV_LEAF_PROMPT}}"
CODE_SEARCH_MARKER = "{{AUTODEV_CODE_SEARCH_PROMPT}}"
ROLE_MARKER = "{{AUTODEV_ROLE_PROMPT}}"


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


def render_directory(source_dir: Path, prompt_dir: Path, output_dir: Path) -> list[Path]:
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
        render_role(source, output, prompt_dir, base, leaf, code_search)
        rendered.append(output)
    return rendered


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--prompt-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        rendered = render_directory(args.source_dir, args.prompt_dir, args.output_dir)
    except (OSError, RuntimeError) as error:
        parser.error(str(error))
    print(f"rendered {len(rendered)} native role configs into {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
