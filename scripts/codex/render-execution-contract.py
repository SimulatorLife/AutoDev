#!/usr/bin/env python3
"""Render the machine-readable role contract from native role TOML sources.

The role TOMLs are the editable source of truth for MCP and skill capabilities.
This file produces the JSON projection consumed by provider bridges and child
bootstrap code. The orchestrator declaration is capability-only: it is not a
native child role and is therefore excluded from the installed role registry.
"""

from __future__ import annotations

import argparse
import json
import tempfile
import tomllib
from pathlib import Path

MCP_ORDER = {"lsp": 0, "cocoindex-code": 1, "playwright": 2, "openaiDeveloperDocs": 3, "autodev_spawn": 4}
SKILL_ORDER = {"orchestration": 0, "ccc": 1, "lsp-mcp-server": 2}


def read_role(source: Path) -> tuple[str, list[str], list[str], bool]:
    config = tomllib.loads(source.read_text(encoding="utf-8"))
    kind = "orchestrator" if any(line.strip() == "# role-kind: orchestrator" for line in source.read_text().splitlines()) else "leaf"
    mcp = [
        name
        for name, settings in config.get("mcp_servers", {}).items()
        if isinstance(settings, dict) and settings.get("enabled") is True
    ]
    skills = [
        entry["name"]
        for entry in config.get("skills", {}).get("config", [])
        if isinstance(entry, dict) and entry.get("enabled") is True
    ]
    mcp.sort(key=lambda name: (MCP_ORDER.get(name, 99), name))
    skills.sort(key=lambda name: (SKILL_ORDER.get(name, 99), name))
    return kind, mcp, skills, config.get("sandbox_mode") == "read-only"


def render(source_dir: Path, root_config_path: Path, contract_path: Path) -> dict:
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    roles = contract.setdefault("roles", {})
    for source in sorted(source_dir.glob("*.toml")):
        kind, mcp, skills, read_only = read_role(source)
        roles[source.stem] = {
            "kind": kind,
            "readOnly": read_only,
            "mcp": mcp,
            "skills": skills,
        }

    root_config = tomllib.loads(root_config_path.read_text(encoding="utf-8"))
    orchestrator = roles["orchestrator"]
    enabled_root_mcp = {
        name for name, settings in root_config.get("mcp_servers", {}).items()
        if isinstance(settings, dict) and settings.get("enabled") is True
    }
    missing_root_mcp = set(orchestrator["mcp"]) - enabled_root_mcp - {"autodev_spawn"}
    if missing_root_mcp:
        raise RuntimeError(f"orchestrator capability TOML is not enabled in root config: {sorted(missing_root_mcp)}")
    return contract


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--root-config", type=Path, required=True)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rendered = render(args.source_dir, args.root_config, args.contract)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{args.output.name}.", suffix=".tmp", dir=args.output.parent)
    try:
        with open(descriptor, "w", encoding="utf-8", closefd=True) as stream:
            json.dump(rendered, stream, indent=2)
            stream.write("\n")
        Path(temporary).replace(args.output)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print(f"rendered execution contract into {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
