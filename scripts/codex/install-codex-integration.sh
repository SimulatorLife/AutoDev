#!/usr/bin/env bash

# This should be the single entry point for installing/updating all local AI/agent/Codex/Claude/Antigravity/MiniMax/Copilot integration hooks, profiles, catalogs, and skills.
# It is idempotent and can be run multiple times to update the integration.
# It is intended to be run from the AutoDev repo.
# Any and all symlinks, scheduled launchd processes, etc. are created/updated by this script, and the script will check for drift and report it.

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
hooks_dir="$codex_home/hooks"
agents_dir="$codex_home/agents"
rules_dir="$codex_home/rules"
user_skills_dir="$HOME/.agents/skills"
legacy_skills_dirs=("$codex_home/skills" "$codex_home/agents/skills")

hook_names=(
  codex-antigravity-cli-responses-proxy.mjs
  codex-claude-cli-responses-proxy.py
  codex-copilot-cli-responses-proxy.mjs
  codex-minimax-responses-proxy.mjs
  codex-model-router.mjs
  codex-model-router-status.mjs
  enforce-root-delegation.sh
  ensure-codex-antigravity-proxy.sh
  ensure-codex-claude-bridge.sh
  ensure-codex-copilot-proxy.sh
  ensure-codex-model-router.sh
  ensure-codex-minimax-proxy.sh
  run-codex-antigravity-proxy.sh
  run-codex-claude-bridge.sh
  run-codex-copilot-cli-responses-proxy.sh
  run-codex-model-router.sh
)
obsolete_runtime_hook_names=(log-subagent-model.sh run-codex-antigravity-litellm.sh)
# LaunchAgents earlier versions installed and this one no longer supervises.
# Booted out and unlinked so a removed hop does not keep running from a stale
# plist after the code that fronted it is gone.
obsolete_launchagent_labels=(com.codex.antigravity-litellm)
# Runtime files installed outside the hooks directory that no longer belong.
obsolete_runtime_paths=("$HOME/.config/litellm/antigravity.yaml" "$HOME/.codex/codex-antigravity-litellm-config.sha256")
# Directories under the hooks directory that earlier layouts created and no
# longer belong there. Removed with `rm -rf`, so entries must stay fixed
# literals that name a directory this installer itself once created.
obsolete_runtime_directory_names=(scripts)

dashboard_asset_names=(codex-model-router-dashboard.html)
# Repo-relative assets the bridges load at runtime. The hooks directory is
# flat: each asset is installed at its repo path minus the leading `scripts/`
# (see runtime_module_target), which puts it at the same depth below a bridge
# as it sits in a checkout. One relative specifier -- `./codex/lib/x.mjs`,
# `./codex/prompts/x.md` -- therefore resolves in both.
mcp_launcher_names=(run-autodev-mcp.sh)
runtime_module_names=(
  scripts/codex/lib/resolve-workspace.mjs
  scripts/codex/lib/bridge-role.mjs
  scripts/codex/lib/agent-events.mjs
  scripts/codex/lib/provider-limits.mjs
  scripts/codex/lib/responses-item-ids.mjs
  scripts/codex/lib/codex-spawn-tools.mjs
  scripts/codex/lib/bridge-spawn-session.mjs
  # Executed as a child process by the bridges rather than imported, so nothing
  # else would pull it in: an installed bridge whose --mcp-config points at a
  # missing file silently loses delegation.
  scripts/codex/lib/spawn-shim-mcp.mjs
  scripts/codex/lib/execution-contract.mjs
  scripts/codex/execution-contract.json
  scripts/codex/prompts/base.md
  scripts/codex/prompts/leaf.md
  scripts/codex/prompts/orchestrator.md
)

profile_names=(claude minimax antigravity)
catalog_names=(claude minimax antigravity codex)
agent_role_names=(browser-tester default docs-researcher explorer smart validator worker)
skill_names=(ccc code-simplification diagnosing-bugs improve-codebase-architecture lsp-mcp-server orchestration remove-legacy-shims resolve-merge-conflicts)
rule_names=(default.rules)
launchagent_labels=(
  com.codex.model-router
  com.codex.claude-bridge
  com.codex.minimax-proxy
  com.codex.antigravity-proxy
  com.codex.copilot-proxy
)
custom_provider_names=(local_model_router claude_code_subscription minimax antigravity_cli)
cocoindex_code_package="cocoindex-code[full]==0.2.41"
tracked_sources=""
router_auth_requested=0
materialize_only=0

# The installed path for a runtime module: its repo path without the leading
# `scripts/`, because the bridges are installed flat into the hooks directory
# rather than under a mirrored `scripts/` subtree.
runtime_module_target() { printf '%s\n' "$hooks_dir/${1#scripts/}"; }

