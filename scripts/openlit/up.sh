#!/usr/bin/env bash
# Build and start the AutoDev-maintained OpenLIT patch set.
# Secrets are stored only in CODEX_HOME, never in the tracked env template.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
if [[ -z "$REPO_ROOT" ]]; then
	echo "up.sh: REPO_ROOT is required (run from the AutoDev repo)" >&2
	exit 1
fi

PINNED_COMMIT="${AUTODEV_OPENLIT_PINNED_COMMIT:-9938c66638666ca5d3bcb850350faa82e510924b}"
CODEX_HOME="${CODEX_HOME:-${HOME:?HOME must be set}/.codex}"
COMPOSE_FILE="${AUTODEV_OPENLIT_COMPOSE_FILE:-$REPO_ROOT/config/openlit/docker-compose.yml}"
ENV_FILE="${AUTODEV_OPENLIT_ENV_FILE:-$REPO_ROOT/config/openlit/openlit.env}"
SECRET_FILE="${AUTODEV_OPENLIT_SECRET_FILE:-$CODEX_HOME/openlit-secrets.env}"
LOCK_FILE="${AUTODEV_OPENLIT_LOCK_FILE:-$CODEX_HOME/openlit-patched.lock}"
OTLP_KEY_FILE="${AUTODEV_OPENLIT_OTLP_KEY_FILE:-$CODEX_HOME/openlit-otlp-api-key}"
COMPOSE_DIR="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)"
ASSET_DIR="$COMPOSE_DIR/assets"
CONSOLE_USAGE_TOKEN_OVERRIDE="${AUTODEV_OPENLIT_USAGE_TOKEN:-}"

fingerprint_files() {
	local file
	for file in "$@"; do
		if [[ ! -f "$file" ]]; then
			echo "up.sh: mounted configuration file is missing: $file" >&2
			return 1
		fi
		cat "$file"
		printf '\0'
	done | shasum -a 256 | awk '{print $1}'
}

if [[ ! -d "$REPO_ROOT/patches/openlit" || ! -f "$COMPOSE_FILE" || ! -f "$ENV_FILE" ]]; then
	echo "up.sh: patch directory, compose file, or env template is missing" >&2
	exit 1
fi

# Compose does not detect changes to the contents of bind-mounted files.
# Include their fingerprints in service labels so `compose up` recreates only
# the affected container while leaving its durable volume untouched.
AUTODEV_OPENLIT_CLICKHOUSE_CONFIG_HASH="$(fingerprint_files \
	"$ASSET_DIR/clickhouse-config.xml" \
	"$ASSET_DIR/clickhouse-init.sh")"
export AUTODEV_OPENLIT_CLICKHOUSE_CONFIG_HASH
AUTODEV_OPENLIT_OTEL_CONFIG_HASH="$(fingerprint_files \
	"$ASSET_DIR/otel-collector-config.yaml")"
export AUTODEV_OPENLIT_OTEL_CONFIG_HASH

if ! command -v docker >/dev/null 2>&1; then
	echo "up.sh: docker is required" >&2
	exit 1
fi
if ! docker info >/dev/null 2>&1; then
	echo "up.sh: Docker Engine is not reachable; start Docker Desktop or the Docker service, then retry" >&2
	exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
	echo "up.sh: curl is required to verify OpenLIT readiness" >&2
	exit 1
fi
if docker compose version >/dev/null 2>&1; then
	DOCKER_COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
	DOCKER_COMPOSE=(docker-compose)
else
	echo "up.sh: docker compose plugin is required" >&2
	exit 1
fi

WORK_DIR="$(mktemp -d -t autodev-openlit-up.XXXXXX)"
cleanup() {
	local rc=$?
	if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then
		rm -rf "$WORK_DIR"
	fi
	exit "$rc"
}
trap cleanup EXIT INT TERM

export CODEX_HOME
export AUTODEV_OPENLIT_WORK_DIR="$WORK_DIR"
export AUTODEV_OPENLIT_PINNED_COMMIT="$PINNED_COMMIT"
export AUTODEV_OPENLIT_LOCK_FILE="$LOCK_FILE"

echo "==> Building from the pinned source and applying the local patch set"
# build-local.sh is the sole owner of patch application. Keeping it here avoids
# applying twice into the same intentionally non-empty work directory.
"$REPO_ROOT/scripts/openlit/build-local.sh"

if [[ ! -s "$LOCK_FILE" ]]; then
	echo "up.sh: patched image lock file missing: $LOCK_FILE" >&2
	exit 4
