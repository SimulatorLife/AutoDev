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

if [[ ! -d "$REPO_ROOT/patches/openlit" || ! -f "$COMPOSE_FILE" || ! -f "$ENV_FILE" ]]; then
	echo "up.sh: patch directory, compose file, or env template is missing" >&2
	exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
	echo "up.sh: docker is required" >&2
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

# Generate three random secrets in an out-of-repository CODEX_HOME file;
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
echo "==> Starting the patched OpenLIT stack with authenticated OTLP"
"${DOCKER_COMPOSE[@]}" \
	--env-file "$ENV_FILE" \
	-f "$COMPOSE_FILE" \
	up -d

echo "==> Waiting for ClickHouse to accept connections"
for _ in {1..30}; do
	if "${DOCKER_COMPOSE[@]}" -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client --user="${OPENLIT_DB_USER:-default}" --password="$OPENLIT_DB_PASSWORD" --query="SELECT 1" >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

echo "==> Synchronizing rulesync prompts to OpenLIT Prompt Hub"
OPENLIT_DB_PASSWORD="$OPENLIT_DB_PASSWORD" node "$REPO_ROOT/src/platform/sync-rulesync-prompts.ts" || echo "Warning: prompt synchronization failed" >&2

echo "==> Synchronizing rulesync agent roles to OpenLIT Agents Hub"
OPENLIT_DB_PASSWORD="$OPENLIT_DB_PASSWORD" node "$REPO_ROOT/src/platform/sync-rulesync-agents.ts" || echo "Warning: agent synchronization failed" >&2

echo "==> Synchronizing AutoDev provider models & pricing catalog to OpenLIT"
node "$REPO_ROOT/src/platform/sync-rulesync-models.ts" || echo "Warning: model synchronization failed" >&2

echo "==> Synchronizing AutoDev project and workspace architecture in OpenLIT"
node "$REPO_ROOT/src/platform/sync-rulesync-workspaces.ts" || echo "Warning: workspace synchronization failed" >&2

echo "==> OpenLIT stack started (container build/runtime still requires acceptance probes)."
echo "    Image tag:       $IMAGE_TAG"
echo "    Image lock:      $LOCK_FILE"
echo "    Env template:    $ENV_FILE"
echo "    Secret file:     $SECRET_FILE (mode 0600; outside repository)"
echo "    Producer key:    $OTLP_KEY_FILE (mode 0600; outside repository)"