link_one() {
  local source="$1"
  local target="$2"
  if [[ "$source" != /* ]]; then
    printf 'refusing-relative-symlink-source %s\n' "$source" >&2
    return 1
  fi
  mkdir -p -- "$(dirname -- "$target")"
  if [[ -L "$target" && "$(readlink "$target")" == "$source" ]]; then
    return
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    rm -f -- "$target"
  fi
  ln -s -- "$source" "$target"
}

validate_skill_source() {
  local source="$1"
  if [[ "$source" != /* ]]; then
    printf 'refusing-relative-skill-source %s\n' "$source" >&2
    return 1
  fi
  if [[ ! -d "$source" || -L "$source" ]]; then
    printf 'invalid-skill-directory %s\n' "$source" >&2
    return 1
  fi
  if [[ ! -f "$source/SKILL.md" || -L "$source/SKILL.md" ]]; then
    printf 'invalid-skill-document %s/SKILL.md\n' "$source" >&2
    return 1
  fi
}

link_skill() {
  local source="$1"
  local target="$2"
  validate_skill_source "$source" || return 1
  link_one "$source" "$target"
}

copy_runtime_one() {
  local source="$1"
  local target="$2"
  mkdir -p -- "$(dirname -- "$target")"
  if [[ -L "$target" ]]; then
    rm -f -- "$target"
  fi
  install -m 0755 "$source" "$target"
}

copy_agent_role() {
  local source="$1"
  local target="$2"
  mkdir -p -- "$(dirname -- "$target")"
  if [[ -f "$target" && ! -L "$target" ]] && cmp -s "$source" "$target"; then
    return
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    rm -f -- "$target"
  fi
  install -m 0644 "$source" "$target"
}

check_one() {
  local source="$1"
  local target="$2"
  [[ "$source" == /* && -L "$target" && "$(readlink "$target")" == "$source" ]]
}

render_launchagent() {
  local source="$1"
  local target="$2"
  mkdir -p -- "$(dirname -- "$target")"
  local temporary="$target.$$"
  sed \
    -e "s#__CODEX_HOME__#${codex_home//\\/\\\\}#g" \
    -e "s#__HOME__#${HOME//\\/\\\\}#g" \
    "$source" >"$temporary"
  chmod 0644 "$temporary"
  mv -f -- "$temporary" "$target"
}

check_rendered_launchagent() {
  local source="$1"
  local target="$2"
  [[ -f "$target" && ! -L "$target" ]] || return 1
  local temporary
  temporary="$(mktemp "${TMPDIR:-/tmp}/autodev-plist.XXXXXX")"
  # Render to a temporary file without moving it into the managed directory.
  sed \
    -e "s#__CODEX_HOME__#${codex_home//\\/\\\\}#g" \
    -e "s#__HOME__#${HOME//\\/\\\\}#g" \
    "$source" >"$temporary"
  cmp -s "$temporary" "$target"
  local result=$?
  rm -f -- "$temporary"
  return "$result"
}

check_skill_one() {
  local source="$1"
  local target="$2"
  validate_skill_source "$source" || return 1
  [[ -L "$target" && -d "$target" && "$(readlink "$target")" == "$source" ]] &&
    [[ -f "$target/SKILL.md" && ! -L "$target/SKILL.md" ]]
}

check_versioned_source() {
  local source="$1"
  local relative="${source#"$repo_root/"}"
  if [[ -d "$source" && ! -L "$source" ]]; then
    if printf '%s\n' "$tracked_sources" | awk -v prefix="$relative/" 'index($0, prefix) == 1 { found = 1 } END { exit found ? 0 : 1 }'; then
      return 0
    fi
  elif printf '%s\n' "$tracked_sources" | grep -Fqx -- "$relative"; then
    return 0
  fi
  printf 'untracked-provider-source %s\n' "$source"
  return 1
}

check_versioned_sources() {
  local failed=0
  local name source role

  if ! tracked_sources="$(git -C "$repo_root" ls-files)"; then
    printf 'unable-to-list-versioned-provider-sources\n'
    return 1
  fi

  for name in "${hook_names[@]}"; do
    source="$repo_root/scripts/$name"
    if ! check_versioned_source "$source"; then
      failed=1
    fi
  done
  for name in "${dashboard_asset_names[@]}"; do
    source="$repo_root/scripts/$name"
    if ! check_versioned_source "$source"; then
      failed=1
    fi
  done
  for name in "${profile_names[@]}"; do
    source="$repo_root/scripts/codex/profiles/$name.config.toml"
    if ! check_versioned_source "$source"; then
      failed=1
    fi
  done
  for name in "${catalog_names[@]}"; do
    source="$repo_root/scripts/codex/catalogs/$name-model-catalog.json"
    if ! check_versioned_source "$source"; then
      failed=1
    fi
  done
  source="$repo_root/scripts/codex/model-routing.json"
  if ! check_versioned_source "$source"; then
    failed=1
  fi
  for role in "${agent_role_names[@]}"; do
    source="$repo_root/scripts/codex/agents/$role.toml"
    if ! check_versioned_source "$source"; then
      failed=1
    fi
  done
  for name in "${skill_names[@]}"; do
    source="$repo_root/scripts/codex/skills/$name"
    if ! check_versioned_source "$source"; then
      failed=1
    fi
  done
  for name in "${rule_names[@]}"; do
    source="$repo_root/scripts/codex/rules/$name"
    if ! check_versioned_source "$source"; then
      failed=1
    fi
  done
  for name in "${runtime_module_names[@]}"; do
    source="$repo_root/$name"
    if ! check_versioned_source "$source"; then
      failed=1
    fi
  done
  for name in "${mcp_launcher_names[@]}"; do
    source="$repo_root/scripts/codex/$name"
    if ! check_versioned_source "$source"; then
      failed=1
    fi
  done
  for source in "$repo_root/scripts/codex/config.toml" "$repo_root/scripts/codex/install-codex-integration.sh" \
    "$repo_root/scripts/codex/launchagents/com.codex.model-router.plist" \
    "$repo_root/scripts/codex/launchagents/com.codex.claude-bridge.plist" \
    "$repo_root/scripts/codex/launchagents/com.codex.minimax-proxy.plist" \
    "$repo_root/scripts/codex/launchagents/com.codex.antigravity-proxy.plist" \
    "$repo_root/scripts/codex/launchagents/com.codex.copilot-proxy.plist"; do
    if ! check_versioned_source "$source"; then
      failed=1
    fi
  done

  if [[ "$failed" == 0 ]]; then
    printf 'ok provider sources are tracked in AutoDev\n'
  fi
  return "$failed"
}

check_agent_registry() {
  local failed=0
  local role project_section user_section

  # Workspace-local agents are supported, but the flat user registry owns the
  # managed role names. Allow project-specific names while rejecting only an
  # ambiguous same-name override that would make precedence depend on launch
  # surface rather than the documented role contract.
  if [[ -d "$repo_root/.codex/agents" ]]; then
    while IFS= read -r local_agent; do
      local_name="$(basename "$local_agent" .toml)"
      case " ${agent_role_names[*]} " in
        *" $local_name "*)
          printf 'project-agent-role-conflict %s\n' "$local_agent"
          failed=1
          ;;
        *) printf 'ok project-local-agent-role %s\n' "$local_agent" ;;
      esac
    done < <(find "$repo_root/.codex/agents" -type f -name '*.toml' -print 2>/dev/null | sort)
  fi

  for role in "${agent_role_names[@]}"; do
    if [[ "$role" == *-* ]]; then
      project_section="[agents.\"$role\"]"
      user_section="$project_section"
    else
      project_section="[agents.$role]"
      user_section="$project_section"
    fi
    if [[ ! -f "$repo_root/scripts/codex/agents/$role.toml" ]]; then
      printf 'missing-user-agent-source %s\n' "$repo_root/scripts/codex/agents/$role.toml"
      failed=1
    fi
    if grep -Fq "$project_section" "$repo_root/.codex/config.toml" 2>/dev/null; then
      printf 'project-agent-registration-not-allowed %s\n' "$role"
      failed=1
    fi
    if ! grep -Fq "$user_section" "$repo_root/scripts/codex/config.toml" || \
      ! grep -Fq "config_file = \"./agents/$role.toml\"" "$repo_root/scripts/codex/config.toml"; then
      printf 'missing-user-agent-registration %s\n' "$role"
      failed=1
    fi
  done

  if [[ "$failed" == 0 ]]; then
    printf 'ok flat agent registry (%s roles)\n' "${#agent_role_names[@]}"
  fi
  return "$failed"
}

check_user_agent_files() {
  local failed=0
  local role source target

  for role in "${agent_role_names[@]}"; do
    source="$repo_root/scripts/codex/agents/$role.toml"
    target="$agents_dir/$role.toml"
    if [[ -f "$target" && ! -L "$target" ]] && cmp -s "$source" "$target"; then
      printf 'ok %s (runtime copy of %s)\n' "$target" "$source"
    else
      printf 'missing, symlinked, or drifted %s -> %s\n' "$target" "$source"
      failed=1
    fi
  done
  return "$failed"
}

ensure_pipx() {
  # pipx is a prerequisite of the step below, not a thing the operator should
  # have to go and fetch by hand: this script is meant to be the single entry
  # point, and bailing out with "install pipx, then rerun" makes it two.
  #
  # Homebrew first on any machine that has it. The Pythons Homebrew ships are
  # PEP 668 externally-managed, so `pip install --user` fails there outright,
  # and Homebrew also puts pipx somewhere already on PATH. The pip fallback is
  # for machines with no Homebrew (Linux, CI), and is only attempted when the
  # interpreter actually permits it -- forcing past an externally-managed marker
  # would be modifying a Python the OS package manager owns.
  if command -v pipx >/dev/null 2>&1; then
    printf 'ok pipx (%s)\n' "$(command -v pipx)" >&2
    return 0
  fi
  if [[ "${AUTODEV_SKIP_PIPX_INSTALL:-0}" == "1" ]]; then
    printf 'skipping pipx installation (AUTODEV_SKIP_PIPX_INSTALL=1)\n' >&2
    return 1
  fi

  if command -v brew >/dev/null 2>&1; then
    # `bash` is a universal binary on macOS and, on this class of machine,
    # launches translated (x86_64 under Rosetta) even when the login shell is
    # native arm64. This script is normally invoked as `bash install-...sh`, so
    # it inherits that -- and Homebrew installed at the ARM prefix refuses to
    # install from a translated process ("Cannot install under Rosetta 2 in ARM
    # default prefix"). Re-exec brew natively in that case; `arch -arm64` works
    # from a translated parent, and the check is a no-op on Intel and on Linux.
    local brew_launcher=()
    if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]] \
      && [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then
      brew_launcher=(arch -arm64)
      printf 'running Homebrew natively (this process is translated under Rosetta)\n' >&2
    fi
    printf 'installing pipx with Homebrew\n' >&2
    "${brew_launcher[@]}" brew install pipx || true
  elif python3 -c 'import os, sysconfig, sys; sys.exit(0 if not os.path.exists(os.path.join(sysconfig.get_path("stdlib"), "EXTERNALLY-MANAGED")) else 1)' 2>/dev/null; then
    printf 'installing pipx with pip --user\n' >&2
    python3 -m pip install --user pipx || true
    # A --user install lands in the interpreter's user base, which is not
    # necessarily on PATH; add it for the rest of this run so the pipx call
    # below resolves even before any shell restart.
    local user_bin
    user_bin="$(python3 -c 'import site, os; print(os.path.join(site.getuserbase(), "bin"))' 2>/dev/null || true)"
    if [[ -n "$user_bin" && -d "$user_bin" ]]; then
      export PATH="$user_bin:$PATH"
    fi
  else
    printf 'cannot install pipx automatically: no Homebrew, and this Python is externally managed (PEP 668)\n' >&2
    printf 'Install pipx yourself (e.g. `brew install pipx`, or your distro package), then rerun %s\n' "${BASH_SOURCE[0]##*/}" >&2
    return 1
  fi

  # The shell caches command lookups, so a freshly installed pipx is invisible
  # to `command -v` in this same process without clearing that cache.
  hash -r 2>/dev/null || true
  if ! command -v pipx >/dev/null 2>&1; then
    printf 'pipx installation did not put pipx on PATH\n' >&2
    printf 'Install pipx yourself, then rerun %s\n' "${BASH_SOURCE[0]##*/}" >&2
    return 1
  fi
  # Puts pipx's own bin directory on PATH for future shells. Best effort: it
  # edits shell rc files, and a failure here does not stop this run, which uses
  # the absolute paths above.
  pipx ensurepath >/dev/null 2>&1 || true
  printf 'ok pipx installed (%s)\n' "$(command -v pipx)" >&2
}

install_cocoindex_code() {
  # The MCP entry is versioned in config.toml; this step owns only the user-level
  # executable. A missing ccc is fatal unless a caller explicitly opts out (the
  # opt-out is used by isolated installer tests and is not a production path).
  if [[ "${AUTODEV_SKIP_COCOINDEX_INSTALL:-0}" == "1" ]]; then
    printf 'skipping CocoIndex Code installation (AUTODEV_SKIP_COCOINDEX_INSTALL=1)\n' >&2
    return 0
  fi
  if command -v ccc >/dev/null 2>&1; then
    printf 'ok CocoIndex Code executable (%s)\n' "$(command -v ccc)" >&2
    return 0
  fi
  if ! ensure_pipx; then
    return 1
  fi
  printf 'installing CocoIndex Code with pipx (%s)\n' "$cocoindex_code_package" >&2
  # Some of this package's dependencies build C extensions from source
  # (`watchdog` compiles against the macOS FSEvents API). On a Mac where clang
  # is not already resolving the SDK -- Command Line Tools selected through
  # Xcode.app, no SDKROOT exported -- that build fails on a missing `assert.h`,
  # which reads as a broken package rather than a missing toolchain setting.
  # Supply the SDK path the way Apple's own tooling does, and only when the
  # caller has not already chosen one.
  if [[ -z "${SDKROOT:-}" ]] && command -v xcrun >/dev/null 2>&1; then
    local sdk_path
    sdk_path="$(xcrun --show-sdk-path 2>/dev/null || true)"
    if [[ -n "$sdk_path" && -d "$sdk_path" ]]; then
      printf 'using macOS SDK at %s for native dependency builds\n' "$sdk_path" >&2
      export SDKROOT="$sdk_path"
    fi
  fi
  # A third-party clang earlier on PATH than /usr/bin -- a Homebrew LLVM is the
  # usual one -- does not carry Apple's SDK search conventions, so these builds
  # fail on a missing `math.h` or `library 'm' not found`. That looks like a
  # broken package and is really a shadowed compiler. Point the build at Apple's
  # clang for this install only; the caller's PATH and any CC they chose
  # themselves are left alone.
  if [[ "$(uname -s)" == "Darwin" && -z "${CC:-}" && -x /usr/bin/clang ]] \
    && ! (command -v clang >/dev/null 2>&1 && clang --version 2>/dev/null | grep -q 'Apple clang'); then
    printf 'using /usr/bin/clang for native builds (the clang on PATH is not Apple clang)\n' >&2
    export CC=/usr/bin/clang
    export CXX=/usr/bin/clang++
  fi
  pipx install "$cocoindex_code_package"
}

check_cocoindex_code_executable() {
  if [[ "${AUTODEV_SKIP_COCOINDEX_INSTALL:-0}" == "1" ]]; then
    printf 'skipping CocoIndex Code executable check (AUTODEV_SKIP_COCOINDEX_INSTALL=1)\n'
    return 0
  fi
  if command -v ccc >/dev/null 2>&1; then
    printf 'ok CocoIndex Code executable (%s)\n' "$(command -v ccc)"
    return 0
  fi
  printf 'missing CocoIndex Code executable ccc (run the installer without AUTODEV_SKIP_COCOINDEX_INSTALL)\n'
  return 1
}

check_agy_playwright_mcp() {
  if [[ "${AUTODEV_SKIP_AGY_MCP:-0}" == "1" ]]; then
    printf 'skipping agy Playwright MCP check (AUTODEV_SKIP_AGY_MCP=1)\n'
    return 0
  fi
  if ! command -v agy >/dev/null 2>&1; then
    printf 'skipping agy Playwright MCP check (agy is not installed)\n'
    return 0
  fi
  local listing
  listing="$(agy mcp list 2>/dev/null || true)"
  if grep -Eq '^playwright[[:space:]]+stdio[[:space:]]+enabled[[:space:]]+pnpm exec playwright-mcp[[:space:]]*$' <<<"$listing"; then
    printf 'ok agy Playwright MCP (pinned pnpm executable)\n'
    return 0
  fi
  printf 'missing-or-drifted agy Playwright MCP (expected pnpm exec playwright-mcp)\n'
  return 1
}

check_cocoindex_code_config() {
  local config="$repo_root/scripts/codex/config.toml"
  local failed=0
  grep -Fq '[mcp_servers."cocoindex-code"]' "$config" || {
    printf 'missing-user-mcp-registration cocoindex-code\n'
    failed=1
  }
  grep -Fq 'command = "ccc"' "$config" || {
    printf 'invalid-user-mcp-command cocoindex-code\n'
    failed=1
  }
  grep -Fq 'args = ["mcp"]' "$config" || {
    printf 'invalid-user-mcp-args cocoindex-code\n'
    failed=1
  }
  grep -Fq 'name = "ccc"' "$config" || {
    printf 'missing-user-skill-registration ccc\n'
    failed=1
  }
  if [[ "$failed" == 0 ]]; then
    printf 'ok CocoIndex Code user MCP and skill registration\n'
  fi
  return "$failed"
}

check_custom_provider_config() {
  local failed=0
  local provider profile

  for provider in "${custom_provider_names[@]}"; do
    if ! grep -Fq "[model_providers.$provider]" "$repo_root/scripts/codex/config.toml"; then
      printf 'missing-user-provider-registration %s\n' "$provider"
      failed=1
    fi
  done

  for profile in "${profile_names[@]}"; do
    if ! grep -Fq 'model_provider =' "$repo_root/scripts/codex/profiles/$profile.config.toml" || \
      ! grep -Fq 'wire_api = "responses"' "$repo_root/scripts/codex/profiles/$profile.config.toml" || \
      ! grep -Fq 'requires_openai_auth = false' "$repo_root/scripts/codex/profiles/$profile.config.toml"; then
      printf 'invalid-custom-provider-profile %s\n' "$repo_root/scripts/codex/profiles/$profile.config.toml"
      failed=1
    fi
  done

  if ! grep -Fq 'requires_openai_auth = false' "$repo_root/scripts/codex/config.toml"; then
    printf 'missing-user-provider-auth-boundary %s\n' "$repo_root/scripts/codex/config.toml"
    failed=1
  fi

  if [[ "$failed" == 0 ]]; then
    printf 'ok custom provider user config (Responses API, no OpenAI auth dependency)\n'
  fi
  return "$failed"
}

check_legacy_skill_links() {
  local failed=0
  local name legacy_dir target
  for legacy_dir in "${legacy_skills_dirs[@]}"; do
    for name in "${skill_names[@]}"; do
      target="$legacy_dir/$name"
      if [[ -L "$target" ]]; then
        printf 'obsolete-user-skill-link %s\n' "$target"
        failed=1
      elif [[ -e "$target" ]]; then
        printf 'obsolete-user-skill-path %s\n' "$target"
        failed=1
      fi
    done
  done
  return "$failed"
}

check_router_auth_state() {
  local env_file="${CODEX_ENV_FILE:-$codex_home/.env}"
  if [[ ! -f "$env_file" ]] || ! grep -q '^CODEX_ROUTER_AUTH_TOKEN=' "$env_file"; then
    printf '%s\n' 'router auth token not staged (use --enable-router-auth during a planned restart)'
    return 0
  fi
  local status_json auth_enabled
  if status_json="$(curl --silent --max-time 1 http://127.0.0.1:4100/status 2>/dev/null)"; then
    auth_enabled="$(printf '%s' "$status_json" | python3 -c 'import json,sys; print("1" if json.load(sys.stdin).get("authentication", {}).get("responseRequests") else "0")' 2>/dev/null || printf '0')"
    if [[ "$auth_enabled" == 1 ]]; then
      printf '%s\n' 'ok router authentication is active'
    else
      printf '%s\n' 'router auth token staged; active router still needs a planned restart'
    fi
  else
    printf '%s\n' 'router auth token staged (router status unavailable)'
  fi
}

check_removed_runtime_hooks() {
  local failed=0
  local name target
  for name in "${obsolete_launchagent_labels[@]}"; do
    target="$HOME/Library/LaunchAgents/$name.plist"
    if [[ -e "$target" || -L "$target" ]]; then
      printf 'obsolete-launchagent %s\n' "$target"
      failed=1
    fi
  done
  for target in "${obsolete_runtime_paths[@]}"; do
    if [[ -e "$target" || -L "$target" ]]; then
      printf 'obsolete-runtime-path %s\n' "$target"
      failed=1
    fi
  done
  for name in "${obsolete_runtime_hook_names[@]}"; do
    target="$hooks_dir/$name"
    if [[ -e "$target" || -L "$target" ]]; then
      printf 'obsolete-runtime-hook %s\n' "$target"
      failed=1
    fi
  done
  for name in "${obsolete_runtime_directory_names[@]}"; do
    target="$hooks_dir/$name"
    if [[ -e "$target" || -L "$target" ]]; then
      printf 'obsolete-runtime-directory %s\n' "$target"
      failed=1
    fi
  done
  return "$failed"
}

check_links() {
  local failed=0
  local name source target
  for name in "${rule_names[@]}"; do
    source="$repo_root/scripts/codex/rules/$name"
    target="$rules_dir/$name"
    if check_one "$source" "$target"; then
      printf 'ok %s -> %s\n' "$target" "$source"
    else
      printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
      failed=1
    fi
  done
  for name in "${skill_names[@]}"; do
    source="$repo_root/scripts/codex/skills/$name"
    target="$user_skills_dir/$name"
    if check_skill_one "$source" "$target"; then
      printf 'ok %s -> %s\n' "$target" "$source"
    else
      printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
      failed=1
    fi
  done
  for name in "${runtime_module_names[@]}"; do
    source="$repo_root/$name"
    target="$(runtime_module_target "$name")"
    if [[ -f "$target" && ! -L "$target" ]] && cmp -s "$source" "$target"; then
      printf 'ok %s (runtime copy of %s)\n' "$target" "$source"
    else
      printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
      failed=1
    fi
  done
  for name in "${mcp_launcher_names[@]}"; do
    source="$repo_root/scripts/codex/$name"
    target="$hooks_dir/$name"
    if check_one "$source" "$target"; then
      printf 'ok %s -> %s\n' "$target" "$source"
    else
      printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
      failed=1
    fi
  done
  for name in "${hook_names[@]}"; do
    source="$repo_root/scripts/$name"
    target="$hooks_dir/$name"
    if [[ -f "$target" && ! -L "$target" ]] && cmp -s "$source" "$target"; then
      printf 'ok %s (runtime copy of %s)\n' "$target" "$source"
    else
      printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
      failed=1
    fi
  done
  for name in "${dashboard_asset_names[@]}"; do
    source="$repo_root/scripts/$name"
    target="$hooks_dir/$name"
    if [[ -f "$target" && ! -L "$target" ]] && cmp -s "$source" "$target"; then
      printf 'ok %s (runtime copy of %s)\n' "$target" "$source"
    else
      printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
      failed=1
    fi
  done
  for name in "${profile_names[@]}"; do
    source="$repo_root/scripts/codex/profiles/$name.config.toml"
    target="$codex_home/$name.config.toml"
    if check_one "$source" "$target"; then
      printf 'ok %s -> %s\n' "$target" "$source"
    else
      printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
      failed=1
    fi
  done
  for name in "${catalog_names[@]}"; do
    source="$repo_root/scripts/codex/catalogs/$name-model-catalog.json"
    target="$codex_home/$name-model-catalog.json"
    if check_one "$source" "$target"; then
      printf 'ok %s -> %s\n' "$target" "$source"
    else
      printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
      failed=1
    fi
  done
  source="$repo_root/scripts/codex/config.toml"
  target="$codex_home/config.toml"
  if check_one "$source" "$target"; then
    printf 'ok %s -> %s\n' "$target" "$source"
  else
    printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
    failed=1
  fi
  source="$repo_root/scripts/codex/model-routing.json"
  target="$codex_home/codex-model-routing.json"
  if check_one "$source" "$target"; then
    printf 'ok %s -> %s\n' "$target" "$source"
  else
    printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
    failed=1
  fi
  if ! check_agent_registry; then
    failed=1
  fi
  if ! check_user_agent_files; then
    failed=1
  fi
  if ! check_custom_provider_config; then
    failed=1
  fi
  if ! check_cocoindex_code_executable; then
    failed=1
  fi
  if ! check_agy_playwright_mcp; then
    failed=1
  fi
  if ! check_cocoindex_code_config; then
    failed=1
  fi
  if ! check_legacy_skill_links; then
    failed=1
  fi
  if ! check_removed_runtime_hooks; then
    failed=1
  fi
  for label in "${launchagent_labels[@]}"; do
    source="$repo_root/scripts/codex/launchagents/$label.plist"
    target="$HOME/Library/LaunchAgents/$label.plist"
    if check_rendered_launchagent "$source" "$target"; then
      printf 'ok %s -> %s\n' "$target" "$source"
    else
      printf 'missing-or-drifted %s -> %s\n' "$target" "$source"
      failed=1
    fi
  done
  if ! check_versioned_sources; then
    failed=1
  fi
  check_router_auth_state
  return "$failed"
}

enable_router_auth() {
  local env_file="${CODEX_ENV_FILE:-$codex_home/.env}"
  local token
  mkdir -p -- "$(dirname -- "$env_file")"
  if [[ -f "$env_file" ]] && token="$(sed -n 's/^CODEX_ROUTER_AUTH_TOKEN=//p' "$env_file" | tail -n 1)" && [[ -n "$token" ]]; then
    printf 'ok router auth token already exists in %s\n' "$env_file" >&2
  else
    command -v openssl >/dev/null 2>&1 || { printf 'openssl is required to enable router auth\n' >&2; return 1; }
    token="$(openssl rand -hex 32)"
    (umask 077; printf 'CODEX_ROUTER_AUTH_TOKEN=%s\n' "$token" >>"$env_file")
    printf 'created router auth token in %s\n' "$env_file" >&2
  fi
  chmod 0600 "$env_file"
  export CODEX_ROUTER_AUTH_TOKEN="$token"
  if [[ "${AUTODEV_SKIP_LAUNCHCTL:-0}" != "1" ]] && command -v launchctl >/dev/null 2>&1; then
    launchctl setenv CODEX_ROUTER_AUTH_TOKEN "$token" >/dev/null 2>&1 || true
  fi
}

# `--restart` is gone: installing now always restarts, so a flag asking for it
# described a choice that no longer exists. It is rejected rather than accepted
# as a no-op, because silently ignoring it would leave the caller believing they
# had opted into something.
check_only=0
for argument in "$@"; do
  case "$argument" in
    --check) check_only=1 ;;
    --enable-router-auth) router_auth_requested=1 ;;
    --materialize-only) materialize_only=1 ;;
    *)
      printf 'usage: %s [--check|--enable-router-auth] [--materialize-only]\n' "${BASH_SOURCE[0]##*/}" >&2
      printf 'installing normally restarts services; use --materialize-only for a live session.\n' >&2
      exit 2
      ;;
  esac
