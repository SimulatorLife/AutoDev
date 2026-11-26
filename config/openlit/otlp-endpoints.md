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

When the AutoDev `openlit` ingress mode is enabled, producers use this receiver
and must provide the standard header:

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

Native client exporters report to the same receiver without an AutoDev
translation layer:

- **Codex** exports logs, traces and metrics from the `[otel]` table of the
  portable `config/config.autodev.toml` (`log_user_prompt = false`), with the
  header the router launcher publishes to the GUI launchd domain.
- **Claude Code** (2.1.x) exports metrics and log events when the installer
  has added AutoDev's slice to `~/.claude/settings.json`
  (`runtime/src/platform/claude-code-telemetry.ts`):
  `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`,
  `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, and
  `otelHeadersHelper`, which runs `runtime/src/telemetry/otel-headers-helper.ts`
  to print the bearer header from the private secret file at export time. The
  key is never written into the settings file. Prompt, tool-detail, tool-content
  and raw-API-body logging stay off; an operator value that differs from
  AutoDev's, or turns one of those on, is reported by the installer and
  `--check`, never overwritten.
- Copilot, Antigravity and MiniMax Code native exporters are not configured:
  their support at the installed versions is not yet qualified.

OpenLIT's embedded Collector accepts OTLP/HTTP JSON and Protobuf as supported
by its receiver. Producers use standard OTLP protocol settings; no AutoDev
telemetry translation layer is inserted. AutoDev no longer ships or runs a
separate Collector. The legacy `direct` ingress mode still targets the router's
receiver on port 4100; it is not the OpenLIT path and is scheduled for removal
after its live-control state is separated. A protected local trace POST has
been verified against OpenLIT's receiver; remaining live producer/deployment
acceptance gates are tracked in
[`docs/autodev-console-target-state.md`](../../docs/autodev-console-target-state.md) §12.

OpenLIT Community Edition provides session identity but no granular
viewer/operator RBAC for `/autodev`. The Control API proxy and authorization
contract are documented in `scripts/openlit/README.md` and the canonical
AutoDev Console target-state document.
