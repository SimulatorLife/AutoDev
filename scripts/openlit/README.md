# OpenLIT local build / pin scripts

> **Memory provider target / legacy-patch notice:** AutoDev's [Memory target state](../../docs/memory-target-state.md) now selects **Mem0 Platform** for long-term memory and the **OpenLIT Mem0 connector/component patterns** for the sole AutoDev Console Memory UI and OpenTelemetry analytics. The legacy `autodev` connector and historical standalone OpenLIT Memory-page patch instructions below describe the **current/previous implementation and patch lineage**, not the intended provider or a second operator UI. Verify the Mem0 connector remains available in the pinned/reduced OpenLIT build, and test its API-version/permission/capability mapping before replacing the current paths; no cutover has been performed by this documentation change.

These scripts implement the OpenLIT integration described in
[`docs/autodev-console-target-state.md`](../../docs/autodev-console-target-state.md).
The split is deliberate:

- `apply-patches.sh` — fetch the pinned upstream commit into a local bare git
  cache (`$CODEX_HOME/cache/openlit-upstream.git`, falling back to a direct
  shallow fetch when uncacheable), check it out into a fresh workdir, apply each
  patch in `patches/openlit/` (in order) against the accumulating tree, and
  normalize source mtimes from file contents so BuildKit and Next.js caches stay
  warm across temporary checkouts. Refuses to run if the upstream HEAD does not
  match the pinned commit.
- `build-local.sh` — build the locally patched image using BuildKit layer and
  cache mounts (`82-optimize-dockerfile-build-cache.patch`) and lock the source
  commit, patch-set hash, image ID, and resulting digest. The local stack uses
  this patched image; it does not silently fall back to stock OpenLIT.
- `pin-image.sh` — pull and verify the first-party OpenLIT image digest so
  deployments can use an immutable ref.

## Patch series ownership

`tests/openlit-patch-series.ts` is the single owner of the series: it exports
`OPENLIT_PATCH_NAMES` (every patch, in apply order) and
`assertOpenlitPatchSeries()`, the rule that decides whether a directory listing
_is_ that series. Both gates in `tests/openlit-patches-apply.test.ts` call that
one function rather than carrying a list of their own.

This matters because those two gates require a `git clone` of the pinned OpenLIT
commit. Where cloning is not possible, a stale or missing patch name was
invisible. That already happened: the series had grown to 39 patches while a
second hand-maintained list in the applying test still stopped at 25, so patches
26–39 were never order-checked anywhere.

`tests/openlit-patch-series.test.ts` therefore checks the invariant against the
files on disk with no clone, and runs in `pnpm test:root`. It also asserts
completeness (the directory holds every maintained patch and nothing else),
because `assertOpenlitPatchSeries()` intersects the expected series with what is
present in order to tolerate a checkout predating the newest patches — a
tolerance the apply path needs, and one that means the series rule alone cannot
see a patch that is simply absent. Adding or renaming a patch means updating
`OPENLIT_PATCH_NAMES` and the directory together.

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

AutoDev does not run or ship a separate Collector. The opt-in `openlit`
ingress uses OpenLIT's embedded `otelcol-contrib` receiver; the legacy `direct`
ingress still targets the AutoDev router's OTLP receiver on port 4100 and is
scheduled for removal after its live-control state is separated. A protected
local trace POST has been verified against OpenLIT's receiver; remaining live
producer/deployment acceptance gates are tracked in
[`docs/autodev-console-target-state.md`](../../docs/autodev-console-target-state.md) §12.

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

The same out-of-repository secret file also contains a distinct
`AUTODEV_PLAYTEST_CONTROL_API_TOKEN`. It is loaded only into the AutoDev Runtime
model-router process and is never copied into `console/.env.local` or the
OpenLIT container. The Runtime role bridge passes it only to a Playtester MCP
process after binding the role, workspace and task session; the generic Console
Control token is never accepted for Playtest run-control routes.

Viewer/operator allowlists (`AUTODEV_CONTROL_VIEWERS` /
`AUTODEV_CONTROL_OPERATORS`) are configured on the AutoDev side and read
by the AutoDev Control API, not by OpenLIT. The proxy does not consult
them.

The AutoDev router's model/OTLP listener remains loopback-only on port 4100.
For container reachability, OpenLIT calls the separate Control-API-only
listener at `host.docker.internal:4101`. When
`--enable-openlit-ingress` is selected, `scripts/run-autodev-model-router.sh`
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
limited to the seeded time range and bounded workspace/provider/model/agent/skill
values; skill filtering is exposed only where source semantics support it. The
`autodev-openlit-usage-v5` response carries validated fixed-widget data, filter
options, Git change counters/breakdowns, and a privacy-filtered list of at most
25 recent provider attempts; it accepts no raw SQL or arbitrary widget
selector. The endpoint has a dedicated
`AUTODEV_OPENLIT_USAGE_TOKEN` and does not accept OpenLIT sessions or API keys.
The Console server reads the same secret from its server environment as
`AUTODEV_OPENLIT_USAGE_TOKEN`; it must never be forwarded to browser code.