done
if [[ "$check_only" == 1 ]]; then
  if [[ "$router_auth_requested" == 1 || "$materialize_only" == 1 || "$#" -ne 1 ]]; then
    printf '%s\n' '--check cannot be combined with install options.' >&2
    exit 2
  fi
  check_links
  exit $?
fi

if [[ "$router_auth_requested" == 1 ]]; then
  enable_router_auth || exit 1
fi

if [[ "$materialize_only" == 0 ]] && ! install_cocoindex_code; then
  exit 1
fi

register_agy_spawn_shim() {
  # The Antigravity bridge hands agy a delegation tool so its children are
  # created by Codex -- and therefore appear as real, clickable sessions --
  # rather than inside agy where nothing can see them.
  #
  # Unlike Claude, agy has no per-invocation MCP flag: its server list is the
  # single global ~/.gemini/config/mcp_config.json, so the registration has to
  # happen once, here. The bridge still decides per turn whether the tool is
  # offered at all: it passes the session in the child's environment, which the
  # shim inherits, and a leaf turn passes none.
  if [[ "${AUTODEV_SKIP_AGY_MCP:-0}" == "1" ]]; then
    printf 'skipping agy MCP registration (AUTODEV_SKIP_AGY_MCP=1)\n' >&2
    return 0
  fi
  if ! command -v agy >/dev/null 2>&1; then
    printf 'skipping agy MCP registration (agy is not installed)\n' >&2
    return 0
  fi
  # agy has no per-invocation MCP config, so the browser role's server must be
  # registered globally. Keep it on the same pinned package used by native
  # Codex and Claude bridge turns; an npx @latest entry can fail on an offline
  # host and silently deprives browser-tester children of their only browser.
  if ! agy mcp add playwright pnpm exec playwright-mcp >/dev/null 2>&1; then
    printf 'could not register the pinned agy Playwright MCP server\n' >&2
    return 1
  fi
  printf 'ok agy Playwright MCP registered (playwright)\n' >&2
  local shim="$codex_home/hooks/codex/lib/spawn-shim-mcp.mjs"
  if [[ ! -f "$shim" ]]; then
    printf 'agy spawn shim missing at %s\n' "$shim" >&2
    return 1
  fi
  if agy mcp add autodev_spawn node "$shim" >/dev/null 2>&1; then
    printf 'ok agy spawn shim registered (autodev_spawn)\n' >&2
    return 0
  fi
  # Not fatal: agy then delegates in its own runtime as it did before, which is
  # invisible to the app but still delegation.
  printf 'could not register the agy spawn shim; agy will delegate in-CLI instead\n' >&2
  return 0
}

