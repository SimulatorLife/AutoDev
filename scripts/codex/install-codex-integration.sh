#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
hooks_dir="$codex_home/hooks"
agents_dir="$codex_home/agents"
rules_dir="$codex_home/rules"
user_skills_dir="$HOME/.agents/skills"
legacy_skills_dirs=("$codex_home/skills" "$codex_home/agents/skills")
litellm_dir="$HOME/.config/litellm"

hook_names=(
  codex-antigravity-cli-responses-proxy.mjs
  codex-claude-cli-responses-proxy.py
  codex-copilot-cli-responses-proxy.mjs
  codex-model-router.mjs
  codex-model-router-status.mjs
  enforce-root-delegation.sh
  ensure-codex-antigravity-proxy.sh
  ensure-codex-claude-bridge.sh
  ensure-codex-copilot-proxy.sh
  ensure-codex-model-router.sh
  ensure-codex-minimax-proxy.sh
  run-codex-antigravity-litellm.sh
  run-codex-antigravity-proxy.sh
  run-codex-claude-bridge.sh
  run-codex-copilot-cli-responses-proxy.sh
  run-codex-model-router.sh
)
obsolete_runtime_hook_names=(log-subagent-model.sh)

dashboard_asset_names=(codex-model-router-dashboard.html)
runtime_module_names=(scripts/codex/lib/resolve-workspace.mjs)

profile_names=(claude minimax antigravity)
catalog_names=(claude minimax antigravity codex)
agent_role_names=(browser-tester default docs-researcher explorer smart validator worker)
skill_names=(diagnosing-bugs improve-codebase-architecture lsp-mcp-server orchestration remove-legacy-shims code-simplification)
rule_names=(default.rules)
custom_provider_names=(local_model_router claude_code_subscription minimax antigravity_cli)
tracked_sources=""

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
  for source in "$repo_root/scripts/codex/config.toml" "$repo_root/scripts/codex/install-codex-integration.sh" "$repo_root/scripts/codex/litellm/antigravity.yaml" \
    "$repo_root/scripts/codex/launchagents/com.codex.model-router.plist" \
    "$repo_root/scripts/codex/launchagents/com.codex.claude-bridge.plist" \
    "$repo_root/scripts/codex/launchagents/com.codex.minimax-proxy.plist" \
    "$repo_root/scripts/codex/launchagents/com.codex.antigravity-litellm.plist" \
    "$repo_root/scripts/codex/launchagents/com.codex.antigravity-proxy.plist"; do
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
  for name in "${obsolete_runtime_hook_names[@]}"; do
    target="$hooks_dir/$name"
    if [[ -e "$target" || -L "$target" ]]; then
      printf 'obsolete-runtime-hook %s\n' "$target"
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
    target="$hooks_dir/$name"
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
  source="$repo_root/scripts/codex/litellm/antigravity.yaml"
  target="$litellm_dir/antigravity.yaml"
  if [[ -f "$target" && ! -L "$target" ]] && cmp -s "$source" "$target"; then
    printf 'ok %s (runtime copy of %s)\n' "$target" "$source"
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

if [[ "${1:-}" == "--check" ]]; then
  check_links
  exit $?
fi

for name in "${obsolete_runtime_hook_names[@]}"; do
  target="$hooks_dir/$name"
  if [[ -e "$target" || -L "$target" ]]; then
    rm -f -- "$target"
    printf 'removed obsolete runtime hook %s\n' "$target"
  fi
done

for name in "${runtime_module_names[@]}"; do
  source="$repo_root/$name"
  target="$hooks_dir/$name"
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
mkdir -p -- "$litellm_dir"
if [[ -L "$litellm_dir/antigravity.yaml" ]]; then
  rm -f -- "$litellm_dir/antigravity.yaml"
fi
install -m 0644 "$repo_root/scripts/codex/litellm/antigravity.yaml" "$litellm_dir/antigravity.yaml"

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
  com.codex.antigravity-litellm
  com.codex.antigravity-proxy
)
for label in "${launchagent_labels[@]}"; do
  plist_src="$repo_root/scripts/codex/launchagents/$label.plist"
  if [[ -f "$plist_src" ]]; then
    link_one "$plist_src" "$HOME/Library/LaunchAgents/$label.plist"
  fi
done

if [[ "${1:-}" == "--restart" ]]; then
  domain="gui/$(id -u)"
  launchd_ok=1
  for label in "${launchagent_labels[@]}"; do
    plist_link="$HOME/Library/LaunchAgents/$label.plist"
    [[ -f "$plist_link" ]] || { launchd_ok=0; continue; }
    launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
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
      http://127.0.0.1:4001/health/liveliness \
      http://127.0.0.1:4002/health/liveliness \
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
  printf '{"model":"sonnet"}\n' | bash "$repo_root/scripts/ensure-codex-claude-bridge.sh"
  printf '{"model":"MiniMax-M3"}\n' | bash "$repo_root/scripts/ensure-codex-minimax-proxy.sh"
  printf '{"model":"gemini-3.6-flash-medium"}\n' | bash "$repo_root/scripts/ensure-codex-antigravity-proxy.sh"

fi

check_links