The endpoint only reports metrics for successful individual widget queries.
Query errors remain explicitly unobserved, and unsupported distinct-value
capabilities produce unavailable filters rather than fabricated options.
Filter-option discovery is bounded to the selected time window and scoped to
the AutoDev service(s) that emit each attribute; it never scans unrelated
OpenLIT services for dropdown values. Trace attempts are bounded observations;
selecting one resolves detail through the fixed read-only span route. The retained OpenLIT app is configured for
request-time rendering because its telemetry pages consume URL search state;
image builds must not prerender those pages.

## Memory ownership

The Console owns Memory reads and writes through AutoDev's Control API. Patch
80 retires the fork's page-only same-origin action, outcome, cohort, and
use-assessment proxy routes;
the OpenLIT Memory page was removed earlier. Generic OpenLIT Memory connector
read/CRUD APIs remain separate integration capabilities.

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
source, builds or reuses the verified patched image, creates secrets under
`$CODEX_HOME`, writes the OTLP token material to a mode-0600 file, starts
Compose, and waits for ClickHouse and OpenLIT HTTP readiness. The tracked
`config/openlit/openlit.env` remains a non-secret template. Generated database,
Control API, receiver, and Usage tokens are stored together in
`$CODEX_HOME/openlit-secrets.env`; the OTLP token is also materialized at
`$CODEX_HOME/openlit-otlp-api-key`. Neither file is in the repository. After
OpenLIT is ready, the runner also synchronizes the tracked prompt/agent,
provider-model, and workspace catalogs to the local OpenLIT instance.

The root `pnpm run dev` reconciles this lifecycle on every startup, before it
launches the Console; HTTP health alone does not establish that a running image
matches the current patch set. `up.sh` verifies the deployed Usage response
through the Data client/parser and fails startup if the v4 contract is stale or
invalid. The build is reused when its source and patch hash match, and Compose
recreates only affected services while preserving durable volumes. On macOS the
runner starts Docker Desktop if its Engine is not running; on other platforms
the Docker Engine must be running. Use `down.sh` only when an operator
explicitly wants to stop the stack.

### The runner converges on the stack, not on Compose's exit code

A Compose failure is not by itself a failed stack, and the two are told apart
by what the runner observes rather than by what Compose prints.

Docker Desktop's API proxy aborts any Docker Engine call that misses its fixed
10-second deadline and reports it as `500 Internal Server Error`. Compose
turns that into `dependency clickhouse failed to start: … check if the server
supports the requested API version`, which reads like an API version mismatch
and is not one: the version in the message is the one Compose asked with. The
Engine simply did not answer in time, which happens whenever the host is
loaded enough to starve the Docker VM.

The same starved Engine produces the other health-gate failure: the health
check cannot start inside the container, the container is recorded unhealthy,
and Compose refuses to start the service that depends on it — even when that
service is serving. Both failures are transient, and the same `compose up`
converges once the Engine and the stack recover.

The runner therefore:

- retries `compose up -d` when — and only when — the failure was one of those
  two, waiting for `docker info` to answer again and letting the stack settle
  between attempts, so a retry is not the same attempt again;
- fails immediately on a Compose failure no retry can fix (a malformed compose
  file, a missing image, an unset variable, a taken port);
- decides success on the stack's readiness: ClickHouse accepts an
  authenticated query and OpenLIT answers HTTP. The ClickHouse probe accepts
  either path to a serving server — the published port, which is what the
  Console and the producers use, or the container itself, which is what
  answers when the port forwarder is the starved part.

`AUTODEV_OPENLIT_COMPOSE_ATTEMPTS`,
`AUTODEV_OPENLIT_COMPOSE_RETRY_DELAY_SECONDS`,
`AUTODEV_OPENLIT_ENGINE_TIMEOUT_SECONDS`,
`AUTODEV_OPENLIT_CLICKHOUSE_TIMEOUT_SECONDS`, and
`AUTODEV_OPENLIT_HTTP_TIMEOUT_SECONDS` bound those steps.