for name in "${obsolete_launchagent_labels[@]}"; do
  target="$HOME/Library/LaunchAgents/$name.plist"
  launchctl bootout "gui/$(id -u)/$name" >/dev/null 2>&1 || true
  if [[ -e "$target" || -L "$target" ]]; then
    rm -f -- "$target"
    printf 'removed obsolete launchagent %s\n' "$target"
  fi
done

for target in "${obsolete_runtime_paths[@]}"; do
  if [[ -e "$target" || -L "$target" ]]; then
    rm -f -- "$target"
    printf 'removed obsolete runtime path %s\n' "$target"
  fi
done

for name in "${obsolete_runtime_hook_names[@]}"; do
  target="$hooks_dir/$name"
  if [[ -e "$target" || -L "$target" ]]; then
    rm -f -- "$target"
    printf 'removed obsolete runtime hook %s\n' "$target"
  fi
done

[[ -n "$hooks_dir" ]] || { echo "hooks_dir is unset; refusing to remove obsolete directories" >&2; exit 1; }
for name in "${obsolete_runtime_directory_names[@]}"; do
  target="$hooks_dir/$name"
  if [[ -e "$target" || -L "$target" ]]; then
    rm -rf -- "$target"
    printf 'removed obsolete runtime directory %s\n' "$target"
  fi
