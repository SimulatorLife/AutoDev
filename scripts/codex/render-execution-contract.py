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


def read_role(source: Path) -> tuple[str, list[str], list[str], bool, dict[str, bool] | None]:
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

    web_research = None
    tools_config = config.get("tools")
    if tools_config is not None:
        if not isinstance(tools_config, dict):
            raise RuntimeError(f"{source}: tools must be a table")
        if "web_search" in tools_config and not isinstance(tools_config["web_search"], bool):
            raise RuntimeError(f"{source}: tools.web_search must be boolean")
        if tools_config.get("web_search") is True:
            # Codex's web_search includes page fetching/opening; keep that
            # provider-specific fact out of the native TOML and expose one
            # provider-neutral role capability in the generated contract.
            web_research = {"search": True, "fetch": True, "optionalMcp": []}

    return kind, mcp, skills, config.get("sandbox_mode") == "read-only", web_research


def render(source_dir: Path, root_config_path: Path, contract_path: Path) -> dict:
    template = json.loads(contract_path.read_text(encoding="utf-8"))
    if not isinstance(template, dict):
        raise RuntimeError(f"execution contract must contain a JSON object: {contract_path}")
    # Provider metadata is deliberately retained here because it describes the
    # adapter boundary, not a role's capabilities. Role entries, in contrast,
    # are rebuilt from scratch so deleting/renaming a role TOML cannot leave a
    # stale capability entry behind in the generated artifact.
    contract = {
        "version": template.get("version", 1),
        "roles": {},
        "providers": template.get("providers", {}),
    }
    roles = contract["roles"]
    for source in sorted(source_dir.glob("*.toml")):
        kind, mcp, skills, read_only, web_research = read_role(source)
        role_entry = {
            "kind": kind,
            "readOnly": read_only,
            "mcp": mcp,
            "skills": skills,
        }
        if web_research is not None:
            if source.stem == "smart":
                web_research["optionalMcp"] = ["playwright"]
            role_entry["webResearch"] = web_research
        roles[source.stem] = role_entry

    RESEARCH_ROLES = {"docs-researcher", "smart", "orchestrator"}
    for role_name in RESEARCH_ROLES:
        if role_name in roles:
            wr = roles[role_name].get("webResearch")
            if not wr or not wr.get("search") or not wr.get("fetch"):
                raise RuntimeError(
                    f"role '{role_name}' must declare webResearch with search and fetch enabled"
                )

    if "orchestrator" not in roles:
        raise RuntimeError("role TOMLs must include the orchestrator capability declaration")
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