| Script                  | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply-patches.sh`      | Materialize the pinned OpenLIT commit via a cached upstream bare repo, apply all local patches, and normalize file mtimes for reproducible BuildKit/Next.js caching.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `build-local.sh`        | Build the patched image (with BuildKit npm, Prisma, and `.next/cache` mounts) and record source, patch, image-ID, and digest metadata outside the repo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `bootstrap-secrets.sh`  | Generate/preserve strong DB, Control API, OTLP receiver, and Console Usage tokens. Writes the canonical `$CODEX_HOME/openlit-secrets.env` (mode 0600, outside the repo) and additionally materializes the two Console server-only tokens plus their local base URL defaults into `console/.env.local` (mode 0600, ignored by `.env.*`) for Next.js to auto-load during the root `pnpm run dev` workflow. The production launchd-managed Console (`scripts/run-autodev-console.sh`) continues to source the canonical secret file directly and does not depend on `console/.env.local`; it validates backend contracts before serving. |
| `bootstrap-otlp-key.sh` | Materialize the same generated receiver token for producers; it does not call an OpenLIT API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `up.sh`                 | Build or reuse the locked patch-matched image, prepare secrets, start Compose (retrying an unresponsive Engine), wait for ClickHouse/OpenLIT readiness, ensure the Collector's OTEL schema, apply diagnostic log TTLs only where missing, synchronize model/workspace catalogs in parallel, and validate the live Usage v5 response through Data.                                                                                                                                                                                                                                                                                     |
| `down.sh`               | Stop the local stack while preserving its durable ClickHouse and OpenLIT data volumes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

The bring-up runner cleans up only its own fresh scratch clone. It never edits the
tracked env template or removes pre-existing `.tmp` data. The down runner leaves
the named persistent data volumes intact. Current patched-image
and runtime acceptance evidence, including remaining gates, lives only in the
[canonical AutoDev Console target](../../docs/autodev-console-target-state.md) §§11–12;
source patch application alone is not deployment or cutover proof.

The runner owns the Collector's OTEL schema. The ClickHouse image initializes
`/docker-entrypoint-initdb.d` only when its data directory is empty, and it
does that by starting a temporary server bound to the container's loopback,
running the schema, killing it, and starting the real one — so the published
port is dead for as long as the schema takes. With the always-run flag set,
that dance happened on _every_ start, and the schema took minutes on a loaded
host: the Collector, the Usage API, and the Control API's own ClickHouse read
all failed while it ran. The tables persist in the named volume, so the
runner checks for them and creates any that are missing.

The Docker-built image is the one rendered in the UI: `OPENLIT_IMAGE` is
overridden by the runner with a tag derived from the pinned source commit
and patch-set hash. The lock file records the resulting local image ID/digest.
Before Compose starts, the runner verifies that the deterministic tag still
resolves to the image ID recorded in the mode-0600 lock. A successful script
exit proves the locked image is available, ClickHouse accepts a query, the
Collector's OTEL tables exist, and the OpenLIT HTTP service responds;
cutover also requires live auth, persistence, dashboard, and control-proxy
probes.

```sh
# Full local bring-up (also invoked by pnpm run dev when needed):
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

## Local Console environment materialization

`scripts/openlit/bootstrap-secrets.sh` is the canonical writer for both
secret stores the local Console needs:

1. The out-of-repository canonical secret file
   `$CODEX_HOME/openlit-secrets.env` (mode 0600), which the launchd-managed
   `scripts/run-autodev-console.sh` LaunchAgent reads via an exact-key parser
   to export the two Console-required service credentials before exec'ing
   `next start`.
2. The Next.js auto-loaded file `console/.env.local` (mode 0600), which the
   `pnpm run dev` and `pnpm --filter @simulatorlife/autodev-console build/start` workflow
   picks up directly. Next.js loads it on every server-side request; the
   file is gitignored via the root `.gitignore` rule `.env.*`.

`console/.env.local` carries only the two Console-required server-only
service credentials (`AUTODEV_CONTROL_API_TOKEN`,
`AUTODEV_OPENLIT_USAGE_TOKEN`) and their non-secret local base URL
defaults (`AUTODEV_CONTROL_API_BASE_URL`,
`AUTODEV_OPENLIT_USAGE_URL`). It deliberately does **not** carry the
OpenLIT database password or the OTLP receiver token, because those are
OpenLIT-side and proxy-only credentials respectively and must never reach
the Console server process. URL defaults use Next.js
`${VAR:-default}` expansion so operators can override them per shell
session without editing the file.

The writer is an atomic tmp-file + `mv -f` swap followed by an explicit
`chmod 0600`; it overwrites any previous `console/.env.local` and
re-enforces the owner-only permission even if the prior file was more
permissive (e.g. left behind by a hand-edit). When the script cannot
locate a `console/` directory next to the `scripts/openlit/` path it is
invoked from, the `.env.local` step is skipped silently and the canonical
secret file is still produced. Test harnesses pass `REPO_ROOT=<tmpdir>`
to drive the bootstrap end-to-end without touching the real
`console/.env.local`.

The security boundary is server-only: neither the CONTROL nor the USAGE
token may be exposed to browser code. The Console's
`src/lib/server/control-api.ts` and `src/lib/server/openlit-usage.ts`
adapters read these variables from `process.env` and the server-rendered
pages render a documented "credential not configured" state when the
variables are absent; `console/.env.local` is the contract that closes
that gap for the `pnpm` workflow.