done

for name in "${runtime_module_names[@]}"; do
  source="$repo_root/$name"
  target="$(runtime_module_target "$name")"
  mkdir -p -- "$(dirname -- "$target")"
  install -m 0644 "$source" "$target"
done
for name in "${mcp_launcher_names[@]}"; do
  link_one "$repo_root/scripts/codex/$name" "$hooks_dir/$name"
done
for name in "${hook_names[@]}"; do
  chmod +x "$repo_root/scripts/$name"
  copy_runtime_one "$repo_root/scripts/$name" "$hooks_dir/$name"
done
for name in "${dashboard_asset_names[@]}"; do
  install -m 0644 "$repo_root/scripts/$name" "$hooks_dir/$name"
done
for name in "${profile_names[@]}"; do
  link_one "$repo_root/scripts/codex/profiles/$name.config.toml" "$codex_home/$name.config.toml"
done
for name in "${catalog_names[@]}"; do
  link_one "$repo_root/scripts/codex/catalogs/$name-model-catalog.json" "$codex_home/$name-model-catalog.json"
done
for name in "${rule_names[@]}"; do
  link_one "$repo_root/scripts/codex/rules/$name" "$rules_dir/$name"
done
for name in "${skill_names[@]}"; do
  for legacy_dir in "${legacy_skills_dirs[@]}"; do
    legacy_target="$legacy_dir/$name"
    if [[ -L "$legacy_target" ]]; then
      rm -f -- "$legacy_target"
    elif [[ -e "$legacy_target" ]]; then
      printf 'refusing to replace obsolete non-symlink skill path: %s\n' "$legacy_target" >&2
      exit 1
    fi
  done
  link_skill "$repo_root/scripts/codex/skills/$name" "$user_skills_dir/$name"
