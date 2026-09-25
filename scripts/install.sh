#!/usr/bin/env bash
# AutoDev installation entrypoint.
# Configures user/global tool exclusions and environment (Git global excludes,
# Repomix global configuration, CodeGraphContext global configuration & ignore rules,
# and repo-bootstrap command), then dispatches to AutoDev's typed installer CLI.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
home="${HOME:-$(cd ~ && pwd)}"
xdg_config_home="${XDG_CONFIG_HOME:-$home/.config}"

is_check=0
for arg in "$@"; do
  if [[ "$arg" == "--check" ]]; then
    is_check=1
    break
  fi
done

# Universal exclusions for Git global core.excludesFile
GIT_GLOBAL_EXCLUDES=(
  ".codegraphcontext/"
  ".cgc/"
  ".cgc_cache/"
  ".cgc-cache/"
  ".cgc-state/"
  ".cgc-state-*/"
  ".cgcignore"
  ".repograph/"
  ".repomix/"
  "repomix-output.*"
  "repomix-output-*/"
  ".repomix-output.*"
  ".repomixignore"
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
  "mcp_debug.log"
  "*.launchd.*.log"
  "*.tsbuildinfo"
  ".nyc_output/"
)

# Universal directory pruning for CodeGraphContext traversal
CGC_IGNORE_DIRS="node_modules,dist,build,target,out,coverage,.venv,venv,env,.git,.idea,.vscode,.codegraphcontext,.cgc,.cgc_cache,.cgc-cache,.cgc-state,.repograph,.repomix,.cocoindex_code,.lsp,.lsp-cache,.ccls-cache,.clangd,.agent-cache,.playwright-mcp,.playwright,.ruff_cache,.tox,.nox,.turbo,.svelte-kit,.cache,.tmp,.nyc_output"

# Universal ignore rules for ~/.codegraphcontext/.cgcignore
CGC_GLOBAL_PATTERNS=(
  ".codegraphcontext/"
  ".cgc/"
  ".cgc_cache/"
  ".cgc-cache/"
  ".cgc-state/"
  ".cgc-state-*/"
  ".cgcignore"
  ".repograph/"
  "repomix-output.*"
  ".repomix-output.*"
  "repomix-output-*/"
  ".repomix/"
  ".repomixignore"
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
  "mcp_debug.log"
  "*.launchd.*.log"
  "*.tsbuildinfo"
  ".nyc_output/"
  ".ruff_cache/"
  ".tox/"
  ".nox/"
  ".turbo/"
  ".svelte-kit/"
  ".cache/"
  ".tmp/"
  ".coverage"
)

