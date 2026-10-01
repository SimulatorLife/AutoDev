#!/usr/bin/env bash
# Synchronize AutoDev model catalogs, providers, and pricing into OpenLIT (ClickHouse).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
if [[ -z "$REPO_ROOT" ]]; then
	echo "sync-models.sh: REPO_ROOT is required (run from the AutoDev repo)" >&2
	exit 1
fi

CODEX_HOME="${CODEX_HOME:-${HOME:?HOME must be set}/.codex}"
SECRET_FILE="${AUTODEV_OPENLIT_SECRET_FILE:-$CODEX_HOME/openlit-secrets.env}"

if [[ -f "$SECRET_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$SECRET_FILE"
	set +a
fi

node "$REPO_ROOT/src/platform/sync-rulesync-models.ts"