done
mkdir -p -- "$agents_dir"
for role in "${agent_role_names[@]}"; do
  copy_agent_role "$repo_root/scripts/codex/agents/$role.toml" "$agents_dir/$role.toml"
done
link_one "$repo_root/scripts/codex/config.toml" "$codex_home/config.toml"
link_one "$repo_root/scripts/codex/model-routing.json" "$codex_home/codex-model-routing.json"
# The registration consumes the installed spawn shim, so it must happen after
# runtime modules are materialized. The Playwright entry is registered in the
# same pass for agy's global MCP registry.
if [[ "$materialize_only" == 0 ]] && ! register_agy_spawn_shim; then
  exit 1
fi
# The router (parent transport) and the four subagent bridges must survive app
# restarts, crashes, and sleep. launchd KeepAlive agents provide that durability
# (each plist invokes the installed hook copy under ~/.codex, outside Desktop,
# so macOS privacy controls on the AutoDev repo do not block launchd). When the
# installer runs from inside the Codex sandbox launchctl may be unreachable;
# that is tolerated, and the ensure-hooks below start the bridges directly.
#
# The router plist writes separate stdout/stderr logs to $CODEX_HOME/run with
# the launchd label as a suffix, and the ensure hook writes its fallback
# pid/log there too. Create the directory user-private up front so launchd
# (which runs as the user) can create files in it without permission errors.
mkdir -p -- "$codex_home/run"
chmod 0700 "$codex_home/run"
for router_log in \
  "$codex_home/run/codex-model-router.launchd.out.log" \
  "$codex_home/run/codex-model-router.launchd.err.log"; do
  if [[ -L "$router_log" ]]; then
    printf 'refusing symlinked router log path: %s\n' "$router_log" >&2
    exit 1
  fi
  if [[ ! -e "$router_log" ]]; then
    (umask 077; : >"$router_log")
  fi
  chmod 0600 "$router_log"
