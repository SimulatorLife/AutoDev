#!/usr/bin/env bash
# Bootstraps repo-specific, machine-local git and tool exclusions for the
# active checkout.
#
# Principles:
# 1. Configures once at the user/global level wherever possible (e.g.
#    ~/.gitignore_global, ~/.config/repomix/repomix.config.json,
#    ~/.codegraphcontext/.env, ~/.codegraphcontext/.cgcignore).
# 2. Avoids modifying tracked repository files by default. Never edits the
#    tracked .gitignore.
# 3. Uses .git/info/exclude for genuinely repository-specific exclusions
#    (such as /.agents/skills/ when Rulesync generates it, since Antigravity
#    refuses to read skills from a gitignored .agents/skills/), or machine-local
#    tool-config fallbacks when no effective global excludes file is present.
# 4. Inspects active CodeGraphContext (CGC) and Repomix configuration:
#    - If CGC active mode is per-repo (e.g. local .codegraphcontext directory,
#      CGC_MODE=per_repo, or workspace mapping), manages repo-local .cgcignore,
#      merges safely without overwriting user rules, and keeps it untracked in
#      .git/info/exclude.
#    - If Repomix local config disables useGitignore, manages repo-local
#      .repomixignore, merges safely without overwriting, and keeps it untracked
#      in .git/info/exclude.
# 5. Idempotent: rerunning without repo changes leaves all files byte-identical.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bootstrap-repo-exclusions.sh [--check] [--cgc-mode <global|per_repo>] [<repo-root>]

  --check                 Report what would change without modifying files.
                          Exits 1 if changes are needed, 0 if already up to date.
  --cgc-mode <mode>       Explicitly specify CGC tool mode (global or per_repo).
                          Defaults to detecting from active CGC config/repo layout.
  <repo-root>             Git repository to bootstrap. Defaults to current directory.
USAGE
}

