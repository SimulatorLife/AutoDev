# Local AI and provider setup

> This is an operational/current-state runbook. The canonical future ownership and AutoDev Console target live in [`docs/autodev-console-target-state.md`](autodev-console-target-state.md). Where this file describes native role TOMLs or other transitional inputs, do not treat them as a competing long-term source of truth; RuleSync is the target canonical source for every agent-facing configuration surface it natively supports.

The `scripts/` tree is the tracked home for the local-PC setup previously kept in RacingGame. It includes provider proxies/routers, Codex role and model configuration, launch agents, installation/ensure scripts, and provider health checks.

## Installation

AutoDev now requires Node 24.12+ for native TypeScript execution. Validate the
checkout and typed configuration surfaces with:

```bash
pnpm run typecheck
pnpm autodev -- check
```

Start with the installer and read the script before running it:

```bash
bash scripts/install.sh
# or: pnpm run install:codex
```

Provider-specific `ensure-*` and `run-*` scripts are intentionally separate so a machine can enable only the providers it has credentials for. Use environment variables documented in each script to override local binary paths and project roots; do not add machine secrets or generated logs to this repository.

### Typed CLI commands

`pnpm autodev -- --help` lists every command family and the values each one
accepts. The list is generated from the same declarations the dispatchers
validate against, so a command cannot be advertised there and rejected by the
CLI:

```text
Usage: pnpm autodev -- <command> [subcommand] [options]

Commands:
  check
  render agents|contract|mcp|catalog
  router run|ensure|status
  provider claude|minimax|copilot|antigravity
  hook session-start|subagent-start|root-delegation|skill-read
  repo bootstrap
  install
```

Every rejection names the values it would have accepted, so a typo does not
require reading the source to recover. Omitting a subcommand says which one is
missing rather than reporting the command itself as unknown:

```console
$ pnpm autodev -- render
autodev: render target requires one of: agents, contract, mcp, or catalog
$ pnpm autodev -- provider openai
autodev: unsupported provider: openai (expected one of: claude, minimax, copilot, or antigravity)
$ pnpm autodev -- repo
autodev: repo subcommand requires one of: bootstrap
$ pnpm autodev -- statuss
autodev: unsupported command: statuss (expected one of: check, render, router, provider, hook, repo, or install)
```

Commands exit `0` on success and `2` on a rejected argument. Diagnostics go to
stderr through `writeErrorLine`; command output goes to stdout, so a caller can
separate them.

### Repo-specific git and tool exclusions bootstrap

`scripts/bootstrap-repo-exclusions.sh` (also available via `autodev repo bootstrap`
and `~/.local/bin/autodev-bootstrap`) idempotently reconciles a checkout's
`.git/info/exclude` and tool-specific exclusions without manually configuring each
repository. It adheres to the configure-once-globally principle: universal local
and tool-generated artifacts are ignored at the user/global level
(`~/.gitignore_global`, `~/.config/repomix/repomix.config.json`,
`~/.codegraphcontext/.env`, and `~/.codegraphcontext/.cgcignore`), so arbitrary
repositories work out-of-the-box without modifying tracked repository files.

When entering a codebase, the bootstrap runs automatically on session start
(via the `SessionStart` hook) or can be executed directly:

```bash
autodev repo bootstrap                               # reconcile active repository
autodev repo bootstrap --check                       # report only, exit 1 if changes are pending
autodev repo bootstrap --cgc-mode per_repo [<path>]  # specify active tool mode explicitly
# or: bash scripts/bootstrap-repo-exclusions.sh [--check] [<repo-root>]
```

It inspects the active repository and toolchain configuration:

- **Global Git excludes verification:** Detects whether the operator's global
  excludes file (`git config core.excludesFile`, falling back to
  `$XDG_CONFIG_HOME/git/ignore` or `~/.gitignore_global`) is effective and
  covers universal tool artifacts.
- **Active CodeGraphContext (CGC) mode:** CGC runs in `global` mode by default,
  where global settings (`~/.codegraphcontext/.env`'s `IGNORE_DIRS` and
  `~/.codegraphcontext/.cgcignore`) ignore Repomix outputs and build/cache
  artifacts without repo-local files. If CGC is in `per_repo` mode (e.g. a
  `.codegraphcontext` directory exists or is mapped), the bootstrap safely
  creates/merges a repo-local `.cgcignore` preserving existing user patterns,
  and ensures it is kept untracked in `.git/info/exclude`.
- **Active Repomix mode:** Repomix respects `.gitignore` and global excludes
  by default (`useGitignore: true`). If a repository's local `repomix.config.json`
  explicitly disables gitignore (`"useGitignore": false`), the bootstrap safely
  creates/merges `.repomixignore` with required CGC, CGC report artifacts (`CGC_REPORT.md`), CocoIndex, LSP, and tool
  cache patterns and ensures it is kept untracked in `.git/info/exclude`.
- **Repository-specific needs:** Adds `/.agents/skills/` to `.git/info/exclude`
  only when the repo generates Rulesync output there (`.rulesync/skills/` plus an
  `.agents/` directory present), matching the reason the installer excludes it:
  Antigravity does not load skills from a gitignored `.agents/skills/`.
- **Machine-local fallbacks:** Adds universal tool fallbacks (`.claude/settings.local.json`,
  `.cgc/`, `.codegraphcontext/`, `.cgcignore`, `repomix-output.*`, `.repomix/`,
  `.repomixignore`, `CGC_REPORT.md`, `.cocoindex_code/`, `.lsp/`, `.agent-cache/`, `.playwright-mcp/`,
  `mcp_debug.log`) only when no global excludes file is effective yet.
- **Idempotence & preservation:** It never modifies tracked `.gitignore` or
  tracked repository files, preserves pre-existing user configuration, and reruns
  are byte-identical when nothing has changed.

`tests/bootstrap-repo-exclusions.test.ts` exercises the script against real
temporary git repositories to prove idempotence, CGC/Repomix mode adaptations,
safe merging, no-duplication guarantees, and non-zero exit outside a git repository.

### CodeGraphContext graph bootstrap

The session-start hook also keeps the active checkout's CodeGraphContext graph
present and current, so agents never index repositories themselves. After the
router is healthy, `runtime/src/hooks/session-start.ts` calls `ensureCodeGraph` through
the `@simulatorlife/autodev-runtime/platform` workspace contract. Outside a git
checkout it does nothing.
Inside one it starts a detached worker for the repository's top level and
returns immediately, so it adds no session-start latency. The worker:

- takes a per-repository lock, so a burst of sessions runs one refresh; a lock
  left by a process that has exited is replaced;