done
for label in "${launchagent_labels[@]}"; do
  plist_src="$repo_root/scripts/codex/launchagents/$label.plist"
  if [[ -f "$plist_src" ]]; then
    render_launchagent "$plist_src" "$HOME/Library/LaunchAgents/$label.plist"
  fi
done

# The CODEX_HOME the installed launchagents point at. The plists carry one fixed
# absolute path, so this is the only tree whose services this installer owns.
plist_codex_home() {
  local plist="$HOME/Library/LaunchAgents/com.codex.model-router.plist"
  [[ -f "$plist" ]] || return 0
  /usr/bin/plutil -extract EnvironmentVariables.CODEX_HOME raw -o - "$plist" 2>/dev/null || true
}

# The loopback port and the installed hook each supervised service owns. Used to
# find processes squatting a port outside launchd, so a service can actually be
# adopted rather than losing the bind to an orphan of itself.
service_port() {
  case "$1" in
    com.codex.model-router) printf '4100\n' ;;
    com.codex.claude-bridge) printf '4000\n' ;;
    com.codex.antigravity-proxy) printf '4002\n' ;;
    com.codex.copilot-proxy) printf '4003\n' ;;
    com.codex.minimax-proxy) printf '18765\n' ;;
  esac
}

service_hook() {
  case "$1" in
    com.codex.model-router) printf '%s/codex-model-router.mjs\n' "$hooks_dir" ;;
    com.codex.claude-bridge) printf '%s/codex-claude-cli-responses-proxy.py\n' "$hooks_dir" ;;
    com.codex.antigravity-proxy) printf '%s/codex-antigravity-cli-responses-proxy.mjs\n' "$hooks_dir" ;;
    com.codex.copilot-proxy) printf '%s/codex-copilot-cli-responses-proxy.mjs\n' "$hooks_dir" ;;
    com.codex.minimax-proxy) printf '%s/codex-minimax-responses-proxy.mjs\n' "$hooks_dir" ;;
  esac
}

service_launcher() {
  case "$1" in
    com.codex.model-router) printf '%s/run-codex-model-router.sh\n' "$hooks_dir" ;;
    com.codex.claude-bridge) printf '%s/run-codex-claude-bridge.sh\n' "$hooks_dir" ;;
    com.codex.antigravity-proxy) printf '%s/run-codex-antigravity-proxy.sh\n' "$hooks_dir" ;;
    com.codex.copilot-proxy) printf '%s/run-codex-copilot-cli-responses-proxy.sh\n' "$hooks_dir" ;;
    com.codex.minimax-proxy) printf '%s/ensure-codex-minimax-proxy.sh\n' "$hooks_dir" ;;
  esac
}