fi
IMAGE_TAG="$(awk -F= '$1 == "AUTODEV_OPENLIT_IMAGE_TAG" { sub(/^[^=]*=/, ""); print; exit }' "$LOCK_FILE")"
LOCKED_IMAGE_ID="$(awk -F= '$1 == "AUTODEV_OPENLIT_IMAGE_ID" { sub(/^[^=]*=/, ""); print; exit }' "$LOCK_FILE")"
if [[ -z "$IMAGE_TAG" || ! "$LOCKED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]; then
	echo "up.sh: patched image tag or image ID is missing/invalid in the lock file" >&2
	exit 4
fi
ACTUAL_IMAGE_ID="$(docker image inspect --format='{{.Id}}' "$IMAGE_TAG" 2>/dev/null || true)"
if [[ "$ACTUAL_IMAGE_ID" != "$LOCKED_IMAGE_ID" ]]; then
	echo "up.sh: image tag no longer points to the locked patched image ID" >&2
	exit 4
fi

# Generate strong secrets in an out-of-repository CODEX_HOME file;
# the checked-in env template is never modified.
echo "==> Preparing out-of-repository secrets"
"$REPO_ROOT/scripts/openlit/bootstrap-secrets.sh" --secret-file "$SECRET_FILE"
"$REPO_ROOT/scripts/openlit/bootstrap-otlp-key.sh" \
	--secret-file "$SECRET_FILE" \
	--key-file "$OTLP_KEY_FILE"

# The generated secret file is trusted, mode 0600, and outside the repo.
# Export its values so both Docker Compose v2 and docker-compose receive the
# same secrets without copying them into the tracked template.
set -a
# shellcheck disable=SC1090
source "$SECRET_FILE"
set +a
export OPENLIT_IMAGE="$IMAGE_TAG"

# ---- Bringing the stack up -------------------------------------------
#
# Docker Desktop's API proxy aborts any Docker Engine call that misses its
# fixed 10-second deadline and reports the failure as `500 Internal Server
# Error`. Compose turns that into "dependency clickhouse failed to start: ...
# check if the server supports the requested API version", which reads like a
# version mismatch and is not one: the API version in the message is the one
# Compose asked with, and the Engine serves it. The Engine simply did not
# answer in time.
#
# The same starved Engine produces the other health-gate failure: the health
# check itself cannot start inside the container, the container is recorded
# unhealthy, and Compose refuses to start the service that depends on it --
# even when that service is serving. Both failures are transient, and the
# same `compose up` converges once the Engine and the stack recover. The
# runner therefore retries those failures instead of failing the whole
# startup, and it decides success on the stack's readiness rather than on
# Compose's exit code.
TRANSIENT_COMPOSE_FAILURE_PATTERN='request returned 5[0-9][0-9] Internal Server Error|Cannot connect to the Docker daemon|context deadline exceeded|i/o timeout|connection reset by peer|unexpected EOF|dependency failed to start: container .* is unhealthy'

# How many times Compose may be asked to start the stack before the runner
# gives up on a stack that will not come up.
COMPOSE_ATTEMPTS="${AUTODEV_OPENLIT_COMPOSE_ATTEMPTS:-3}"
# How long to wait for the Engine to answer again between those attempts.
ENGINE_TIMEOUT_SECONDS="${AUTODEV_OPENLIT_ENGINE_TIMEOUT_SECONDS:-60}"
# How long to let the stack settle before the next attempt, so a retry is
# not the same attempt again.
COMPOSE_RETRY_DELAY_SECONDS="${AUTODEV_OPENLIT_COMPOSE_RETRY_DELAY_SECONDS:-5}"
# How long the stack may take to serve once Compose has started it.
CLICKHOUSE_TIMEOUT_SECONDS="${AUTODEV_OPENLIT_CLICKHOUSE_TIMEOUT_SECONDS:-120}"
OPENLIT_TIMEOUT_SECONDS="${AUTODEV_OPENLIT_HTTP_TIMEOUT_SECONDS:-120}"
CLICKHOUSE_HTTP_PORT="${AUTODEV_OPENLIT_CLICKHOUSE_HTTP_PORT:-8123}"

COMPOSE_LOG="$WORK_DIR/compose-up.log"

# Start the stack.
#
# Returns 0 when Compose brought it up, 1 when the failure is transient, and
# 2 for a Compose failure that will not fix itself (a bad compose file, a
# missing image, an unset variable, a taken port).
compose_up() {
	local status=0
	"${DOCKER_COMPOSE[@]}" \
		--env-file "$ENV_FILE" \
		-f "$COMPOSE_FILE" \
		up -d 2>&1 | tee "$COMPOSE_LOG" || status=$?
	if [[ "$status" -eq 0 ]]; then
		return 0
	fi
	if grep -Eq "$TRANSIENT_COMPOSE_FAILURE_PATTERN" "$COMPOSE_LOG"; then
		return 1
	fi
	return 2
}

# Wait for the Docker Engine to answer again.
#
# A Compose attempt that failed because the Engine was too slow fails the
# same way until the Engine recovers, so the runner waits for the Engine
# instead of retrying into the same stall.
wait_for_engine() {
	local deadline=$((SECONDS + ENGINE_TIMEOUT_SECONDS))
	while (( SECONDS < deadline )); do
		if docker info >/dev/null 2>&1; then
			return 0
		fi
		sleep 2
	done
	return 1
}

# Does ClickHouse accept an authenticated query?
#
# The published port is probed first: it is what the Console and the producers
# use, and it needs no Docker API call. The container is the fallback, because
# when the port forwarder is the starved part the server is serving and only
# the path to it is slow -- and the reverse is true too, so the probe accepts
# either path rather than failing a stack that is up on one of them.
clickhouse_accepts_query() {
	if curl --fail --silent --show-error --max-time 10 \
		--user "${OPENLIT_DB_USER:-default}:${OPENLIT_DB_PASSWORD}" \
		--data-urlencode "query=SELECT 1" \
		"http://127.0.0.1:${CLICKHOUSE_HTTP_PORT}/" >/dev/null 2>&1; then
		return 0
	fi
	"${DOCKER_COMPOSE[@]}" -f "$COMPOSE_FILE" exec -T clickhouse \
		clickhouse-client \
		--user="${OPENLIT_DB_USER:-default}" \
		--password="$OPENLIT_DB_PASSWORD" \
		--query="SELECT 1" >/dev/null 2>&1
}

# Does OpenLIT answer HTTP?
openlit_http_ready() {
	curl --fail --silent --show-error --location --max-time 10 \
		"http://127.0.0.1:${PORT:-3000}/" >/dev/null 2>&1
}

# Does ClickHouse have the OTEL tables the Collector writes to?
#
# The schema lives in the persistent volume, and the image only runs its own
# initialization when that volume is empty -- so a volume whose first
# initialization was interrupted keeps missing the tables the Collector
# writes to, and the Console then shows a stack that ingests nothing. One
# query decides; the initialization runs only when the tables are absent.
clickhouse_has_otel_schema() {
	"${DOCKER_COMPOSE[@]}" -f "$COMPOSE_FILE" exec -T clickhouse \
		clickhouse-client \
		--query="SELECT count() FROM system.tables WHERE database = '${OPENLIT_DB_NAME:-openlit}' AND name = 'otel_traces'" \
		2>/dev/null | tr -d '[:space:]' | grep -qx "1"
}

# Create the Collector's OTEL schema in the running ClickHouse.
#
# The image's own initialization is skipped when the volume already holds a
# database, so the schema is created here instead: the same script the
# image would have run, against a server that is already serving.
ensure_otel_schema() {
	echo "==> Ensuring the Collector's OTEL schema in ClickHouse"
	if clickhouse_has_otel_schema; then
		echo "    OTEL tables are present."
		return 0
	fi
	echo "    OTEL tables are missing; creating them..."
	if ! "${DOCKER_COMPOSE[@]}" -f "$COMPOSE_FILE" exec -T clickhouse \
		bash /docker-entrypoint-initdb.d/init.sh; then
		echo "up.sh: the Collector's OTEL schema could not be created in ClickHouse." >&2
		echo "up.sh: the Console would ingest no telemetry until they exist." >&2
		return 1
	fi
	return 0
}

# Print the last Compose output so a failure names its cause instead of
# pointing at the runner.
report_compose_output() {
	if [[ -s "$COMPOSE_LOG" ]]; then
		echo "up.sh: last docker compose output:" >&2
		tail -n 20 "$COMPOSE_LOG" >&2
	fi
}

echo "==> Starting the patched OpenLIT stack with authenticated OTLP"
compose_attempt=1
compose_status=0
compose_up || compose_status=$?
while [[ "$compose_status" -eq 1 ]]; do
	if [[ "$compose_attempt" -ge "$COMPOSE_ATTEMPTS" ]]; then
		echo "up.sh: docker compose could not start the OpenLIT stack after ${compose_attempt} attempts." >&2
		echo "up.sh: a Docker Engine that does not answer in time reports this as a 500 with an API-version hint; the version is not the problem." >&2
		report_compose_output
		compose_status=3
		break
	fi
	compose_attempt=$((compose_attempt + 1))
	echo "up.sh: the OpenLIT stack did not start; waiting for the Docker Engine and the stack to recover and retrying (attempt ${compose_attempt}/${COMPOSE_ATTEMPTS})" >&2
	wait_for_engine || true
	sleep "${COMPOSE_RETRY_DELAY_SECONDS}"
	compose_status=0
	compose_up || compose_status=$?
done
if [[ "$compose_status" -eq 2 ]]; then
	echo "up.sh: docker compose could not start the OpenLIT stack:" >&2
	report_compose_output
	exit 6
fi

# Readiness, not Compose's exit code, decides whether the stack is up. A
# Compose attempt can fail while the stack it started is in fact serving —
# that is what an Engine that timed out mid health-gate looks like — and the
# runner's promise is that a successful exit means ClickHouse accepts a
# query and OpenLIT answers HTTP.
echo "==> Waiting for ClickHouse to accept connections"
CLICKHOUSE_READY=0
CLICKHOUSE_DEADLINE=$((SECONDS + CLICKHOUSE_TIMEOUT_SECONDS))
while (( SECONDS < CLICKHOUSE_DEADLINE )); do
	if clickhouse_accepts_query; then
		CLICKHOUSE_READY=1
		break
	fi
	sleep 2
done
if [[ "$CLICKHOUSE_READY" -ne 1 ]]; then
	echo "up.sh: ClickHouse did not accept a query within ${CLICKHOUSE_TIMEOUT_SECONDS} seconds; inspect the openlit-clickhouse container logs" >&2
	report_compose_output
	exit 5
fi

echo "==> Waiting for the OpenLIT HTTP service"
OPENLIT_READY=0
OPENLIT_DEADLINE=$((SECONDS + OPENLIT_TIMEOUT_SECONDS))
while (( SECONDS < OPENLIT_DEADLINE )); do
	if openlit_http_ready; then
		OPENLIT_READY=1
		break
	fi
	sleep 2
done
if [[ "$OPENLIT_READY" -ne 1 ]]; then
	echo "up.sh: OpenLIT did not become HTTP-ready on port ${PORT:-3000} within ${OPENLIT_TIMEOUT_SECONDS} seconds; inspect the openlit container logs" >&2
	report_compose_output
	exit 5
fi

if ! ensure_otel_schema; then
	exit 7
fi

echo "==> Verifying the deployed AutoDev Usage response contract"
AUTODEV_OPENLIT_USAGE_TOKEN="${CONSOLE_USAGE_TOKEN_OVERRIDE:-$AUTODEV_OPENLIT_USAGE_TOKEN}" \
	pnpm --filter @simulatorlife/autodev-runtime openlit:verify-usage

echo "==> Synchronizing rulesync prompts to AutoDev Prompt Hub"
OPENLIT_DB_PASSWORD="$OPENLIT_DB_PASSWORD" pnpm --filter @simulatorlife/autodev-data openlit:sync-prompts || echo "Warning: prompt synchronization failed" >&2

echo "==> Synchronizing rulesync agent roles to AutoDev Agents Hub"
OPENLIT_DB_PASSWORD="$OPENLIT_DB_PASSWORD" pnpm --filter @simulatorlife/autodev-data openlit:sync-agents || echo "Warning: agent synchronization failed" >&2

echo "==> Synchronizing AutoDev provider models & pricing catalog"
pnpm --filter @simulatorlife/autodev-data openlit:sync-models || echo "Warning: model synchronization failed" >&2

echo "==> Synchronizing AutoDev project and workspace architecture"
pnpm --filter @simulatorlife/autodev-data openlit:sync-workspaces || echo "Warning: workspace synchronization failed" >&2

echo "==> OpenLIT HTTP and ClickHouse are ready for the AutoDev Console."
echo "    Image tag:       $IMAGE_TAG"
echo "    Image lock:      $LOCK_FILE"
echo "    Env template:    $ENV_FILE"
echo "    Secret file:     $SECRET_FILE (mode 0600; outside repository)"
echo "    Producer key:    $OTLP_KEY_FILE (mode 0600; outside repository)"