- hashes `HEAD` plus `git status --porcelain`, and exits without touching CGC
  when the graph already holds the repository and that stamp matches the last
  successful run;
- otherwise runs `codegraphcontext index --no-progress <root>` for a repository
  the graph does not list, or `codegraphcontext update --quiet <root>` for one
  it does, recording the new stamp only on success so a failure retries at the
  next session start.

Its state lives in `$CODEX_HOME/provider-runtime/code-graph/<hash>/` (`lock`,
`state.json`, and `worker.log`); nothing is written to the repository. The
worker uses the same binary resolution as the MCP launcher, including
`AUTODEV_CODEGRAPHCONTEXT_BIN`, and shares CGC's FalkorDB server with the
running MCP servers. `tests/platform/code-graph-ensure.test.ts` covers it.

### User configuration composition

Codex user-level configuration is managed via a composed model rather than a direct symlink:

- **Portable runtime/provider source (`config/config.autodev.toml`):** Contains AutoDev-owned model/provider, telemetry, feature, and shell/runtime settings that are not canonical RuleSync agent-facing configuration. Agent/skill/MCP/hook/permission definitions belong in RuleSync where supported; `.rulesync/mcp.jsonc` is already canonical for MCP declarations.
- **Composer (`runtime/src/config/compose-user-config.ts`):** Deterministically merges the portable source and the Rulesync-generated MCP projection with existing machine-local state at `$CODEX_HOME/config.toml`. AutoDev-owned settings win conflicts, while operator-specific keys (such as `notify`, `projects`, `marketplaces`, desktop/TUI preferences, custom non-AutoDev MCP servers, and user-added skills) are preserved.
- **Root role settings:** The root turn is the orchestrator, so the composer overlays `agents/roles/orchestrator.toml`'s per-server settings (`enabled`, `enabled_tools`, `default_tools_approval_mode`) onto each server the MCP projection declares, the same keys a child role's TOML owns for that child. Launch keys stay with the projection. Orchestrator entries the projection does not declare (the bridge-injected `autodev_spawn` and the plugin-owned `codex_app`) add nothing to `mcp_servers`. This is what gives native and Claude-served root turns the orchestrator's scoped CodeGraphContext tools rather than CGC's full surface.
- **Hook and state handling:** `.rulesync/hooks.jsonc` is the sole hook declaration source. The installer generates provider projections alongside repository skills, including `.codex/hooks.json` in the active project location Codex reads; `--check` validates those outputs. The composer removes legacy Codex hook event arrays while preserving `hooks.state` and unrelated machine-local state. Rulesync projections are lossy where documented: Codex cannot retain `prevent_idle_sleep`, and Copilot/Antigravity support fewer hook events.
- **Regular file output:** Writes an atomic regular file to `$CODEX_HOME/config.toml` (never a symlink). Codex resolves configuration at startup, and symlinking would cause local overrides to be overwritten or lost.
- **Legacy seed retirement:** `config/config.toml` is no longer tracked or authoritative. An older installation with a valid symlink target is migrated once into a regular composed file at `$CODEX_HOME/config.toml`; a broken legacy symlink fails closed rather than discarding machine-local state.
- **Drift detection:** `bash scripts/install.sh --check` invokes the composer in `--check` mode to detect any drift between the installed configuration and the composed portable source without writing changes.

The tracked Codex role files under `agents/roles/` contain role-specific
configuration plus shared-prompt composition markers. The installer renders
`base.md`, `leaf.md`, and the optional `code-search.md` piece into regular files
under `$CODEX_HOME/agents/` before Codex loads them; provider identity remains configured in the provider
profiles/catalogs, while role names stay stable and codebase-agnostic. Agent
configurations do not hardcode `model_reasoning_effort` so child
agents inherit their configured model reasoning effort; this ensures compatibility
with models like MiniMax-M3 that only support `none` or `high` reasoning. A
role's `[mcp_servers.<name>]` tables declare only per-role settings (`enabled`,
`default_tools_approval_mode`, `enabled_tools`). The renderer copies each
server's launch keys from the Codex projection of `.rulesync/mcp.jsonc`:
`command` and `args`, or `url` plus `transport = "streamable_http"`. Every
rendered entry is therefore a complete server even when disabled, and a role
naming a server `.rulesync/mcp.jsonc` does not declare fails to render. Codex App connectors are native app tools rather than role MCP
servers and must not be represented as enabled-only role tables.

