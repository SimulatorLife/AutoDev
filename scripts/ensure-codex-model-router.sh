#!/usr/bin/env bash
# Ensure the Codex model router is healthy. launchd owns the router whenever
# its user LaunchAgent is available; the direct process is a deliberately
# bounded fallback for environments where launchd cannot be reached.

set -euo pipefail
umask 077

router_host="${CODEX_MODEL_ROUTER_HOST:-127.0.0.1}"
router_port="${CODEX_MODEL_ROUTER_PORT:-4100}"
router_url="http://${router_host}:${router_port}"
liveness_probe="${router_url}/health/liveliness"

codex_home="${CODEX_HOME:-$HOME/.codex}"
run_dir="${CODEX_MODEL_ROUTER_RUN_DIR:-$codex_home/run}"
launchd_run_dir="$codex_home/run"
fallback_log="${CODEX_MODEL_ROUTER_FALLBACK_LOG:-$run_dir/codex-model-router.fallback.log}"
fallback_pid_file="${CODEX_MODEL_ROUTER_FALLBACK_PID_FILE:-$run_dir/codex-model-router.fallback.pid}"
ensure_lock="${CODEX_MODEL_ROUTER_ENSURE_LOCK:-$run_dir/codex-model-router.ensure.lock}"
lock_dir="${ensure_lock}.d"
lock_owner=""

launcher="$codex_home/hooks/run-codex-model-router.sh"

label="com.codex.model-router"
domain="gui/$(id -u)"
plist_link="$HOME/Library/LaunchAgents/${label}.plist"

probe_ok() {
  curl --silent --fail --max-time 1 "$liveness_probe" >/dev/null 2>&1
}

# Bounded exponential polling: 50ms, 100ms, 200ms, ... capped at 1s.
# BSD date (the supported macOS runtime) has no %N nanosecond formatter, so
# use a whole-second deadline and round the millisecond budget up.
wait_for_probe() {
  local budget_ms="${CODEX_MODEL_ROUTER_READY_TIMEOUT_MS:-5000}"
  [[ "$budget_ms" =~ ^[0-9]+$ ]] || {
    echo "Codex model router: CODEX_MODEL_ROUTER_READY_TIMEOUT_MS must be a non-negative integer." >&2
    return 1
  }
  local budget_seconds=$(( (budget_ms + 999) / 1000 ))
  local sleep_ms=50
  local cap_ms=1000
  local deadline=$(( $(date +%s) + budget_seconds ))
  while :; do
    if probe_ok; then return 0; fi
    if (( $(date +%s) >= deadline )); then return 1; fi
    sleep "$(awk -v ms="$sleep_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
    sleep_ms=$(( sleep_ms * 2 ))
    if (( sleep_ms > cap_ms )); then sleep_ms=$cap_ms; fi
  done
}

cleanup_lock() {
  if [[ -n "$lock_owner" && "$lock_owner" == "$$" ]]; then
    rm -f "$lock_dir/pid"
    rmdir "$lock_dir" 2>/dev/null || true
  fi
}

secure_log_file() {
  local path="$1"
  if [[ -L "$path" ]]; then
    echo "Codex model router: refusing to use symlinked log path: $path" >&2
    return 1
  fi
  if [[ ! -e "$path" ]]; then
    (umask 077; : >"$path")
  fi
  chmod 0600 "$path"
}

secure_launchd_logs() {
  secure_log_file "$launchd_run_dir/codex-model-router.launchd.out.log"
  secure_log_file "$launchd_run_dir/codex-model-router.launchd.err.log"
}