check_only=0
cgc_mode_override=""
repo_arg=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      check_only=1
      shift
      ;;
    --cgc-mode)
      if [[ $# -lt 2 ]]; then
        echo "bootstrap-repo-exclusions: --cgc-mode requires an argument (global or per_repo)" >&2
        exit 2
      fi
      cgc_mode_override="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "bootstrap-repo-exclusions: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$repo_arg" ]]; then
        echo "bootstrap-repo-exclusions: unexpected extra argument: $1" >&2
        exit 2
      fi
      repo_arg="$1"
      shift
      ;;
  esac
done

target_dir="${repo_arg:-$PWD}"
if [[ ! -d "$target_dir" ]]; then
  echo "bootstrap-repo-exclusions: not a directory: $target_dir" >&2
  exit 1
fi

if ! repo_root="$(cd -- "$target_dir" && git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "bootstrap-repo-exclusions: $target_dir is not inside a git repository" >&2
  exit 1
fi

exclude_path="$(git -C "$repo_root" rev-parse --path-format=absolute --git-path info/exclude)"
gitignore_path="$repo_root/.gitignore"

# --- 1. Inspect and verify operator's global Git excludes ---
global_excludes_file="$(git -C "$repo_root" config --get core.excludesFile 2>/dev/null || true)"
if [[ -z "$global_excludes_file" ]]; then
  xdg_config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  default_global="$xdg_config_home/git/ignore"
  if [[ -f "$default_global" ]]; then
    global_excludes_file="$default_global"
  fi
fi
if [[ -n "$global_excludes_file" && "$global_excludes_file" == "~"* ]]; then
  global_excludes_file="${HOME}${global_excludes_file#\~}"
fi

global_excludes_effective=0
global_excludes_content=""
if [[ -n "$global_excludes_file" && -r "$global_excludes_file" ]]; then
  global_excludes_effective=1
  global_excludes_content="$(cat -- "$global_excludes_file")"
  echo "bootstrap-repo-exclusions: global excludes effective at $global_excludes_file"
else
  echo "bootstrap-repo-exclusions: no effective global excludes file (core.excludesFile is unset or unreadable); machine-local tool-config fallbacks will be added to $exclude_path instead" >&2
fi

gitignore_content=""
if [[ -f "$gitignore_path" ]]; then
  gitignore_content="$(cat -- "$gitignore_path")"
fi

line_covered() {
  local needle="$1" haystack="$2"
  local IFS_saved="$IFS"
  IFS=$'\n'
  local line
  for line in $haystack; do
    if [[ "$line" == "$needle" ]]; then
      IFS="$IFS_saved"
      return 0
    fi
  done
  IFS="$IFS_saved"
  return 1
}

is_tracked_in_git() {
  local rel_path="$1"
  git -C "$repo_root" ls-files --error-unmatch "$rel_path" >/dev/null 2>&1
}

# --- 2. Inspect active CGC configuration and mode ---
# CGC operates in 'global' mode by default. If per-repo mode is configured
# or a child context (.codegraphcontext directory) exists in the repo, a
# local .cgcignore may be required.
cgc_mode="global"
if [[ -n "$cgc_mode_override" ]]; then
  cgc_mode="$cgc_mode_override"
elif [[ -n "${CGC_MODE:-}" ]]; then
  cgc_mode="$CGC_MODE"
elif [[ -d "$repo_root/.codegraphcontext" ]]; then
  cgc_mode="per_repo"
elif [[ -f "${HOME}/.codegraphcontext/config.yaml" ]]; then
  if grep -q "mode:[[:space:]]*per_repo" "${HOME}/.codegraphcontext/config.yaml" 2>/dev/null; then
    cgc_mode="per_repo"
  elif grep -q "$repo_root" "${HOME}/.codegraphcontext/config.yaml" 2>/dev/null; then
    cgc_mode="per_repo"
  fi
fi

# Standard patterns for CGC if repo-local .cgcignore is required
cgc_required_patterns=(
  "repomix-output.*"
  ".repomix-output.*"
  "repomix-output-*/"
  ".repomix/"
  ".repomixignore"
  ".codegraphcontext/"
  ".cgc/"
  ".cgc_cache/"
  ".cgc-cache/"
  ".cgc-state/"
  ".cgc-state-*/"
  ".cgcignore"
  ".cocoindex_code/"
  ".lsp/"
  ".lsp-cache/"
  ".ccls-cache/"
  ".clangd/"
  ".agent-cache/"
  ".agents/cache/"
  ".claude/cache/"
  ".playwright-mcp/"
  ".playwright/"
  "node_modules/"
  "venv/"
  ".venv/"
  "__pycache__/"
  ".pytest_cache/"
  ".mypy_cache/"
  ".ruff_cache/"
  ".tox/"
  ".nox/"
  ".coverage"
  "coverage/"
  "dist/"
  "build/"
  "target/"
  "out/"
  "obj/"
  "*.tsbuildinfo"
  "*.png"
  "*.jpg"
  "*.jpeg"
  "*.gif"
  "*.svg"
  "*.mp4"
  "*.mp3"
  "*.zip"
  "*.tar"
  "*.gz"
)

# --- 3. Inspect active Repomix configuration ---
repomix_config_file=""
repomix_disables_gitignore=0
for cand in "repomix.config.json" "repomix.config.jsonc" "repomix.config.json5" "repomix.config.ts" "repomix.config.js" "repomix.config.mjs" "repomix.config.cjs"; do
  if [[ -f "$repo_root/$cand" ]]; then
    repomix_config_file="$repo_root/$cand"
    if grep -q '"useGitignore"[[:space:]]*:[[:space:]]*false' "$repomix_config_file" 2>/dev/null; then
      repomix_disables_gitignore=1
    fi
    break
  fi
done

repomix_required_patterns=(
  "**/.codegraphcontext/**"
  "**/.cgc/**"
  "**/.cgc_cache/**"
  "**/.cgc-cache/**"
  "**/.cgc-state/**"
  "**/.cgc-state-*/**"
  "**/.cgcignore"
  "**/.repomix/**"
  "**/repomix-output.*"
  "**/.repomix-output.*"
  "**/repomix-output-*/**"
  "**/.repomixignore"
  "**/.cocoindex_code/**"
  "**/.lsp/**"
  "**/.lsp-cache/**"
  "**/.ccls-cache/**"
  "**/.clangd/**"
  "**/.agent-cache/**"
  "**/.agents/cache/**"
  "**/.claude/cache/**"
  "**/.playwright-mcp/**"
  "**/.playwright/**"
  "**/.ruff_cache/**"
  "**/.tox/**"
  "**/.nox/**"
  "**/.turbo/**"
  "**/.svelte-kit/**"
  "**/.cache/**"
  "**/.tmp/**"
  "**/*.tsbuildinfo"
  "**/.coverage"
  "**/.repograph/**"
  "**/.nyc_output/**"
)

# Track pending changes across all files
pending_changes=0

# Helper to merge ignore patterns into a file safely without overwriting
merge_ignore_patterns() {
  local target_file="$1"
  local marker="$2"
  shift 2
  local patterns=("$@")
  local existing=""
  if [[ -f "$target_file" ]]; then
    existing="$(cat -- "$target_file")"
  fi
  local missing=()
  for pat in "${patterns[@]}"; do
    if ! line_covered "$pat" "$existing"; then
      missing+=("$pat")
    fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    return 0
  fi
  if [[ "$check_only" -eq 1 ]]; then
    echo "bootstrap-repo-exclusions: would add to $target_file:" >&2
    for m in "${missing[@]}"; do
      echo "  $m" >&2
    done
    pending_changes=1
    return 0
  fi
  mkdir -p -- "$(dirname -- "$target_file")"
  local separator=""
  if [[ -n "$existing" ]]; then
    separator=$'\n'
  fi
  {
    printf '%s' "$existing"
    printf '%s' "$separator"
    if ! line_covered "$marker" "$existing"; then
      printf '%s\n' "$marker"
    fi
    for m in "${missing[@]}"; do
      printf '%s\n' "$m"
    done
  } >"${target_file}.tmp"
  mv -- "${target_file}.tmp" "$target_file"
  echo "bootstrap-repo-exclusions: merged ${#missing[@]} patterns into $target_file"
}

# --- 4. Reconcile repo-local .cgcignore if required by active tool mode ---
if [[ "$cgc_mode" == "per_repo" ]]; then
  cgcignore_file="$repo_root/.cgcignore"
  marker="# AutoDev repo-bootstrap (active per-repo tool mode exclusions)"
  merge_ignore_patterns "$cgcignore_file" "$marker" "${cgc_required_patterns[@]}"
fi

# --- 5. Reconcile repo-local .repomixignore if required by active tool mode ---
if [[ "$repomix_disables_gitignore" -eq 1 ]]; then
  repomixignore_file="$repo_root/.repomixignore"
  marker="# AutoDev repo-bootstrap (Repomix useGitignore:false exclusions)"
  merge_ignore_patterns "$repomixignore_file" "$marker" "${repomix_required_patterns[@]}"
fi

# --- 6. Determine required untracked entries for .git/info/exclude ---
declare -a candidate_entries=()

# Repository-specific toolchain needs:
if [[ -d "$repo_root/.rulesync/skills" && -d "$repo_root/.agents" ]]; then
  # Antigravity does not load skills from a gitignored .agents/skills/, so
  # this Rulesync-generated output must live in info/exclude rather than the
  # tracked .gitignore.
  candidate_entries+=("/.agents/skills/")
fi

if [[ -d "$repo_root/.codegraphcontext" ]]; then
  candidate_entries+=("/.codegraphcontext/")
fi

# If repo-local tool ignore files exist and are untracked by git, keep them untracked:
if [[ -f "$repo_root/.cgcignore" ]] && ! is_tracked_in_git ".cgcignore"; then
  candidate_entries+=(".cgcignore")
fi

if [[ -f "$repo_root/.repomixignore" ]] && ! is_tracked_in_git ".repomixignore"; then
  candidate_entries+=(".repomixignore")
fi

# Machine-local fallbacks if global git excludes is not effective:
if [[ "$global_excludes_effective" -eq 0 ]]; then
  candidate_entries+=(
    ".claude/settings.local.json"
    ".cgc/"
    ".codegraphcontext/"
    ".cgcignore"
    ".cocoindex_code/"
    ".lsp/"
    ".agent-cache/"
    ".playwright-mcp/"
    "mcp_debug.log"
    "repomix-output.*"
    ".repomix/"
    ".repomixignore"
  )
fi

# --- 7. Reconcile .git/info/exclude: only genuinely missing entries ---
declare -a missing_entries=()
exclude_content=""
if [[ -f "$exclude_path" ]]; then
  exclude_content="$(cat -- "$exclude_path")"
fi

if [[ ${#candidate_entries[@]} -gt 0 ]]; then
  for entry in "${candidate_entries[@]}"; do
    if line_covered "$entry" "$gitignore_content"; then
      continue
    fi
    if [[ "$global_excludes_effective" -eq 1 ]] && line_covered "$entry" "$global_excludes_content"; then
      continue
    fi
    if line_covered "$entry" "$exclude_content"; then
      continue
    fi
    # Deduplicate within missing_entries
    already_missing=0
    for m in "${missing_entries[@]:-}"; do
      if [[ "$m" == "$entry" ]]; then
        already_missing=1
        break
      fi
    done
    if [[ "$already_missing" -eq 0 ]]; then
      missing_entries+=("$entry")
    fi
  done
fi

if [[ ${#missing_entries[@]} -gt 0 ]]; then
  if [[ "$check_only" -eq 1 ]]; then
    echo "bootstrap-repo-exclusions: would add to $exclude_path:" >&2
    for entry in "${missing_entries[@]}"; do
      echo "  $entry" >&2
    done
    pending_changes=1
  else
    mkdir -p -- "$(dirname -- "$exclude_path")"
    if [[ ! -f "$exclude_path" ]]; then
      printf '' >"$exclude_path"
    fi
    existing="$(cat -- "$exclude_path")"
    separator=""
    if [[ -n "$existing" ]]; then
      separator=$'\n'
    fi
    marker="# Added by scripts/bootstrap-repo-exclusions.sh (repo-specific, not for .gitignore)"
    {
      printf '%s' "$existing"
      printf '%s' "$separator"
      if ! line_covered "$marker" "$exclude_content"; then
        printf '%s\n' "$marker"
      fi
      for entry in "${missing_entries[@]}"; do
        printf '%s\n' "$entry"
      done
    } >"$exclude_path.tmp"
    mv -- "$exclude_path.tmp" "$exclude_path"
    echo "bootstrap-repo-exclusions: added ${#missing_entries[@]} entr$([[ ${#missing_entries[@]} -eq 1 ]] && echo y || echo ies) to $exclude_path"
  fi
fi

if [[ "$check_only" -eq 1 ]]; then
  if [[ "$pending_changes" -eq 1 ]]; then
    exit 1
  fi
  echo "bootstrap-repo-exclusions: all repository exclusions up to date (check passed)"
  exit 0
fi

if [[ ${#missing_entries[@]} -eq 0 && "$pending_changes" -eq 0 ]]; then
  echo "bootstrap-repo-exclusions: $exclude_path is already up to date"
fi

exit 0
