# AutoDev Playtesting Statistics (isolated)

Pinned, hash-locked Python analysis used by the Runtime-owned
`runtime/src/playtesting/statistics/analysis.ts` invocation API.

This environment is selected by `docs/playtesting-measurement-contract.md`
§4 "Statistics reuse", which requires an isolated analysis task that uses
SciPy bootstrap on paired independent-unit arrays, plus statsmodels
multiplicity corrections on a predeclared family. Core supplies quantity
definitions and input grouping; this environment performs the inference
without rewriting correlation/bootstrap math.

## Pinned versions

| Library       | Version  |
| ------------- | -------- |
| Python        | >=3.12,<3.14 |
| NumPy         | 2.3.5    |
| SciPy         | 1.17.0   |
| statsmodels   | 0.14.6   |

The exact resolved package set, including hashes, lives in `uv.lock`.
Reproducing the install:

```
uv sync --frozen --project .
```

`uv sync` refuses to mutate `uv.lock`; any drift in resolved versions
fails the lifecycle gate before the API runs.

## Public entry point

`python_script/__main__.py` reads one JSON-RPC envelope on stdin,
executes the requested statistical analysis, and writes the JSON-RPC
result on stdout. It does not read human responses or agent
configurations, and never touches ClickHouse, OTLP, or the Docker
sandbox.