# mkdir is atomic on macOS and is available without installing GNU flock.
# The PID marker permits recovery from a SIGKILL without deleting a live lock.
acquire_lock() {
  mkdir -p -- "$run_dir" "$launchd_run_dir" "$(dirname "$ensure_lock")"
  chmod 0700 "$run_dir" "$launchd_run_dir"
  secure_launchd_logs

  if mkdir "$lock_dir" 2>/dev/null; then
    chmod 0700 "$lock_dir"
    printf '%s\n' "$$" >"$lock_dir/pid"
    chmod 0600 "$lock_dir/pid"
    lock_owner="$$"
    trap cleanup_lock EXIT
    return 0
  fi

  local owner=""
  [[ -r "$lock_dir/pid" ]] && owner="$(<"$lock_dir/pid")"
  if [[ "$owner" =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
    # Rename first so two contenders cannot both remove a newly acquired lock.
    local stale_dir="${lock_dir}.stale.$$"
    if mv "$lock_dir" "$stale_dir" 2>/dev/null; then
      rm -f "$stale_dir/pid"
      rmdir "$stale_dir" 2>/dev/null || true
      if mkdir "$lock_dir" 2>/dev/null; then
        chmod 0700 "$lock_dir"
        printf '%s\n' "$$" >"$lock_dir/pid"
        chmod 0600 "$lock_dir/pid"
        lock_owner="$$"
        trap cleanup_lock EXIT
        return 0
      fi
    fi
  fi

  echo "Codex model router: another ensure invocation is in progress (lock held at $lock_dir)." >&2
  return 1
}

launchd_job_loaded() {
  command -v launchctl >/dev/null 2>&1 || return 1
  launchctl print "$domain/$label" >/dev/null 2>&1
}

launchd_pid() {
  launchctl print "$domain/$label" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }'
}

listener_pid() {
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -a -iTCP:"$router_port" -sTCP:LISTEN -t 2>/dev/null | head -n 1
}

# A healthy port is not enough to prove launchd owns it: an old unmanaged
# router can keep serving while a launchd job repeatedly fails with EADDRINUSE.
# Require both the launchd child PID and the actual listening PID to match.
launchd_owns_listener() {
  local owner listener
  owner="$(launchd_pid)"
  listener="$(listener_pid || true)"
  [[ "$owner" =~ ^[0-9]+$ && "$listener" =~ ^[0-9]+$ && "$owner" == "$listener" ]]
}

# Return codes: 0 means launchd is healthy; 1 means launchd is the owner but
# failed to become healthy or a loaded job does not own a healthy port; 2 means
# launchd is unavailable and fallback may be attempted. A healthy port with no
# verified launchd owner is deliberately left for the fallback ownership check,
# which refuses to create a duplicate.
ensure_via_launchd() {
  command -v launchctl >/dev/null 2>&1 || return 2

  if launchd_job_loaded; then
    launchctl enable "$domain/$label" >/dev/null 2>&1 || true
    if probe_ok; then
      launchd_owns_listener && return 0
      echo "Codex model router: launchd job $label is loaded but does not own the healthy listener; refusing to restart or duplicate it." >&2
      return 1
    fi
    launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || return 1
    if wait_for_probe && launchd_owns_listener; then return 0; fi
    return 1
  fi

  # Never bootstrap a launchd job over an already healthy, untracked process.
  # The fallback path will report that ownership conflict instead.
  if probe_ok; then return 2; fi

  if [[ -f "$plist_link" ]] && launchctl bootstrap "$domain" "$plist_link" >/dev/null 2>&1; then
    launchctl enable "$domain/$label" >/dev/null 2>&1 || true
    launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || return 1
    if wait_for_probe && launchd_owns_listener; then return 0; fi
    return 1
  fi
  return 2
}

fallback_pid_is_owned() {
  local pid="$1"
  local command_line
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command_line" == *"run-codex-model-router.sh"* || "$command_line" == *"codex-model-router.mjs"* ]]
}

rotate_fallback_log_if_needed() {
  [[ -f "$fallback_log" ]] || return 0
  local size
  size="$(wc -c <"$fallback_log" | tr -d '[:space:]')"
  if [[ "$size" =~ ^[0-9]+$ ]] && (( size > 10 * 1024 * 1024 )); then
    mv -f "$fallback_log" "${fallback_log}.1"
  fi
}

# Return codes: 0 means healthy tracked fallback; 2 means startup failure;
# 3 means a different process already owns the healthy port.
ensure_via_fallback() {
  mkdir -p -- "$run_dir"
  chmod 0700 "$run_dir"
  [[ -x "$launcher" ]] || {
    echo "Codex model router: launcher is missing or not executable: $launcher" >&2
    return 2
  }

  if [[ -f "$fallback_pid_file" ]]; then
    local existing_pid
    existing_pid="$(<"$fallback_pid_file" 2>/dev/null || true)"
    if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
      if fallback_pid_is_owned "$existing_pid"; then
        if probe_ok; then return 0; fi
        kill "$existing_pid" 2>/dev/null || true
        for _ in {1..50}; do
          kill -0 "$existing_pid" 2>/dev/null || break
          sleep 0.1
        done
        if kill -0 "$existing_pid" 2>/dev/null; then
          kill -KILL "$existing_pid" 2>/dev/null || true
        fi
      fi
      # Do not kill a PID that has been reused by an unrelated process.
      rm -f "$fallback_pid_file"
    else
      rm -f "$fallback_pid_file"
    fi
  fi

  if probe_ok; then
    echo "Codex model router: ${router_url} is already serving traffic from an untracked process; refusing to start a duplicate." >&2
    return 3
  fi

  rotate_fallback_log_if_needed
  : >>"$fallback_log"
  chmod 0600 "$fallback_log"
  nohup /bin/bash "$launcher" >>"$fallback_log" 2>&1 </dev/null &
  local started_pid=$!
  printf '%s\n' "$started_pid" >"$fallback_pid_file"
  chmod 0600 "$fallback_pid_file"
  if wait_for_probe; then return 0; fi

  # Do not leave an orphaned process or a PID time bomb after startup failure.
  if kill -0 "$started_pid" 2>/dev/null && fallback_pid_is_owned "$started_pid"; then
    kill -KILL "$started_pid" 2>/dev/null || true
  fi
  rm -f "$fallback_pid_file"
  return 2
}

copilot_ensure="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/ensure-codex-copilot-proxy.sh"

acquire_lock

# Try the supervised owner first, even when the port is already healthy. This
# prevents a healthy unmanaged process from silently surviving an install.
case "$(ensure_via_launchd; echo $?)" in
  0) bash "$copilot_ensure" || true; exit 0 ;;
  1) echo "Codex model router failed to start under launchd. LaunchAgent: $plist_link" >&2; exit 1 ;;
esac

case "$(ensure_via_fallback; echo $?)" in
  0)
    bash "$copilot_ensure" || true
    exit 0
    ;;
  2)
    echo "Codex model router fallback failed to start. Log: $fallback_log" >&2
    tail -n 40 -- "$fallback_log" >&2 2>/dev/null || true
    exit 1
    ;;
  3)
    exit 1
    ;;
esac