`.rulesync/mcp.jsonc` declares the `codegraphcontext`, `lsp`, `cocoindex-code`,
and `playwright` MCP servers through the installed `run-autodev-mcp.sh` launcher,
`openaiDeveloperDocs` by URL, and `context7` by URL. `context7` is the hosted
`https://mcp.context7.com/mcp` server that resolves third-party library IDs and
returns version-pinned docs and source snippets; the operator supplies the
`CONTEXT7_API_KEY` env var and Codex's `bearer_token_env_var` plumbing forwards
it as the bearer token, so the key never leaves the operator's shell. The
`context7` entry is registered at user-level but the role TOMLs explicitly
gate it: `docs-researcher` and `explorer` enable it (their bounded work
frequently needs to answer "how do I call method X on library Y" or "what's the
current signature for API Z"); `orchestrator` and `browser-tester` explicitly
disable it so the root turn never picks it up and the UI-testing role never
diverts from Playwright. Other roles (`default`, `worker`, `validator`,
`smart`) intentionally omit `context7` and follow their existing MCP surface. The launcher resolves binaries from
AutoDev's pinned devDependencies while preserving the active workspace as the
MCP process cwd, so a target repository does not need to duplicate those
packages.

That cwd contract only holds when the caller launches from inside the
workspace. A host that starts MCP servers from its own process directory
instead leaves `cocoindex-code` with no project at all: `ccc mcp` binds its
index to the nearest ancestor holding `.cocoindex_code` and refuses to start
when there is none, and its auto-init cannot create one on a read-only root.
Such a caller sets `AUTODEV_MCP_WORKSPACE` to the absolute path of the active
workspace, and `runtime/src/mcp/launcher.ts` runs the server there rather than
inheriting the caller's directory. The launcher rejects a relative or missing
workspace rather than starting in the wrong project, and initializes a
cocoindex project in the workspace only when no ancestor already holds one.
`AUTODEV_MCP_WORKSPACE` composes with `AUTODEV_REPO_ROOT`, which selects the
AutoDev checkout supplying the launcher code and its pinned binaries, so a host
with more than one AutoDev checkout still runs the workspace it intends.
`tests/config/mcp-launcher.test.ts` covers both.

Both resolve from pinned AutoDev devDependencies (`lsp-mcp-server` and `@playwright/mcp`) rather
than `pnpm dlx @playwright/mcp@latest`; `dlx @latest` re-resolves the package on
every cold start (network + startup latency), grows the pnpm `dlx` cache, and
drifts the version across hosts and agents, so it is not used. Code-oriented
roles (`default`, `explorer`, `worker`, `validator`, and `smart`) enable the
`lsp` server and the `lsp-mcp-server` skill. The normal implementation roles
(`default` and `worker`) scope `lsp` with `enabled_tools` to its precision
tools: symbol lookup (`lsp_find_symbol`, `lsp_smart_search`), definitions,
references, implementations, type hierarchy, hover, signatures, document
symbols, diagnostics, and rename/code-action/format refactoring. They do not
see `lsp_workspace_symbols` (CocoIndex owns discovery and `lsp_find_symbol`
bundles it), `lsp_call_hierarchy`, `lsp_file_imports`, or `lsp_related_files`
(CodeGraphContext owns call and dependency relationships), or the editor and
server-lifecycle tools. `explorer`, `validator`, `smart`, and `orchestrator`
keep the full LSP surface as the fallback for questions the preferred owner
cannot answer. `tests/config/config-rendering.test.ts` freezes that split.
Copilot registers `lsp` per session, as it does `codegraphcontext`, so the
bridge can apply each role's allowlist: `.rulesync/mcp.jsonc` removes both from
Copilot's user-level file. The `browser-tester` and `smart`
roles use the pinned TypeScript language server from AutoDev's devDependencies;
the installer also installs `python-lsp-server==1.15.0` with pipx so Python
files have a working `pylsp` backend. The launcher adds both AutoDev's
`node_modules/.bin` and the pipx user bin directory to `PATH` before starting
the LSP MCP server. The `browser-tester` and `smart`
role files explicitly enable the `playwright` server and pin its tool approval
mode to `approve`; this explicit role-level enablement is required because the
role block overrides the user-level MCP entry. The `browser-tester` and
`docs-researcher` roles explicitly disable `lsp` because their bounded work does
not require code navigation. AutoDev declares the MCP bridge, browser
automation, and TypeScript language-server dependencies so this repository can
launch and use them with `pnpm exec`. Other active repositories need to expose
the same `lsp-mcp-server` and `playwright-mcp` commands through their package
manager for the user-level MCP entries to work there. The `docs-researcher`
role enables the OpenAI Developer Docs MCP and Codex's native `web_search`
tool, which includes web fetching/opening and is the appropriate search/open/read
path for authoritative websites. Do not add a separate Codex `web_fetch` tool.
Its rendered remote MCP entry sets `transport = "streamable_http"`, which the
installed Codex 0.153.x role loader requires even when `url` is present.
The Playwright MCP remains strictly for UI and browser testing roles and is disabled
for `docs-researcher`, which must explicitly use web search/fetch tools and never Playwright.
`smart` and `orchestrator` follow the web-research policy. A Claude-served turn acts only
through Codex's own tools, so it reaches exactly the MCP servers and Playwright tools its
Codex role TOML enables; the Claude bridge passes `--strict-mcp-config` with only the
per-turn Codex tools server, so user-level `~/.claude.json` servers and a workspace's own
`.mcp.json` never reach a bridged turn. Only `browser-tester` and `smart` receive Playwright.
Playwright is never exposed to the root orchestrator. Antigravity's registry is
global, so its bridge creates an invocation-scoped temporary home that exposes
only the current role's contracted MCP servers and tools. This lets `browser-tester`
and `smart` use their Playwright allowlists without changing the global registry
or exposing Playwright to other roles. For documentation and web research,
Antigravity uses its native `search_web` and `read_url_content` tools.

The installer installs CodeGraphContext `0.6.13` and CocoIndex Code
`0.2.41` with pipx at pinned versions. The `codegraphcontext` MCP starts
through `run-autodev-mcp.sh` in the active workspace; its graph database
persists between turns. Session start indexes and refreshes the active
checkout's graph (see "CodeGraphContext graph bootstrap"). For code work, agents
check `list_indexed_repositories` once and treat CGC as unavailable when the
repository is not listed yet, because CGC answers queries about an unindexed
repository with empty results. CocoIndex Code stores its
incremental semantic index in the workspace's `.cocoindex_code/` directory and
is used only when the relevant concept or implementation location remains
unknown after graph discovery. Its MCP search refreshes changed files; `ccc init`
is needed only if the MCP reports that the repository is not initialized.

The CodeGraphContext allowlist, in every code-capable role TOML and (through
the orchestrator role) the root config, exposes only `list_indexed_repositories`,
`find_code`, `analyze_code_relationships`, and `get_repository_stats`; indexing
belongs to session start, and raw Cypher, deletion, remote indexing, and
directory-watching tools are excluded. The installer runs
none of `codex mcp add`, `copilot mcp add`, or `agy mcp add`: Rulesync writes
user-level MCP files from the canonical declaration. Install pipx before running
the installer if it is not already present.

Native role contracts enable CodeGraphContext, CocoIndex, and LSP for the
root orchestrator and code-capable profiles, and omit them from
`docs-researcher` and `browser-tester`. Codex-native and bridged providers
enforce these role contracts. Antigravity is the exception: its MCP registry is
global and has no per-role server filtering, so its four explicitly permitted
CodeGraphContext tools are also visible to `docs-researcher` sessions despite
that role's contract. The docs-researcher prompt forbids using local-code tools;
this is prompt policy, not a capability boundary. Antigravity rejects
`browser-tester` requests because Playwright cannot be isolated there.

The installer exposes these AutoDev-owned shared skill directories in
`$HOME/.agents/skills/` through symlinks. A Claude-served turn reads them through
Codex's tools from the skills catalogue in Codex's own context, like any Codex-served
turn, so there is no Claude-specific skill view; the installer removes the obsolete
`$CODEX_HOME/provider-runtime/claude/` views. The root `orchestration` skill is
also enabled in the parent user config and injected deterministically into root
turns by the delegation hook and provider bridges; leaf role TOMLs keep it
disabled so child agents do not inherit parent orchestration policy.

Antigravity has a global MCP registry and workspace customization discovery.
The installer registers the pinned `codegraphcontext`, `cocoindex-code`, and
`lsp` MCP servers with `agy`; `.agents/skills.json` continues to expose the
`ccc` and `lsp-mcp-server` skills from the canonical `.rulesync/skills/` source.
The shared code-search prompt directs code roles to CGC first. The bridge filters
the installed MCP catalogue for each invocation and creates a temporary home
containing only that role's contracted servers and tool grants. It preserves
explicit user denies and does not rewrite the global registry or settings.
CodeGraphContext tool grants remain explicit rather than wildcarded.

Headless subagents run noninteractively and cannot answer interactive permission
prompts. The installer maintains machine-level permissions in
`~/.gemini/antigravity-cli/settings.json`; for router-managed turns the bridge
replaces only MCP allow grants in a temporary settings copy with grants from the
selected role contract. Read-only roles keep the Antigravity sandbox and never
receive `--dangerously-skip-permissions` or `command(*)`. If a native command is
not allowed, the leaf prompt directs the model to stop retrying it and return a
visible summary that records the limitation.

- Web research permissions: `read_url(*)` for headless document and URL inspection.
- Exact and recursive read grants for shared configuration: `read_file(~/.agents)`
  plus `read_file(~/.agents/**)`, and the equivalent pair for `~/.codex`.
- Scoped `read_file(<root>)` and `read_file(<root>/**)` grants for every
  configured workspace.
- A small fixed `unsandboxed(...)` allowlist for `pwd`, `pnpm test`, and the
  repository Python test command; this is not a general shell grant.

By default, the installer grants read access to the current AutoDev repository root.
When working across multiple repositories or projects, configure the roots via the
colon-separated `AUTODEV_AGY_READ_ROOTS` environment variable:

```bash
export AUTODEV_AGY_READ_ROOTS="/path/to/repo1:/path/to/repo2"
bash scripts/install.sh
```

The installer normalizes each entry, strips empty segments, and deduplicates
paths. Per-root grants stay narrow (`read_file(<root>)`) instead of graduating to
`command(*)` or global `--dangerously-skip-permissions`, because the headless
surface for read-only roles is bounded code-search navigation rather than shell
execution. These installer grants support direct CLI use. AutoDev-managed
read-only turns build an isolated settings copy from the validated request
workspace, preserve explicit denies, and do not inherit user command, write, or
`unsandboxed(...)` grants. User-configured `read_url(...)` rules remain separate
from local file access. The bridge passes agy's `--sandbox` flag to read-only
roles; write-capable roles retain their existing permission policy. Broad shell
execution is never granted to read-only validation roles.

Run the installer with `--check` to validate that all configured workspace roots
and required MCP/read grants are present in the settings file:

```bash
bash scripts/install.sh --check
```

If any configured workspace or required MCP permission is missing, `--check`
reports the missing grants and exits with a non-zero status.

- `ccc`
- `code-simplification`
- `diagnosing-bugs`
- `doubt-driven-development`
- `improve-codebase-architecture`
- `lsp-mcp-server`
- `orchestration`
- `remove-legacy-shims`
- `resolve-merge-conflicts`

The shared engineering skills are repository-agnostic and intended to apply
across local Codex development. `code-simplification` focuses on DRY, KISS,
cohesion, coupling, ownership, fragmentation, and abstraction cleanup.
`diagnosing-bugs` focuses on reproducible failure signals, root-cause tracing,
falsifiable hypotheses, evidence-safe instrumentation, regression guards, and
verification against the original symptom. `improve-codebase-architecture`
focuses on ownership, module depth, seams, dependency direction, locality, test
surfaces, and structural change amplification. `resolve-merge-conflicts`
provides an intent-preserving conflict-resolution workflow plus a bundled
compact context extractor so agents can inspect unresolved paths and hunks
without loading whole conflicted files by default. `doubt-driven-development`
applies adversarial verification before a meaningful change hardens, including
ownership, coupling, and assumption checks. `writing-agent-skills` guides the
design, revision, and validation of new `SKILL.md` content.

Each agent role in `agents/roles/*.toml` declares which of these skills it
enables through `[[skills.config]]` entries. The execution contract
(`config/execution-contract.json`) projects that mapping for runtime
consumers. Per-role enablement is intentionally narrow so a role does not
inherit capabilities it does not need:

- `default` (general-purpose developer) enables `code-simplification`,
  `diagnosing-bugs`, `improve-codebase-architecture`,
  `remove-legacy-shims`, and `resolve-merge-conflicts`.
- `worker` (bounded implementation) enables the cross-workspace
  implementation set: `code-simplification`, `diagnosing-bugs`,
  `doubt-driven-development`, `improve-codebase-architecture`,
  `remove-legacy-shims`, and `resolve-merge-conflicts`.
- `smart` (full-capability, broad work) enables the same cross-workspace
  set as `worker`.
- `validator` (read-only verification) enables `diagnosing-bugs` and
  `doubt-driven-development` so it can reason about bugs and apply
  adversarial verification without making changes.
- `orchestrator` keeps `orchestration` plus the navigation pair
  (`ccc`, `lsp-mcp-server`) and explicitly disables it on every leaf role so
  children do not inherit parent delegation policy.
- `explorer` keeps `ccc` and `lsp-mcp-server` for read-only codebase
  navigation.
- `browser-tester` and `docs-researcher` deliberately enable no
  engineering skills; their bounded work is Playwright UI testing and
  authoritative documentation research, respectively.

### Skill-surface lockdown

AutoDev's portable source (`config/config.autodev.toml`) suppresses Codex
plugin families that are noise for this repository, so the root
orchestrator turn's model context lists only `openai-docs`, the AutoDev
skills under `.rulesync/skills/`, and the existing
`ccc`/`lsp-mcp-server`/`orchestration` triple. Codex 0.154.0 distinguishes
two skill-discovery surfaces, and the suppression uses the smallest knob
that works for each:

- **Whole-plugin disable** (`[plugins."<plugin>@<marketplace>"] enabled = false`)
  is the only mechanism Codex 0.154.0 honours for plugin-provided
  skills: `[[skills.config]] name = "<plugin-skill>" enabled = false`
  does **not** gate them. With the plugin disabled, the marketplace
  vanishes from the rendered request's `### Skill roots` and the plugin's
  skills disappear from `### Available skills`. Captured against the live
  plugin cache from an isolated CODEX_HOME pointed at the real
  `~/.codex/plugins/cache`. Every skill-declaring plugin AutoDev does not
  use is disabled: the whole `openai-primary-runtime` family (`pdf`,
  `documents`, `presentations`, `spreadsheets`, `template-creator`),
  `sites`, `openai-developers`, and `openai-templates` from
  `openai-curated-remote`, and `sites`, `browser`, `computer-use`,
  `unified-computer-use`, and `visualize` from `openai-bundled`. `sites`
  ships from two marketplaces that declare the same
  `sites-building`/`sites-hosting` skill names, so both copies must be
  disabled. `plugin-management` is deliberately left enabled as the
  operator's escape hatch for re-enabling any of the above. `codex-app-tools`
  is explicitly enabled because AutoDev narrows its `codex_app` MCP to
  `request_user_input`. Plugins that declare no skills (for example `github`)
  are not named here at all and stay under the operator's local config.
- **Per-skill disable** (`[[skills.config]] name = "<skill>" enabled = false`)
  works for the four Codex `.system/` skills that are not relevant to
  AutoDev: `imagegen`, `plugin-creator`, `skill-creator`,
  `skill-installer`. `openai-docs` is intentionally kept because Codex
  self-knowledge is directly relevant to this repository.
- `[skills.bundled] enabled = false` is **not** used at user level
  because it would also suppress `openai-docs`. `agents/roles/browser-tester.toml`
  keeps that key because that role legitimately does not need
  `openai-docs`; it is a valid key in 0.154.0 and removes the bundled
  `.system/` skills for that role.

The whole-plugin disables are written under the portable source so
`compose-user-config.ts` re-asserts them on every install, even when Codex
Desktop regenerates the user's local config. The composer treats
AutoDev-owned `[plugins]` keys as authoritative against the operator's
existing entries, so editing `~/.codex/config.toml` by hand does not
survive: the next install re-asserts `enabled = false`. To use a
suppressed plugin again, flip it in `config/config.autodev.toml` (or drop
its entry entirely, which returns ownership of that plugin to the
operator's local config) and re-run the installer. Only plugins the
portable source does not name are left to machine-local state.

`autodev-codex-request-capture`, `autodev-session-diagnostics`,
`opentelemetry`, and `writing-agent-skills` are **AutoDev-repository-only**
skills. They are intentionally not wired into any cross-workspace agent
role because their guidance is meaningless outside of developing the AutoDev
codebase itself (provider adapters and router routes, AutoDev session
telemetry, OpenTelemetry semantic conventions, and AutoDev skill
authorship). They still ship under `.rulesync/skills/` and reach the
relevant tools through Rulesync's repository projection: the three
`autodev-*` and `opentelemetry` skills carry no `targets` frontmatter, so
they land in every tool's repository skills folder; only Copilot reaches
`orchestration`, `ccc`, and `lsp-mcp-server` because Copilot has no
user-level skills. A turn working on AutoDev itself still sees these
AutoDev-only skills through its workspace's tool-specific skills folder,
while a turn working on any other repository sees only the cross-workspace
skills.

Keep the canonical registered user-level skill content in AutoDev; update the
skill directories there and rerun the installer when changing this setup. The
installer links each complete skill directory with an absolute target; do not
link an individual `SKILL.md` file because Codex currently skips file-level
symlinks. Its `--check` mode rejects missing or relative skill-directory links
and symlinked `SKILL.md` files. Restart Codex or start a new task after
installation so user-level skill discovery refreshes.

### Prompt catalog (Codex custom prompts)

`.rulesync/commands/*.md` is the single tracked source for AutoDev's Codex
custom prompts (slash commands). The file name is the prompt name; agents
surface them as `/<name>`. Each file declares `targets: ["*"]` and a concise
`description:` in YAML frontmatter, followed by the prompt body. The catalog is
the union of the prior AutoDev Codex prompt catalog and the AutoDev-owned
generic scheduler catalog formerly published at `.agents/prompts/*.md`:
the eight pre-existing entries (build-fix, css-cleanup, file-organize,
merge-prs, new-feature, optimize, resolve-merges, test-fix) keep their
AutoDev Codex-specific bodies, the fifty-one directly-migrated entries keep
the original `.agents/prompts/<slug>.md` body verbatim, and the three slugs
that appeared under both names (bug-fix, lint-fix, dedupe-helper / former
helper-substitution) were merged in place so the AutoDev rulesync body
remains the only entry for each. The current catalog is:

- `bug-fix` — pick the next major/outstanding issue and fix it at the source.
- `build-fix` — fix outstanding build issues, failures, or errors.
- `css-cleanup` — comprehensive CSS DRY / dedupe pass.
- `dedupe-helper` — refactor code to use a shared helper or platform API.
- `file-organize` — pick two organization issues and reorganize around them.
- `lint-fix` — fix outstanding lint errors and warnings properly.
- `merge-prs` — review open PRs against master, merge or re-implement worthwhile ones, and resolve local merge conflicts strategically.
- `new-feature` — pick and implement a high-value scoped feature.
- `optimize` — profile, measure, and fix performance bottlenecks.
- `resolve-merges` — resolve local merge conflicts safely.
- `test-fix` — investigate failing tests and fix root issues.

The installer projects the catalog through Rulesync's `codexcli` commands
feature into `$CODEX_HOME/prompts/<name>.md` (one regular file per catalog
entry, mode `0o644`). Rulesync's `codexcli` commands feature is global-only
and honors `$HOME` rather than `$CODEX_HOME`, so the installer runs Rulesync
with `$HOME` pointed at a throwaway `mkdtempSync` directory and copies each
generated prompt into the real `$CODEX_HOME/prompts/` via
`materializeRuntimeFile`. Data's `RuleSyncRepository` validates and reads the
canonical `.rulesync/commands/` catalog. Runtime's `loadCodexCommands` selects
entries targeted at `codexcli` or `*`; both the installer and `checkCommands`
use this same inventory. The materializer fails loudly if a selected command
produces no projection or if Rulesync generates a prompt without a canonical
Codex target. The `$CODEX_HOME/prompts/` directory is AutoDev-owned and
reconciled — any `*.md` not in the selected catalog is removed during install
via `removeStalePaths`, so unmanaged prompts cannot drift in.

The Console's Prompt detail also renders the canonical Markdown body with raw
HTML disabled. Its read-only Git history lists the newest 20 committed versions;
selecting one displays its source and a unified diff against the current working
tree. These views use GET-only `/control/prompts/:name/versions` routes and do
not check out or modify Git state. A non-Git repository reports history as
unavailable rather than as an empty version list.

The Codex desktop app reads `$CODEX_HOME/prompts/` only when its window
opens (the Electron main process sends `custom-prompts-updated` from its
renderer-ready handler and never watches the directory). A running app keeps
expanding `/prompts:<name>` to the text it loaded at launch, however many
installs have happened since. The installer therefore prints
`updated Codex prompts: <names> -- restart the Codex app ...` whenever an
install added, rewrote, or removed a prompt; restart (quit and reopen) the
Codex app to pick them up.

Rulesync's `codexcli` commands feature is intentionally **not** added to the
project-mode `rulesync.jsonc` `features` array: it would throw for the project
mode of codexcli alongside the other targets, and the other targets do not
need a parallel commands projection. The installer drives the commands
projection directly.

Upstream Codex marks custom prompts deprecated in favour of skills while
they remain functional, so the catalog stays as prompts (not skills) and
surfaces through `/<name>` invocations today. Re-running the installer is
idempotent: `tests/rulesync-commands.test.ts` covers the catalog shape, the
projection contract, the materialization, and the reconciliation; the typed
install-check verifies the live `$CODEX_HOME/prompts/` matches a fresh
projection. After editing `.rulesync/commands/*.md`, run:

```bash
node --test tests/rulesync-commands.test.ts
bash scripts/install.sh --check
```

### Seed-retirement acceptance

An upgrade is accepted when the installer/composer creates a regular, non-symlink
`$CODEX_HOME/config.toml` from the portable source and Rulesync MCP projection,
reads an existing legacy symlink target only during migration, and preserves
machine-local values such as projects, notifications, custom MCP
servers, and trusted hook state. Re-running the installer must be idempotent;
`bash scripts/install.sh --check` must pass afterward.

Destructive Git commands are enforced by Codex's native rules engine. The
tracked rules live in `agents/rules/default.rules` and are symlinked by
the installer to `$CODEX_HOME/rules/default.rules`. Validate a rule without
running the command:

```bash
codex execpolicy check --pretty \
  --rules agents/rules/default.rules \
  -- git reset --hard HEAD
```

The same rules allow explicit localhost diagnostics such as
`curl http://127.0.0.1:4100/status`, while remote curl commands remain gated.
They also deny direct `ccc` CLI execution from agent shell commands. Code-capable
roles must use the configured `cocoindex-code` MCP server; the configured MCP
process is still allowed to launch its backend command. Every native and provider
registration goes through `run-autodev-mcp.sh cocoindex-code`, so minimal provider
PATH environments do not lose the backend executable. The rules also deny
destructive Git history/worktree operations, force pushes and branch deletion,
superuser/raw-disk commands, and catastrophic root/home recursive deletion.

## Safety

- Inspect launch-agent plists before loading them with `launchctl`. The model
  router plist keeps `KeepAlive` and `RunAtLoad`, separates stdout/stderr
  under `$CODEX_HOME/run/`, uses `ProcessType=Standard` (Background would
  throttle it into the lowest CPU and disk I/O tier), and sets an
  `ExitTimeOut` large enough for the router's drain timeout before launchd
  SIGKILLs it. Inspect the other provider plists independently; they may have
  different lifecycle and log-path contracts.
- Every service LaunchAgent sets `AUTODEV_NODE_BIN` to the Node the installer
  resolved: its own Node when that is native to the machine, otherwise the
  newest native nvm or Homebrew Node. launchd's `PATH` alone finds
  `/usr/local/bin/node` first, which on many Apple Silicon Macs is an Intel
  build that Rosetta translates on every cold start. The launchers fall back to
  `PATH` only when that binary no longer exists; reinstall after changing Node
  installations. `bash scripts/install.sh --check` reports the drift.
- Keep OAuth/PAT/API credentials outside the repository. Background services
  load provider credentials from `~/.codex/.env`; for MiniMax this means a
  private `MINIMAX_API_KEY=...` entry with restrictive file permissions.
- Treat proxy and router logs as local-only operational data. Antigravity's
  launchd service is the canonical supervisor when loaded; the ensure hook
  refuses to start a duplicate unmanaged process on port 4002. The
  typed session-start platform owner now owns the same property for port 4100 and additionally
  serializes concurrent invocations through an atomic private lock directory
  at `$CODEX_HOME/run/codex-model-router.ensure.lock.d`.
- All router operational state (launchd stdout/stderr logs, the fallback
  pid/log files, the ensure lock) lives under `$CODEX_HOME/run/` which the
  installer creates with mode 0700. Override individual paths with
  `CODEX_MODEL_ROUTER_FALLBACK_LOG`,
  `CODEX_MODEL_ROUTER_FALLBACK_PID_FILE`, and
  `CODEX_MODEL_ROUTER_ENSURE_LOCK` when sandboxing requires a different
  writable location.
- Liveness vs readiness: `GET /health/liveliness` (or `/health`) returns
  HTTP 200 when the router's HTTP server is bound; use it only as a liveness
  probe. `GET /health/readiness` returns HTTP 200 while the router accepts
  work and HTTP 503 while it is draining. `GET /status` remains the detailed
  diagnostic surface for per-provider health, cooldown countdowns, active
  request counts, and the router instance ID — use it to decide whether an
  upstream is usable and to correlate a turn's request header across
  restarts.
- Prefer `ensure-*` scripts for idempotent setup and the `diagnose-*` scripts for evidence before changing provider routing.
- The retired router HTML dashboard is not an operational surface. Use the AutoDev/OpenLIT **Usage** console for historical/aggregate observability and `http://127.0.0.1:4100/status` for raw live router state. Inspect that state through the typed entrypoint with `pnpm autodev -- router status`; use `node runtime/src/cli/router-status.ts` for the detailed report (or add `--json` for machine-readable output). It reports observed session-limit, throttling, quota, capacity, timeout, and availability failures; it cannot query an upstream provider's private quota dashboard. Antigravity CLI turns allow up to 15 minutes by default (override
  with `AGY_PRINT_TIMEOUT` when needed). Router counters and recent events are
  persisted in `$CODEX_HOME/codex-router-state.json`; response headers and
  structured router events provide per-request
  correlation without logging prompts or credentials.

The tracked configuration enables network access for workspace-write sessions
so agents can query approved localhost diagnostics such as the model router.
Read-only roles use a broader filesystem policy only to inspect runtime state
such as `~/.codex`; their role instructions still prohibit edits outside the
active repository.

### Execution contract

The versioned execution contract is `config/execution-contract.json`.
It is generated by `runtime/src/config/render-execution-contract.ts` from the native
role TOMLs plus the root orchestrator configuration, then installed beside the
bridge modules. Provider bridges consume it for role kind, read-only intent,
expected MCP/skill capabilities, and adapter spawn-tool metadata. Canonical role prose lives in
`agents/prompts/roles/*.md`; bridges and the native-role renderer share
those fragments instead of duplicating them. A bridge must report missing
capabilities rather than silently substituting a different workflow. Native role
TOMLs remain the **current transitional capability input** until the RuleSync subagent/agent-role migration reaches parity; they are not the long-term canonical source. The installer fails when the generated contract drifts from the current input. The root orchestrator uses the
capability-only `agents/roles/orchestrator.toml` declaration but is not
installed as a child role. A native child receives only its `agent_type` and task
message; Codex resolves the installed role TOML to bootstrap its enabled MCP
servers and skills. Skill paths and MCP lists are intentionally not copied into
individual spawn payloads.

Workspace-local `.codex/agents/*.toml` roles are allowed when they use names
outside AutoDev's managed flat roles. A project-local role that reuses a managed
name is rejected as an explicit conflict rather than silently choosing precedence;
this keeps user-level provider routing deterministic while allowing repository-
specific agents, MCPs, and skills to coexist under distinct names.

### Rulesync shared configuration

`.rulesync/` is the only tracked Rulesync input, and nothing Rulesync generates is tracked as a test fixture. The repository projections use `codexcli`, `claudecode`, `copilot`, and `antigravity-cli`; the separate `copilotcli` target is used for user-level MCP generation. `rulesync.jsonc` is the only RuleSync configuration. **Current state:** its project-mode generation still covers the repository projections that have reached parity, while native role TOMLs/execution-contract code remain transitional for subagent/role behavior. **Target:** migrate agent/subagent definitions and every other RuleSync-supported agent-facing configuration surface into canonical RuleSync sources, then delete the duplicate native authority once parity is proven. Do not add another AutoDev-specific declarative schema during that migration.

Repository agent instructions do not go through Rulesync. `AGENTS.md` is their only source. Codex, Antigravity, and Copilot (cloud agent, code review, CLI, VS Code chat) read it natively, and `CLAUDE.md` is a symlink to it for Claude Code. Copilot Chat on github.com reads only `.github/copilot-instructions.md`, which is intentionally absent. `tests/agent-instructions.test.ts` keeps it that way.

`.rulesync/mcp.jsonc` is the only static MCP source, and the installer generates every live MCP file from it with the pinned Rulesync `16.30.2`. The `autodev_spawn` entry used by orchestrator bridges is the exception at runtime: Claude and Copilot receive it as a per-session MCP definition with a request-scoped session key, loopback URL, and token; Antigravity adds the equivalent server only to the isolated temporary home for an authorized root turn. Leaf Antigravity invocations do not receive the spawn server, and no global MCP registration grants unrelated turns a delegation path:

- **Claude Code, Copilot CLI, Antigravity:** for each of `claude`, `copilot`, and `agy` found on `PATH`, `rulesync generate --global --features mcp` writes `~/.claude.json`, `~/.copilot/mcp-config.json`, or `~/.gemini/config/mcp_config.json`. Rulesync keeps every non-MCP key in those files but owns their server lists: a server you add by hand is removed on the next install and reported as drift by `--check`. Add personal servers to `.rulesync/mcp.jsonc` instead.
- **Codex:** Rulesync's global output ignores `CODEX_HOME`. The installer therefore generates the Codex projection into a temporary root, and the composer merges its servers into `$CODEX_HOME/config.toml`, keeping any server you added there. The role renderer and execution-contract builder read the same projection.
- MCP generation passes its settings as flags, because a Rulesync config file with `global: true` generates nothing.

The suites generate from `.rulesync/` into temporary roots:

- `tests/rulesync-mcp.test.ts` checks that the Codex projection and each user-level file list exactly the servers `.rulesync/mcp.jsonc` declares for that tool, that non-MCP keys survive, and that `--check` catches edited or extra servers.
- `tests/rulesync-hooks-shadow.test.ts` checks the six command hooks across SessionStart, SubagentStart, UserPromptSubmit, and PreToolUse. Rulesync emits only the supported PreToolUse hook for Antigravity and omits Codex-only fields such as `prevent_idle_sleep`; Copilot and Antigravity projections are intentionally lossy and the tests freeze those limits.
- `tests/rulesync-commands.test.ts` checks the `.rulesync/commands/*.md` catalog: Data reads every canonical file, Runtime selects only `codexcli` and wildcard targets (including RuleSync's default target), the Rulesync projection contains exactly those commands with description-only frontmatter (no `targets` leak), and real materialization preserves prompt bodies, reconciles stale files, reports changed prompts, and is idempotent.

AutoDev scripts remain the hook implementations, while Rulesync owns declarations. The installer materializes the generated projections in the active repository and validates them with `--check`; no duplicate hook declarations remain in `config.autodev.toml`. RuleSync permissions generation is not yet the current runtime authority, but the canonical target requires permissions to migrate into RuleSync once the existing effective policy has been inventoried and represented losslessly. After changing `.rulesync/`, `rulesync.jsonc`, or the pinned Rulesync version, run the same suites CI runs:

```bash
node --test tests/rulesync-mcp.test.ts tests/rulesync-hooks-shadow.test.ts tests/rulesync-skills.test.ts tests/rulesync-permissions-inventory.test.ts tests/rulesync-commands.test.ts
```

Rulesync does not replace AutoDev's live hook enforcement or role filtering. `.rulesync/skills/` is the single tracked source for every AutoDev skill, and its generated repository skill folders are live output. The repository skill folders each tool discovers inside AutoDev (`.github/skills/` for Copilot, `.claude/skills/` for Claude Code, `.agents/skills/` for Codex and Antigravity) are untracked Rulesync output. The installer generates them by running the pinned `node_modules/.bin/rulesync` with `rulesync.jsonc` (run `pnpm install --frozen-lockfile` first). Its `--check` reports edited, stale, or missing copies. `.gitignore` lists the first two. The installer writes `/.agents/skills/` to `.git/info/exclude` instead, because Antigravity does not load a gitignored `.agents/skills/`. Copilot's cloud agent generates its folder in `copilot-setup-steps.yml`. Each skill's Rulesync `targets` frontmatter selects its folders. Repository-only development skills such as `autodev-codex-request-capture`, `autodev-session-diagnostics`, and `opentelemetry` keep the default and reach every tool, with their bundled scripts (if any). `ccc`, `lsp-mcp-server`, and `orchestration` target only `copilot`, because Copilot's cloud agent has no user level. The remaining skills target nothing, because they already reach local tools at user level and a repository copy would list them twice. Repository-only skills are never installed at user level. Tools that read the repository without running setup, such as github.com Copilot chat and code review, see no repository skills. `tests/rulesync-skills.test.ts` generates the folders fresh and freezes that exposure. The installer symlinks Codex/user-level skills from `.rulesync/skills/`, and Antigravity continues to use its explicit `include_only` registration. Claude-served turns read skills through Codex's tools, so there is no Claude-specific skill view. Hook declarations are Rulesync-owned and generated into each provider's active repository location; AutoDev continues to own the implementation scripts. Codex's `prevent_idle_sleep` field is a known projection limitation, and Copilot/Antigravity projections remain intentionally lossy.

To enable the router authentication boundary during a planned restart, run:

```bash
bash scripts/install.sh --enable-router-auth --materialize-only
```

This creates/reuses a private `CODEX_ROUTER_AUTH_TOKEN` in
`$CODEX_HOME/.env`, exports it to launchd, and synchronizes the configured
`local_model_router` provider without restarting the current services. Run the
normal installer later, when no active task depends on the local router, to
restart the supervisors and enforce the token on live requests. It is
intentionally an explicit migration flag rather than an implicit install-time
change so an existing Desktop session is not disconnected unexpectedly.

For a live Desktop session, use `--materialize-only` to synchronize hooks,
role files, MCP launchers, and rendered LaunchAgents without cycling any running
service:

```bash
bash scripts/install.sh --materialize-only
```

Run the normal installer later, when no active task depends on the local router,
to restart the supervisors and load the new runtime code.

## AutoDev Console and OpenLIT local operations

These are current local/operator entry points. Product, UI, ownership, and migration requirements remain authoritative in [autodev-console-target-state.md](autodev-console-target-state.md) and [autodev-console-migration.md](autodev-console-migration.md).

### Local stack lifecycle

Current local stack lifecycle:

```bash
bash scripts/openlit/up.sh
bash scripts/openlit/down.sh
```

### Console development

Run the AutoDev Console independently while the transitional OpenLIT UI still occupies
port 3000:

```bash
pnpm --filter @simulatorlife/autodev-console dev
pnpm --filter @simulatorlife/autodev-console build
pnpm --filter @simulatorlife/autodev-console start
```

`next dev` writes to `console/.next-dev`; `next build` (and the Runtime
installer's console-build step) writes the production build that `next start`
and the Console LaunchAgent serve to `console/.next`. The split lives in
`console/src/lib/build-output.ts` (applied by `console/next.config.ts`), so a build cannot delete the chunks a running dev
server loads (the `Cannot find module './<n>.js'` crash from `_document.js`).
`console/next-env.d.ts` points at whichever directory generated it last, so it
is gitignored; `pnpm --filter @simulatorlife/autodev-console typecheck` runs
`next typegen` first, which regenerates it and the `console/.next/types` route
types. The dev server's `console/.next-dev/types` stay out of the type-check.

The Console defaults to port 3300 (`AUTODEV_CONSOLE_PORT` overrides it). Set
`AUTODEV_CONTROL_API_TOKEN` only in the Console server environment; the
Control API base defaults to `http://127.0.0.1:4101` and can be configured with
`AUTODEV_CONTROL_API_BASE_URL`. To query Usage, set
`AUTODEV_OPENLIT_USAGE_TOKEN` in the Console server environment to the
separately generated value in `$CODEX_HOME/openlit-secrets.env`;
`AUTODEV_OPENLIT_USAGE_URL` defaults to `http://127.0.0.1:3000`. The Console is the only Memory operator surface: durable records, experiences, and outcome cohorts are read through the Control API in `console/app/memory`. The transitional external Memory portal is gone, so `AUTODEV_OPENLIT_UI_URL` no longer has a consumer — delete it from `$CODEX_HOME/.env` and do not reintroduce it. The Console launcher forwards only the two URL variables the server actually reads (`AUTODEV_CONTROL_API_BASE_URL`, `AUTODEV_OPENLIT_USAGE_URL`). Do not source or expose the full secret file to browser code.

The two Console server-only tokens are seeded into the server environment by
exactly one writer: `scripts/openlit/bootstrap-secrets.sh`, which is the same
script that populates `$CODEX_HOME/openlit-secrets.env` and is invoked from
`scripts/openlit/up.sh`. It writes the canonical secret file outside the
repository and additionally materializes a mode-0600 `console/.env.local`
that Next.js auto-loads on every server-side request from the `pnpm`
Console workflow. That file carries only the two Console-required server
credentials plus their non-secret local base URL defaults; the OpenLIT
database password and the OTLP receiver token are deliberately not
included. The launchd-managed Console path does not depend on
`console/.env.local` — `scripts/run-codex-console.sh` reads the canonical
secret file via an exact-key parser and exports only the two tokens
needed by the Next.js server.

### GitHub Actions runtime facts

The Console GitHub page always shows the workflow definitions parsed from
`.github/workflows/`. Observed Actions state and recent runs come from the
read-only Control API route `/control/github`, which issues only `GET`
requests for the repository's Actions workflows and runs. That route runs
inside the model router process: the `com.codex.model-router` LaunchAgent
starts `scripts/run-codex-model-router.sh`, which loads `$CODEX_HOME/.env`
before starting `runtime/src/router/server.ts`. To enable runtime facts, add
two entries to that private file:

- `AUTODEV_GITHUB_TOKEN`: a server-side, least-privilege token. Use a
  fine-grained personal access token scoped only to the bound repository,
  with read-only **Actions** permission (plus the read-only **Metadata**
  permission that GitHub always adds), and a short expiry.
- `AUTODEV_GITHUB_REPOSITORY`: the `owner/repo` identifier. It must exactly
  match an enabled workspace `id` in `config/workspaces.json`. An unknown or
  disabled id shows as `invalid`, and a missing token shows as
  `unavailable`. In each case the page still shows the workflow definitions.

Keep `$CODEX_HOME/.env` at mode `0600`. Never commit the token, never put it
in `console/.env.local` or any `NEXT_PUBLIC_*` variable, and never pass it to
browser code. The Console launcher ignores `*TOKEN*` keys in
`$CODEX_HOME/.env`, and the adapter redacts the token from error messages.
Restart the router with the normal installer when no active task depends on it
(`--materialize-only` does not restart services). The new values apply only
after the restart.

### Transitional OpenLIT projections

Current out-of-band OpenLIT projections:

```bash
pnpm --filter @simulatorlife/autodev-data openlit:sync-prompts
pnpm --filter @simulatorlife/autodev-data openlit:sync-agents
pnpm --filter @simulatorlife/autodev-data openlit:sync-models
pnpm --filter @simulatorlife/autodev-data openlit:sync-workspaces
```

The Data-owned agents, prompts, and models adapters populate transitional OpenLIT read models; they do not supersede canonical RuleSync/AutoDev configuration ownership. **Do not add new product consumers, mutation authority, or canonical state to these sync paths.** Delete each sync command/adapter after its retained feature is served directly through the unified Console/Data integration and no verified consumer still requires the OpenLIT projection. The remaining workspace bootstrap is only an internal singleton migration, not a per-workspace OpenLIT tenancy adapter, and should be removed when the retained OpenLIT internals no longer require that singleton compatibility row.

The asynchronous GitHub issue metrics workflow remains a separate GitHub-development reporting surface (`.github/workflows/metrics-dashboard.yml`, issue #2). It is not a replacement observability backend for AutoDev runtime telemetry.