# Universal customPatterns for Repomix global config
REPOMIX_CUSTOM_PATTERNS=(
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

ensure_git_global_excludes() {
  local excludes_file
  excludes_file="$(git config --global --get core.excludesFile 2>/dev/null || true)"
  if [[ -z "$excludes_file" ]]; then
    excludes_file="$home/.gitignore_global"
    git config --global core.excludesFile "$excludes_file"
  elif [[ "$excludes_file" == "~"* ]]; then
    excludes_file="${home}${excludes_file#\~}"
  fi

  if [[ ! -f "$excludes_file" ]]; then
    mkdir -p "$(dirname "$excludes_file")"
    touch "$excludes_file"
  fi

  local existing_content
  existing_content="$(cat -- "$excludes_file" 2>/dev/null || true)"
  local missing=()
  for pattern in "${GIT_GLOBAL_EXCLUDES[@]}"; do
    if ! echo "$existing_content" | grep -Fqx "$pattern" >/dev/null 2>&1; then
      missing+=("$pattern")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    {
      if [[ -n "$existing_content" && "$existing_content" != *$'\n' ]]; then
        echo ""
      fi
      echo "# AutoDev universal exclusions (CodeGraphContext, Repomix, and caches)"
      for pattern in "${missing[@]}"; do
        echo "$pattern"
      done
    } >> "$excludes_file"
  fi
}

ensure_repomix_global_config() {
  local config_dir="$xdg_config_home/repomix"
  local config_file="$config_dir/repomix.config.json"
  mkdir -p "$config_dir"

  node - "$config_file" "${REPOMIX_CUSTOM_PATTERNS[@]}" <<'EOF'
const fs = require("node:fs");
const configFile = process.argv[2];
const requiredPatterns = process.argv.slice(3);

let config = {};
if (fs.existsSync(configFile)) {
  try {
    config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {}
}
if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
if (!config.ignore || typeof config.ignore !== "object" || Array.isArray(config.ignore)) config.ignore = {};
config.ignore.useGitignore = true;
config.ignore.useDefaultPatterns = true;
config.ignore.useDotIgnore = true;

const set = new Set(Array.isArray(config.ignore.customPatterns) ? config.ignore.customPatterns : []);
for (const p of requiredPatterns) {
  set.add(p);
}
config.ignore.customPatterns = Array.from(set);
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
EOF
}

ensure_cgc_global_config() {
  local cgc_dir="$home/.codegraphcontext"
  local cgc_env="$cgc_dir/.env"
  local cgc_ignore="$cgc_dir/.cgcignore"
  mkdir -p "$cgc_dir"

  # 1. Update IGNORE_DIRS in ~/.codegraphcontext/.env
  node - "$cgc_env" "$CGC_IGNORE_DIRS" <<'EOF'
const fs = require("node:fs");
const envFile = process.argv[2];
const requiredDirs = process.argv[3].split(",");

let content = "";
if (fs.existsSync(envFile)) {
  content = fs.readFileSync(envFile, "utf8");
}

const lines = content.split(/\r?\n/);
let found = false;
const newLines = lines.map(line => {
  if (/^\s*IGNORE_DIRS\s*=/i.test(line)) {
    found = true;
    const match = line.match(/^\s*IGNORE_DIRS\s*=\s*["']?(.*?)["']?\s*$/i);
    const existingDirs = match && match[1] ? match[1].split(",") : [];
    const set = new Set(existingDirs.map(d => d.trim()).filter(Boolean));
    for (const dir of requiredDirs) {
      set.add(dir.trim());
    }
    return `IGNORE_DIRS="${Array.from(set).join(",")}"`;
  }
  return line;
});

if (!found) {
  if (newLines.length > 0 && newLines[newLines.length - 1] !== "") {
    newLines.push("");
  }
  newLines.push(`IGNORE_DIRS="${requiredDirs.join(",")}"`);
}

fs.writeFileSync(envFile, newLines.join("\n") + (newLines[newLines.length - 1] === "" ? "" : "\n"));
EOF

  # 2. Run cgc config set IGNORE_DIRS if cgc CLI is available
  if command -v cgc >/dev/null 2>&1; then
    cgc config set IGNORE_DIRS "$CGC_IGNORE_DIRS" >/dev/null 2>&1 || true
  fi

  # 3. Ensure ~/.codegraphcontext/.cgcignore
  local existing_cgc_content=""
  if [[ -f "$cgc_ignore" ]]; then
    existing_cgc_content="$(cat -- "$cgc_ignore" 2>/dev/null || true)"
  fi
  local missing=()
  for pattern in "${CGC_GLOBAL_PATTERNS[@]}"; do
    if ! echo "$existing_cgc_content" | grep -Fqx "$pattern" >/dev/null 2>&1; then
      missing+=("$pattern")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    {
      if [[ -n "$existing_cgc_content" && "$existing_cgc_content" != *$'\n' ]]; then
        echo ""
      fi
      echo "# CodeGraphContext universal ignore rules (AutoDev)"
      for pattern in "${missing[@]}"; do
        echo "$pattern"
      done
    } >> "$cgc_ignore"
  fi
}

ensure_cgc_package_patches() {
  local venv_python=""
  for candidate in \
    "$home/.local/pipx/venvs/codegraphcontext/bin/python" \
    "$home/.local/pipx/venvs/codegraphcontext/bin/python3"; do
    if [[ -x "$candidate" ]]; then
      venv_python="$candidate"
      break
    fi
  done

  if [[ -z "$venv_python" ]]; then
    return 0
  fi

  "$venv_python" - <<'PYEOF'
import importlib.util, pathlib, sys

try:
    spec = importlib.util.find_spec("codegraphcontext")
    if not spec or not spec.submodule_search_locations:
        sys.exit(0)
    cgc_dir = pathlib.Path(spec.submodule_search_locations[0])

    constants_file = cgc_dir / "tools" / "indexing" / "constants.py"
    if constants_file.exists():
        content = constants_file.read_text(encoding="utf-8")
        if "repomix-output.*" not in content:
            repomix_addition = '\n    # Repomix outputs\n    "repomix-output.*",\n    ".repomix-output.*",\n    "repomix-output-*/",\n    ".repomix/",\n'
            idx = content.find("DEFAULT_IGNORE_PATTERNS = [")
            if idx != -1:
                insert_pos = content.find("\n", idx) + 1
                new_content = content[:insert_pos] + repomix_addition + content[insert_pos:]
                constants_file.write_text(new_content, encoding="utf-8")

    cgcignore_file = cgc_dir / "core" / "cgcignore.py"
    if cgcignore_file.exists():
        cgc_code = cgcignore_file.read_text(encoding="utf-8")
        if "find_global_cgcignore" not in cgc_code:
            global_helpers = '''

def find_global_cgcignore() -> Optional[Path]:
    """Check for global .cgcignore in ~/.codegraphcontext/.cgcignore."""
    global_path = Path.home() / ".codegraphcontext" / ".cgcignore"
    if global_path.exists():
        return global_path
    return None


def find_git_exclude(project_root: Path) -> Optional[Path]:
    """Find .git/info/exclude in the repository."""
    exclude_path = project_root / ".git" / "info" / "exclude"
    if exclude_path.exists():
        return exclude_path
    return None


def find_global_gitignore() -> Optional[Path]:
    """Find global gitignore configured in git core.excludesFile."""
    try:
        import subprocess
        result = subprocess.run(
            ["git", "config", "--global", "--get", "core.excludesFile"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode == 0 and result.stdout.strip():
            p = Path(result.stdout.strip()).expanduser()
            if p.exists():
                return p
    except Exception:
        pass
    default_global = Path.home() / ".gitignore_global"
    if default_global.exists():
        return default_global
    return None
'''
            build_pos = cgc_code.find("def build_ignore_spec(")
            if build_pos != -1:
                cgc_code = cgc_code[:build_pos] + global_helpers + "\n" + cgc_code[build_pos:]
                cgcignore_file.write_text(cgc_code, encoding="utf-8")
except Exception:
    pass
PYEOF
}

ensure_bootstrap_command() {
  local bin_dir="$home/.local/bin"
  local target="$bin_dir/autodev-bootstrap"
  local script="$repo_root/scripts/bootstrap-repo-exclusions.sh"

  mkdir -p "$bin_dir"
  chmod 755 "$script"
  ln -sf "$script" "$target"

  "$target" "$repo_root" >/dev/null 2>&1 || true
}

if [[ $is_check -eq 0 ]]; then
  echo "==> Configuring AutoDev user and global tool exclusions..."
  ensure_git_global_excludes
  ensure_repomix_global_config
  ensure_cgc_global_config
  ensure_cgc_package_patches
  ensure_bootstrap_command
fi

exec env AUTODEV_REPO_ROOT="$repo_root" CODEX_HOME="$codex_home" node "$repo_root/src/cli/install.ts" "$@"
