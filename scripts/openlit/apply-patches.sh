#!/usr/bin/env bash
# Apply the AutoDev patches to an empty checkout of the pinned OpenLIT source.
# Existing worktrees are never reset or cleaned: use a fresh scratch path.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
if [[ -z "$REPO_ROOT" ]]; then
	echo "apply-patches.sh: REPO_ROOT is required (run from the AutoDev repo)" >&2
	exit 1
fi

PINNED_COMMIT="${AUTODEV_OPENLIT_PINNED_COMMIT:-9938c66638666ca5d3bcb850350faa82e510924b}"
PATCHES_DIR="${AUTODEV_OPENLIT_PATCHES_DIR:-$REPO_ROOT/patches/openlit}"
WORK_DIR="${AUTODEV_OPENLIT_WORK_DIR:-$REPO_ROOT/.tmp/openlit-build}"

if [[ ! -d "$PATCHES_DIR" ]]; then
	echo "apply-patches.sh: patch directory not found: $PATCHES_DIR" >&2
	exit 1
fi
if [[ -L "$WORK_DIR" ]]; then
	echo "apply-patches.sh: refusing symlinked work directory: $WORK_DIR" >&2
	exit 1
fi
if [[ -d "$WORK_DIR" ]] && [[ -n "$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
	echo "apply-patches.sh: refusing to reset or clean non-empty work directory: $WORK_DIR" >&2
	exit 1
fi
mkdir -p "$(dirname "$WORK_DIR")"

if ! git clone --filter=blob:none --no-checkout \
	"https://github.com/openlit/openlit.git" "$WORK_DIR"; then
	echo "apply-patches.sh: pinned OpenLIT clone failed" >&2
	exit 2
fi
pushd "$WORK_DIR" >/dev/null
if ! git checkout --quiet "$PINNED_COMMIT"; then
	echo "apply-patches.sh: pinned commit $PINNED_COMMIT could not be checked out" >&2
	exit 2
fi
ACTUAL_COMMIT="$(git rev-parse HEAD)"
if [[ "$ACTUAL_COMMIT" != "$PINNED_COMMIT" ]]; then
	echo "apply-patches.sh: HEAD is $ACTUAL_COMMIT, expected $PINNED_COMMIT" >&2
	exit 2
fi
git checkout --quiet -b autodev-patches "$PINNED_COMMIT"

shopt -s nullglob
PATCH_FILES=("$PATCHES_DIR"/*.patch)
shopt -u nullglob
if [[ ${#PATCH_FILES[@]} -eq 0 ]]; then
	echo "apply-patches.sh: no *.patch files found in $PATCHES_DIR" >&2
	exit 1
fi

echo "==> Applying ${#PATCH_FILES[@]} patches in order against $PINNED_COMMIT"
for patch in "${PATCH_FILES[@]}"; do
	echo "    - $(basename "$patch")"
	if ! git apply --check "$patch"; then
		echo "apply-patches.sh: $patch failed git apply --check" >&2
		exit 3
	fi
	git apply "$patch"
done
echo "==> Patch set applied to fresh pinned worktree $WORK_DIR"
git status --short | head -30
popd >/dev/null
