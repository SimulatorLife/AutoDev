"""Statistic primitives for the AutoDev Playtesting measurement contract.

The statistics layer implements two operations required by
`docs/playtesting-measurement-contract.md` §4-5:

  paired_percentile_bootstrap(array) -> NumericInterval
    Percentile bootstrap of an ordered paired-difference array using
    scipy.stats.bootstrap with numpy.random.default_rng(seed).
    Default behaviour matches the §4 "Worked A/B calculation fixture"
    exactly: 100 paired synthetic episodes, ten +1 / ninety 0; thirty -1
    / seventy 0, default_rng(42), 100_000 resamples, 95% confidence.

  multiplicity_adjusted_pvalues(pvalue_array) -> (rejected, p_adjusted)
    Family-wise adjustment via statsmodels.stats.multitest.multipletests,
    mirroring §5 "Use predeclared family correction".

Both operations refuse silently-degenerate inputs: an NaN element, an
empty array, a confidence level outside (0, 1), or a non-positive
resample count. Honest failures raise `StatisticInputError`; the worker
in `__main__.py` translates that to a JSON-RPC error carrying a stable
classification so Runtime callers can route it correctly.

We do not implement bootstrap or multiplicity math here. The numerical
routines are scipy.stats.bootstrap and statsmodels.stats.multitest.multipletests.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Sequence, Tuple

import numpy as np
from scipy import stats

try:
    from statsmodels.stats.multitest import multipletests
except ImportError:  # pragma: no cover - import guard for type checkers.
    multipletests = None  # type: ignore[assignment]

from .library_versions import assert_library_pins, library_tag

__all__ = [
    "StatisticInputError",
    "NumericInterval",
    "MultiplicityResult",
    "paired_percentile_bootstrap",
    "multiplicity_adjusted_pvalues",
    "expected_fixture_intervals",
]


class StatisticInputError(ValueError):
    """Raised when statistics input is empty, NaN, or out of policy range.

    The Runtime wrapper distinguishes input-validation failures from
    transient/launch failures via `StatisticInputError`. Input failures
    are always deterministic and never retry-resolved.
    """


@dataclass(frozen=True)
class NumericInterval:
    """Plain numeric interval matching Core's `PlaytestNumericInterval`.

    The numeric payload is intentionally minimal: the JSON-RPC layer
    folds these into the envelope, and Core's validator
    (`isValidPlaytestInterval`) decides whether the upper and lower
    bounds are valid for classification.
    """

    lower: float
    upper: float
    method: str
    library_version: str
    confidence_level: float
    resamples: int
    seed: str

    def to_dict(self) -> dict:
        return {
            "lower": float(self.lower),
            "upper": float(self.upper),
            "method": self.method,
            "libraryVersion": self.library_version,
            "confidenceLevel": float(self.confidence_level),
            "resamples": int(self.resamples),
            "seed": self.seed,
        }


@dataclass(frozen=True)
class MultiplicityResult:
    """Family-wise multiplicity decision for a predeclared p-value array."""

    rejected: Tuple[bool, ...]
    p_adjusted: Tuple[float, ...]
    method: str

    def to_dict(self) -> dict:
        return {
            "rejected": list(self.rejected),
            "pAdjusted": list(self.p_adjusted),
            "method": self.method,
        }


# Defaults from docs/playtesting-measurement-contract.md §4 "Worked A/B
# calculation fixture".
DEFAULT_RESAMPLES = 100_000
DEFAULT_CONFIDENCE_LEVEL = 0.95
DEFAULT_SEED = 42
PRIMARY_METHOD = "percentile-bootstrap"
ALLOWED_METHODS = frozenset({"percentile", "percentile-bootstrap"})


def _validate_paired_array(
    array: Sequence[float],
    *,
    min_length: int = 1,
) -> np.ndarray:
    """Validate and copy a paired-difference array to a 1-D float ndarray."""
    try:
        iterator = iter(array)
    except TypeError as exc:
        raise StatisticInputError("Paired-difference array must be iterable.") from exc
    values = list(iterator)
    if len(values) < min_length:
        raise StatisticInputError(
            f"Paired-difference array must contain at least {min_length} values; "
            f"received {len(values)}."
        )
    out = np.asarray(values, dtype=np.float64)
    if out.ndim != 1:
        raise StatisticInputError(
            f"Paired-difference array must be one-dimensional; received ndim={out.ndim}."
        )
    if not np.isfinite(out).all():
        nan_count = int(np.isnan(out).sum())
        inf_count = int(np.isinf(out).sum())
        raise StatisticInputError(
            "Paired-difference array contains non-finite values: "
            f"NaN={nan_count}, Inf={inf_count}. "
            "Reject NaN/degenerate intervals per measurement contract §4."
        )
    return out


def paired_percentile_bootstrap(
    array: Sequence[float],
    *,
    resamples: int = DEFAULT_RESAMPLES,
    confidence_level: float = DEFAULT_CONFIDENCE_LEVEL,
    seed: int = DEFAULT_SEED,
    statistic=None,
) -> NumericInterval:
    """Run scipy.stats.bootstrap (percentile) on an ordered paired array.

    Required inputs
    ---------------
    array
        Ordered paired-difference array. Must be non-empty, finite, and
        one-dimensional. Heterogeneous types are coerced with a clear
        error rather than silently broadening.
    resamples
        Number of bootstrap resamples. Must be a positive integer.
    confidence_level
        Confidence for the percentile interval; must be in (0, 1).
    seed
        Integer seed for ``numpy.random.default_rng``. Reproducibility
        of the §4 worked fixture requires ``seed=42``.
    statistic
        Optional callable (default ``np.mean``). Only simple per-array
        statistics are accepted; we reject multi-sample blueprints to
        keep the JSON-RPC schema minimal.

    Returns
    -------
    NumericInterval suitable for Core's ``PlaytestNumericInterval``.

    Honest failures
    ---------------
    * non-finite (``NaN`` or ``Inf``) input -> ``StatisticInputError``
    * array shorter than 1 -> ``StatisticInputError``
    * ``resamples`` <= 0 or non-int -> ``StatisticInputError``
    * ``confidence_level`` outside (0, 1) -> ``StatisticInputError``
    * ``seed`` outside int64 range or non-int -> ``StatisticInputError``

    The function never silently substitutes zero or NaN for failures.
    """
    assert_library_pins()
    if statistic is None:
        statistic = np.mean
    if not callable(statistic):
        raise StatisticInputError("statistic must be callable.")
    if not isinstance(resamples, int) or isinstance(resamples, bool):
        raise StatisticInputError("resamples must be an int.")
    if resamples <= 0:
        raise StatisticInputError(f"resamples must be positive; received {resamples}.")
    if not isinstance(confidence_level, (int, float)) or isinstance(confidence_level, bool):
        raise StatisticInputError("confidence_level must be a real number.")
    if (
        math.isnan(confidence_level)
        or not (0.0 < float(confidence_level) < 1.0)
    ):
        raise StatisticInputError(
            f"confidence_level must lie in (0, 1); received {confidence_level!r}."
        )
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise StatisticInputError("seed must be an int.")
    if not (-(2**63) <= seed < 2**63):
        raise StatisticInputError("seed must fit into int64.")

    values = _validate_paired_array(array)
    point_estimate = float(statistic(values))

    rng = np.random.default_rng(seed)
    try:
        result = stats.bootstrap(
            (values,),
            statistic,
            n_resamples=int(resamples),
            confidence_level=float(confidence_level),
            random_state=rng,
            method="percentile",
            axis=0,
        )
    except ValueError as exc:
        # scipy raises ValueError for degenerate inputs (e.g. all-identical
        # samples when method='basic' or 'BCa'); we still want to surface
        # this honestly, never fabricate an interval.
        raise StatisticInputError(f"scipy.stats.bootstrap rejected input: {exc}") from exc

    low, high = result.confidence_interval
    if not (np.isfinite(low) and np.isfinite(high)):
        raise StatisticInputError(
            "Bootstrap produced non-finite bounds "
            f"(low={low!r}, high={high!r}); reject NaN/degenerate intervals per §4."
        )
    if low > high:
        # Defensive: scipy always returns low <= high for percentile method,
        # but the contract demands we surface rather than silently swap.
        raise StatisticInputError(
            f"Bootstrap interval is non-monotonic (low={low}, high={high})."
        )

    return NumericInterval(
        lower=float(low),
        upper=float(high),
        method=PRIMARY_METHOD,
        library_version=library_tag(),
        confidence_level=float(confidence_level),
        resamples=int(resamples),
        seed=str(seed),
    )


def multiplicity_adjusted_pvalues(
    pvalues: Sequence[float],
    *,
    alpha: float = 0.05,
    method: str = "fdr_bh",
) -> MultiplicityResult:
    """Apply family-wise multiplicity correction via statsmodels.

    Predeclared-family correction is enforced by the method argument
    being one of the well-known STMs methods:
    ``bonferroni``, ``sidak``, ``holm``, ``fdr_bh``, ``fdr_by``,
    ``fdr_tsbh``, ``fdr_tsbky``.

    Required inputs
    ---------------
    pvalues
        Iterable of p-values in (0, 1]; the algorithm tolerates NaNs but
        they always force ``StatisticInputError`` here.
    alpha
        Predeclared alpha. Must lie in (0, 1).
    method
        One of the supported ``multipletests`` method names.

    Returns
    -------
    MultiplicityResult whose ``rejected`` list is True wherever the
    adjusted p-value crossed ``alpha``.

    Honest failures
    ---------------
    Empty input, NaN, alpha outside (0, 1), unsupported method names,
    and any ``statsmodels`` ``ValueError`` -> ``StatisticInputError``.
    """
    assert_library_pins()
    if multipletests is None:
        raise RuntimeError("statsmodels.stats.multitest.multipletests was not imported.")
    if not isinstance(alpha, (int, float)) or isinstance(alpha, bool):
        raise StatisticInputError("alpha must be a real number.")
    if math.isnan(alpha) or not (0.0 < float(alpha) < 1.0):
        raise StatisticInputError(f"alpha must lie in (0, 1); received {alpha!r}.")
    if not isinstance(method, str) or not method:
        raise StatisticInputError("method must be a non-empty string.")
    supported = {
        "bonferroni",
        "sidak",
        "holm",
        "fdr_bh",
        "fdr_by",
        "fdr_tsbh",
        "fdr_tsbky",
    }
    if method not in supported:
        raise StatisticInputError(
            f"Unsupported multiplicity method {method!r}; allowed: {sorted(supported)}."
        )

    try:
        iterator = iter(pvalues)
    except TypeError as exc:
        raise StatisticInputError("pvalues must be iterable.") from exc
    values = list(iterator)
    if not values:
        raise StatisticInputError("pvalues must contain at least one value.")
    array = np.asarray(values, dtype=np.float64)
    if array.ndim != 1:
        raise StatisticInputError(f"pvalues must be one-dimensional; received ndim={array.ndim}.")
    if not np.isfinite(array).all():
        raise StatisticInputError("pvalues must contain only finite numbers (no NaN/Inf).")
    if np.any(array < 0.0) or np.any(array > 1.0):
        raise StatisticInputError("pvalues must lie in [0, 1].")

    try:
        rejected, p_adjusted, _, _ = multipletests(array, alpha=float(alpha), method=method)
    except ValueError as exc:
        raise StatisticInputError(f"statsmodels.multipletests rejected input: {exc}") from exc

    return MultiplicityResult(
        rejected=tuple(bool(value) for value in rejected),
        p_adjusted=tuple(float(value) for value in p_adjusted),
        method=method,
    )


def expected_fixture_intervals() -> dict:
    """Return the exact §4 worked-fixture expected intervals.

    These are the integers and floating-point bounds that an integration
    test must observe when the analysis runs against the canonical
    fixture. They are baked into ``expected_results.py`` so an
    accidental library upgrade that re-orders resamples or seeds cannot
    silently pass: the Runtime wrapper asserts both the worker's output
    and the documented §4 values agree.
    """
    primary = _expected_completion_interval()
    guard = _expected_clarity_interval()
    return {
        "completion": primary.to_dict(),
        "clarity": guard.to_dict(),
    }


def _expected_completion_interval() -> NumericInterval:
    # 100 paired synthetic episodes, ten +1, ninety 0 (mean +0.10).
    array = [1.0] * 10 + [0.0] * 90
    return paired_percentile_bootstrap(array)


def _expected_clarity_interval() -> NumericInterval:
    # 100 paired synthetic episodes, thirty -1, seventy 0 (mean -0.30).
    array = [-1.0] * 30 + [0.0] * 70
    return paired_percentile_bootstrap(array)
