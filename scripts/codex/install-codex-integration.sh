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
runtime_module_names=(
  scripts/codex/lib/resolve-workspace.mjs
  scripts/codex/lib/bridge-role.mjs
  scripts/codex/lib/agent-events.mjs
  scripts/codex/lib/provider-limits.mjs
  scripts/codex/prompts/base.md
  scripts/codex/prompts/leaf.md
  scripts/codex/prompts/orchestrator.md
)

profile_names=(claude minimax antigravity)
catalog_names=(claude minimax antigravity codex)
agent_role_names=(browser-tester default docs-researcher explorer smart validator worker)
skill_names=(code-simplification diagnosing-bugs improve-codebase-architecture lsp-mcp-server orchestration remove-legacy-shims resolve-merge-conflicts)
rule_names=(default.rules)
custom_provider_names=(local_model_router claude_code_subscription minimax antigravity_cli)
tracked_sources=""

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

  if [[ -d "$repo_root/.codex/agents" ]] && find "$repo_root/.codex/agents" -type f -print -quit 2>/dev/null | grep -q .; then
    printf 'project-local-agent-role-not-allowed %s\n' "$repo_root/.codex/agents"
    failed=1
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
  if ! check_legacy_skill_links; then
    failed=1
  fi
  if ! check_removed_runtime_hooks; then
    failed=1
  fi
  if ! check_versioned_sources; then
    failed=1
  fi
  return "$failed"
}

# `--restart` is gone: installing now always restarts, so a flag asking for it
# described a choice that no longer exists. It is rejected rather than accepted
# as a no-op, because silently ignoring it would leave the caller believing they
# had opted into something.
case "${1:-}" in
  "") ;;
  --check)
    check_links
    exit $?
    ;;
  *)
    printf 'usage: %s [--check]\n' "${BASH_SOURCE[0]##*/}" >&2
    printf 'installing always restarts the services; there is no --restart.\n' >&2
    exit 2
    ;;
esac

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
launchagent_labels=(
  com.codex.model-router
  com.codex.claude-bridge
  com.codex.minimax-proxy
  com.codex.antigravity-proxy
  com.codex.copilot-proxy
)
for label in "${launchagent_labels[@]}"; do
  plist_src="$repo_root/scripts/codex/launchagents/$label.plist"
  if [[ -f "$plist_src" ]]; then
    link_one "$plist_src" "$HOME/Library/LaunchAgents/$label.plist"
  fi
done

# The CODEX_HOME the installed launchagents point at. The plists carry one fixed
# absolute path, so this is the only tree whose services this installer owns.
plist_codex_home() {
  local plist="$repo_root/scripts/codex/launchagents/com.codex.model-router.plist"
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
  local launchd_ok=1 label plist_link probe
  for label in "${launchagent_labels[@]}"; do
    local plist_link="$HOME/Library/LaunchAgents/$label.plist"
    [[ -f "$plist_link" ]] || { launchd_ok=0; continue; }
    launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
    reap_unmanaged "$label"
    if launchctl bootstrap "$domain" "$plist_link" >/dev/null 2>&1; then
      launchctl enable "$domain/$label" >/dev/null 2>&1 || true
      launchctl kickstart -k "$domain/$label" >/dev/null 2>&1 || true
    else
      launchd_ok=0
    fi
  done
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

restart_services

check_links
