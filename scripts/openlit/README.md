# OpenLIT local build / pin scripts

These scripts implement the OpenLIT integration described in
[`docs/autodev-console-target-state.md`](../../docs/autodev-console-target-state.md).
The split is deliberate:

- `apply-patches.sh` — checkout the pinned upstream commit, run `git apply
--check` on every patch in `patches/openlit/`, then apply them to a
  scratch worktree. Refuses to run if the upstream HEAD does not match the
  pinned commit.
- `build-local.sh` — build the locally patched image and lock the source
  commit, patch-set hash, image ID, and resulting digest. The local stack uses
  this patched image; it does not silently fall back to stock OpenLIT.
- `pin-image.sh` — pull and verify the first-party OpenLIT image digest so
  deployments can use an immutable ref.

## Pinned upstream

| Identifier         | Value                                                                     |
| ------------------ | ------------------------------------------------------------------------- |
| source release tag | `openlit-2.1.0`                                                           |
| image tag          | `2.1.0`                                                                   |
| commit             | `9938c66638666ca5d3bcb850350faa82e510924b`                                |
| image              | `ghcr.io/openlit/openlit:2.1.0`                                           |
| image digest       | `sha256:94552ccd09379b5e2fec3c51c4fec1b41d88d6b56b0a5ccc895c116673884fa8` |

## OTLP ingestion

OpenLIT 2.1.0 bundles `otelcol-contrib` v0.142.0 and its first-party
receiver on `:4318` (HTTP) / `:4317` (gRPC). Source inspection confirmed
that the pinned stock config has no `OTLP_REQUIRE_API_KEY` setting and
accepts unauthenticated OTLP. `03-otlp-receiver-auth.patch` locally attaches
the contrib `bearertokenauth` server authenticator to both protocols. The
secret is generated outside the repository and passed to the embedded
Collector as `OPENLIT_OTLP_API_KEY`; producers send
`Authorization: Bearer <token>`. This modifies OpenLIT's existing receiver
configuration; it does not add a sidecar or second telemetry path. See
`config/openlit/otlp-endpoints.md`.

## Control/API ownership

The canonical Control API resource model, authorization, and audit contract are
maintained only in
[`docs/autodev-console-target-state.md`](../../docs/autodev-console-target-state.md) §10.
The `/autodev` patch is a same-origin UI/proxy client of that API, not a second
source of control semantics. This README documents only deployment wiring.

### OpenLIT-side environment

| Variable                       | Required | Notes                                                                      |
| ------------------------------ | -------- | -------------------------------------------------------------------------- |
| `AUTODEV_CONTROL_API_URL`      | yes      | Control-only AutoDev listener; defaults to `host.docker.internal:4101`.    |
| `AUTODEV_CONTROL_API_TOKEN`    | yes      | Service credential used by the proxy. Server-only.                         |
| `AUTODEV_CONTROL_API_DISABLED` | no       | Set to `1` to short-circuit the proxy with 503 during cutover.             |
| `AUTODEV_OPENLIT_USAGE_TOKEN`  | yes      | Dedicated bearer credential accepted only by the read-only Usage endpoint. |

Viewer/operator allowlists (`AUTODEV_CONTROL_VIEWERS` /
`AUTODEV_CONTROL_OPERATORS`) are configured on the AutoDev side and read
by the AutoDev Control API, not by OpenLIT. The proxy does not consult
them.

The AutoDev router's model/OTLP listener remains loopback-only on port 4100.
For container reachability, OpenLIT calls the separate Control-API-only
listener at `host.docker.internal:4101`. When
`--enable-openlit-ingress` is selected, `scripts/run-codex-model-router.sh`
starts that listener only for `/control/*`; each request independently requires
the service token. With no viewer/operator allowlists configured, the API
authorizes only the fixed `autodev-local` actor as the single local operator.
Configuring either allowlist disables that local identity and requires an
explicitly listed actor. The listener does not expose `/v1/responses`,
`/v1/traces`, or the local dashboard. Compose maps `host.docker.internal` to
the host gateway for Linux as well as Docker Desktop. The 4101 listener binds
to the configured interface (default `0.0.0.0` in OpenLIT mode); use the host
firewall appropriate to the environment in addition to the server-only service
token. For remote deployments, configure viewer/operator actor allowlists from
a trusted reverse-proxy/SSO integration.

