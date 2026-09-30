#!/usr/bin/env bash
# Synchronize canonical SimulatorLife/AutoDev project and rulesync workspace architecture in OpenLIT (Prisma / SQLite).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
if [[ -z "$REPO_ROOT" ]]; then
	echo "sync-workspaces.sh: REPO_ROOT is required (run from the AutoDev repo)" >&2
	exit 1
fi

node "$REPO_ROOT/src/platform/sync-rulesync-workspaces.ts"
