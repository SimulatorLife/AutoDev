#!/usr/bin/env bash
# Run the pinned AutoDev OpenTelemetry Collector in the foreground under launchd.
#
# Inputs:
#   AUTODEV_OTELCOL_BIN        explicit path to the otelcol binary (preferred)
#   AUTODEV_OTEL_CONFIG        absolute path to the collector config (defaults to repo fixture)
#   AUTODEV_OTEL_VERSION_FILE  absolute path to the pinned version file (defaults to repo fixture)
#   AUTODEV_OTEL_HOST          collector bind host (default 127.0.0.1)
#   AUTODEV_OTEL_PORT          collector OTLP/HTTP listen port (default 4318)
#
# This script never vendors or installs a binary. It only locates a host-local
# copy, verifies it matches the pinned version, refuses to start on a port
# that is already serving a duplicate, and exec's the binary.
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="${AUTODEV_OTEL_REPO_ROOT:-$script_dir/../../../}"
config_file="${AUTODEV_OTEL_CONFIG:-$repo_root/config/otel/collector.yaml}"
version_file="${AUTODEV_OTEL_VERSION_FILE:-$repo_root/config/otel/collector.version}"
host="${AUTODEV_OTEL_HOST:-127.0.0.1}"
port="${AUTODEV_OTEL_PORT:-4318}"
check_only=0
if [[ "${1:-}" == "--check" ]]; then
  check_only=1
elif [[ "$#" -gt 0 ]]; then
  fail() { printf 'run-autodev-otel-collector: unsupported argument: %s\n' "$1" >&2; exit 2; }
  fail "$1"
fi

fail() { printf 'run-autodev-otel-collector: %s\n' "$*" >&2; exit 1; }

resolve_binary() {
  if [[ -n "${AUTODEV_OTELCOL_BIN:-}" ]]; then
    local explicit
    explicit="$AUTODEV_OTELCOL_BIN"
    [[ -x "$explicit" && -f "$explicit" ]] || return 1
    printf '%s\n' "$explicit"
    return 0
  fi
  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  local candidate
  for candidate in \
      "$codex_home/otelcol" \
      "$codex_home/otelcol/otelcol" \
      "$codex_home/bin/otelcol"; do
    if [[ -x "$candidate" && -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if command -v otelcol >/dev/null 2>&1; then
    command -v otelcol
    return 0
  fi
  return 1
}

# Cheap TCP probe that does not assume GNU netcat. Background nc with SIGALRM
# stays portable across BSD and GNU nc implementations.
port_busy() {
  command -v nc >/dev/null 2>&1 || return 1
  local status
  (
    trap 'exit 124' ALRM
    nc -z "$host" "$port" </dev/null >/dev/null 2>&1 &
    local nc_pid=$!
    ( sleep 1; kill -ALRM $$ 2>/dev/null ) &
    wait $nc_pid
    status=$?
    pkill -P $$ 2>/dev/null || true
    exit $status
  ) >/dev/null 2>&1
}

# Ensure the config + version fixtures exist and point at the exact pinned build.
[[ -f "$config_file" ]] || fail "collector config is missing: $config_file"
[[ -f "$version_file" ]] || fail "collector version file is missing: $version_file"
expected_version="$(tr -d '[:space:]' <"$version_file")"
[[ "$expected_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || \
  fail "collector.version is not a well-formed pinned version: '$expected_version'"

binary="$(resolve_binary || true)"
[[ -n "$binary" ]] || fail \
  "could not locate an executable otelcol; set AUTODEV_OTELCOL_BIN or install one under CODEX_HOME"

version_output="$("$binary" --version 2>&1)" || fail "collector --version failed"
extracted_version="$(printf '%s' "$version_output" | tr -d '\r' | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?' | head -n 1 || true)"
[[ "$extracted_version" == v* ]] || extracted_version="v$extracted_version"
if [[ "$extracted_version" != "$expected_version" ]]; then
  printf '%s\n' "$version_output" >&2
  fail "collector version mismatch: expected $expected_version"
fi

# Refuse to start over a port already serving a duplicate Collector or any other
# listener. Launchd would otherwise restart this script in a tight loop because
# the new process could not bind, masking the real cause.
probe_url="http://${host}:${port}/"
if (( check_only == 0 )) && command -v curl >/dev/null 2>&1; then
  http_code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 1 "$probe_url" 2>/dev/null || echo 000)"
  if [[ "$http_code" =~ ^[1-5][0-9][0-9]$ ]]; then
    fail "port ${host}:${port} already serving HTTP ($http_code); refusing to start a duplicate Collector"
  fi
fi
if (( check_only == 0 )) && port_busy; then
  fail "port ${host}:${port} is already in use by another process"
fi

# `otelcol validate` catches fixture/binary drift at boot. A non-zero exit means
# the fixture is out of sync with the installed binary and we must surface that
# instead of exec'ing on top of it.
if ! "$binary" validate --config "$config_file" >/dev/null 2>&1; then
  fail "collector fixture failed validation: $config_file"
fi

if (( check_only == 1 )); then
  printf 'ok Collector %s (%s) validates %s\n' "$expected_version" "$binary" "$config_file"
  exit 0
fi

cd /
exec "$binary" --config "$config_file"
