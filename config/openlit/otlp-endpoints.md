# OpenLIT OTLP endpoints for AutoDev producers

OpenLIT 2.1.0 bundles `otelcol-contrib` v0.142.0 with first-party OTLP/HTTP
and OTLP/gRPC receivers. AutoDev does not add a producer-facing sidecar. The
pinned OpenLIT config is unauthenticated by default, so AutoDev's local patch
`patches/openlit/03-otlp-receiver-auth.patch` binds `bearertokenauth` to both
protocols. Docker publishes the ports on loopback only.

| Signal                  | Protocol  | Host endpoint           |
| ----------------------- | --------- | ----------------------- |
| traces                  | OTLP/HTTP | `http://127.0.0.1:4318` |
| metrics                 | OTLP/HTTP | `http://127.0.0.1:4318` |
| logs                    | OTLP/HTTP | `http://127.0.0.1:4318` |
| traces / metrics / logs | OTLP/gRPC | `http://127.0.0.1:4317` |

All producers must provide the standard header:

```text
Authorization: Bearer <OPENLIT_OTLP_API_KEY>
```

The random token is generated in `$CODEX_HOME/openlit-secrets.env` (mode
0600, outside the repository) and materialized to
`$CODEX_HOME/openlit-otlp-api-key` (mode 0600). Do not put it in Compose,
tracked config, or dashboard state. Codex/router ingress is switched only by
`bash scripts/install.sh --enable-openlit-ingress`; the router launcher loads
the out-of-repository key and publishes the standard OTLP endpoint/header to
its own process and the Codex GUI launchd domain. Disable it with
`bash scripts/install.sh --disable-openlit-ingress`.

The OpenLIT Collector accepts OTLP/HTTP JSON and Protobuf as supported by its
receiver. Producers use standard OTLP protocol settings; no AutoDev telemetry
translation layer is inserted. The separate AutoDev Collector remains an
incumbent rollback path only until the end-to-end cutover gates in
`docs/observability-target-state.md` pass.

OpenLIT Community Edition provides session identity but no granular
viewer/operator RBAC for `/autodev`. The Control API proxy and authorization
contract are documented in `scripts/openlit/README.md` and the canonical
observability target-state document.
