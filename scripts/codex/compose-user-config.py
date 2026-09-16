#!/usr/bin/env python3
"""Compose the AutoDev-owned Codex user-level configuration.

This script merges the versioned, AutoDev-owned portable source at
``scripts/codex/config.autodev.toml`` with whatever machine-local Codex
configuration is already installed at ``$CODEX_HOME/config.toml``. The result
is the canonical, fully-materialized user-level configuration that Codex reads
on its next launch.

The portable source is the only authoritative definition of AutoDev-owned
settings. The existing file contributes the machine-local slice (notify targets,
trusted hook hashes, project trust entries, marketplaces, TUI/desktop state,
non-AutoDev MCP servers, and skills the operator added on top of the AutoDev
set). Conflicts on AutoDev-owned keys always resolve in favor of the portable
source so the installer can run on any host without leaking personal
preferences.

Hook declarations are owned by Rulesync and are not read from the portable
source. Any legacy hook event arrays in the existing config are removed;
``hooks.state`` carries Codex-owned per-hook trusted hashes and is preserved
from the existing file so the installer does not invalidate trust on every run.

``mcp_servers`` never come from the portable source. They come from
``--mcp-source``: the Codex ``config.toml`` Rulesync generates from
``.rulesync/mcp.jsonc``, the one place AutoDev declares its MCP servers. They
are merged by server name: generated servers win conflicts, while any
non-AutoDev server the operator added is retained.

``skills.config`` entries are merged by ``name`` with the same precedence
rule: the portable source wins for AutoDev-owned skill names
(``ccc``, ``lsp-mcp-server``, ``orchestration``) and non-AutoDev entries the
operator registered are retained.

Every other top-level key is preserved from the existing file when it is not
declared by the portable source, and replaced when it is. Unknown nested
tables are merged key-by-key with portable keys winning.

The serializer emits TOML in a canonical order so successive runs are byte-for-
byte identical (the output is itself the diff target for ``--check``), and
writes the result via a sibling temp file + atomic rename so an interrupted run
never leaves a half-written ``config.toml`` for Codex to load.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import tomllib
from pathlib import Path
from typing import Any, Iterable

# Sentinel marker file name used for atomic rename; kept short so the
# destination directory's inode count never grows during a steady-state
# re-compose.
_TEMP_SUFFIX = ".compose-user-config.tmp"


class ComposeError(RuntimeError):
    """Raised when the portable source is missing or the existing config is
    malformed in a way that prevents a safe composition.

    The exit code reflects this distinct failure mode so the installer can
    surface it without conflating it with a drift-detection failure.
    """


def _load_required(path: Path, label: str) -> dict:
    """Read and validate an AutoDev-owned TOML input.

    Both inputs are authoritative for AutoDev-owned settings; a missing or
    malformed file is fatal because the composer has nothing to fall back on.
    Returning ``{}`` here would silently downgrade every AutoDev setting to
    ``None`` and the installer would happily write that to ``config.toml``.
    """
    if not path.is_file():
        raise ComposeError(f"{label} not found: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ComposeError(f"unable to read {label} {path}: {error}") from error
    try:
        loaded = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise ComposeError(f"malformed {label} {path}: {error}") from error
    if not isinstance(loaded, dict):
        raise ComposeError(f"{label} must be a TOML table: {path}")
    return loaded


def _load_portable(portable_path: Path, mcp_source_path: Path) -> dict:
    """Return the portable source with the generated MCP servers attached.

    A portable source that declares ``mcp_servers`` itself is rejected: MCP
    servers have one source, ``.rulesync/mcp.jsonc``, and a second copy here
    would silently win or drift.
    """
    portable = _load_required(portable_path, "portable source")
    if "mcp_servers" in portable:
        raise ComposeError(
            f"portable source must not declare mcp_servers: {portable_path} "
            "(declare MCP servers in .rulesync/mcp.jsonc)"
        )
    servers = _load_required(mcp_source_path, "MCP source").get("mcp_servers")
    if not isinstance(servers, dict) or not servers:
        raise ComposeError(f"MCP source declares no mcp_servers: {mcp_source_path}")
    portable["mcp_servers"] = servers
    return portable


def _load_existing(path: Path) -> dict:
    """Read the existing user-level config if it exists.

    A missing existing file is the bootstrap case and yields an empty table.
    A present but malformed file is fatal because we cannot distinguish
    "preserved machine-local state" from "garbage we must not overwrite".
    """
    if path.is_symlink() and not path.exists():
        raise ComposeError(
            f"existing config symlink target is missing: {path}; "
            "restore the legacy config target before retrying migration"
        )
    if not path.exists():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ComposeError(f"unable to read existing config {path}: {error}") from error
    try:
        loaded = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise ComposeError(f"malformed existing config {path}: {error}") from error
    if not isinstance(loaded, dict):
        raise ComposeError(f"existing config must be a TOML table: {path}")
    return loaded


def _autodev_mcp_names(portable: dict) -> set[str]:
    """Return the set of MCP server names the portable source owns.

    Anything outside this set is treated as user-owned and retained verbatim
    from the existing config.
    """
    servers = portable.get("mcp_servers", {})
    if not isinstance(servers, dict):
        return set()
    return {name for name, value in servers.items() if isinstance(value, dict)}


def _autodev_skill_names(portable: dict) -> set[str]:
    """Return the set of skill names the portable source owns.

    ``skills.config`` is an array of tables keyed by ``name``; that is the
    authoritative identity and is what we use for merge precedence.
    """
    entries = portable.get("skills", {}).get("config", [])
    if not isinstance(entries, list):
        return set()
    return {
        entry["name"]
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("name"), str)
    }


def _merge_value(
    portable_value: Any,
    existing_value: Any,
    *,
    portable_scalar_wins: bool,
) -> Any:
    """Resolve a single key conflict between portable and existing.

    ``portable_scalar_wins`` is set when the key is an AutoDev-owned scalar
    (a top-level portable key): the portable value must win because the
    operator's local override of a value like ``model_provider`` would silently
    reroute Codex off the local router.

    For nested tables, merging happens at the call site so we can preserve the
    per-section rules (hooks, mcp_servers, skills.config).
    """
    if portable_scalar_wins:
        return portable_value
    return existing_value


def _merge_skills_config(portable_entries: list, existing_entries: list) -> list:
    """Merge ``[[skills.config]]`` by ``name`` with portable entries winning.

    Portable entries appear first in the portable source order, followed by any
    existing entries whose names are not in the portable set. Order within each
    group is preserved so the output is deterministic.
    """
    portable_names = _autodev_skill_names({"skills": {"config": portable_entries}})
    seen: set[str] = set()
    merged: list = []
    for entry in portable_entries:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str):
            continue
        merged.append(entry)
        seen.add(name)
    for entry in existing_entries:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or name in seen:
            continue
        merged.append(entry)
        seen.add(name)
    return merged


def _merge_mcp_servers(portable_servers: dict, existing_servers: dict) -> dict:
    """Merge ``[mcp_servers.<name>]`` tables with portable entries winning.

    Non-AutoDev servers are appended in the order they appeared in the existing
    config so the composed output reads in the same order Codex rendered the
    operator's installation.
    """
    autodev = _autodev_mcp_names({"mcp_servers": portable_servers})
    merged: dict = {}
    for name, value in portable_servers.items():
        merged[name] = value
    for name, value in existing_servers.items():
        if name in autodev:
            continue
        merged[name] = value
    return merged


def _merge_hooks(existing_hooks: Any) -> dict:
    """Drop legacy event declarations while preserving Codex-owned state.

    Older configs may contain a malformed/non-table ``hooks`` value. It is
    obsolete declaration data, so remove it rather than allowing composition
    to fail or accidentally preserve event arrays.
    """
    if not isinstance(existing_hooks, dict):
        return {}
    if "state" not in existing_hooks:
        return {}
    return {"state": existing_hooks["state"]}


def _merge_nested_table(
    portable_table: dict,
    existing_table: dict,
    *,
    key_handlers: dict,
) -> dict:
    """Merge a portable nested table with an existing nested table.

    ``key_handlers`` maps a portable key to a callable that produces the
    merged value for that key. Keys without a handler follow the default rule:
    portable value wins when the key is in the portable table, otherwise the
    existing value is preserved.

    Sub-keys of nested tables (e.g. the items inside ``[shell_environment_policy]``)
    are merged key-by-key using the same portable-wins-for-declared-keys rule.
    """
    merged: dict = {}
    for key, value in portable_table.items():
        if key in key_handlers:
            merged[key] = key_handlers[key](value, existing_table.get(key))
        else:
            merged[key] = value
    for key, value in existing_table.items():
        if key in portable_table:
            continue
        merged[key] = value
    return merged


def _merge_shell_environment_policy(portable: dict, existing: dict) -> dict:
    """Merge ``[shell_environment_policy]`` key-by-key with portable winning."""
    if not isinstance(portable, dict):
        portable = {}
    if not isinstance(existing, dict):
        existing = {}
    merged: dict = {}
    for key, value in portable.items():
        merged[key] = value
    for key, value in existing.items():
        if key in portable:
            continue
        merged[key] = value
    return merged


def compose(portable: dict, existing: dict) -> dict:
    """Compose the final user-level config from portable + existing.

    Top-level keys are walked in portable-source order (so the produced output
    reads the same way the portable source does) and then any existing-only
    keys are appended in their original order. This gives a deterministic
    output and a stable diff target for ``--check``.
    """
    composed: dict = {}
    portable_top_level_order: list[str] = list(portable.keys())

    for key, portable_value in portable.items():
        existing_value = existing.get(key)
        if key == "hooks":
            composed[key] = _merge_hooks(existing_value or {})
            continue
        if key == "mcp_servers":
            composed[key] = _merge_mcp_servers(portable_value or {}, existing_value or {})
            continue
        if key == "skills":
            composed[key] = _merge_nested_table(
                portable_value or {},
                existing_value or {},
                key_handlers={
                    "config": lambda p, e: _merge_skills_config(p or [], e or []),
                },
            )
            continue
        if key == "shell_environment_policy":
            composed[key] = _merge_shell_environment_policy(portable_value, existing_value)
            continue
        if isinstance(portable_value, dict) and isinstance(existing_value, dict):
            composed[key] = _merge_nested_table(portable_value, existing_value, key_handlers={})
            continue
        composed[key] = _merge_value(portable_value, existing_value, portable_scalar_wins=True)

    for key, value in existing.items():
        if key in portable_top_level_order:
            continue
        if key == "hooks":
            merged_hooks = _merge_hooks(value)
            if merged_hooks:
                composed[key] = merged_hooks
            continue
        composed[key] = value

    return composed


def apply_otel_ingress(config: dict, ingress: str) -> dict:
    """Select the local OTLP ingress without changing the model transport.

    The model router remains on port 4100 in every mode.  Only Codex's three
    OTLP HTTP exporters move to the opt-in Collector port, so telemetry can be
    rolled back independently of provider routing.
    """
    if ingress not in {"direct", "collector"}:
        raise ComposeError(f"unsupported OTLP ingress: {ingress}")
    if ingress == "direct":
        return config
    otel = config.get("otel")
    if not isinstance(otel, dict):
        raise ComposeError("portable config is missing the [otel] table")
    endpoints = {
        "exporter": "http://127.0.0.1:4318/v1/logs",
        "trace_exporter": "http://127.0.0.1:4318/v1/traces",
        "metrics_exporter": "http://127.0.0.1:4318/v1/metrics",
    }
    for key, endpoint in endpoints.items():
        exporter = otel.get(key)
        if not isinstance(exporter, dict) or not isinstance(exporter.get("otlp-http"), dict):
            raise ComposeError(f"portable config is missing [otel].{key}.otlp-http")
        exporter["otlp-http"]["endpoint"] = endpoint
    return config


# ---------------------------------------------------------------------------
# Deterministic TOML serializer
# ---------------------------------------------------------------------------

# Keys that need quoting even when they look like bare keys. Includes dotted
# keys (table names), keys with hyphens, and Codex-specific quoted keys
# (e.g. hooks.state dotted keys, plugins with namespace prefixes).
_BARE_KEY_PATTERN = None


def _bare_key_ok(key: str) -> bool:
    import re
    global _BARE_KEY_PATTERN
    if _BARE_KEY_PATTERN is None:
        _BARE_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
    return bool(_BARE_KEY_PATTERN.match(key))


def _format_key(key: str) -> str:
    if _bare_key_ok(key):
        return key
    return '"' + key.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _format_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t") + '"'


def _format_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return _format_string(value)
    if isinstance(value, list):
        items = [_format_value(item) for item in value]
        return "[" + ", ".join(items) + "]"
    if isinstance(value, dict):
        items = [f"{_format_key(k)} = {_format_value(v)}" for k, v in value.items()]
        return "{ " + ", ".join(items) + " }"
    raise ComposeError(f"unsupported TOML value type: {type(value).__name__}")


def _is_array_of_tables(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) > 0
        and all(isinstance(item, dict) for item in value)
    )


def _serialize_inline_array_of_tables(value: list) -> str:
    """Render an array of inline tables (a list of dicts with only primitive values).

    Used for inline-style fields; Codex rarely writes these as inline but the
    serializer supports them for forward-compatibility with future portable
    sources.
    """
    items = [_format_value(item) for item in value]
    return "[" + ", ".join(items) + "]"


def _path_join(prefix: str, key: str) -> str:
    if not prefix:
        return key
    return f"{prefix}.{key}"


def _can_inline_dict(value: dict) -> bool:
    """Return True when a dict can be serialized as a TOML inline table.

    An inline table is only safe when every value is itself an inline-friendly
    primitive or list (no nested dicts that themselves contain tables, and no
    array of tables). Codex's portable source uses inline tables only for
    one-level ``{ key = value, key = value }`` style entries such as the OTLP
    exporter endpoints; deeper nesting has to be promoted to a sub-section so
    TOML parsers agree on the result.
    """
    for v in value.values():
        if isinstance(v, dict):
            if not _can_inline_dict(v):
                return False
        elif _is_array_of_tables(v):
            return False
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    if not _can_inline_dict(item):
                        return False
    return True


def _serialize_table(
    table: dict,
    *,
    path: str,
    out: list[str],
) -> None:
    """Render a regular TOML table.

    Scalars come first (in deterministic order: portable insertion order),
    inline-eligible child tables are kept inline (matching the portable
    source style), and array-of-tables entries are emitted with the
    ``[[path]]`` header. Tables that contain their own sub-tables are
    promoted to a sub-section so the output parses back to the same structure.
    """
    scalars: list[tuple[str, Any]] = []
    child_tables: list[tuple[str, dict]] = []
    inline_tables: list[tuple[str, dict]] = []
    array_tables: list[tuple[str, list]] = []

    for key, value in table.items():
        if _is_array_of_tables(value):
            array_tables.append((key, value))
        elif isinstance(value, dict) and _can_inline_dict(value):
            inline_tables.append((key, value))
        elif isinstance(value, dict):
            child_tables.append((key, value))
        else:
            scalars.append((key, value))

    for key, value in scalars:
        out.append(f"{_format_key(key)} = {_format_value(value)}")

    for key, value in inline_tables:
        out.append(f"{_format_key(key)} = {_format_value(value)}")

    for key, value in child_tables:
        header = _path_join(path, _format_key(key))
        out.append("")
        out.append(f"[{header}]")
        _serialize_table(value, path=header, out=out)

    for key, value in array_tables:
        header_prefix = _path_join(path, _format_key(key))
        for entry in value:
            out.append("")
            out.append(f"[[{header_prefix}]]")
            _serialize_table(entry, path=header_prefix, out=out)


def serialize(config: dict) -> str:
    """Render the composed config as deterministic TOML text."""
    out: list[str] = []
    _serialize_table(config, path="", out=out)
    body = "\n".join(out).rstrip("\n") + "\n"
    return body


# ---------------------------------------------------------------------------
# I/O orchestration
# ---------------------------------------------------------------------------


def _atomic_write(target: Path, content: str) -> None:
    """Write ``content`` to ``target`` as a regular file via temp + rename.

    The temp file is created next to the target so the rename stays on the
    same filesystem (and is therefore atomic on POSIX). The target is removed
    first if it is a symlink so a stale link to the old portable file cannot
    be silently followed.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_dir() and not target.is_symlink():
        raise ComposeError(f"refusing to overwrite directory {target}")
    descriptor, temp_path = tempfile.mkstemp(
        prefix=f".{target.name}.",
        suffix=_TEMP_SUFFIX,
        dir=str(target.parent),
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=True) as stream:
            stream.write(content)
        os.replace(temp_path, target)
    except Exception:
        Path(temp_path).unlink(missing_ok=True)
        raise


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def run(
    portable_path: Path,
    mcp_source_path: Path,
    existing_path: Path,
    output_path: Path,
    *,
    check: bool,
    otel_ingress: str,
) -> int:
    portable = _load_portable(portable_path, mcp_source_path)
    existing = _load_existing(existing_path)
    composed = compose(portable, existing)
    apply_otel_ingress(composed, otel_ingress)
    rendered = serialize(composed)

    if check:
        if not output_path.exists():
            if output_path.is_symlink():
                print(
                    f"drift detected: {output_path} is a symlink, expected a composed regular file",
                    file=sys.stderr,
                )
                return 1
            print(
                f"ok bootstrap target absent: {output_path} (would be created with {len(rendered)} bytes)",
            )
            return 0
        if output_path.is_symlink():
            print(
                f"drift detected: {output_path} is a symlink, expected a composed regular file",
                file=sys.stderr,
            )
            return 1
        existing_text = _read_text(output_path)
        if existing_text == rendered:
            print(f"ok composed config matches {output_path}")
            return 0
        print(
            f"drift detected: {output_path} does not match the composed portable source + existing state",
            file=sys.stderr,
        )
        return 1

    _atomic_write(output_path, rendered)
    print(f"composed user-level config into {output_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--portable-source",
        type=Path,
        required=True,
        help="Path to the AutoDev-owned portable TOML source (config.autodev.toml).",
    )
    parser.add_argument(
        "--mcp-source",
        type=Path,
        required=True,
        help="Codex config.toml that Rulesync generated from .rulesync/mcp.jsonc; supplies the AutoDev MCP servers.",
    )
    parser.add_argument(
        "--existing-config",
        type=Path,
        required=True,
        help="Path to the existing user-level Codex config to merge machine-local state from.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Path to write the composed regular-file config to.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Detect drift between the existing output and what would be composed; do not write.",
    )
    parser.add_argument(
        "--otel-ingress",
        choices=("direct", "collector"),
        default="direct",
        help="Select direct AutoDev OTLP ingress or the opt-in local Collector.",
    )
    args = parser.parse_args(argv)
    try:
        return run(
            args.portable_source,
            args.mcp_source,
            args.existing_config,
            args.output,
            check=args.check,
            otel_ingress=args.otel_ingress,
        )
    except ComposeError as error:
        print(f"compose-user-config: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