# Terminate any process holding this service's port that launchd is not
# supervising. Such a process is unkillable-by-design from launchd's point of
# view: it owns the bind, so `bootstrap` fails and the agent never starts, while
# the port keeps answering health checks and everything downstream looks fine.
# That is how a bridge ends up serving code that was replaced days earlier.
#
# Only ever terminates a process running this service's own installed hook. A
# port held by something unrelated is a conflict to report, never something to
# kill, so the guard is on the command line rather than on the port alone. Runs
# after `bootout`, when nothing this service owns should still be listening.
reap_unmanaged() {
  local label="$1" port hook pid
  port="$(service_port "$label")"
  hook="$(service_hook "$label")"
  [[ -n "$port" && -n "$hook" ]] || return 0
  command -v lsof >/dev/null 2>&1 || return 0
  for pid in $(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    if ps -o command= -p "$pid" 2>/dev/null | grep -Fq -- "$hook"; then
      printf 'reaping unmanaged %s on port %s (pid %s)\n' "$label" "$port" "$pid" >&2
      kill "$pid" 2>/dev/null || true
    else
      printf 'port %s held by a process this installer does not own (pid %s); %s not started\n' "$port" "$pid" "$label" >&2
    fi
  done
  for _ in {1..40}; do
    lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    sleep 0.1
  done
}

# Installing new code and leaving the old code running is not an install. This
# used to sit behind an opt-in --restart flag, which meant the ordinary path
# copied files into place and left every service executing whatever it had
# already loaded. Nothing reports that: the ports stay healthy, the files on
# disk look right, and a bridge can run for days on code that no longer exists.
# Restarting unconditionally is what makes "ran the installer" and "is running
# the installed code" the same statement.
#
# The router drains in-flight requests on SIGTERM, which is what launchctl
# bootout sends, so an in-flight turn finishes rather than being cut off.
restart_services() {
  local domain
  domain="gui/$(id -u)"

  # The launchd labels are global to the user, but the plists point at one fixed
  # absolute hooks directory. An install that materialized files somewhere else
  # -- a test fixture, a staging tree, anything with CODEX_HOME overridden --
  # must not cycle those services: it would bounce the live router while the
  # code it was asked to deploy sits in another directory entirely. Deploying
  # and materializing are different operations and only one of them owns the
  # running services.
  local plist_home
  plist_home="$(plist_codex_home)"
  if [[ -n "$plist_home" && "$hooks_dir" != "$plist_home/hooks" ]]; then
    printf 'materialized into %s; leaving the services under %s alone.\n' "$hooks_dir" "$plist_home/hooks" >&2
    return 0
  fi
  local launchd_ok=1 foreign_service=0 label plist_link probe job_dump expected_hook
  for label in "${launchagent_labels[@]}"; do
    local plist_link="$HOME/Library/LaunchAgents/$label.plist"
    [[ -f "$plist_link" ]] || { launchd_ok=0; continue; }
    # LaunchAgent labels are global. Never boot out a service owned by a
    # different CODEX_HOME (for example a hermetic installer test or a staged
    # migration); only cycle a loaded job whose program is this install's hook.
    if job_dump="$(launchctl print "$domain/$label" 2>/dev/null)"; then
      expected_hook="$(service_launcher "$label")"
      if ! grep -Fq -- "$expected_hook" <<<"$job_dump"; then
        printf 'loaded %s belongs to another runtime; leaving it alone.\n' "$label" >&2
        launchd_ok=0
        foreign_service=1
        continue
      fi
    fi
    launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
    reap_unmanaged "$label"
    if launchctl bootstrap "$domain" "$plist_link" >/dev/null 2>&1; then
      launchctl enable "$domain/$label" >/dev/null 2>&1 || true
      launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
    else
      launchd_ok=0
    fi
  done
  if [[ "$foreign_service" == 1 ]]; then
    printf '%s\n' 'another AutoDev runtime owns one or more labels; leaving all active services untouched.' >&2
    return 0
  fi
  if [[ "$launchd_ok" == 1 ]]; then
    printf '%s\n' 'Provider bridges supervised by launchd (KeepAlive; survive restart/crash/sleep).' >&2
    # Let services bind before the idempotent ensure-hooks run, so those hooks
    # observe healthy ports and no-op instead of racing/replacing the agents.
    for probe in \
      http://127.0.0.1:4100/health/readiness \
      http://127.0.0.1:4000/health/liveliness \
      http://127.0.0.1:4002/health/liveliness \
      http://127.0.0.1:4003/health/liveliness \
      http://127.0.0.1:18765/health; do
      for _ in {1..80}; do
        curl --silent --fail --max-time 1 "$probe" >/dev/null 2>&1 && break
        sleep 0.25
      done
    done
  else
    printf '%s\n' 'launchctl unavailable (sandbox?); starting bridges through the direct ensure-hook path.' >&2
  fi
  bash "$repo_root/scripts/ensure-codex-model-router.sh"
  # A bridge that cannot start -- CLI not installed, credentials absent -- is a
  # supported configuration: the router skips that provider and routes around
  # it. Report it and carry on rather than failing the whole install over an
  # optional fallback. The router above is not optional and stays fatal.
  local bridge
  for bridge in \
    'sonnet:ensure-codex-claude-bridge.sh' \
    'MiniMax-M3:ensure-codex-minimax-proxy.sh' \
    'gemini-3.8-flash-medium:ensure-codex-antigravity-proxy.sh'; do
    if ! printf '{"model":"%s"}\n' "${bridge%%:*}" | bash "$repo_root/scripts/${bridge#*:}"; then
      printf 'bridge start failed: %s (router will route around it)\n' "${bridge#*:}" >&2
    fi
  done
  bash "$repo_root/scripts/ensure-codex-copilot-proxy.sh" || \
    printf 'bridge start failed: ensure-codex-copilot-proxy.sh (router will route around it)\n' >&2
}

if [[ "$materialize_only" == 0 ]]; then
  restart_services
else
  printf '%s\n' 'Materialized AutoDev integration without restarting services.' >&2
fi

check_links
