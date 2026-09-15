#!/usr/bin/env bash
# Ensure exactly one pinned AutoDev OpenTelemetry Collector is serving locally.
#
# This hook is intentionally idempotent: Codex command hooks and the launchd
# job both call it on every startup. The hook never starts a second unmanaged
# copy beside launchd, never adopts an unrelated process by pid alone, never
# keeps pid files or logs in the user's shell-visible working directory, and
# never blames a duplicate Collector on a port conflict.
#
# State lives under $CODEX_HOME/run with mode 0700 so the Collector logs and
# probe artifacts stay private to the user.
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runner="${AUTODEV_OTEL_RUNNER:-$script_dir/run-autodev-otel-collector.sh}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
host="${AUTODEV_OTEL_HOST:-127.0.0.1}"
port="${AUTODEV_OTEL_PORT:-4318}"
run_dir="${AUTODEV_OTEL_RUN_DIR:-$codex_home/run}"
pid_file="$run_dir/autodev-otel-collector.pid"
ensure_log="${AUTODEV_OTEL_LOG:-$run_dir/autodev-otel-collector.ensure.log}"
start_timeout="${AUTODEV_OTEL_START_TIMEOUT:-10}"
check_only=0
if [[ "${1:-}" == "--check" ]]; then
  check_only=1
elif [[ "$#" -gt 0 ]]; then
  fail() { printf 'ensure-autodev-otel-collector: unsupported argument: %s\n' "$1" >&2; exit 2; }
  fail "$1"
fi

fail() { printf 'ensure-autodev-otel-collector: %s\n' "$*" >&2; exit 1; }

if (( check_only == 1 )); then
  exec /bin/bash "$runner" --check
fi

probe_ready() {
  command -v curl >/dev/null 2>&1 || return 1
  local code
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 1 "http://${host}:${port}/" 2>/dev/null || echo 000)"
  [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]
}

# Cheap TCP probe that does not rely on GNU-only nc flags. Background nc with
# a SIGALRM timeout stays portable across BSD and GNU netcat.
port_busy_not_http() {
  command -v nc >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || return 1
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
  status=$?
  [[ $status -eq 0 ]] && ! probe_ready
}

if probe_ready; then exit 0; fi
if port_busy_not_http; then fail "port ${host}:${port} is in use by a non-HTTP process"; fi
[[ -x "$runner" ]] || fail "collector runner is missing or not executable: $runner"

mkdir -p "$run_dir"
chmod 700 "$run_dir" || true

rm -f -- "$pid_file"

trap 'rm -f -- "$pid_file"' EXIT INT TERM

nohup /bin/bash "$runner" >>"$ensure_log" 2>&1 </dev/null &
runner_pid=$!
printf '%s\n' "$runner_pid" >"$pid_file"

end=$((SECONDS + start_timeout))
while (( SECONDS < end )); do
  if probe_ready; then exit 0; fi
  if ! kill -0 "$runner_pid" 2>/dev/null; then
    tail -n 5 "$ensure_log" >&2 2>/dev/null || true
    fail "collector exited before becoming ready"
  fi
  sleep 0.1
done

kill "$runner_pid" 2>/dev/null || true
wait "$runner_pid" 2>/dev/null || true
tail -n 5 "$ensure_log" >&2 2>/dev/null || true
fail "collector did not become ready within ${start_timeout}s"
