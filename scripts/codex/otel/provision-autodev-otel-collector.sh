#!/usr/bin/env bash
# Provision the pinned OpenTelemetry Collector binary into CODEX_HOME.
# The binary is machine-local and never becomes a repository artifact.
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="${AUTODEV_OTEL_REPO_ROOT:-$script_dir/../../../}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
artifact_file="${AUTODEV_OTEL_ARTIFACTS:-$repo_root/config/otel/collector-artifacts.json}"
version_file="${AUTODEV_OTEL_VERSION_FILE:-$repo_root/config/otel/collector.version}"
target="${AUTODEV_OTELCOL_TARGET:-$codex_home/otelcol}"

fail() { printf 'provision-autodev-otel-collector: %s\n' "$*" >&2; exit 1; }

[[ -f "$artifact_file" ]] || fail "artifact manifest is missing: $artifact_file"
[[ -f "$version_file" ]] || fail "collector version file is missing: $version_file"
version="$(tr -d '[:space:]' <"$version_file")"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid pinned Collector version: $version"

if [[ -n "${AUTODEV_OTELCOL_BIN:-}" ]]; then
  [[ -x "$AUTODEV_OTELCOL_BIN" && -f "$AUTODEV_OTELCOL_BIN" ]] || fail "AUTODEV_OTELCOL_BIN is not executable: $AUTODEV_OTELCOL_BIN"
  exit 0
fi

if [[ -x "$target" && -f "$target" ]]; then
  exit 0
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=amd64 ;;
  *) fail "unsupported host architecture: $arch" ;;
esac
case "$os" in
  darwin|linux) ;;
  *) fail "unsupported host operating system: $os" ;;
esac
platform="$os/$arch"
read -r asset checksum <<EOF_MANIFEST
$(python3 - "$artifact_file" "$version" "$platform" <<'PY'
import json, sys
path, version, platform = sys.argv[1:]
data = json.load(open(path, encoding="utf-8"))
if data.get("version") != version:
    raise SystemExit(f"manifest version {data.get('version')!r} does not match pinned {version!r}")
entry = data.get("assets", {}).get(platform)
if not entry:
    raise SystemExit(f"no Collector artifact is pinned for {platform}")
print(entry["name"], entry["sha256"])
PY
)
EOF_MANIFEST

base_url="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/${version}"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/autodev-otelcol.XXXXXX")"
trap 'rm -rf -- "$temporary_dir"' EXIT
archive="$temporary_dir/$asset"
command -v curl >/dev/null 2>&1 || fail "curl is required to provision the pinned Collector"
curl --fail --location --retry 3 --silent --show-error "$base_url/$asset" -o "$archive"
if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$archive" | awk '{print $1}')"
else
  fail "shasum or sha256sum is required to verify the Collector artifact"
fi
[[ "$actual" == "$checksum" ]] || fail "Collector checksum mismatch for $asset"

mkdir -p -- "$(dirname -- "$target")"
extract_dir="$temporary_dir/extracted"
mkdir -p -- "$extract_dir"
tar -xzf "$archive" -C "$extract_dir"
extracted="$(find "$extract_dir" -type f -name otelcol -perm -u+x -print -quit)"
[[ -n "$extracted" ]] || fail "Collector archive did not contain an executable otelcol"
install -m 0700 "$extracted" "$target"
printf 'provisioned %s Collector at %s\n' "$version" "$target"
