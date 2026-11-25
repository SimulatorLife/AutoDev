# Local AI and provider setup

> **MCP migration target:** The direct provider MCP launch/configuration paths described below are current operational behavior, not the end state. The [mandatory shared MCP gateway](autodev-console-target-state.md#mandatory-shared-mcp-gateway) requires all AutoDev-managed provider MCP traffic to use Supergateway, with no direct backend fallback. Canonical Rulesync declarations and role/workspace contracts remain authoritative; the optional ChatGPT tunnel is not a prerequisite for local access. Subagent delegation likewise converges on the [single XACPX MCP interface](autodev-console-target-state.md#cross-provider-agent-delegation-contract) through the gateway. References below to native Codex spawn tools, code-mode spawn or the removed Codex-tools bridge describe pre-ACP behavior, not target requirements or fallback mechanisms.

> This is an operational/current-state runbook. The canonical future ownership and AutoDev Console target live in [`docs/autodev-console-target-state.md`](autodev-console-target-state.md).

**JavaScript prerequisite:** install standalone pnpm (v12.21.0 for this
checkout), then use `pnpm runtime set node 24.12.0 -g` to provision Node
without npm, npx, NVM, or Corepack. The repository's `.node-version` is
understood by pnpm's `node` shim. Keep `PNPM_HOME/bin` on PATH
(`~/Library/pnpm/bin` on macOS). The installer does not edit `.zprofile`. Where this file describes native role TOMLs or other transitional inputs, do not treat them as a competing long-term source of truth; RuleSync is the target canonical source for every agent-facing configuration surface it natively supports.

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
# or: pnpm run install:autodev
```

`scripts/install.sh` passes `--env-file-if-exists="$repo_root/.env"` to Node.js so
a git-ignored `.env` file at the repository root is loaded automatically when
present (including during MCP gateway/tunnel provisioning). Explicit
environment variables set in the calling shell take precedence over `.env`
values, and `scripts/install.sh` continues normally when no `.env` file exists.
Never commit `.env` (already ignored via `.gitignore`), log its credentials, or
expose `.env` files through external MCP tools.

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
  hook session-start|skill-read
  repo bootstrap
  install
```

Render target arguments (after `render`; bracketed options are optional):

```text
    agents --mcp-source <toml> --output-dir <dir>
      [--source-dir <dir>] [--prompt-dir <dir>] [--check]
    contract --output <file>
      [--source-dir <dir>] [--root-config <file>] [--contract <file>] [--check]
    mcp --mcp-source <toml> --output <file>
      [--check]
    catalog --routing-config <file> --catalogs-dir <dir> --output <file>
      [--check]
```

The checkout-relative defaults are `agents/roles` for `--source-dir`,
`agents/prompts` for `--prompt-dir`, `config/config.autodev.toml` for
`--root-config`, and `config/execution-contract.json` for `--contract`.
`--mcp-source` must point to a Codex TOML MCP projection; `.rulesync/mcp.jsonc`
is its source, not a directly accepted input. Output paths and catalog inputs
remain required where shown. For example, generate the projection and render to
a temporary working directory without changing tracked configuration:

```sh
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
pnpm exec rulesync generate --input-roots .rulesync --targets codexcli --features mcp --output-roots "$tmpdir" --silent
pnpm autodev -- render agents --mcp-source "$tmpdir/.codex/config.toml" --output-dir "$tmpdir/agents"
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
- **Repository-specific needs:** Leaves the exclusion of Rulesync's own outputs
  to `rulesync gitignore`, which writes them to `.git/info/exclude` instead of
  the tracked `.gitignore`. The bootstrap does not write a second copy of that
  rule: Antigravity does not load skills from a gitignored `.agents/skills/`,
  so the exclusion has to live in the exclude file, and `rulesync gitignore`
  owns it there.
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
- hashes HEAD, Git status, and the contents/modes of tracked changed and
  non-ignored untracked files, so repeated edits to one already-dirty path
  invalidate the stamp; it exits without touching CGC only when the graph holds
  the repository and the full checkout stamp matches the last successful run;
- otherwise runs `codegraphcontext index --no-progress <root>` for a repository
  the graph does not list, or `codegraphcontext update --quiet <root>` for one
  it does, recording the new stamp only on success so a failure retries at the
  next session start.

Its state lives in `$CODEX_HOME/provider-runtime/code-graph/<hash>/` (`lock`,
`state.json`, and `worker.log`); nothing is written to the repository. The
worker uses the same binary resolution as the MCP launcher, including
`AUTODEV_CODEGRAPHCONTEXT_BIN`, and shares CGC's FalkorDB server with the
running MCP servers. `tests/platform/code-graph-ensure.test.ts` covers it.

**The graph database has to answer, or the MCP server does not start.** CGC
reads its graph from the database `~/.codegraphcontext/.env` names in
`DEFAULT_DATABASE`, and the MCP server connects to it before it answers
anything. A database that is not there takes the whole server with it: it
exits at startup, writes nothing to stdout, and the MCP client reports
`Failed to connect: Connection closed` — which names the transport and not the
cause. The same database is what the session-start refresh writes to, so a
database that is down leaves the graph stale as well, and the refresh fails
into a log the operator does not read.

`bash scripts/install.sh --check` therefore asks the database a question
rather than asking whether the executable is installed: `ok CodeGraphContext
graph database` when it answers, and the database it was using together with
the reason it did not when it does not. `codegraphcontext doctor` is the same
question asked by CGC itself. The local `falkordb` database is the one that
holds the graph on a host with no shared database server: it starts on
demand, keeps its data in `~/.codegraphcontext/global/db/falkordb`, and
`DEFAULT_DATABASE=falkordb` selects it.

The checks resolve the tools the way the MCP launcher resolves them, because
the launcher is what has to run them. pipx installs into `~/.local/bin`, which
a shell profile puts on `PATH` and a bare process does not, so a `PATH`-only
lookup reported an installed tool as missing on a host where the launcher
started it every day.

Native MCP clients such as Claude Code also start servers with a minimal
environment, which may omit Node even when it is installed through pnpm. The
launcher checks `PATH`, then `PNPM_HOME/bin/node` (or pnpm's platform-default
bin directory); `AUTODEV_NODE_BIN` can select a Node executable explicitly.
Without Node, all three AutoDev MCP processes exit before their server starts,
and the client reports the generic `Connection closed` transport error.

### User configuration composition

Codex user-level configuration is managed via a composed model rather than a direct symlink:

- **Portable runtime/provider source (`config/config.autodev.toml`):** Contains AutoDev-owned model/provider, telemetry, feature, and shell/runtime settings that are not canonical RuleSync agent-facing configuration. Agent/skill/MCP/hook/permission definitions belong in RuleSync where supported; `.rulesync/mcp.jsonc` is canonical for MCP declarations and `.rulesync/permissions.jsonc` is canonical for Codex and Antigravity permissions and command rules (`default_permissions = ":danger-full-access"`, `approval_policy`, `approvals_reviewer`, `tools.web_search`, and `$CODEX_HOME/rules/rulesync.rules`).
- **Composer (`runtime/src/config/compose-user-config.ts`):** Deterministically merges the portable source, the Rulesync-generated Codex MCP projection, and the Rulesync-generated Codex permissions projection (`codexcli`) with existing machine-local state at `$CODEX_HOME/config.toml`. AutoDev-owned settings win conflicts, while operator-specific keys (such as `notify`, `projects`, `marketplaces`, desktop/TUI preferences, custom non-AutoDev MCP servers, and user-added skills) are preserved. Legacy `[permissions.*]`, `sandbox_mode`, and `[sandbox_workspace_write]` keys from older installations are stripped so stale sandboxes cannot linger.
- **Root role settings:** The root turn is the orchestrator, so the composer overlays `agents/roles/orchestrator.toml`'s per-server settings (`enabled`, `enabled_tools`, `default_tools_approval_mode`) onto each server the MCP projection declares, the same keys a child role's TOML owns for that child. Launch keys stay with the projection. Orchestrator entries the projection does not declare (the plugin-owned `codex_app`) add nothing to `mcp_servers`. This is what gives native and Claude-served root turns the orchestrator's scoped CodeGraphContext tools rather than CGC's full surface.
- **Hook and state handling:** `.rulesync/hooks.jsonc` is the sole hook declaration source, and it declares one shared block with no per-target override. The installer generates provider projections alongside repository skills. Codex hooks are written only to `$CODEX_HOME/hooks.json` (a regular file rendered by Rulesync's user-level projection): Codex loads that file and the working project's `.codex/hooks.json`, so a repository copy ran every hook twice in AutoDev sessions; the installer removes it and trusts only the user-level path. `--check` validates those outputs, including that the repository carries no `.codex/hooks.json`. The composer removes legacy Codex hook event arrays while preserving `hooks.state` and unrelated machine-local state. Codex runs a hook only when `[hooks.state]` in `$CODEX_HOME/config.toml` holds the hash it computes for that hook's definition, and it skips a hook whose stored hash is missing or stale without saying so; the installer therefore computes those hashes from the hooks file it just wrote (`runtime/src/platform/hook-trust.ts`), the way Codex computes them, instead of keeping a table of them, so a declaration change cannot leave a hook untrusted. Rulesync projections are lossy where documented: Codex cannot retain `prevent_idle_sleep`; Copilot projects `PreToolUse` but not `SessionStart`; Antigravity projects `SessionStart` and `PreToolUse` but not `SubagentStart` or `UserPromptSubmitted`. Validate the actual provider projection and hook behavior against the current Rulesync sources.
- **Orchestration policy lives in the skill, not in a hook:** The root's delegation policy is carried by the always-enabled `orchestration` skill, which Rulesync projects to every target, and enforced by the `role-sandbox` `PreToolUse` hook, which refuses the git-history subcommands for a root model (and by the same list as Copilot's `--deny-tool` arguments). No hook injects policy into a prompt: the injection the root-delegation hook used to perform was removed, and the hook itself is gone. `agents/prompts/roles/orchestrator.md` names the orchestration layer as the root's delegation surface; it is the only orchestrator prompt, and the runtime installs it read-only.
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
with MiniMax-M3, which supports `none` or `high`, and MiniMax-M3.1-Flash-Preview,
which supports `low` through `max` but rejects `none`. A
role's `[mcp_servers.<name>]` tables declare only per-role settings (`enabled`,
`default_tools_approval_mode`, `enabled_tools`). The renderer copies each
server's launch keys from the Codex projection of `.rulesync/mcp.jsonc`:
`command` and `args`, or `url` plus `transport = "streamable_http"`. Every
rendered entry is therefore a complete server even when disabled, and a role
naming a server `.rulesync/mcp.jsonc` does not declare fails to render. Codex App connectors are native app tools rather than role MCP
servers and must not be represented as enabled-only role tables.

`.rulesync/mcp.jsonc` declares the `codegraphcontext`, `lsp`, `cocoindex-code`,
and `playwright` MCP servers through the installed `run-autodev-mcp.sh` launcher,
`openaiDeveloperDocs` by URL, and `context7` and `googleDeveloperKnowledge` by URL.
`context7` is the hosted
`https://mcp.context7.com/mcp` server that resolves third-party library IDs and
returns version-pinned docs and source snippets; the operator supplies the
`CONTEXT7_API_KEY` secret — in macOS Keychain (service `CONTEXT7_API_KEY`, via
`node runtime/src/platform/install-state.ts keychain set CONTEXT7_API_KEY` or
Keychain Access), or exported as
an explicit environment override — and AutoDev injects it only into role
processes that enable `context7`, where Codex's `bearer_token_env_var` plumbing
forwards it as the bearer token. The
`context7` entry is registered at user-level but the role TOMLs explicitly
gate it: `docs-researcher` and `explorer` enable it (their bounded work
frequently needs to answer "how do I call method X on library Y" or "what's the
current signature for API Z"); `orchestrator` and `browser-tester` explicitly
disable it so the root turn never picks it up and the UI-testing role never
diverts from Playwright. Other roles (`default`, `worker`, `validator`,
`smart`) intentionally omit `context7` and follow their existing MCP surface.
`googleDeveloperKnowledge` is Google's official Developer Knowledge MCP at
`https://developerknowledge.googleapis.com/mcp`, whose `search_documents`,
`get_documents`, and `answer_query` tools serve Google's own documentation
corpus. Its credential is a Google API key sent in the `X-Goog-Api-Key` header,
and the declaration names the variable rather than the key:
`"headers": { "X-Goog-Api-Key": "${GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY}" }`.
A `${VAR}` header value is AutoDev's convention for "this header's value comes
from the environment variable VAR" (the same convention RuleSync uses);
RuleSync gives the Codex projection Codex's native `env_http_headers` spelling
for it, Codex reads the variable from its own process environment, and every
AutoDev-owned surface (the bridge MCP catalogue, the Control API's declared and
applied MCP state) keeps the `${VAR}` reference, so no tracked file and no
catalogue holds the key. The operator supplies
`GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY` the same way as `CONTEXT7_API_KEY` — in
macOS Keychain (`install-state keychain set GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY`),
in the environment AutoDev runs in, or in `$CODEX_HOME/.env`. The role TOMLs
gate it the way they gate `context7`: `docs-researcher` and `smart` enable it,
`orchestrator` explicitly disables it so documentation research is delegated
rather than done by the root turn, and every other role omits it. Without a key
the server still starts and answers authentication failures, so its tools are
simply unusable. The launcher resolves binaries from
AutoDev's pinned devDependencies while preserving the active workspace as the
MCP process cwd, so a target repository does not need to duplicate those
packages.

That cwd contract only holds when the caller launches from inside the
workspace. A host that starts MCP servers from its own process directory
instead leaves `cocoindex-code` with no project at all: `ccc mcp` binds its
index to the nearest ancestor holding `.cocoindex_code/settings.yml` and
refuses to start when there is none, and its auto-init cannot create one on a
read-only root. The settings file is the project marker, not the directory:
`~/.cocoindex_code/` is ccc's user-level directory (`global_settings.yml` and
its daemon), so it never makes the home directory a project.
Such a caller sets `AUTODEV_MCP_WORKSPACE` to the absolute path of the active
workspace, and `runtime/src/mcp/launcher.ts` runs the server there rather than
inheriting the caller's directory. The launcher rejects a relative or missing
workspace rather than starting in the wrong project, and initializes a
cocoindex project only when no ancestor already holds one. It initializes where
`ccc init` itself would: the nearest ancestor below the home directory that
holds `.git`, otherwise the workspace. It refuses to initialize the home
directory, any of its ancestors or the filesystem root, because that would index
everything beneath it, so a server started with no workspace (for example from
`$HOME`) exits with that reason instead.
`AUTODEV_MCP_WORKSPACE` composes with `AUTODEV_REPO_ROOT`, which selects the
AutoDev checkout supplying the launcher code and its pinned binaries, so a host
with more than one AutoDev checkout still runs the workspace it intends.
`tests/config/mcp-launcher.test.ts` covers both.

The launcher also resolves the tools it starts — `ccc` and `codegraphcontext`,
which pipx installs into `~/.local/bin` — and it resolves them from the home the
server runs with. A host that runs its provider CLI under a temporary `HOME`
(the Antigravity bridge does, to isolate the CLI's own configuration) hands the
servers it starts a home that holds none of the user's tools, and the launcher
then reports an installed tool as missing: "AutoDev CodeGraphContext MCP binary
is missing" or "AutoDev MCP binary is missing or not executable: `<temporary
home>/.local/bin/ccc`". `ccc` also reads its global settings from that home, so
the same home decides whether the server can serve at all.

Backend execution must resolve the installed binary and permitted configuration from trusted Runtime context, independently of a provider's isolated HOME. The launcher checks each candidate before selecting it; a nonexistent home-local binary must not shadow a working installation. The gateway target centralizes this backend environment selection and restricts access to approved workspace/index roots and required runtime dependencies. Do not solve missing tools by granting arbitrary home-directory access.

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
The canonical Rulesync configuration contains provider-specific current projection overrides. The ACP profile and gateway target must deliver the exact effective role tools, regardless of the provider's user-level registry. The `browser-tester` and `smart`
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
role enables the OpenAI Developer Docs, Context7, and Google Developer
Knowledge MCPs and Codex's native `web_search` tool, which includes web
fetching/opening and is the appropriate search/open/read path for authoritative
websites. Do not add a separate Codex `web_fetch` tool. Their rendered remote
MCP entries set `transport = "streamable_http"`, which the installed Codex
0.153.x role loader requires even when `url` is present.
Playwright is reserved for explicitly granted UI/browser testing roles; documentation-only and ungranted root roles do not receive it. Resolve tool names and grants from the current role contract, rather than relying on a provider's native tool surface. All ACP profiles and the shared Supergateway (including authenticated ChatGPT sessions) enforce the same canonical role and workspace policy, without provider-specific read-only restrictions.

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

Code-capable roles receive the contracted CodeGraphContext, CocoIndex and LSP tools; other roles must not receive ungranted code-navigation tools. The current ACP provider profile implementation (`runtime/src/acp/provider-profiles.ts`) isolates native settings and effective role capabilities. Missing required tool exposure is an integration defect, not a reason to weaken a role or exclude a provider on tool support. At gateway cutover every provider connects only to its role-scoped gateway endpoints.

The installer exposes the shared canonical skills through `$HOME/.agents/skills/`; root orchestrators receive the orchestration skill, and leaf roles receive only their own contracted skills. XACPX manages delegation; no parent-native spawn path or provider-specific tool mirroring is required.

Headless subagents run noninteractively and cannot answer interactive permission
prompts. The installer projects static Antigravity CLI permissions from
`.rulesync/permissions.jsonc` (via `rulesync`) into
`~/.gemini/antigravity-cli/settings.json` and layers dynamic, machine-local
workspace `read_file` grants on top; for AutoDev-managed turns the ACP profile must apply the selected role's effective grants without widening user or operator denies. Read-only roles keep the Antigravity sandbox and never
receive `--dangerously-skip-permissions` or `command(*)`. If a native command is
not allowed, the leaf prompt directs the model to stop retrying it and return a
visible summary that records the limitation.

- Web research permissions: `read_url` (`webfetch: { "*": "allow" }` in
  `.rulesync/permissions.jsonc`) for headless document and URL inspection.
- Scoped literal read grants for shared configuration: `read_file(~/.agents)`,
  `read_file(~/.codex)`, and `read_file(~/.gemini)` (in agy, directory grants provide recursive access without globs).
- Scoped `read_file(<root>)` grants for every configured workspace.
- A small fixed `unsandboxed(...)` allowlist (`pwd`, `pnpm test`, and the
  repository Python test command) declared in `.rulesync/permissions.jsonc`; this is not a general shell grant.

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
from local file access. Read-only roles must retain enforceable sandbox restrictions; write-capable roles retain their authorized policy. Broad shell
execution is never granted to read-only validation roles.

Run the installer with `--check` to validate that all configured workspace roots
and required MCP/read grants are present in the settings file:

```bash
bash scripts/install.sh --check
```

If any configured workspace or required MCP permission is missing, `--check`
reports the missing grants and exits with a non-zero status.

The installer links every skill whose frontmatter declares `targets` into
`$HOME/.agents/skills/`; today that is:

- `ccc`
- `code-simplification`
- `diagnosing-bugs`
- `doubt-driven-development`
- `game-playtesting`
- `improve-codebase-architecture`
- `lsp-mcp-server`
- `orchestration`
- `playtest-analysis`
- `remove-legacy-shims`
- `resolve-merge-conflicts`
- `source-driven-development`
- `writing-agent-skills`

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
- `docs-researcher` enables only `source-driven-development` for
  authoritative documentation research.
- `playtester` enables `game-playtesting`, and `playtest-analyst` enables
  `playtest-analysis`.
- `browser-tester` deliberately enables no engineering skills; its bounded
  work is Playwright UI testing.

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
  `sites`, `openai-developers`, `openai-templates`, and `cloud-environment`
  from `openai-curated-remote`, and `sites`, `browser`, `computer-use`,
  and `visualize` from `openai-bundled`. `sites`
  ships from two marketplaces that declare the same
  `sites-building`/`sites-hosting` skill names, so both copies must be
  disabled. `plugin-management` is deliberately left enabled as the
  operator's escape hatch for re-enabling any of the above. `codex-app-tools`
  is explicitly enabled because AutoDev narrows its `codex_app` MCP to
  `request_user_input`. Plugins that declare no skills (for example `github`)
  are not named here at all and stay under the operator's local config.
- **Bundled-plugin tool lockdown** covers the whole `openai-bundled`
  marketplace, including the plugins that declare no skills. `unified-computer-use`
  is the one that ships tools rather than skills: its `cua_repl` MCP server
  is Codex's native computer-control surface, and its tools reach the model
  directly. It is disabled in the portable source with the rest of the
  family, and the composer disables any other bundled plugin the portable
  source does not enable - including the plugins Codex has installed under
  `$CODEX_HOME/plugins/cache/openai-bundled/`, which Codex enables when no
  config names them.
- **Per-skill disable** (`[[skills.config]] name = "<skill>" enabled = false`)
  works for the four Codex `.system/` skills that are not relevant to
  AutoDev: `imagegen`, `plugin-creator`, `skill-creator`,
  `skill-installer`. `openai-docs` is intentionally kept because Codex
  self-knowledge is directly relevant to this repository.
- **Remote-installed plugin skills** need per-skill disables too. Codex
  Desktop 0.167 lists the skills of plugins installed for the account
  (`openai-curated-remote`) even when the portable source disables the
  plugin: every agent on 2026-11-12 carried `openai-developers`, `sites`,
  `visualize`, `google-drive`, and `work-pets` skills, about 6 KB of
  context per thread, and `cloud-environment` (`cloud-desktop`,
  `cloud-environment-runtime`) also surfaced from the plugin cache. The
  account's `openai-templates` skills, which the
  machine-local config disables by name, were absent. So the portable
  source also disables each of those skills by `<plugin>:<skill>` name,
  and `google-drive`, `work-pets`, and `cloud-environment` as plugins. An isolated `CODEX_HOME`
  cannot reproduce this, because it has no account-installed plugins. Check
  the next live rollout's `### Available skills` to confirm.
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
portable source does not name are left to machine-local state, with one
exception: the `openai-bundled` marketplace is off by default, so a bundled
plugin the portable source does not enable stays disabled even when the
local config turns it on, and a bundled plugin Codex installs after the last
install is named - disabled - by the next one. Enabling one of those means
enabling it in `config/config.autodev.toml` and re-running the installer.

`autodev-request-capture` and `autodev-session-diagnostics` are **AutoDev-specific, repository-only** development skills because they operate on its runtime, transports, and session evidence. `opentelemetry` is also currently projected at repository level, but its engineering guidance is project-independent; the active project's documentation owns concrete observability decisions. `writing-agent-skills` is reusable and declares user-level targets. Repository-only skills omit `targets` and reach the repository skill folders; `orchestration`, `ccc`, and `lsp-mcp-server` target Copilot in addition to their user-level installation because Copilot's cloud agent has no user-level skills. External curated skills declared in `rulesync.jsonc` (`sources`) are
materialized under `.rulesync/skills/.curated/` via `rulesync install --frozen`
and projected alongside the repository skills rather than linked as user-level
skills. Two transports carry them: `vercel-labs/agent-skills` and
`multica-ai/andrej-karpathy-skills` come from GitHub and are pinned in
`rulesync.lock` (`react-best-practices` and `karpathy-guidelines`), while the
skills that the packages this repository already depends on ship -- `acpx`
from `acpx`, `quota-axi` from `quota-axi`, `opencli-autofix`,
`opencli-browser`, and `opencli-usage` from `@jackwener/opencli`, and
`getting-started` and `table-state` from `@tanstack/react-table` -- are
fetched from the npm registry and pinned in `rulesync-npm.lock.json`. The
manifest names the package and no version, the way the GitHub sources name a
repository and no ref: the lockfile records the release the frozen install
fetches, and that release is the version the workspace installs, so a skill
always documents the CLI this repository runs.

Keep the canonical registered user-level skill content in AutoDev; update the
skill directories there and rerun the installer when changing this setup. The
installer links each complete skill directory with an absolute target; do not
link an individual `SKILL.md` file because Codex currently skips file-level
symlinks. Its `--check` mode rejects missing or relative skill-directory links
and symlinked `SKILL.md` files. Restart Codex or start a new task after
installation so user-level skill discovery refreshes.

### Prompt catalog (commands for every provider)

`.rulesync/commands/*.md` is the single tracked source for AutoDev's custom
prompts (slash commands) in every provider Rulesync supports. The file name is the prompt name; agents
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

`rulesync.jsonc` gives `commands` to the targets that own a command surface, so
every `rulesync generate` from that config (the installer's repository
generation, its `--check`, and Copilot's cloud setup steps) projects the
catalog into each project target's native command surface, as Rulesync defines
it:

- Claude Code: `.claude/commands/<name>.md` (`/<name>`).
- GitHub Copilot: `.github/prompts/<name>.prompt.md` (`/<name>`).
- Antigravity (CLI and IDE): `.agents/skills/<name>/SKILL.md`, invoked as
  `/<name>`. Antigravity retired workflows (`.agents/workflows/`) on
  2026-10-19 in favour of skills, which are invoked the same way, so Rulesync
  projects commands as skills. The IDE reads the same project
  `.agents/skills/` directory, so the `antigravity-cli` target covers both.
  Codex also reads `.agents/skills/`, so it lists these as repository skills
  in this repository.

These outputs are untracked (`.gitignore` lists the first two;
`.agents/skills/` is in `.git/info/exclude`). Rulesync skips project-mode
commands for `codexcli` (global-only) and `agentsmd` (simulated only), which is
why the installer projects Codex prompts separately as above. A Console prompt
edit runs `materializeCurrentCommandProjections`, which regenerates and checks
the repository projections and then reconciles `$CODEX_HOME/prompts/`.

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

Destructive Git commands and unsafe shell commands are blocked by Codex's native rules engine (`permission.bash` in `.rulesync/permissions.jsonc`). The installer projects those rules via Rulesync and copies them to `$CODEX_HOME/rules/rulesync.rules` as a regular file: Codex loads a rules entry only when it resolves to a file directly inside `$CODEX_HOME/rules/` and skips symlinks silently, which leaves every rule inert. `bash scripts/install.sh --check` reports a missing, symlinked, or stale `rulesync.rules` file as drift. Validate projected rules without running a command using `codex execpolicy check --pretty --rules "$CODEX_HOME/rules/rulesync.rules" -- git reset --hard HEAD`.

The rules deny direct `ccc` CLI execution from agent shell commands (code-capable roles must use the configured `cocoindex-code` MCP server; `run-autodev-mcp.sh cocoindex-code` still launches its backend process), prompt on `git commit --amend`, and deny destructive Git history/worktree operations (`git checkout`, `git reset`, `git stash`, `git clean`, `git rebase`, `git restore .`, `git branch -D`, force pushes), superuser/raw-disk commands, and catastrophic recursive deletion targets (`rm -rf /`, `~`, `.`, `..`, `.git`).

### Codex command rules: only entries inside the rules directory load

Codex reads command rules from `$CODEX_HOME/rules/*.rules`. It loads an entry only when that entry resolves to a file **directly inside `$CODEX_HOME/rules/`**. A symlink whose target sits anywhere else — the repository checkout, another file in `$CODEX_HOME`, or a subdirectory of `rules/` — resolves outside that directory and is skipped **silently**: no error, no warning, and no rule from the file takes effect.

That is why the installer copies the projected `rulesync.rules` into `$CODEX_HOME/rules/rulesync.rules` as a regular file (`0o644`) instead of symlinking it.

**Detection.** Look at the installed file directly or run `--check`:

```bash
ls -l "$CODEX_HOME/rules/rulesync.rules"   # a regular file, not a symlink
bash scripts/install.sh --check              # reports "rule file rulesync.rules" drift
```

`install.sh --check` compares the installed file against a fresh projection of `.rulesync/permissions.jsonc` by content and rejects a symlink, so a drifted installation is visible without running Codex at all.

**Verified how.** The behaviour was reproduced against real Codex binaries (an isolated `CODEX_HOME` holding one rule file, a throwaway workdir, and a scripted fake provider):

```bash
node .rulesync/skills/autodev-session-diagnostics/scripts/rule-loading-probe.ts --codex "$(command -v codex)"
```

`tests/config/command-rules.test.ts` pins both the `codex execpolicy check` decisions on projected `rulesync.rules` and the regular-file copy behavior (replacing any symlink).

### Codex command rules: the exemption is granted per command, not per session

The `allow` rules in `agents/rules/default.rules` are what let an agent stage
and commit. Codex's `workspace-write` sandbox keeps `<root>/.git` read-only, so
an allowed command runs outside the sandbox and an unallowed one cannot write
the index at all — it fails with `.git/index.lock: Operation not permitted`.

That exemption is decided **per command**, and Codex judges a chain as a
whole: the chain runs outside the sandbox only when **every** part of it
matches a rule. So the shape of the command decides whether the agent can
commit:

| Command form                                   | Can write `.git` |
| ---------------------------------------------- | ---------------- |
| `git add <path>`                               | yes              |
| `git add -- <paths>` (many paths, one command) | yes              |
| `git add <path> && git status --short`         | yes              |
| `git add <path>; git status --short`           | yes              |
| `git add <path> && git commit -m "…"`          | yes              |
| `cd <dir> && git add <path>`                   | no               |
| `git add <path> 2>&1`                          | no               |
| `git add <path> \| cat`                        | no               |
| `for f in <paths>; do git add "$f"; done`      | no               |
| any of the above with `shell: "/bin/bash"`     | no               |

The last row is a separate mechanism: Codex resolves the `shell` argument by
**name** through `PATH`, ignoring the directory in the path you give it. On an
Apple Silicon machine `bash` is often a Homebrew x86_64 build that runs
translated, and macOS keeps the sandbox on a translated shell, so the
exemption never applies. The default shell works.

The read-only inspection commands (`git status`, `git diff`, `git rev-parse`,
`git ls-files`, `git branch`) are allowed so that the natural
`git add … && git status` chain works. `git log` and `git show` are not: the
root orchestrator's own policy refuses to read Git history at all.

**Do not probe the write access with `touch .git/<file>`.** It matches no
rule, so it is sandboxed by design and always fails, including in a session
that stages successfully — a session that read that failure as ".git is
read-only" had never tried a real `git add`. On this machine the tell for a
sandboxed command is the noise the login shell makes when it is sandboxed
(`/Users/<user>/.rvm/scripts/rvm: line 15: /bin/ps: Operation not permitted`);
its absence means the command ran outside the sandbox.

**Verified how.** The same harness as the rule-loading probe: a real Codex
against a throwaway Git repository and an isolated `CODEX_HOME` holding the
tracked rules file, with a scripted fake provider (no API key, no network).
The probe stages one file through each command form and reports which forms
keep the write access:

```bash
node .rulesync/skills/autodev-session-diagnostics/scripts/git-write-access-probe.ts --codex "$(command -v codex)"
```

Observed on 2026-11-21 with `codex-cli 0.171.0-alpha.13` (the Codex app
bundle): the table above, with the `&& git status` chain failing before the
read-only inspection rules were added and passing after.

### How `.git` becomes writable: three mechanisms, measured

The exemption above is one of three ways an agent can write `.git`, and they
are not interchangeable. Measured on 2026-11-21 with `codex-cli 0.171.0-alpha.13`
(the probe drives a real Codex against a throwaway repository; `--writable-root`,
`--permission-profile` and `--no-sandbox-mode` select the configuration):

| Mechanism                                                              | Who can write `.git`                    | `git add … && git status`                    | `git config core.hooksPath` |
| ---------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------- | --------------------------- |
| the sandbox alone (`workspace-write`)                                  | nobody                                  | no                                           | no                          |
| an execpolicy `allow` rule                                             | that one command, outside the sandbox   | yes, when every part of the chain is allowed | no                          |
| `[sandbox_workspace_write] writable_roots = ["<repo>/.git"]`           | every command                           | yes                                          | **yes**                     |
| `writable_roots = ["<repo>/.git/index"]` (a file)                      | nobody — a writable root is a directory | no                                           | no                          |
| a Codex permission profile, `".git/**" = "write"`                      | every command                           | yes                                          | **yes**                     |
| a permission profile, `".git/**" = "write"` + `".git/config" = "read"` | every command except `.git/config`      | yes                                          | no                          |

Two facts follow from the table:

- **A writable root is a directory, and a permission profile is not.** The
  sandbox's `writable_roots` cannot say "writable `.git/index`, not
  `.git/config`": a file path as a writable root has no effect, so the smallest
  grant that works is the whole `.git` directory, and that lets any command
  plant a hook. A Codex permission profile (`default_permissions` plus
  `[permissions.<name>.filesystem]`) is path-scoped _with specificity_: the more
  specific `".git/config" = "read"` wins over the broader `".git/**" = "write"`,
  so staging works while `.git/config` stays read-only.
- **A selected permission profile overrides the sandbox.** With
  `default_permissions` set, the profile's filesystem table decides what is
  writable — `sandbox_mode` and `[sandbox_workspace_write]` no longer do. That
  is also why AutoDev does not let Rulesync generate the Codex permission
  profile: one global profile flattens the per-role tiers
  (`config/config.autodev.toml` + `config/execution-contract.json`), which is
  the 2026-11-11 incident recorded above.

The execpolicy `allow` rule stays the mechanism AutoDev uses: it is per
command, so every other command keeps `.git` read-only, and it does not
disturb the sandbox the roles run in.

## Safety

- Inspect launch-agent plists before loading them with `launchctl`. The model
  router plist keeps `KeepAlive` and `RunAtLoad`, separates stdout/stderr
  under `$CODEX_HOME/run/`, uses `ProcessType=Standard` (Background would
  throttle it into the lowest CPU and disk I/O tier), and sets an
  `ExitTimeOut` large enough for the router's drain timeout before launchd
  SIGKILLs it. Inspect the other provider plists independently; they may have
  different lifecycle and log-path contracts.
- Every service LaunchAgent sets `AUTODEV_NODE_BIN` to the installer's
  chosen native Node. A direct launch or hook under launchd's minimal `PATH`
  resolves `${PNPM_HOME:-$HOME/Library/pnpm}/bin/node` instead. There is no
  fallback to NVM, npm or Homebrew-managed Node, and the installer never
  creates or rewrites `~/.zprofile` to modify the login shell's PATH.
  If Node is missing, provision it with `pnpm runtime set node 24.12.0 -g`
  and rerun the installer.
- Keep OAuth/PAT/API credentials outside the repository. On macOS, store `MINIMAX_API_KEY`, `CONTEXT7_API_KEY`, and `AUTODEV_CHATGPT_TUNNEL_API_KEY` in macOS Keychain via `/usr/bin/security` (or `node runtime/src/platform/install-state.ts keychain set <NAME>` reading from stdin); explicit environment variables always override Keychain. Normal runs of `scripts/install.sh` check that required API keys (`MINIMAX_API_KEY`, `CONTEXT7_API_KEY`) are present in macOS Keychain without modifying Keychain or migrating `.env` automatically (and `scripts/install.sh --check` reports missing Keychain items or leftover plaintext entries in `$CODEX_HOME/.env`). Each secret is injected only into processes that require it (`MINIMAX_API_KEY` into the Model Router and `mcode`, `CONTEXT7_API_KEY` into roles enabling `context7`, `AUTODEV_CHATGPT_TUNNEL_API_KEY` into `tunnel-client`). Background services keep other internal router/bridge credentials in mode-0600 `$CODEX_HOME/.env` and `$CODEX_HOME/openlit-secrets.env`.
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
It is generated by `runtime/src/config/render-execution-contract.ts` from the current
role TOMLs plus the root orchestrator configuration. Runtime consumes it for role kind, the sandbox a role
declares, expected MCP/skill capabilities, and adapter spawn-tool metadata. Canonical role prose lives in
`agents/prompts/roles/*.md`; the execution integration and role renderer share those fragments instead of duplicating them. A provider integration must report missing capabilities rather than silently substituting a different workflow. Native role
TOMLs remain the **current transitional capability input** until the RuleSync subagent/agent-role migration reaches parity; they are not the long-term canonical source. The installer fails when the generated contract drifts from the current input. The root orchestrator uses the
capability-only `agents/roles/orchestrator.toml` declaration but is not
installed as a child role. A child must be resolved through the canonical role and workspace contract, with exact effective MCP/skill grants. The XACPX-only delegation target does not depend on native Codex child inheritance. Skill paths and grants are derived by Runtime, not trusted from agent-supplied spawn prose.

Workspace-local `.codex/agents/*.toml` roles are allowed when they use names
outside AutoDev's managed flat roles. A project-local role that reuses a managed
name is rejected as an explicit conflict rather than silently choosing precedence;
this keeps user-level provider routing deterministic while allowing repository-
specific agents, MCPs, and skills to coexist under distinct names.

### Role capabilities and read-only isolation

AutoDev runs Codex without OS-level `sandbox_mode` (`default_permissions = ":danger-full-access"` in `.rulesync/permissions.jsonc`) and enforces per-role access directly at the tool, MCP, and hook boundaries:

- Read-only role TOMLs declare `# role-access: read-only`, and shell-free roles (`browser-tester`, `playtester`, `playtest-analyst`) set `[features] shell_tool = false` and restrict MCP tools via `enabled_tools`.
- Read-only roles with file access (`explorer`, `docs-researcher`) pass `AUTODEV_MCP_READ_ONLY` to `filesystem` MCP (`--read-only`), which removes file-mutation tools from the server schema, while `runtime/src/hooks/role-sandbox.ts` + `runtime/src/agents/read-only-policy.ts` enforce the read-only shell allowlist in `PreToolUse`.
- ACP Runtime evaluates `session/request_permission` against the effective role/read-only contract; the gateway target requires matching server-side tool and workspace enforcement for all callers. Do not rely on a provider-specific header or direct launch path as the only security boundary.

- `runtime/src/hooks/role-sandbox.ts` is a Codex `PreToolUse` hook. Codex runs
  a hook for every tool call, inside the thread that made it, and the hook is
  told the role of that thread. The hook refuses the calls a read-only role
  may not make, with `permissionDecision: "deny"` and the reason the model
  reads back.
- `runtime/src/agents/read-only-policy.ts` is the policy the hook applies. It
  is an allowlist: a command is permitted when every command in it is a
  command that cannot write, and the shell's write-capable constructs --
  redirection, command substitution, environment overrides -- are refused
  outright. `git` and `gh` are allowed only in their reading forms, `curl`
  only for a read method, and a program run by path has to live in a system
  directory the agent cannot write to. A denylist would have to know every
  command that can write, and the next interpreter or script runner would be
  a hole in it.
- The hook is registered in `.rulesync/hooks.jsonc` and materialized to
  `$CODEX_HOME/src/hooks/role-sandbox.ts`.

The root orchestrator is subject to the same role-aware policy regardless of host. Existing `runtime/src/agents/orchestrator-policy.ts` restricts Git history access; scoped regression investigations belong to an authorized child. Native provider shell and file gates are defense in depth. ACP permission handling and the gateway/backend must enforce effective role and workspace bounds independently; provider hooks alone are not an OS security boundary.

A role-scoped run receives only the authorized sandbox and tool grants. The provider's actual enforceable restrictions must be verified; unsupported restrictions fail closed. Network access follows the effective policy, not a client-controlled header.

The Console's role capability matrix publishes both answers: the sandbox a
role runs in (the effective mode) and the sandbox it declared. A role whose
declaration the session narrowed shows the narrowing rather than folding it
away.

### File surface hook

Files are read and edited only through the `filesystem` MCP server
(`@modelcontextprotocol/server-filesystem`), on every provider; see "File
interaction surface" in `docs/autodev-console-target-state.md`. For Codex,
AutoDev's model catalogs leave out `apply_patch_tool_type`, so `apply_patch` is
not offered. `view_image` cannot be removed by configuration -- Codex 0.171
offers it whatever `[tools] view_image` or the model's input modalities say --
so `runtime/src/hooks/file-surface.ts`, a `PreToolUse` hook registered in
`.rulesync/hooks.jsonc` for `apply_patch|view_image`, refuses both with the
`filesystem` tool to use instead (`read_media_file`; `edit_file` or
`write_file`). It also covers `apply_patch` on a model whose catalog AutoDev
does not render. Refusals are logged to `$CODEX_HOME/hooks/hooks.log` with
`"hook":"file-surface"`.

The existing launcher accepts `AUTODEV_MCP_WORKSPACE` and `AUTODEV_MCP_READ_ONLY=1` from trusted execution context, adds `--confine-roots` and the approved skill roots as `--read-only-dir`. In the mandatory gateway target, these are gateway/backend launch parameters, not client-controlled grants.

### Rulesync shared configuration

`.rulesync/` is the only tracked Rulesync input, and nothing Rulesync generates is tracked as a test fixture. The repository projections use `codexcli`, `claudecode`, `copilot`, and `antigravity-cli`; the separate `copilotcli` target is used for user-level MCP generation. `rulesync.jsonc` is the only RuleSync configuration, and it declares the features **per target** rather than one list for all of them, because a shared output tree needs a single writer. `.agents/skills/` is read by Codex CLI and Antigravity CLI alike: two targets writing it would have to produce byte-identical files, and a skill whose frontmatter one client reads and the other ignores -- `user-invocable` in the `quota-axi` skill, which Antigravity turns into `disable-slash-command` and Codex ignores -- makes that impossible, so the check reports the tree as drifted on every run. The `codexcli` target therefore owns `.agents/skills/` and the `antigravity-cli` target owns the commands projected into the same directory; the `codexcli` target owns no `hooks`, because Codex hooks are written only at user level. A Rulesync run that names its features or targets replaces this per-target map with a flat selection, and a flat selection cannot express "this target owns that feature", so the Runtime runs the whole configuration and lets Rulesync resolve the owners from the map. `rulesync.jsonc` also declares the output root per target, so each target's projections are named in the configuration instead of being implied by a single shared root. A hook in the shared `hooks` section reaches every target, and a per-target section **replaces** the shared section for the event it names rather than adding to it: a `codexcli.hooks.preToolUse` entry leaves Codex without the shared `PreToolUse` hooks, so a hook that belongs to one host only has to be listed there together with the shared ones it needs. **Current state:** its project-mode generation covers repository projections that have reached parity. The pinned RuleSync version supports native subagent generation for the four configured targets, but native role TOMLs/execution-contract code remain transitional because those projections do not encode AutoDev's complete shared role contract losslessly; the `subagents` and `permissions` features are not currently enabled. **Target:** move every losslessly representable agent-facing definition into canonical RuleSync sources, then delete the duplicate native authority only after field-level and runtime parity is proven. Do not add another AutoDev-specific declarative schema during that migration.

`.rulesync/rules/overview.md` is the canonical source for repository-wide agent instructions. RuleSync targets only `agentsmd` for this rule and generates the tracked root `AGENTS.md` projection, which Codex, Antigravity, and Copilot (cloud agent, code review, CLI, VS Code chat) read natively. `CLAUDE.md` remains a symlink to the projection for Claude Code. Copilot Chat on github.com reads only `.github/copilot-instructions.md`, which is intentionally absent. `tests/agent-instructions.test.ts` and `tests/rulesync-rules.test.ts` guard the ownership and generated output.

`.rulesync/mcp.jsonc` is the canonical MCP backend source; use the Rulesync version pinned by `package.json`. The `xacpx` MCP is declared here and the existing launcher runs its native `mcp-stdio` entrypoint. Its exposure is role-scoped. The canonical target requires all provider-facing MCP projections to reference the shared gateway, including XACPX; the direct launch projections below describe the existing materialization path until cutover:

- **Claude Code, Copilot CLI, Antigravity:** for each of `claude`, `copilot`, and `agy` that is installed, `rulesync generate --global --features mcp` writes `~/.claude.json`, `~/.copilot/mcp-config.json`, or `~/.gemini/config/mcp_config.json`. `claude` and `agy` are looked for on `PATH`; `copilot` is looked for the way its bridge looks for it, so a CLI installed under a version manager counts as installed. Rulesync keeps every non-MCP key in those files but owns their server lists: a server you add by hand is removed on the next install and reported as drift by `--check`. Add personal servers to `.rulesync/mcp.jsonc` instead.
- **Codex:** Rulesync's global output ignores `CODEX_HOME`. The installer therefore generates the Codex projection into a temporary root, and the composer merges its servers into `$CODEX_HOME/config.toml`, keeping any server you added there. The role renderer and execution-contract builder read the same projection.
- **MiniMax Code (`mcode`):** the provider runs against the AutoDev-managed MiniMax Code profile in `$AUTODEV_HOME/providers/mcode`, handed over through `MINIMAX_DATA_DIR` (MiniMax Code resolves its profile from `--data-dir`, `MINIMAX_DATA_DIR`, `MAVIS_DATA_DIR` or `~/.minimax`; it never reads `MCODE_HOME`). The profile is generated from the canonical `.rulesync/` sources with stock RuleSync targets -- `agentsmd` writes the profile `AGENTS.md`, `claudecode` writes the profile `hooks.json` and `permission.json` -- and `config.yaml` and `auth/` are links to the operator's own MiniMax Code profile, so a session runs with the models and credentials the operator already configured. The profile holds no MCP configuration on purpose: the role's authorized MCP servers are injected into the ACP session from the execution contract, and MiniMax Code merges session servers over profile servers by name, so a profile-level list would expose servers to roles that do not hold them. MiniMax Code discovers the canonical skills and instructions without a MiniMax-specific projection: it reads `$HOME/.agents/skills/` and `<workspace>/.agents/skills/` (the shared RuleSync skill projections), `<workspace>/AGENTS.md`, and the profile `AGENTS.md`. Two projections are translated here because RuleSync cannot express them for this product: MiniMax Code rejects a hook matcher that carries an inline case-insensitive flag, so the canonical matchers are projected onto MiniMax Code's tool names, and MiniMax Code's native permission rules are `permission.json` v2 entries rather than Claude's rule strings, so the canonical deny list is projected into that shape. Only the deny rules are projected: an allow rule in MiniMax Code's engine answers a tool call without asking the ACP client, which would take the role contract out of the decision.
- MCP generation passes its settings as flags, because a Rulesync config file with `global: true` generates nothing.

The suites generate from `.rulesync/` into temporary roots:

- `tests/rulesync-mcp.test.ts` checks that the Codex projection and each user-level file list exactly the servers `.rulesync/mcp.jsonc` declares for that tool, that non-MCP keys survive, and that `--check` catches edited or extra servers.
- `tests/rulesync-hooks-shadow.test.ts` checks the five command hooks across SessionStart and PreToolUse, and that the declaration carries no per-target override. Rulesync omits `SessionStart` for Copilot and omits Codex-only fields such as `prevent_idle_sleep`; the tests freeze each target's actual projection.
- `tests/rulesync-commands.test.ts` checks the `.rulesync/commands/*.md` catalog: Data reads every canonical file, Runtime selects only `codexcli` and wildcard targets (including RuleSync's default target), the Rulesync projection contains exactly those commands with description-only frontmatter (no `targets` leak), the project-mode projection writes the whole catalog to Claude Code, Copilot, and Antigravity CLI, and real materialization preserves prompt bodies, reconciles stale files, reports changed prompts, and is idempotent.

AutoDev scripts remain the hook implementations, while Rulesync owns declarations. The installer materializes the generated projections in the active repository and validates them with `--check`; no duplicate hook declarations remain in `config.autodev.toml`. `.rulesync/permissions.jsonc` is the canonical portable permission source, with generated Codex and Antigravity permission/command-rule projections where supported. The role execution contract and runtime enforcement remain responsible for restrictions that are not expressible losslessly in those projections. After changing `.rulesync/`, `rulesync.jsonc`, or the pinned Rulesync version, run the same suites CI runs:

```bash
node --test tests/rulesync-mcp.test.ts tests/rulesync-hooks-shadow.test.ts tests/rulesync-skills.test.ts tests/rulesync-permissions-inventory.test.ts tests/rulesync-commands.test.ts tests/rulesync-rules.test.ts
```

Rulesync does not replace AutoDev's live hook enforcement or role filtering. `.rulesync/skills/` is the single tracked source for every AutoDev-authored skill, and external curated skills declared in `rulesync.jsonc` (`sources`) and locked in `rulesync.lock` (the GitHub sources) and `rulesync-npm.lock.json` (the npm sources) are materialized under gitignored `.rulesync/skills/.curated/` via `pnpm exec rulesync install --frozen --silent`. The generated repository skill folders each tool discovers inside AutoDev (`.github/skills/` for Copilot, `.claude/skills/` for Claude Code, `.agents/skills/` for Codex) are untracked Rulesync output combining both local repository skills and curated skills; `.agents/skills/` also holds the Antigravity CLI command surface, which is the same directory. The installer installs frozen sources from both lockfiles and generates the projections by running the pinned `node_modules/.bin/rulesync` with `rulesync.jsonc` (run `pnpm install --frozen-lockfile` first). Its `--check` reports edited, stale, or missing copies. `.gitignore` lists the first two as well as `/.rulesync/skills/.curated/` (while tracking `rulesync.lock` and `rulesync-npm.lock.json`). The installer writes the exclusions for the generated outputs to `.git/info/exclude` instead, by running `rulesync gitignore`: the repository's `rulesync.jsonc` routes them there with `"gitignoreDestination": "gitexclude"`, which keeps them out of the tracked `.gitignore` and keeps `.agents/skills/` loadable, because Antigravity does not load skills from a gitignored `.agents/skills/`. That block also lists the rule projections, so the tracked `.gitignore` re-includes `AGENTS.md` and `CLAUDE.md`: Git reads `.gitignore` before the exclude file, and an ignore rule for a tracked file still hides it from every tool that walks the tree with Git's ignore rules applied. Copilot's cloud agent installs frozen sources and generates its folder in `copilot-setup-steps.yml`. Each skill's Rulesync `targets` frontmatter selects its folders. Repository-only skills such as `autodev-request-capture`, `autodev-session-diagnostics`, and `opentelemetry` — as well as the external curated skills in `.rulesync/skills/.curated/` — keep the default targets (`["*"]`) and reach every tool, with their bundled scripts (if any). `ccc`, `lsp-mcp-server`, and `orchestration` target only `copilot`, because Copilot's cloud agent has no user level. The remaining skills target nothing, because they already reach local tools at user level and a repository copy would list them twice. Repository-only skills are never installed at user level. Tools that read the repository without running setup, such as github.com Copilot chat and code review, see no repository skills. `tests/rulesync-skills.test.ts` generates the folders fresh and freezes that exposure. The installer symlinks every skill that declares `targets` (the user-level set `runtime/src/platform/user-level-skills.ts` reads from the frontmatter) from `.rulesync/skills/` into `$HOME/.agents/skills/`, and Antigravity continues to use its explicit `include_only` registration. Claude-served turns read skills through Codex's tools, so there is no Claude-specific skill view. Hook declarations are Rulesync-owned and generated into each provider's active repository location; AutoDev continues to own the implementation scripts. Codex's `prevent_idle_sleep` field is a known projection limitation, Copilot omits `SessionStart`, and Antigravity omits `SubagentStart`/`UserPromptSubmitted`. A skill may also show what another skill could look like: such an example names files on purpose that the skill does not ship, so `tests/rulesync-skills.test.ts` ignores the paths inside a `<!-- skill-example -->` … `<!-- /skill-example -->` region, and a skill that names a file it does not ship has to mark it as one.

The Console Skills detail view edits only an existing canonical `.rulesync/skills/<name>/SKILL.md`; Runtime revision-checks the source, then runs the pinned RuleSync generator and `--check` over the configuration before confirming. For manual source edits, regenerate and verify the same projections with:

```bash
node_modules/.bin/rulesync generate --config rulesync.jsonc
node_modules/.bin/rulesync generate --config rulesync.jsonc --check
```

Copilot execution now uses its native ACP CLI rather than a separate Responses proxy. Do not provision or reload the removed Copilot bridge as a prerequisite; confirm the current executable, provider authentication and ACP session readiness.

The Codex CLI is found by one lookup in `runtime/src/shared/executables.ts`,
and every surface that runs it uses that lookup: an explicit `CODEX_BIN` wins,
and otherwise the newest CLI installed wins over a stale one on the default
`PATH`. The candidates are `~/.local/bin/codex`, the first `codex` on `PATH`,
and the pnpm-global `PNPM_HOME/bin/codex`. A machine usually holds more than
one copy -- a stale one in the system bin directory is common -- and the stale
one rejects the flags the role integration and command rules depend on, so the
newest one is the one that runs. A `CODEX_BIN` that names something unusable
is reported as the misconfiguration it is, and a machine with no Codex CLI at
all reports that none is installed rather than guessing at one.

The Copilot CLI itself is found the way the Codex CLI is found, by one lookup
in `runtime/src/shared/executables.ts`: `COPILOT_BIN` when it is set, then the
first `copilot` on `PATH`, then `PNPM_HOME/bin/copilot`, then
`~/.local/bin/copilot`. The installer and execution integration should reuse that lookup. The explicit pnpm-global fallback works
under launchd even when its minimal `PATH` omits pnpm's bin directory. The Copilot CLI's launcher is a
`#!/usr/bin/env node` script, so the execution integration must supply the pinned Node on the
CLI's `PATH` and the CLI runs natively rather than through Rosetta.

The installer provisions `CODEX_ROUTER_OPENCLI_API_KEY` the same way for the
opencli bridge (`com.codex.opencli-proxy`, `127.0.0.1:4004`), which the Router
and `run-autodev-opencli-proxy.sh` both load. opencli itself is not a global
install: it is the Runtime's pinned `@jackwener/opencli` dependency, installed
by `pnpm install --frozen-lockfile` and reached from the installed tree through
its `node_modules` link, so launchd's `PATH` never decides which opencli runs
(`OPENCLI_BIN` overrides it). Its pnpm `postinstall` (shell completions only)
is not needed.

Which browser opencli drives is the **Dedicated browser** toggle on either
opencli provider's page in the Console (Providers -> `opencli-chatgpt` or
`opencli-gemini` -> Browser). It covers both providers, is stored in
`$CODEX_HOME/run/opencli-browser.json`, and applies to the next turn without a
restart.

- **Off (the default): your own Chrome.** Install opencli's Browser Bridge
  Chrome extension and sign in to each site once in your Chrome; turns run in
  the extension's "OpenCLI" tab group. Confirm the extension with the
  commands below.
  The extension drives its tabs through Chrome's `chrome.debugger` API, so
  Chrome shows an _"OpenCLI" started debugging this browser_ banner while it
  is attached. AutoDev does not start your Chrome and cannot pass it flags;
  to hide the banner, quit Chrome completely (Cmd-Q) and start it yourself
  with `--silent-debugger-extension-api`:

  ```bash
  open -a "Google Chrome" --args --silent-debugger-extension-api
  ```

  The flag is ignored if Chrome is already running, and applies only to that
  launch: Chrome started later from the Dock or Spotlight shows the banner
  again. `chrome://version` lists it under "Command Line" when it took
  effect. It silences the banner for every extension with the `debugger`
  permission, not only OpenCLI, so Chrome no longer tells you when any
  extension attaches to your pages. The dedicated browser below never shows
  the banner: it is driven over loopback CDP, not through the extension.

- **On: a dedicated Chrome for Testing.** The normal typed installer always
  installs the pinned headed build into
  `$CODEX_HOME/provider-runtime/opencli/browsers`, without using or altering
  your Chrome installation, so the toggle needs no reinstall. The bridge
  starts this browser with a private profile at
  `$CODEX_HOME/run/opencli-browser-profile`, exposes CDP only on loopback, and
  keeps one target per admitted turn. The window is visible because ChatGPT
  blocks headless Chromium. Sign in to ChatGPT and Gemini in that separate
  window once; the cookies remain in that profile and are not exported, and
  you may need to sign in again when a site's session expires. Turning the
  toggle off closes the window once its running turns finish.

When the selected browser is signed in to several Google accounts, set
`OPENCLI_GEMINI_ACCOUNT` to an account that has Gemini enabled in
`$CODEX_HOME/.env`; otherwise Gemini may open under an account without app
access:

```bash
echo 'OPENCLI_GEMINI_ACCOUNT=you@example.com' >> ~/.codex/.env
```

```bash
node runtime/node_modules/@jackwener/opencli/dist/src/main.js doctor
```

```bash
node runtime/node_modules/@jackwener/opencli/dist/src/main.js chatgpt status
```

With the dedicated browser on, the opencli proxy starts that browser before
reporting healthy, and Provider status in the Console reports browser
startup/transport failures separately from a site's Sign-in required state.
Site login is not a prerequisite for the bridge to start.

**What an opencli change has to refresh.** An opencli change lives in up to
three places, and each one is live at a different moment:

- The **site adapter** (`clis/<site>/…` inside the `@jackwener/opencli` package)
  runs in the CLI process the bridge spawns for a turn. The bridge resolves
  that package through the installed tree's `node_modules` link, and Node caches
  the resolution for the life of the process — a link that moves under a
  running bridge does not move that bridge. A patch to the adapter is live
  only for processes started after the link moved.
- In your own Chrome, the **daemon** (opencli's Browser Bridge session, shared
  machine-wide on one port) also holds the adapter it loaded. A patch keeps the
  package version, so the daemon cannot tell it is stale and the bridge's
  stale-daemon recovery (which replaces a daemon of another _version_) never
  fires: run `opencli daemon stop` after a patch. The dedicated browser has no
  daemon.
- The **bridge and browser owner** (`runtime/src/providers/opencli*.ts`) runs
  from the generation the installer publishes behind the `$CODEX_HOME/src`
  symlink (`$CODEX_HOME/.src-<hash>/providers/`, swapped atomically so a
  restarting process never observes a half-written tree and retained for 7 days
  after replacement for in-flight sessions), the path
  `run-autodev-opencli-proxy.sh` executes. With the dedicated browser on, the
  bridge owns Chrome for Testing's lifecycle and CDP target pool; its private
  profile remains in `CODEX_HOME` across restarts. The normal installer
  refreshes the bridge and ensures the build pinned by Runtime's Playwright
  dependency is installed.

After a patch: `pnpm install --frozen-lockfile` re-applies the patch and moves
the link (live for processes started afterwards), then `bash scripts/install.sh`
deploys the bridge, reconciles the pinned browser and reloads the proxy; in
your own Chrome, `opencli daemon stop` then lets the next command start a
daemon with the patched adapter.

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

### One-command development startup

`pnpm run dev` is the one-command entrypoint to start the AutoDev Console together with the required local OpenLIT and ClickHouse Usage telemetry stack:

```bash
pnpm run dev
```

Before launching the Next.js dev server (on port 3300 by default), `pnpm run dev` validates the Control API and coordinates the Console's backend dependencies:

- **Secret synchronization:** Ensures `console/.env.local` is materialized from the canonical secrets in `$CODEX_HOME/openlit-secrets.env`, updating it only when missing or out of sync.
- **Backend reconciliation:** Checks Docker Engine, then invokes the canonical `scripts/openlit/up.sh` on every `pnpm run dev`. The locked image is reused when its pinned source/patch hash is unchanged, and Compose idempotently recreates only services whose image, environment, or bind-mounted config fingerprint changed. ClickHouse and OpenLIT readiness are checked after reconciliation; unchanged services and persistent volumes are preserved.
- **The install reconciles the same stack:** `autodev install` restarts the supervised Console, whose launcher verifies the Runtime and Usage contracts before it serves a page — so the install brings the Usage stack up _before_ it bootstraps the Console's job, through the same typed owner the development server uses (`runtime/src/platform/usage-stack.ts`). A stack that is not serving leaves the Console unbootstrapped, and the install says which service was missing rather than reporting the Console as broken.
- **A backend that has not come up yet is not a broken service:** the Control API and Usage verifiers exit with the temporary-failure status (`EX_TEMPFAIL`, 75) when a backend did not answer, and with a failure status when a backend answered with a stale contract or a rejected credential. The Console's launcher passes that status through, and the installer treats it as a job that is still coming up: it keeps waiting for readiness instead of declaring a crash loop on a service that was about to serve.
- **Convergence on an unresponsive Docker Engine:** Docker Desktop's API proxy aborts any Docker Engine call that misses its fixed 10-second deadline and reports it as `500 Internal Server Error`, which Compose prints as `dependency clickhouse failed to start: … check if the server supports the requested API version`. That message names an API version mismatch it did not find: the Engine simply did not answer in time, which happens when the host is loaded enough to starve the Docker VM. The same starved Engine also makes a health check fail to start inside the container, which Compose reports as `container openlit-clickhouse is unhealthy`. The runner retries `compose up -d` for those two failures alone — waiting for `docker info` to answer again and letting the stack settle between attempts — fails immediately on a Compose failure no retry can fix, and decides success on the stack's readiness (ClickHouse accepts an authenticated query, OpenLIT answers HTTP) rather than on Compose's exit code.
- **Docker Engine prerequisite and automatic macOS launch:** Docker Engine is required for the local OpenLIT and ClickHouse Usage telemetry stack. On macOS (`darwin`), if the Docker daemon is not running, `pnpm run dev` automatically launches Docker Desktop (`open -a Docker`) and polls boundedly (up to 120 seconds) for Docker Engine to become responsive. The installer's Console restart does the same. Because `open` hands its whole environment to the launched app, Docker Desktop is launched with only the login-session identity (`HOME`, `USER`, `LOGNAME`, launchd's default `PATH`), as Finder would launch it; the caller's pnpm/Node environment and AutoDev secrets made its Electron UI abort before the Engine came up. On other platforms, Docker Engine must be running beforehand; if it is unavailable, startup fails immediately with a clear prerequisite error before attempting to start services.
- **Service startup and bounded wait:** The canonical runner reconciles the ClickHouse and OpenLIT containers against the current pinned image and mounted configuration, starting or restarting only what is stale, then polls boundedly for both services to report readiness. If startup fails or times out, the command throws and halts so the Console is never spawned without required Usage telemetry.
- **Router lifecycle & automatic startup:** The Control API is served by the AutoDev Model Router (model listener on port 4100; private Control API listener on port 4101). `pnpm run dev` ensures the Model Router is materialized and active before starting the Console. If the router is inactive or ports 4100/4101 are closed, it materializes integration files and launches or restarts the service via launchd (`com.codex.model-router`) or the fallback runner, polling until readiness is confirmed.
- **Control API contract & Evaluations validation:** Validates the authenticated `/control/contracts` compatibility revision and performs read-only probes for Providers v5, provider-model-discovery v1, workspace-scoped Playtesting capabilities, and Evaluations v1. Re-probes boundedly with retry delay so transient router spin-ups do not fail the start.
- **Console port conflict resolution:** Checks port 3300 (or `AUTODEV_CONSOLE_PORT`). On macOS, if the production `com.codex.autodev-console` LaunchAgent is running on port 3300, `pnpm run dev` automatically unloads the conflicting agent and waits for the port to clear before binding `127.0.0.1` explicitly.
- **Container persistence:** The Docker containers persist when the Console dev server exits. Stopping `pnpm run dev` (e.g. `Ctrl+C`) stops the Next.js process, but leaves the database and OpenLIT containers running for subsequent runs.

### Operator stack lifecycle

Operators can still manage the container stack manually using the canonical scripts:

```bash
bash scripts/openlit/up.sh
bash scripts/openlit/down.sh
```

### Console startup contract

Use `pnpm run dev` as the supported development entrypoint. Directly launching the Next.js workspace bypasses backend reconciliation and contract validation and is intentionally not exposed as a root script. The production Console launcher performs the same read-only Control API compatibility check and validates the OpenLIT Usage v5 response before it starts `next start`.

The normal `pnpm run install:autodev` release materializes the Console LaunchAgent, verifies that this Runtime owns the Console port, builds Next into a unique staging directory, leaves the active production artifact untouched on build failure, then reloads/verifies the managed Console after Runtime. `bash scripts/install.sh --materialize-only` deliberately skips both the production build and service restart for an active session. The installer owns the Console port: it stops a Console process this Runtime owns — a previous install's console, or a development server occupying the configured port — and takes the port for the managed Console, so a repeated install converges instead of failing. It never kills a listener it does not own and never publishes over a foreign listener's port; that listener has to be stopped, or the port changed with `AUTODEV_CONSOLE_PORT`.

`next dev` writes to `console/.next-dev`; `next build` (and the Runtime installer’s console-build step) writes the production build that `next start` and the Console LaunchAgent serve to `console/.next`. The split lives in `console/src/lib/build-output.ts` (applied by `console/next.config.ts`), so a build cannot delete the chunks a running dev server loads (the `Cannot find module './<n>.js'` crash from `_document.js`). `console/next-env.d.ts` points at whichever directory generated it last, so it is gitignored; `pnpm --filter @simulatorlife/autodev-console typecheck` runs `next typegen` first, which regenerates it and the `console/.next/types` route types. The dev server’s `console/.next-dev/types` stay out of the type-check.

The Console defaults to port 3300 (`AUTODEV_CONSOLE_PORT` overrides it). Set
`AUTODEV_CONTROL_API_TOKEN` only in the Console server environment; the
Control API base defaults to `http://127.0.0.1:4101` and can be configured with
`AUTODEV_CONTROL_API_BASE_URL`. `pnpm run dev` validates the configured endpoint’s
compatibility revision, Providers, provider-model discovery, and Playtesting contracts before starting
Next.js. The production launcher runs the same Control API check and verifies
the OpenLIT Usage v5 contract before `next start`; neither startup path starts
with known-stale backend responses. The runner Playtesting MCP uses a **separate, Playtesting-only**
`AUTODEV_PLAYTEST_CONTROL_API_TOKEN` provisioned in the Runtime and MCP process,
plus the trusted `AUTODEV_PLAYTEST_CONTROL_API_ACTOR` and exact
`AUTODEV_PLAYTEST_CONTROL_API_ROLE` (`playtester`, `validator`, or another
configured run-control role); the configured role must match the MCP role. The
Runtime accepts that role-bound credential only on typed Playtesting
capability/run routes and rejects missing or role-escalated session context.
Playtest and Playwright exposure must follow the child's effective role and trusted Runtime-provided session context, not the root's inherited tool set. The XACPX/ACP delegation target resolves separate child grants through Supergateway. Do not enable either server at the root as a workaround for missing child tools; report a role-projection or gateway authorization defect.
For an isolated Browser Tester CLI run, use the `browser-tester` role through
`run-provider-agent.sh`; that path reasserts the exact Playwright tool and
environment allowlists. Playtester MCP launches require the dedicated trusted
runner context and must be dispatched by a Runtime-owned caller; an arbitrary
shell launch is expected to fail closed. Console Play/Watch and Runtime-owned
analysis remain the supported UI lifecycle.

The read-only analyst MCP does not use the Control API run-control client: its
allowlisted packet/review operations read and write through the workspace-bound
Playtesting repository and artifact store, and the analyst receives no Control
API credentials. Console dispatch still uses the existing `run-provider-agent`
role path and Runtime-owned task lifecycle.
The dispatched role runs in a private empty directory and isolated Codex home
(not the game checkout or the user's normal Codex profile), copies only the
`playtest-analyst` role file, and uses only the `playtest-analysis` skill and
that current read-only role, keeps the local-router credential, and removes
unrelated API/MCP credentials. Its `CODEX_PROJECT_ROOT` is explicitly pinned to
the same private empty directory so Code Mode follow-up requests can resolve a
project context without guessing or landing on the game checkout; the separate
`AUTODEV_PLAYTEST_WORKSPACE_ID` continues to scope evidence access. Only its trusted `playtest` MCP server is bound
to the source `CODEX_HOME`, because the workspace approval, evidence-packet
artifacts and OpenLIT credential it must read live there; the isolated home
receives no database secret.
It never receives a game-run capability or the general Control API token. Configure
`AUTODEV_CONTROL_API_BASE_URL` in the MCP process as a loopback URL, and set
`AUTODEV_CONTROL_API_LISTEN_HOST`/`AUTODEV_CONTROL_API_LISTEN_PORT` on Runtime
when enabling the private listener. Neither Playtesting credential is inherited
by the game adapter. To query Usage, set
`AUTODEV_OPENLIT_USAGE_TOKEN` in the Console server environment to the
separately generated value in `$CODEX_HOME/openlit-secrets.env`;
`AUTODEV_OPENLIT_USAGE_URL` defaults to `http://127.0.0.1:3000`. The custom PostgreSQL/pgvector memory store and `/memory` product surface have been removed. Mem0 integration is postponed; do not bootstrap a legacy memory connector or database. The external OpenLIT Memory portal is gone, so `AUTODEV_OPENLIT_UI_URL` no longer has a consumer — delete it from `$CODEX_HOME/.env` and do not reintroduce it. The Console launcher forwards only the two URL variables the server actually reads (`AUTODEV_CONTROL_API_BASE_URL`, `AUTODEV_OPENLIT_USAGE_URL`). Do not source or expose the full secret file to browser code.

If `/usage` reports `autodev_openlit_usage_unreachable`, check that OpenLIT is running and that `AUTODEV_OPENLIT_USAGE_URL` points to an address reachable from the Console server. The local default is port 3000; start the OpenLIT stack with `scripts/openlit/up.sh` when Docker is available. A successful HTTP response with an invalid Usage schema is reported separately as `autodev_openlit_usage_invalid_response`. Verify that OpenLIT serves the required AutoDev Usage v5 contract; if that live contract is valid, rebuild and restart the managed Console so its long-lived server process loads the matching bundle. Neither failure state renders metric panels or substitutes sample values.

The AutoDev summary response is `autodev-openlit-usage-v5`, including validated widget data, filter options, bounded recent-attempt data, and Git change metrics. After changing the Usage patch set (including the v4 compaction and v5 Git metrics widgets), rebuild and restart the patched OpenLIT stack with `scripts/openlit/up.sh`; the Console deliberately rejects older response contracts instead of silently dropping data.

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
`console/.env.local` — `scripts/run-autodev-console.sh` reads the canonical
secret file via an exact-key parser and exports only the two tokens
needed by the Next.js server.

### Running a live visual playtest

The visual mode needs two things the operator provides: a target approved for
the workspace, and the game reachable at that target's approved origin. The
Console's Playtesting view reads both from the Runtime's own readiness, so a
run that is refused says which of the two is missing — the target store, the
browser, or the decision backend — instead of failing inside the episode.

**Playtesting → Play** starts the run: pick the approved target, the decision
backend, the areas of focus, and the episode and step counts. The request is a
versioned launch request, and the Runtime owns the approval, the budgets and
the mode; the Console never substitutes another mode when the Runtime refuses
one. **Sessions** lists what ran, and a session page carries the four recorded
dimensions side by side — the game outcome, the execution status, the replay
integrity and the evidence completeness — because a run that produced no
outcome is not a run that failed.

The binding budget is the per-episode Smart token budget, not the step cap: a
vision decision costs several thousand tokens, so the approved 20 000 tokens
pay for about four decisions and the episode then ends `budget-truncated` with
the reason `usage-budget`. Raising that ceiling is the operator's call.

A target's approval carries two more thresholds, under **No-progress
thresholds**: how many consecutive decisions may pass without the game
advancing, and how long it may go without advancing. The Runtime compares
what the player sees now with what they saw before — the screen, the progress
the page reports, and the controls it offers — and a page that is still
loading does not count against either number. When the game has not advanced
for as long as the thresholds allow, the episode ends with the reason
`no-progress` rather than spending the rest of its budget, and the decision
backend is told what the Runtime measured so it can choose differently
instead of proposing the same action again. Leave the fields blank and the
run is never cut short for not advancing: the Runtime still measures the run
and still reports what it measured, but it does not end a run for not
advancing unless the operator asked it to, and a run ends on its own budgets
instead.

The session page's spectator shows what each step did: the frame the decision
was taken from, the action that was selected, and whether the action reached
the game. A refused action is recorded with the reason it was refused. When the
refusal says the page moved under the observation, the episode observes again
and decides with that refusal in its history, bounded by the approved budgets;
when the refusal is final — the action was not allowed, the game needs setup,
or the episode is out of budget — the episode ends with the termination reason
`action-refused`, which the badge reads as "Action refused" rather than as a
crash.

**Analyze this session** runs the analyst over the recorded frames. What it
records are hypotheses and observations, not defects: nothing the analyst
produces is reproduced or verified on its own, so the Findings view says so,
and a verified finding needs the confirmatory pass that no run has produced
yet.

### GitHub Actions runtime facts

The Console GitHub page always shows the workflow definitions parsed from
`.github/workflows/`. Observed Actions state and recent runs come from the
read-only Control API route `/control/github`, which issues only `GET`
requests for the repository's Actions workflows and runs. That route runs
inside the model router process: the `com.codex.model-router` LaunchAgent
starts `scripts/run-autodev-model-router.sh`, which loads `$CODEX_HOME/.env`
before starting `runtime/src/router/server.ts`. To configure runtime facts, set
the following in that private file:

- `AUTODEV_GITHUB_REPOSITORY`: the `owner/repo` identifier. It must still
  resolve to an enabled workspace `id` in `config/workspaces.json` (`enabled: true`).
  An unknown or disabled workspace id shows as `invalid`.
- `AUTODEV_GITHUB_TOKEN`: a server-side, least-privilege token. This token is
  optional for public repositories because GitHub REST workflow and run GET
  endpoints are reachable anonymously, but authenticated requests are preferable
  for stable rate limits (avoiding GitHub's 60 req/hr unauthenticated limit).
  Private repositories still require this token, configured as a fine-grained
  personal access token scoped only to the bound repository, with read-only
  **Actions** permission (plus the read-only **Metadata** permission that GitHub
  always adds), and a short expiry.

When querying private repositories without a token, when requests return 403
Forbidden, or when unauthenticated or authenticated requests are rate-limited
(HTTP 403/429), runtime facts surface as `unavailable` with a redacted diagnostic
message. Invalid credentials (HTTP 401) surface as `invalid`. The page still
shows the workflow definitions in either case.

Keep `$CODEX_HOME/.env` at mode `0600`. Never commit the token, never put it
in `console/.env.local` or any `NEXT_PUBLIC_*` variable, and never pass it to
browser code. The Console launcher ignores `*TOKEN*` keys in
`$CODEX_HOME/.env`, and the adapter redacts the token (`[REDACTED]`) from error
messages. Restart the router with the normal installer when no active task
depends on it (`--materialize-only` does not restart services). The new values
apply only after the restart.

### Transitional OpenLIT projections

Current out-of-band OpenLIT projections:

```bash
pnpm --filter @simulatorlife/autodev-data openlit:sync-models
pnpm --filter @simulatorlife/autodev-data openlit:sync-workspaces
```

The Data-owned models adapter populates a transitional OpenLIT read model; it does not supersede canonical RuleSync/AutoDev configuration ownership. **Do not add new product consumers, mutation authority, or canonical state to these sync paths.** Delete each sync command/adapter after its retained feature is served directly through the unified Console/Data integration and no verified consumer still requires the OpenLIT projection. The remaining workspace bootstrap is only an internal singleton migration, not a per-workspace OpenLIT tenancy adapter, and should be removed when the retained OpenLIT internals no longer require that singleton compatibility row.

The agents adapter is gone. It wrote the OpenLIT's `openlit_agents_summary` and `openlit_agent_versions` tables, and the only thing that ever read those tables was the fork's `/api/agents` API — which had no page, no caller inside the fork, and no caller in AutoDev. The fork's own materializer cron, which would have been the second writer, was never registered: `restoreAgentsMaterializeCron` was called only by its own test. A projection whose only reader has no reader is a write to a table nobody looks at.

The models adapter reaches ClickHouse only through
`data/src/clickhouse/clickhouse-client.ts`, which owns the request: the URL,
the content type, the ceiling on how long the request may wait, and the error
it raises when ClickHouse says no. An adapter supplies the query and the rows
it computed; it must not assemble a URL, choose a content type, or format its
own read error.

The provider and model tables have a protocol of their own — they are read as
`FORMAT JSONEachRow` and written as `application/x-ndjson` with no trailing
newline — so the models adapter says which protocol it wants and the client
carries it out. That protocol used to be the adapter's excuse to build its
requests from scratch, which is how the one projection left in the package was
also the one request without a ceiling: an unresponsive ClickHouse hung the
catalog sync instead of failing with the reason. `data/src/openlit/clickhouse-config.ts`
owns credentials only, and the default endpoint now lives with the client.

The asynchronous GitHub issue metrics workflow remains a separate GitHub-development reporting surface (`.github/workflows/metrics-dashboard.yml`, issue #2). It is not a replacement observability backend for AutoDev runtime telemetry.
