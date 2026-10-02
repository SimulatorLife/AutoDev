#!/usr/bin/env bash
# Stop the local OpenLIT stack without deleting its durable telemetry volumes.
set -euo pipefail

repo_root="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [[ -z "$repo_root" ]]; then
  echo "down.sh: REPO_ROOT is required (run from the AutoDev repo)" >&2
  exit 1
fi

codex_home="${CODEX_HOME:-${HOME:?HOME must be set}/.codex}"
compose_file="${AUTODEV_OPENLIT_COMPOSE_FILE:-$repo_root/config/openlit/docker-compose.yml}"
env_file="${AUTODEV_OPENLIT_ENV_FILE:-$repo_root/config/openlit/openlit.env}"
secret_file="${AUTODEV_OPENLIT_SECRET_FILE:-$codex_home/openlit-secrets.env}"

if [[ ! -f "$compose_file" || ! -f "$env_file" ]]; then
  echo "down.sh: compose file or env template is missing" >&2
  exit 1
fi
if [[ ! -f "$secret_file" ]]; then
  echo "down.sh: out-of-repository secrets are missing: $secret_file" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "down.sh: docker is required" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  docker compose --env-file "$env_file" -f "$compose_file" down
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose --env-file "$env_file" -f "$compose_file" down
else
  echo "down.sh: docker compose plugin is required" >&2
  exit 1
fi