Viewer/operator actor IDs are configured on AutoDev in `$CODEX_HOME/.env` as
`AUTODEV_CONTROL_VIEWERS` and `AUTODEV_CONTROL_OPERATORS` when external identity
is in use. The legacy OpenLIT proxy forwards only its verified session actor; it
does not assign a role. The unified Console uses the fixed `autodev-local`
identity only in local single-user mode, and sends it from its server together
with the service credential. See the canonical AutoDev Console target for the
authorization boundary and mutation audit rules.

## Usage query endpoint

The patched OpenLIT server exposes a read-only `POST /api/autodev/usage`
contract for the unified Console. It uses the existing typed `runWidgetQuery`,
board variable specs, and datasource `distinctValues` adapter. Request input is
limited to the seeded time range and workspace/provider/model/agent values;
there is no raw SQL or arbitrary widget selector. The endpoint has a dedicated
`AUTODEV_OPENLIT_USAGE_TOKEN` and does not accept OpenLIT sessions or API keys.
The standalone Console reads the same secret from its server environment as
`AUTODEV_OPENLIT_USAGE_TOKEN`; it must never be forwarded to browser code.

The endpoint only reports metrics for successful individual widget queries.
Query errors remain explicitly unobserved, and unsupported distinct-value
capabilities produce unavailable filters rather than fabricated options.

## Usage

```sh
# Pull and verify the first-party image.
scripts/openlit/pin-image.sh

# Apply the patch set (idempotent; verifies commit).
scripts/openlit/apply-patches.sh

# Build a local image with the patch set applied.
scripts/openlit/build-local.sh
```

## End-to-end local bring-up

`scripts/openlit/up.sh` applies every patch to a fresh checkout of the pinned
source, builds the patched image, creates secrets under `$CODEX_HOME`, writes
the OTLP token material to a mode-0600 file, and starts Compose. The tracked
`config/openlit/openlit.env` remains a non-secret template. Generated database,
Control API, receiver, and Usage tokens are stored together in
`$CODEX_HOME/openlit-secrets.env`; the OTLP token is also materialized at
`$CODEX_HOME/openlit-otlp-api-key`. Neither file is in the repository.

| Script                  | Responsibility                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apply-patches.sh`      | Apply all local patches to the exact pinned OpenLIT commit.                                                      |
| `build-local.sh`        | Build the patched image and record source, patch, image-ID, and digest metadata outside the repo.                |
| `bootstrap-secrets.sh`  | Generate/preserve strong DB, Control API, OTLP receiver, and Console Usage tokens in the CODEX_HOME secret file. |
| `bootstrap-otlp-key.sh` | Materialize the same generated receiver token for producers; it does not call an OpenLIT API.                    |
| `up.sh`                 | Build, prepare secrets, then start the locally patched image with the non-secret template.                       |
| `down.sh`               | Stop the local stack while preserving its durable ClickHouse and OpenLIT data volumes.                           |

The bring-up runner cleans up only its own fresh scratch clone. It never edits the
tracked env template or removes pre-existing `.tmp` data. The down runner leaves
the named persistent data volumes intact. Current patched-image
and runtime acceptance evidence, including remaining gates, lives only in the
[canonical AutoDev Console target](../../docs/autodev-console-target-state.md) §§11–12;
source patch application alone is not deployment or cutover proof.

The Docker-built image is the one rendered in the UI: `OPENLIT_IMAGE` is
overridden by the runner with a tag derived from the pinned source commit
and patch-set hash. The lock file records the resulting local image ID/digest.
Before Compose starts, the runner verifies that the deterministic tag still
resolves to the image ID recorded in the mode-0600 lock. A successful script
exit proves image build and Compose start only; cutover also requires live
auth, persistence, dashboard, and control-proxy probes.

```sh
# Full local bring-up:
scripts/openlit/up.sh

# Stop the stack without deleting telemetry or OpenLIT data:
scripts/openlit/down.sh

# Pull and verify the first-party upstream image (optional; not required
# when running `up.sh` because the runner builds the patched image).
scripts/openlit/pin-image.sh

# Manual apply + build (split out for debugging):
scripts/openlit/apply-patches.sh
scripts/openlit/build-local.sh
```
