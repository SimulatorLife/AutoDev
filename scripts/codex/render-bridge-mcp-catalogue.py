#!/usr/bin/env python3
"""Render the MCP catalogue the provider bridges read.

`.rulesync/mcp.jsonc` is the only MCP source. The installer generates its Codex
projection with Rulesync; this renderer keeps only each server's launch keys
(`command` and `args`, or `url`) so the Claude and Copilot bridges can give a
role exactly its contract's servers without parsing TOML or restating any
server definition.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import tomllib
from pathlib import Path

LAUNCH_KEYS = ("command", "args", "url")


def render(mcp_source: Path) -> str:
    try:
        servers = tomllib.loads(mcp_source.read_text(encoding="utf-8")).get("mcp_servers")
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise RuntimeError(f"unable to read MCP source {mcp_source}: {error}") from error
    if not isinstance(servers, dict) or not servers:
        raise RuntimeError(f"MCP source declares no mcp_servers: {mcp_source}")
    catalogue = {
        name: {key: server[key] for key in LAUNCH_KEYS if key in server}
        for name, server in sorted(servers.items())
        if isinstance(server, dict)
    }
    return json.dumps(catalogue, indent=2, sort_keys=True) + "\n"


def write(output: Path, content: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
        os.chmod(temporary, 0o644)
        os.replace(temporary, output)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcp-source", type=Path, required=True, help="Codex config.toml Rulesync generated from .rulesync/mcp.jsonc.")
    parser.add_argument("--output", type=Path, required=True, help="Catalogue path, normally $CODEX_HOME/provider-runtime/mcp-servers.json.")
    parser.add_argument("--check", action="store_true", help="Report drift without writing.")
    args = parser.parse_args()
    try:
        rendered = render(args.mcp_source)
    except RuntimeError as error:
        parser.error(str(error))
    if args.check:
        if args.output.is_file() and not args.output.is_symlink() and args.output.read_text(encoding="utf-8") == rendered:
            print(f"ok bridge MCP catalogue {args.output}")
            return 0
        print(f"missing-or-drifted bridge MCP catalogue {args.output}")
        return 1
    write(args.output, rendered)
    print(f"rendered bridge MCP catalogue into {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
