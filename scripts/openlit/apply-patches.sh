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
UPSTREAM_URL="https://github.com/openlit/openlit.git"
DEFAULT_CODEX_HOME="${CODEX_HOME:-${HOME:-/tmp}/.codex}"
GIT_CACHE="${AUTODEV_OPENLIT_GIT_CACHE:-$DEFAULT_CODEX_HOME/cache/openlit-upstream.git}"

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

ensure_git_cache() {
	if git --git-dir="$GIT_CACHE" cat-file -e "${PINNED_COMMIT}^{commit}" 2>/dev/null; then
		return 0
	fi
	mkdir -p "$(dirname "$GIT_CACHE")" 2>/dev/null || return 1
	if [[ ! -d "$GIT_CACHE" ]]; then
		local cache_tmp="${GIT_CACHE}.tmp.$$"
		rm -rf "$cache_tmp" 2>/dev/null || true
		if ! git init --bare --quiet "$cache_tmp" 2>/dev/null; then
			rm -rf "$cache_tmp" 2>/dev/null || true
			return 1
		fi
		if ! git --git-dir="$cache_tmp" fetch --depth=1 --quiet "$UPSTREAM_URL" "$PINNED_COMMIT" 2>/dev/null; then
			rm -rf "$cache_tmp" 2>/dev/null || true
			return 1
		fi
		git --git-dir="$cache_tmp" update-ref "refs/pinned/${PINNED_COMMIT}" FETCH_HEAD 2>/dev/null || true
		if ! mv "$cache_tmp" "$GIT_CACHE" 2>/dev/null; then
			rm -rf "$cache_tmp" 2>/dev/null || true
		fi
	fi
	if ! git --git-dir="$GIT_CACHE" cat-file -e "${PINNED_COMMIT}^{commit}" 2>/dev/null; then
		git --git-dir="$GIT_CACHE" fetch --depth=1 --quiet "$UPSTREAM_URL" "$PINNED_COMMIT" 2>/dev/null || return 1
		git --git-dir="$GIT_CACHE" update-ref "refs/pinned/${PINNED_COMMIT}" FETCH_HEAD 2>/dev/null || true
	fi
	git --git-dir="$GIT_CACHE" cat-file -e "${PINNED_COMMIT}^{commit}" 2>/dev/null
}

checked_out_from_cache=0
if ensure_git_cache; then
	if git init --quiet "$WORK_DIR"; then
		if [[ -f "$GIT_CACHE/shallow" ]]; then
			cp "$GIT_CACHE/shallow" "$WORK_DIR/.git/shallow"
		fi
		ABS_GIT_CACHE="$(cd "$GIT_CACHE" && pwd)"
		printf '%s/objects\n' "$ABS_GIT_CACHE" > "$WORK_DIR/.git/objects/info/alternates"
		if git -C "$WORK_DIR" checkout --quiet -b autodev-patches "$PINNED_COMMIT" 2>/dev/null; then
			checked_out_from_cache=1
		else
			rm -rf "$WORK_DIR"
			mkdir -p "$(dirname "$WORK_DIR")"
		fi
	fi
fi

if [[ "$checked_out_from_cache" -eq 0 ]]; then
	if ! git init --quiet "$WORK_DIR" ||
		! git -C "$WORK_DIR" fetch --depth=1 --quiet "$UPSTREAM_URL" "$PINNED_COMMIT"; then
		echo "apply-patches.sh: pinned OpenLIT clone failed" >&2
		exit 2
	fi
	if ! git -C "$WORK_DIR" checkout --quiet -b autodev-patches FETCH_HEAD; then
		echo "apply-patches.sh: pinned commit $PINNED_COMMIT could not be checked out" >&2
		exit 2
	fi
fi

pushd "$WORK_DIR" >/dev/null
ACTUAL_COMMIT="$(git rev-parse HEAD)"
if [[ "$ACTUAL_COMMIT" != "$PINNED_COMMIT" ]]; then
	echo "apply-patches.sh: HEAD is $ACTUAL_COMMIT, expected $PINNED_COMMIT" >&2
	exit 2
fi

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
	if ! git apply "$patch"; then
		echo "apply-patches.sh: $patch failed git apply" >&2
		exit 3
	fi
done
echo "==> Patch set applied to fresh pinned worktree $WORK_DIR"
git status --short | sed -n '1,30p'
popd >/dev/null

# Give unchanged files deterministic content-derived timestamps so Docker BuildKit
# and Next.js incremental caches stay warm across fresh temporary checkouts.
if command -v node >/dev/null 2>&1 && [[ -d "$WORK_DIR/src" ]]; then
	node --input-type=commonjs - "$WORK_DIR/src" <<'EOF'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile()) {
      const digest = crypto.createHash("sha256").update(fs.readFileSync(full)).digest();
      const ts = 1_577_836_800 + (digest.readUInt32BE(0) % 100_000_000);
      fs.utimesSync(full, ts, ts);
    }
  }
};
walk(root);
EOF
fi
