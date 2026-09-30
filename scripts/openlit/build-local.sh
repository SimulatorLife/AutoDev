#!/usr/bin/env bash
#
# Build a local OpenLIT image from the pinned source with the AutoDev patch
# set applied. Intended for offline / air-gapped use and for verifying that
# the patch set still produces a buildable tree.
#
# The image is tagged by `upstream_commit + patch_set_hash` so re-applies of
# the same patch set on the same upstream commit always yield the same tag
# (and therefore the same digest). The Docker-built image id/digest is
# recorded in the CODEX_HOME lock file passed in via
# `AUTODEV_OPENLIT_LOCK_FILE` so the compose stack can pin the patched
# image by digest instead of by tag.
#
# Inputs:
#   AUTODEV_OPENLIT_PINNED_COMMIT  commit to verify against (default pinned)
#   AUTODEV_OPENLIT_WORK_DIR       worktree used for the patch run
#   AUTODEV_OPENLIT_IMAGE_TAG      image tag override (default commit+patch hash)
#   AUTODEV_OPENLIT_LOCK_FILE      path to the lock file written by this script
#                                  (default $CODEX_HOME/openlit-patched.lock or
#                                  $REPO_ROOT/.tmp/openlit-patched.lock)
#
# Exit codes:
#   0  image built and verified
#   1  invalid invocation / missing tool
#   2  apply-patches.sh failed
#   3  build failed
#   4  lock file write failed

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
if [[ -z "$REPO_ROOT" ]]; then
	echo "build-local.sh: REPO_ROOT is required" >&2
	exit 1
fi

PINNED_COMMIT="${AUTODEV_OPENLIT_PINNED_COMMIT:-9938c66638666ca5d3bcb850350faa82e510924b}"
CODEX_HOME="${CODEX_HOME:-${HOME:?HOME must be set}/.codex}"
LOCK_FILE="${AUTODEV_OPENLIT_LOCK_FILE:-$CODEX_HOME/openlit-patched.lock}"
PATCHES_DIR="${AUTODEV_OPENLIT_PATCHES_DIR:-$REPO_ROOT/patches/openlit}"
CREATED_WORK_DIR=0
if [[ -n "${AUTODEV_OPENLIT_WORK_DIR:-}" ]]; then
	WORK_DIR="$AUTODEV_OPENLIT_WORK_DIR"
else
	WORK_DIR="$(mktemp -d -t autodev-openlit-build.XXXXXX)"
	CREATED_WORK_DIR=1
fi
export AUTODEV_OPENLIT_WORK_DIR="$WORK_DIR"

cleanup_build_work_dir() {
	local rc=$?
	if [[ "$CREATED_WORK_DIR" -eq 1 && -d "$WORK_DIR" ]]; then
		rm -rf "$WORK_DIR"
	fi
	exit "$rc"
}
if [[ "$CREATED_WORK_DIR" -eq 1 ]]; then
	trap cleanup_build_work_dir EXIT INT TERM
fi

if ! command -v docker >/dev/null 2>&1; then
	echo "build-local.sh: docker is required" >&2
	exit 1
fi

# The pinned OpenLIT Dockerfile defaults its embedded Collector download to
# amd64. Select an explicit native target and pass it through to every stage
# so an arm64 OpenLIT image cannot contain an x86_64 otelcol binary (or vice
# versa).
DOCKER_PLATFORM="$(docker info --format '{{.OSType}}/{{.Architecture}}' 2>/dev/null || true)"
case "$DOCKER_PLATFORM" in
	linux/arm64 | linux/aarch64) TARGET_ARCH="arm64" ;;
	linux/amd64 | linux/x86_64) TARGET_ARCH="amd64" ;;
	*)
		echo "build-local.sh: unsupported Docker platform: ${DOCKER_PLATFORM:-unknown}" >&2
		exit 1
		;;
esac
echo "==> Docker target platform = linux/$TARGET_ARCH"

if [[ ! -d "$PATCHES_DIR" ]]; then
	echo "build-local.sh: patch directory not found: $PATCHES_DIR" >&2
	exit 1
fi

