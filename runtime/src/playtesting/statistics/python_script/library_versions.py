"""Pinned library-version manifest for the Playtesting statistical analysis.

The exact NumPy / SciPy / statsmodels builds are part of the measurement
contract. The Runtime-side validator (`runtime/src/playtesting/statistics/analysis.ts`)
hashes the resolved lockfile before invocation and refuses to call this
script when the lock has drifted from `pyproject.toml`. Tests that need to
emit a `PlaytestNumericInterval.libraryVersion` field use `library_tag()`
so the value can never diverge from the actual resolved version.
"""

from __future__ import annotations

import importlib.metadata

# Exact pin order from pyproject.toml / docs/playtesting-measurement-contract.md.
EXPECTED_NUMPY = "2.3.5"
EXPECTED_SCIPY = "1.17.0"
EXPECTED_STATSMODELS = "0.14.6"


def resolved_version(distribution_name: str) -> str:
    """Return the resolved version string for a pinned distribution."""
    return importlib.metadata.version(distribution_name)


def library_tag() -> str:
    """Return the `libraryVersion` value emitted by the analysis worker.

    Format: `scipy-{scipy_ver}/numpy-{numpy_ver}/statsmodels-{statsmodels_ver}`.
    Core's typed `PlaytestNumericInterval.libraryVersion` is opaque so the
    tag encoding is allowed to evolve; equality tests assert the major
    components only.
    """
    return (
        f"scipy-{resolved_version('scipy')}"
        f"/numpy-{resolved_version('numpy')}"
        f"/statsmodels-{resolved_version('statsmodels')}"
    )


def assert_library_pins() -> None:
    """Raise immediately if the resolved versions drifted from pyproject.toml.

    This protects against an accidental `uv sync` (no `--frozen`) or a
    system Python where dependencies were installed by other tooling.
    """
    actual = {
        "numpy": resolved_version("numpy"),
        "scipy": resolved_version("scipy"),
        "statsmodels": resolved_version("statsmodels"),
    }
    expected = {
        "numpy": EXPECTED_NUMPY,
        "scipy": EXPECTED_SCIPY,
        "statsmodels": EXPECTED_STATSMODELS,
    }
    drift = {name: (actual[name], expected[name]) for name in expected if actual[name] != expected[name]}
    if drift:
        details = ", ".join(f"{name}: got {got!r}, expected {want!r}" for name, (got, want) in drift.items())
        raise RuntimeError(
            "Playtesting statistics worker found drifted library versions: " + details
        )
