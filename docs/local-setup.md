# Local AI and provider setup

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
router is healthy, `src/hooks/session-start.ts` calls `ensureCodeGraph` from
`src/platform/code-graph-ensure.ts`. Outside a git checkout it does nothing.
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

- **Authoritative portable source (`config/config.autodev.toml`):** Contains the versioned, portable slice of configuration owned by AutoDev (model defaults, provider definitions, telemetry, feature flags, native agents, skills, and shell environment policy). MCP declarations are owned by `.rulesync/mcp.jsonc` and generated by the pinned Rulesync version.
- **Composer (`src/config/compose-user-config.ts`):** Deterministically merges the portable source and the Rulesync-generated MCP projection with existing machine-local state at `$CODEX_HOME/config.toml`. AutoDev-owned settings win conflicts, while operator-specific keys (such as `notify`, `projects`, `marketplaces`, desktop/TUI preferences, custom non-AutoDev MCP servers, and user-added skills) are preserved.
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
packages. Both resolve from pinned AutoDev devDependencies (`lsp-mcp-server` and `@playwright/mcp`) rather
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
Playwright is never exposed to the root orchestrator. Because Antigravity's
MCP configuration is global, registering Playwright globally would expose it across all
roles including the orchestrator; rather than falsely claiming per-role isolation, Playwright
registration and `browser-tester` routing are removed for Antigravity. For documentation
and web research, Antigravity uses its native `search_web` and `read_url_content` tools.

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

The CodeGraphContext role allowlist exposes only `list_indexed_repositories`,
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

Antigravity has a separate global MCP registry and workspace customization
discovery. The installer registers the pinned `codegraphcontext`,
`cocoindex-code`, and `lsp` MCP servers with `agy`; `.agents/skills.json`
continues to expose the `ccc` and `lsp-mcp-server` skills from the canonical
`.rulesync/skills/` source. The shared code-search prompt directs code roles to
CGC first. Antigravity permissions grant six approved CodeGraphContext tools
individually and remove any wildcard or other CGC tool grants; the global
registry makes those tools visible to every session.

Headless subagents run noninteractively and cannot answer interactive permission
prompts; if a required tool lacks pre-approval, the CLI auto-denies the call and
halts the turn. The installer pre-approves required capabilities in
`~/.gemini/antigravity-cli/settings.json` under `permissions.allow`:

- Required MCP servers: `codegraphcontext`, `cocoindex-code`, `lsp`,
  `openaiDeveloperDocs`, and `autodev_spawn`. CodeGraphContext receives explicit
  grants only for `add_code_to_graph`, `check_job_status`,
  `list_indexed_repositories`, `find_code`, `analyze_code_relationships`, and
  `get_repository_stats`; it is not covered by a tool wildcard.
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
execution. The bridge passes agy's `--sandbox` flag to read-only roles so they
can run headlessly within terminal restrictions; write-capable roles retain
their existing permission policy. Broad shell execution is never granted to
read-only validation roles.

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
`materializeRuntimeFile`. The `COMMANDS` catalog constant in
`src/platform/install-materializer.ts` is the single source of truth: the
materializer fails loudly if a catalog entry produces no projection, if a
projection names a prompt that is not in the catalog, and `checkCommands`
verifies the installed file equals a fresh projection of the current source.
The `$CODEX_HOME/prompts/` directory is AutoDev-owned and reconciled — any
`*.md` not in `COMMANDS` is removed during install via
`removeStalePaths` — so unmanaged prompts cannot drift in.

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
  --rules /Users/henrykirk/AutoDev/agents/rules/default.rules \
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
- Open `http://127.0.0.1:4100/dashboard` in a browser for the lightweight live
  dashboard. Raw JSON status is available at `http://127.0.0.1:4100/status`.
  The dashboard shows only the router's own state; it does not query the Codex
  app-server. A `thread/list` snapshot was surfaced here once and was removed
  because nothing in routing, concurrency, or fallback read it and it cold-spawned
  an app-server process on every refresh. Inspect the same state with
  `node src/cli/router-status.ts` (use `--json` for automation).
  It reports observed session-limit, throttling, quota, capacity, timeout, and
  availability failures; it cannot query an upstream provider's private quota
  dashboard. Antigravity CLI turns allow up to 15 minutes by default (override
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
It is generated by `src/config/render-execution-contract.ts` from the native
role TOMLs plus the root orchestrator configuration, then installed beside the
bridge modules. Provider bridges consume it for role kind, read-only intent,
expected MCP/skill capabilities, and adapter spawn-tool metadata. Canonical role prose lives in
`agents/prompts/roles/*.md`; bridges and the native-role renderer share
those fragments instead of duplicating them. A bridge must report missing
capabilities rather than silently substituting a different workflow. Native role
TOMLs remain the editable capability source; the installer fails when the
generated contract drifts from them. The root orchestrator uses the
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

`.rulesync/` is the only tracked Rulesync input, and nothing Rulesync generates is tracked as a test fixture. The repository projections use `codexcli`, `claudecode`, `copilot`, and `antigravity-cli`; the separate `copilotcli` target is used for user-level MCP generation. `rulesync.jsonc` is the only Rulesync configuration: it generates live repository skill and hook projections described below. Rulesync's `subagents` feature is intentionally not enabled for this project yet: AutoDev role TOMLs and the execution contract still own sandbox, MCP, skill, provider delegation mode, and Codex-native delegation semantics. Generating generic `.claude/agents`, `.github/agents`, or `.agents/agents` files before that parity exists would create a second, weaker role owner.

Repository agent instructions do not go through Rulesync. `AGENTS.md` is their only source. Codex, Antigravity, and Copilot (cloud agent, code review, CLI, VS Code chat) read it natively, and `CLAUDE.md` is a symlink to it for Claude Code. Copilot Chat on github.com reads only `.github/copilot-instructions.md`, which is intentionally absent. `tests/agent-instructions.test.ts` keeps it that way.

`.rulesync/mcp.jsonc` is the only static MCP source, and the installer generates every live MCP file from it with the pinned Rulesync `16.30.2`. The `autodev_spawn` entry used by orchestrator bridges is the exception at runtime: Claude and Copilot receive it as a per-session MCP definition with a request-scoped session key, loopback URL, and token; Antigravity uses the static global entry but inherits the same session-scoped environment from its identified bridge process. The shim is therefore not a globally active delegation path for unrelated turns:

- **Claude Code, Copilot CLI, Antigravity:** for each of `claude`, `copilot`, and `agy` found on `PATH`, `rulesync generate --global --features mcp` writes `~/.claude.json`, `~/.copilot/mcp-config.json`, or `~/.gemini/config/mcp_config.json`. Rulesync keeps every non-MCP key in those files but owns their server lists: a server you add by hand is removed on the next install and reported as drift by `--check`. Add personal servers to `.rulesync/mcp.jsonc` instead.
- **Codex:** Rulesync's global output ignores `CODEX_HOME`. The installer therefore generates the Codex projection into a temporary root, and the composer merges its servers into `$CODEX_HOME/config.toml`, keeping any server you added there. The role renderer and execution-contract builder read the same projection.
- MCP generation passes its settings as flags, because a Rulesync config file with `global: true` generates nothing.

The suites generate from `.rulesync/` into temporary roots:

- `tests/rulesync-mcp.test.ts` checks that the Codex projection and each user-level file list exactly the servers `.rulesync/mcp.jsonc` declares for that tool, that non-MCP keys survive, and that `--check` catches edited or extra servers.
- `tests/rulesync-hooks-shadow.test.ts` checks the six command hooks across SessionStart, SubagentStart, UserPromptSubmit, and PreToolUse. Rulesync emits only the supported PreToolUse hook for Antigravity and omits Codex-only fields such as `prevent_idle_sleep`; Copilot and Antigravity projections are intentionally lossy and the tests freeze those limits.
- `tests/rulesync-commands.test.ts` checks the `.rulesync/commands/*.md` catalog: every file carries valid frontmatter with `targets` and a non-empty `description`, the `COMMANDS` constant exactly matches the on-disk files, the rulesync `codexcli` commands projection produces one prompt per catalog entry with description-only frontmatter (no `targets` leak), the body is preserved verbatim through projection, a pre-existing non-catalog prompt is removed by reconciliation, and re-running is idempotent.

AutoDev scripts remain the hook implementations, while Rulesync owns declarations. The installer materializes the generated projections in the active repository and validates them with `--check`; no duplicate hook declarations remain in `config.autodev.toml`. Rulesync permissions translation remains deferred until AutoDev has a complete portable permission source inventory. After changing `.rulesync/`, `rulesync.jsonc`, or the pinned Rulesync version, run the same suites CI runs:

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