# Compute a stable hash of every patch in sorted order so the tag changes
# iff the patch set changes.
shopt -s nullglob
PATCH_FILES=("$PATCHES_DIR"/*.patch)
shopt -u nullglob
if [[ ${#PATCH_FILES[@]} -eq 0 ]]; then
	echo "build-local.sh: no *.patch files in $PATCHES_DIR" >&2
	exit 1
fi
PATCH_SET_HASH="$(cat "${PATCH_FILES[@]}" | shasum -a 256)"
PATCH_SET_HASH="${PATCH_SET_HASH%% *}"
PATCH_SET_HASH="${PATCH_SET_HASH:0:16}"
COMMIT_SHORT="$(echo "$PINNED_COMMIT" | cut -c1-12)"
AUTODEV_OPENLIT_IMAGE_TAG="${AUTODEV_OPENLIT_IMAGE_TAG:-autodev-openlit:openlit-${COMMIT_SHORT}-p${PATCH_SET_HASH}}"
export AUTODEV_OPENLIT_IMAGE_TAG
echo "==> tag = $AUTODEV_OPENLIT_IMAGE_TAG"

if ! command -v "$REPO_ROOT/scripts/openlit/apply-patches.sh" >/dev/null 2>&1; then
	echo "build-local.sh: apply-patches.sh not executable" >&2
	exit 1
fi

# Apply the patch set to an empty workdir. apply-patches.sh refuses to reset
# or clean an existing worktree, even when it is at the pinned commit.
"$REPO_ROOT/scripts/openlit/apply-patches.sh"

# Build the first-party receiver plus the local UI/control/auth patch set.
DOCKER_BUILDKIT=1 docker build \
	--platform "linux/$TARGET_ARCH" \
	--build-arg "TARGETARCH=$TARGET_ARCH" \
	--build-arg DOCKER_PORT=3000 \
	-t "$AUTODEV_OPENLIT_IMAGE_TAG" \
	-t "autodev-openlit:openlit-${COMMIT_SHORT}-patched" \
	-f "$WORK_DIR/src/Dockerfile" \
	"$WORK_DIR/src"

# Record the built image id and digest in the lock file so the compose
# stack can pin the patched image by digest (immutable ref). The lock file
# lives outside the repo (CODEX_HOME) so it is never accidentally committed.
mkdir -p "$(dirname "$LOCK_FILE")" 2>/dev/null || true
if ! IMAGE_ID="$(docker inspect --format='{{.Id}}' "$AUTODEV_OPENLIT_IMAGE_TAG" 2>/dev/null)"; then
	echo "build-local.sh: built image could not be inspected" >&2
	exit 4
fi
if [[ ! "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]; then
	echo "build-local.sh: Docker returned an invalid image ID" >&2
	exit 4
fi
# Resolve a registry digest if present; otherwise the immutable local image ID
# is the recorded build digest until an explicit push provides RepoDigests.
if ! REPO_DIGESTS="$(docker inspect --format='{{range .RepoDigests}}{{println .}}{{end}}' "$AUTODEV_OPENLIT_IMAGE_TAG" 2>/dev/null)"; then
	echo "build-local.sh: built image digest could not be inspected" >&2
	exit 4
fi
DIGEST="${REPO_DIGESTS%%$'\n'*}"
if [[ "$DIGEST" == *@* ]]; then DIGEST="${DIGEST##*@}"; fi
if [[ -z "$DIGEST" ]]; then DIGEST="$IMAGE_ID"; fi
if ! cat > "$LOCK_FILE" <<LOCK
# AutoDev patched OpenLIT image lock
# Generated by scripts/openlit/build-local.sh — do not edit by hand.
AUTODEV_OPENLIT_PINNED_COMMIT=$PINNED_COMMIT
AUTODEV_OPENLIT_PATCH_SET_HASH=$PATCH_SET_HASH
AUTODEV_OPENLIT_IMAGE_TAG=$AUTODEV_OPENLIT_IMAGE_TAG
AUTODEV_OPENLIT_IMAGE_ID=$IMAGE_ID
AUTODEV_OPENLIT_IMAGE_DIGEST=$DIGEST
AUTODEV_OPENLIT_IMAGE_LOCK_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOCK
then
	echo "build-local.sh: failed to write lock file: $LOCK_FILE" >&2
	exit 4
fi
chmod 0600 "$LOCK_FILE" 2>/dev/null || true

echo "==> Built image: $AUTODEV_OPENLIT_IMAGE_TAG"
echo "==> Image id:     $IMAGE_ID"
echo "==> Image digest: $DIGEST"
echo "==> Lock:         $LOCK_FILE"

docker images --format "table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}" "$AUTODEV_OPENLIT_IMAGE_TAG"
