#!/usr/bin/env python3
"""Materialize provider-native skill discovery views from the role contract.

The role TOMLs remain the source of truth. This renderer only creates the
filesystem layout required by a provider; it never copies or rewrites skill
contents.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path


PROVIDER_SKILL_ROOTS = {
    "claude": Path(".claude") / "skills",
}


def remove_managed(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def expected_views(contract: dict, canonical_root: Path, output_root: Path, provider: str) -> dict[Path, Path]:
    relative_root = PROVIDER_SKILL_ROOTS[provider]
    views: dict[Path, Path] = {}
    for role, descriptor in contract.get("roles", {}).items():
        for skill in descriptor.get("skills", []):
            source = canonical_root / skill
            if not source.is_dir() or not (source / "SKILL.md").is_file():
                raise RuntimeError(f"role {role} declares missing skill source: {skill} ({source})")
            target = output_root / role / relative_root / skill
            views[target] = source
    return views


def render(contract_path: Path, canonical_root: Path, output_root: Path, provider: str, check: bool) -> None:
    if provider not in PROVIDER_SKILL_ROOTS:
        raise RuntimeError(f"unsupported provider skill layout: {provider}")
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    expected = expected_views(contract, canonical_root, output_root, provider)
    roles = set(contract.get("roles", {}))
    if check:
        if not output_root.is_dir():
            raise RuntimeError(f"missing provider skill view root: {output_root}")
        actual_targets = {
            path for path in output_root.glob("*/.claude/skills/*") if path.is_symlink()
        }
        if actual_targets != set(expected):
            missing = sorted(str(path) for path in set(expected) - actual_targets)
            stale = sorted(str(path) for path in actual_targets - set(expected))
            raise RuntimeError(f"provider skill view drift; missing={missing}, stale={stale}")
        for target, source in expected.items():
            if Path(os.readlink(target)) != source:
                raise RuntimeError(f"provider skill view drift: {target} -> {os.readlink(target)} (expected {source})")
        actual_roles = {path.name for path in output_root.iterdir() if path.is_dir()}
        if actual_roles != roles:
            raise RuntimeError(f"provider skill role view drift; missing={sorted(roles - actual_roles)}, stale={sorted(actual_roles - roles)}")
        return

    output_root.mkdir(parents=True, exist_ok=True)
    for role in roles:
        (output_root / role / PROVIDER_SKILL_ROOTS[provider]).mkdir(parents=True, exist_ok=True)
    for role in roles:
        skill_root = output_root / role / PROVIDER_SKILL_ROOTS[provider]
        expected_names = {target.name for target in expected if target.parent == skill_root}
        for existing in list(skill_root.iterdir()):
            if existing.name not in expected_names:
                remove_managed(existing)
    for target, source in expected.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink() and Path(os.readlink(target)) == source:
            continue
        if target.exists() or target.is_symlink():
            remove_managed(target)
        target.symlink_to(source, target_is_directory=True)
    for role_dir in list(output_root.iterdir()):
        if role_dir.name not in roles:
            remove_managed(role_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--canonical-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--provider", default="claude")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    render(args.contract, args.canonical_root, args.output_root, args.provider, args.check)
    print(f"{'checked' if args.check else 'rendered'} {args.provider} skill views in {args.output_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
