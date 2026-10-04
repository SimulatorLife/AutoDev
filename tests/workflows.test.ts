import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflows = path.join(root, ".github", "workflows");
const prompts = path.join(root, ".rulesync", "commands");
const readWorkflow = (name: string): Promise<string> =>
  readFile(path.join(workflows, name), "utf8");
const readPrompt = (name: string): Promise<string> =>
  readFile(path.join(prompts, name), "utf8");

async function enabledWorkspaceIds(): Promise<string[]> {
  const catalog = JSON.parse(
    await readFile(path.join(root, "config", "workspaces.json"), "utf8")
  ) as {
    schema?: unknown;
    workspaces?: unknown;
  };
  assert.equal(catalog.schema, "autodev-workspaces-v1");
  assert.ok(Array.isArray(catalog.workspaces));
  const workspaces = catalog.workspaces as Array<{
    readonly id?: unknown;
    readonly enabled?: unknown;
  }>;
  assert.ok(
    workspaces.every(
      (workspace) =>
        typeof workspace.id === "string" &&
        typeof workspace.enabled === "boolean"
    ),
    "every canonical workspace must have a stable id and enabled state"
  );
  const ids = workspaces
    .filter((workspace) => workspace.enabled)
    .map((workspace) => workspace.id as string);
  assert.ok(
    ids.length > 0,
    "the canonical workspace catalog must be non-empty"
  );
  assert.equal(
    new Set(ids).size,
    ids.length,
    "enabled workspace ids are unique"
  );
  return ids;
}

test("the canonical workspace catalog declares a non-empty, de-duplicated set of enabled workspace ids", async () => {
  const ids = await enabledWorkspaceIds();
  assert.ok(
    ids.includes("SimulatorLife/AutoDev"),
    "AutoDev itself must be a registered, enabled workspace"
  );
});

// Extracts each `run: |` block's body lines, keyed by the indentation of the
// `run:` key itself, so a malformed quote inside one block (which would
// otherwise swallow the rest of the file as an unterminated string) is
// caught by bash's own parser rather than by string matching.
type RunBlock = { startLine: number; body: string };

// Mirrors actions/github-script's own callAsyncFunction: it builds a
// restricted AsyncFunction from named params (github, context, core, exec,
// glob, io, require) and the script body text. There is no __dirname or
// __filename in that scope -- this is the exact execution surface that
// broke require(path.join(__dirname, ...)) in the target-* workflows.
type GithubScriptStubs = {
  github?: Record<string, unknown>;
  context?: Record<string, unknown>;
  core?: Record<string, unknown>;
  exec?: Record<string, unknown>;
  glob?: Record<string, unknown>;
  io?: Record<string, unknown>;
  env?: Record<string, string>;
};

const githubScriptRequire = createRequire(import.meta.url);

async function runGithubScriptBody(
  body: string,
  stubs: GithubScriptStubs
): Promise<void> {
  const AsyncFunction = Object.getPrototypeOf(async function () {})
    .constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<unknown>;
  const fn = new AsyncFunction(
    "github",
    "context",
    "core",
    "exec",
    "glob",
    "io",
    "require",
    body
  );
  const previousEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(stubs.env ?? {})) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await fn(
      stubs.github ?? {},
      stubs.context ?? {},
      stubs.core ?? {},
      stubs.exec ?? {},
      stubs.glob ?? {},
      stubs.io ?? {},
      githubScriptRequire
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Extracts `script: |` bodies the same way extractRunBlocks extracts
// `run: |` bodies: keyed by the indentation of the `script:` key itself.
const extractScriptBlocks = (source: string): RunBlock[] => {
  const lines = source.split("\n");
  const blocks: RunBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const scriptMatch = line.match(/^(\s*)script: \|-?\s*$/);
    if (!scriptMatch) continue;
    const scriptIndent = (scriptMatch[1] ?? "").length;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const nextLine = lines[j] ?? "";
      if (nextLine.trim() === "") {
        body.push("");
        continue;
      }
      if ((nextLine.match(/^ */)?.[0].length ?? 0) <= scriptIndent) break;
      body.push(nextLine);
    }
    blocks.push({ startLine: i + 1, body: body.join("\n") });
    i = j - 1;
  }
  return blocks;
};

const extractRunBlocks = (source: string): RunBlock[] => {
  const lines = source.split("\n");
  const blocks: RunBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const runMatch = line.match(/^(\s*)run: \|-?\s*$/);
    if (!runMatch) continue;
    const runIndent = (runMatch[1] ?? "").length;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const nextLine = lines[j] ?? "";
      if (nextLine.trim() === "") {
        body.push("");
        continue;
      }
      if ((nextLine.match(/^ */)?.[0].length ?? 0) <= runIndent) break;
      body.push(nextLine);
    }
    blocks.push({ startLine: i + 1, body: body.join("\n") });
    i = j - 1;
  }
  return blocks;
};

type PromptConfig = {
  prompts: Array<{
    name: string;
    path: string;
    promptRepository?: string;
    sourceWorkflow?: string;
  }>;
};
type ValidationProfile = {
  packageManager: string;
  pnpmVersion?: string;
  commands: Array<{ run: string }>;
};
type ValidationProfiles = Record<string, ValidationProfile>;
type ProviderManifest = {
  schemaVersion: number;
  tools: Record<string, { package: string }>;
};
const config = JSON.parse(
  await readFile(path.join(workflows, "weights.json"), "utf8")
) as PromptConfig;

test("scheduler routes prompt, agent, and target repository", async () => {
  const source = await readWorkflow("_scheduler.yml");
  assert.match(source, /cfg\.prompts/);
  assert.match(source, /target_repository: item\.targetRepository/);
  assert.match(source, /prompt_path: item\.promptPath/);
  assert.match(source, /prompt_repository: item\.promptRepository/);
  assert.match(source, /workflow_id: 'run-prompt\.yml'/);
  assert.match(source, /promptRepository[\s\S]*SimulatorLife\/AutoDev/);
});

test("generic prompt runner supports AutoDev and target prompt scopes", async () => {
  const source = await readWorkflow("run-prompt.yml");
  const runner = await readWorkflow("_agent-open-pr-and-ping.yml");
  assert.match(source, /prompt_repository/);
  assert.match(
    runner,
    /prompt_path must be a repository-relative \.agents\/prompts\/\*\.md path/
  );
  assert.match(source, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(
    source,
    /uses: \.\/\.github\/workflows\/_agent-open-pr-and-ping\.yml/
  );
  assert.match(source, /prompt_repository:/);
  assert.match(source, /target_repository:[\s\S]*?type: string/);
  assert.match(source, /prompt_repository:[\s\S]*?type: string/);
  assert.match(source, /prompt_path:/);
  assert.doesNotMatch(source, /options:/);
  assert.match(runner, /config\/workspaces\.json/);
  assert.match(
    runner,
    /workspace-catalog\.cjs/,
    "the reusable prompt runner resolves targets from the canonical catalog"
  );
  assert.match(
    runner,
    /resolve-target/,
    "the reusable prompt runner delegates target resolution to the catalog owner"
  );
  assert.match(
    runner,
    /resolve-prompt/,
    "the reusable prompt runner delegates prompt resolution to the catalog owner"
  );
  assert.match(
    runner,
    /--base-branch/,
    "the reusable prompt runner forwards requested base branch to the catalog owner"
  );
});

test("generic prompt catalog contains only repository-agnostic Markdown prompts", async () => {
  for (const prompt of config.prompts) {
    assert.equal(
      prompt.promptRepository ?? "SimulatorLife/AutoDev",
      "SimulatorLife/AutoDev",
      prompt.name
    );
    assert.match(
      prompt.path,
      /^\.rulesync\/commands\/[^/]+\.md$/u,
      prompt.name
    );
    const source = await readPrompt(path.basename(prompt.path));
    assert.ok(source.trim().length > 0, prompt.name);
  }
});

test("generic prompt catalog includes the migrated organization-wide inventory", async () => {
  assert.equal(config.prompts.length, 52);
  for (const prompt of config.prompts) {
    assert.equal(Object.hasOwn(prompt, "promptRepository"), false, prompt.name);
    assert.equal(Object.hasOwn(prompt, "sourceWorkflow"), false, prompt.name);
  }
  const forbiddenTargetAssumptions =
    /\b(?:GMLoop|GameMaker|pnpm)\b|@gml|\.gml\b/iu;
  for (const prompt of config.prompts) {
    const source = await readPrompt(path.basename(prompt.path));
    assert.doesNotMatch(source, forbiddenTargetAssumptions, prompt.name);
  }
});

test("central provider invocations accept target repository and PR number", async () => {
  for (const name of [
    "claude-invoke.yml",
    "gemini-invoke.yml",
    "qwen-invoke.yml",
    "minimax-invoke.yml",
    "minimax-codex-invoke.yml"
  ]) {
    const source = await readWorkflow(name);
    assert.match(source, /workflow_dispatch:/, name);
    assert.match(source, /target_repository:/, name);
    assert.match(source, /pr_number:/, name);
    if (name !== "minimax-invoke.yml")
      assert.match(source, /github\.event_name == 'workflow_dispatch'/, name);
  }
});

test("target-aware reusable workflows use the PAT checkout", async () => {
  const openPr = await readWorkflow("_agent-open-pr-and-ping.yml");
  const invoke = await readWorkflow("agent-invoke.yml");
  assert.match(openPr, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(openPr, /GH_USER_TOKEN does not have push permission/);
  assert.match(invoke, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(invoke, /REPOSITORY: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(
    invoke,
    /gh api --paginate --slurp.*repos\/\$\{REPOSITORY\}\/issues\/\$\{PR_NUMBER\}\/comments/
  );
  assert.match(invoke, /No \$\{mention\} task comment was found/);
  assert.match(invoke, /Detect target repository toolchain/);
  assert.match(invoke, /Read AutoDev package manager version/);
  assert.match(invoke, /Setup pnpm for provider tooling/);
  assert.ok(invoke.includes("node-version-file: ../../_temp/autodev.nvmrc"));
  assert.match(
    invoke,
    /elif \[ -f package-lock\.json \] \|\| \[ -f npm-shrinkwrap\.json \]/
  );
  assert.match(
    await readWorkflow("target-validation.yml"),
    /node-version-file: \.\.\/\.\.\/_temp\/autodev\.nvmrc/
  );
});

test("AutoDev CI is repository-native and pnpm-native", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8")
  );
  assert.equal(packageJson.packageManager, "pnpm@10.32.1");
  assert.ok(
    (await readFile(path.join(root, "pnpm-lock.yaml"), "utf8")).startsWith(
      "lockfileVersion:"
    )
  );
  const profiles = JSON.parse(
    await readFile(
      path.join(root, ".github", "ci", "validation-profiles.json"),
      "utf8"
    )
  ) as ValidationProfiles;
  const profile = profiles["SimulatorLife/AutoDev"];
  assert.ok(profile);
  assert.equal(profile.packageManager, "pnpm");
  assert.equal(profile.pnpmVersion, undefined);
  for (const [key, item] of Object.entries(profiles)) {
    assert.equal(
      item.pnpmVersion,
      undefined,
      `pnpmVersion present in profile ${key}`
    );
  }
  assert.deepEqual(
    profile.commands.map(({ run }) => run),
    ["pnpm test", "pnpm run typecheck"]
  );
  const source = await readWorkflow("copilot-setup-steps.yml");
  assert.match(source, /uses: pnpm\/action-setup@v6/);
  assert.match(source, /cache: pnpm/);
  assert.match(source, /pnpm install --frozen-lockfile/);
  assert.match(source, /pnpm test/);
  assert.doesNotMatch(source, /test:python/);
  assert.doesNotMatch(source, /\bnpm\b/);
  assert.match(source, /node-version-file: \.nvmrc/);
});

test("AutoDev CI makes actionlint and ShellCheck mandatory", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8")
  );
  assert.equal(packageJson.scripts["validate:actionlint"], "actionlint");
  assert.equal(
    packageJson.scripts["validate:shell"],
    "find scripts -type f -name '*.sh' -exec shellcheck --severity=warning {} +"
  );

  const workflow = await readWorkflow("copilot-setup-steps.yml");
  assert.match(workflow, /Install actionlint and ShellCheck/);
  assert.match(workflow, /ACTIONLINT_VERSION: 1\.7\.12/);
  assert.match(workflow, /ACTIONLINT_SHA256: [0-9a-f]{64}/);
  assert.match(
    workflow,
    /apt-get install --no-install-recommends -y shellcheck/
  );
  assert.match(workflow, /pnpm run validate:actionlint/);
  assert.match(workflow, /pnpm run validate:shell/);

  const actionlintConfig = await readFile(
    path.join(root, ".github", "actionlint.yaml"),
    "utf8"
  );
  assert.match(actionlintConfig, /paths:/);
  assert.match(actionlintConfig, /SC2016/);
  assert.match(actionlintConfig, /SC2129/);
});

test("central target PR janitor owns empty stale PR cleanup", async () => {
  const source = await readWorkflow("target-pr-janitor.yml");
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /stale_hours:[\s\S]*default: 1\.25[\s\S]*type: number/);
  assert.ok(source.includes("STALE_HOURS: ${{ inputs.stale_hours }}"));
  assert.match(source, /rawStaleHours/);
  assert.ok(source.includes("Number(rawStaleHours || '1.25')"));
  assert.match(source, /config\/workspaces\.json/);
  assert.match(source, /workspace-catalog\.cjs/);
  assert.match(source, /loadCatalog/);
  assert.match(source, /listEnabled/);
  assert.match(source, /resolveTarget/);
  assert.match(source, /pulls\.list/);
  assert.match(source, /changed_files/);
  assert.match(source, /pulls\.update/);
  assert.match(source, /git\.deleteRef/);
  assert.match(source, /secrets\.GH_USER_TOKEN/);
  assert.match(source, /autodev-target-pr-janitor/);
});

test("target auto-merge requires completed target check evidence", async () => {
  const source = await readWorkflow("target-automerge.yml");
  assert.match(source, /target_repository:/);
  assert.match(source, /pr_number:/);
  assert.match(source, /checks\.listForRef/);
  assert.match(source, /listCommitStatusesForRef/);
  assert.match(source, /hasEvidence/);
  assert.match(source, /pulls\.merge/);
  assert.match(source, /error\.status === 405/);
  assert.match(source, /Pull Request has merge conflicts|conflict/i);
  assert.match(source, /createWorkflowDispatch/);
  assert.match(source, /agent-02-resolve-merge-conflicts\.yml/);
  assert.ok(source.includes("sha:${sha}"));
  const resolver = await readWorkflow("agent-02-resolve-merge-conflicts.yml");
  assert.match(resolver, /markerForSha/);
  assert.match(resolver, /sha:\$\{process\.env\.HEAD_SHA\}/);
  assert.doesNotMatch(resolver, /ALLOW_REPEAT|allow_repeat/);
  assert.match(source, /GH_USER_TOKEN/);
});

test("MiniMax invocation configures headless OpenAI-compatible authentication", async () => {
  const source = await readWorkflow("minimax-invoke.yml");
  const runner = await readFile(
    path.join(root, "scripts", "run-ci-provider.sh"),
    "utf8"
  );
  assert.match(source, /agent: mini-max/);
  assert.match(runner, /mini-max\)/);
  assert.match(runner, /--auth-type openai/);
  assert.match(runner, /--openai-api-key/);
  assert.match(runner, /--openai-base-url/);
  assert.doesNotMatch(runner, /\bnpx\b/);
});

test("local provider tooling resolves the playwright MCP from a pinned devDependency", async () => {
  // `.rulesync/mcp.jsonc` is the only place the Playwright launch is declared;
  // role TOMLs carry only per-role settings and are rendered with it.
  const mcpSource = JSON.parse(
    await readFile(path.join(root, ".rulesync", "mcp.jsonc"), "utf8")
  );
  const playwright = mcpSource.codexcli.mcpServers.playwright;
  assert.equal(playwright.command, "bash");
  assert.match(playwright.args.at(-1), /run-autodev-mcp\.sh" playwright$/);
  const configs = [path.join(root, ".rulesync", "mcp.jsonc")];
  for (const configFile of configs) {
    const source = await readFile(configFile, "utf8");
    assert.match(source, /run-autodev-mcp\.sh\\" playwright/);
    // Assert against configuration, not prose: a comment may name the forbidden
    // runners in order to warn about them.
    const settings = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    // No dlx @latest: it re-resolves on every cold start (network + startup latency),
    // grows the pnpm dlx cache, and drifts the version across hosts/agents.
    assert.doesNotMatch(settings, /\bdlx\b/);
    assert.doesNotMatch(settings, /@playwright\/mcp@latest/);
    assert.doesNotMatch(settings, /\bnpx\b/);
  }

  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8")
  );
  assert.equal(manifest.devDependencies["@playwright/mcp"], "^0.0.80");

  for (const role of ["browser-tester", "smart"]) {
    const roleSource = await readFile(
      path.join(root, "agents", "roles", `${role}.toml`),
      "utf8"
    );
    const playwrightIndex = roleSource.indexOf("[mcp_servers.playwright]");
    const section =
      playwrightIndex === -1 ? roleSource : roleSource.slice(playwrightIndex);
    const splitIndex = section.indexOf("\n\n");
    const roleSettings =
      splitIndex === -1 ? section : section.slice(0, splitIndex);
    assert.match(roleSettings, /enabled = true/, role);
    assert.match(roleSettings, /default_tools_approval_mode = "approve"/, role);
  }
});

test("the user-level MCP servers are self-sufficient, so no repository needs to redeclare them", async () => {
  const source = JSON.parse(
    await readFile(path.join(root, ".rulesync", "mcp.jsonc"), "utf8")
  );
  const mcpServers = source.codexcli.mcpServers;
  // Each server must carry every setting a project would otherwise re-add
  // locally. A project-local block shadows the user-level one by name, which is
  // how an unpinned `dlx @latest` override silently replaced the pinned
  // devDependency in a target repository.
  for (const server of ["lsp", "playwright"]) {
    const settings = mcpServers[server];
    assert.equal(settings.command, "bash", server);
    assert.match(settings.args.at(-1), /run-autodev-mcp\.sh"/, server);
    assert.equal(settings.default_tools_approval_mode, "approve", server);
    assert.equal(Boolean(settings.disabled), server === "playwright", server);
  }
});

test("root website research uses native search while Playwright stays role-scoped", async () => {
  const autodevConfig = await readFile(
    path.join(root, "config", "config.autodev.toml"),
    "utf8"
  );
  assert.match(autodevConfig, /\[tools\][\s\S]*web_search = true/);
  const mcp = JSON.parse(
    await readFile(path.join(root, ".rulesync", "mcp.jsonc"), "utf8")
  );
  assert.equal(Boolean(mcp.codexcli.mcpServers.playwright.disabled), true);
  for (const role of ["docs-researcher", "smart", "orchestrator"]) {
    const source = await readFile(
      path.join(root, "agents", "roles", `${role}.toml`),
      "utf8"
    );
    assert.match(source, /web_search = true/, role);
  }
});

test("Antigravity workspace customizations expose the code skills", async () => {
  const skills = JSON.parse(
    await readFile(path.join(root, ".agents", "skills.json"), "utf8")
  );
  assert.deepEqual(skills, {
    entries: [
      { path: ".rulesync/skills", include_only: ["ccc", "lsp-mcp-server"] }
    ]
  });
});

test("provider bridges explicitly expose code MCP capabilities", async () => {
  const copilot = await readFile(
    path.join(root, "runtime", "src", "providers", "copilot.ts"),
    "utf8"
  );
  // Copilot MCP exposure follows the role contract (see copilot-mcp-scope.test.ts).
  assert.match(copilot, /--additional-mcp-config/);
  assert.match(copilot, /--disable-mcp-server/);
  assert.match(copilot, /--allow-tool=web_search/);
  assert.match(copilot, /--allow-tool=web_fetch/);
  const claude = await readFile(
    path.join(root, "runtime", "src", "providers", "claude.ts"),
    "utf8"
  );
  // Claude reaches a role's MCP servers through Codex's own tools (Codex
  // loads them from the role TOML), and keeps only its native web research.
  assert.match(claude, /codexToolsMcpConfig/);
  assert.doesNotMatch(claude, /bridgeMcpServers/);
  assert.match(claude, /WebSearch/);
  assert.match(claude, /WebFetch/);
  const antigravity = await readFile(
    path.join(root, "runtime", "src", "providers", "antigravity.ts"),
    "utf8"
  );
  assert.match(antigravity, /search_web/);
  assert.match(antigravity, /read_url_content/);
  const installer = await readFile(
    path.join(root, "scripts", "install.sh"),
    "utf8"
  );
  const settings = await readFile(
    path.join(root, "runtime", "src", "platform", "antigravity-settings.ts"),
    "utf8"
  );
  assert.match(settings, /read_url\(\*\)/);
  const materializer = await readFile(
    path.join(root, "runtime", "src", "platform", "install-materializer.ts"),
    "utf8"
  );
  assert.match(
    materializer,
    /src\/platform\/antigravity-settings|updateAntigravityPermissions/
  );
  // Rulesync writes the user-level MCP server lists from .rulesync/mcp.jsonc.
  assert.doesNotMatch(installer, /\b(agy|copilot|claude) mcp (add|remove)\b/);
});

test("provider CLI versions are pinned in one AutoDev manifest", async () => {
  const manifest = JSON.parse(
    await readFile(
      path.join(root, ".github", "ci", "provider-tools.json"),
      "utf8"
    )
  ) as ProviderManifest;
  assert.equal(manifest.schemaVersion, 1);
  for (const packageSpec of Object.values(manifest.tools)) {
    assert.match(packageSpec.package, /@[^@\s]+@[0-9]+\.[0-9]+\.[0-9]+$/);
  }
  const invoke = await readWorkflow("agent-invoke.yml");
  assert.match(invoke, /run-ci-provider\.sh/);
  assert.match(invoke, /AUTODEV_\$\{key\}_PACKAGE/);
  const runner = await readFile(
    path.join(root, "scripts", "run-ci-provider.sh"),
    "utf8"
  );
  assert.match(runner, /require_pinned_package/);
  for (const name of [
    "claude-invoke.yml",
    "gemini-invoke.yml",
    "minimax-invoke.yml",
    "qwen-invoke.yml",
    "minimax-codex-invoke.yml"
  ]) {
    const source = await readWorkflow(name);
    assert.doesNotMatch(source, /agent_command:/, name);
    assert.doesNotMatch(
      source,
      /pnpm[ \t]+--silent[ \t]+dlx[ \t]+\S*@latest/,
      name
    );
  }
});

test("private target validation clones through AutoDev and reports target status", async () => {
  const source = await readWorkflow("target-validation.yml");
  assert.match(source, /Checkout private target through AutoDev PAT/);
  assert.match(source, /Detect target package manager version/);
  assert.match(
    source,
    /if: \$\{\{ steps\.profile\.outputs\.package_manager == 'pnpm' \}\}/
  );
  assert.match(source, /packageManager as pnpm@<version>/);
  assert.match(
    source,
    /version: \$\{\{ steps\.toolchain\.outputs\.pnpm_version \}\}/
  );
  assert.match(source, /repository: \$\{\{ inputs\.target_repository \}\}/);
  assert.match(source, /token: \$\{\{ secrets\.GH_USER_TOKEN \}\}/);
  assert.match(source, /autodev\/validation/);
  assert.match(source, /run_browser/);
});

test("private target auto-merge trusts only AutoDev validation status", async () => {
  const source = await readWorkflow("target-automerge.yml");
  assert.match(source, /autodev\/validation/);
  assert.match(source, /autoDevValidation/);
  assert.match(source, /autoDevValidation\.state === 'success'/);
});

test("manual repository selectors accept target_repository as string without duplicating repository choices", async () => {
  for (const name of [
    "run-prompt.yml",
    "agent-01-custom-prompt.yml",
    "target-validation.yml",
    "target-automerge.yml",
    "target-pr-janitor.yml",
    "minimax-invoke.yml",
    "claude-invoke.yml",
    "gemini-invoke.yml",
    "minimax-codex-invoke.yml",
    "qwen-invoke.yml"
  ]) {
    const source = await readWorkflow(name);
    if (!source.includes("target_repository:")) continue;
    assert.match(source, /target_repository:[\s\S]*?type: string/, name);
    assert.doesNotMatch(source, /options:\n\s+- SimulatorLife/, name);
  }
});

test("target-handling workflows delegate validation to the workspace-catalog owner", async () => {
  const ownerPath = ".github/scripts/workspace-catalog.cjs";
  const catalogPath = "config/workspaces.json";
  const escapeForRegExp = (segment: string): string =>
    segment.replaceAll(".", String.raw`\.`);
  const ownerRequirePattern = new RegExp(
    String.raw`require\(\s*path\.join\(` +
      String.raw`[\s\S]*?` +
      ownerPath
        .split("/")
        .map(escapeForRegExp)
        .map((segment) => `['"]${segment}['"]`)
        .join(String.raw`[\s\S]*?`) +
      String.raw`\s*\)\s*\)`
  );
  const rootWorkflows = [
    "target-pr-janitor.yml",
    "target-automerge.yml",
    "target-validation.yml"
  ] as const;
  const autodevWorkflows = [
    "_agent-open-pr-and-ping.yml",
    "agent-invoke.yml",
    "agent-02-resolve-merge-conflicts.yml"
  ] as const;

  for (const name of rootWorkflows) {
    const source = await readWorkflow(name);
    assert.match(
      source,
      ownerRequirePattern,
      `${name} loads the catalog owner via its exact repository-relative require path`
    );
    assert.match(
      source,
      new RegExp(catalogPath.replaceAll(".", String.raw`\.`)),
      `${name} references the canonical catalog path`
    );
    assert.doesNotMatch(
      source,
      /autodev-workspaces-v1/,
      `${name} must not duplicate the catalog schema literal`
    );
    assert.doesNotMatch(
      source,
      /\[\^\S[^\s/]*\/\S+\]/,
      `${name} must not duplicate the identity regex`
    );
    assert.doesNotMatch(source, /catalog\.schema !==/, `${name}`);
  }

  for (const name of autodevWorkflows) {
    const source = await readWorkflow(name);
    assert.match(
      source,
      /workspace-catalog\.cjs/,
      `${name} invokes the catalog owner`
    );
    assert.doesNotMatch(
      source,
      /autodev-workspaces-v1/,
      `${name} must not duplicate the catalog schema literal`
    );
    assert.doesNotMatch(
      source,
      /\.workspaces\[\] \| select\(\.id ==/,
      `${name} must not inline the workspace lookup jq query`
    );
  }
});

test("validation profile selection is derived from target_repository", async () => {
  const source = await readWorkflow("target-validation.yml");
  assert.doesNotMatch(source, /validation_profile:/);
  assert.match(source, /validation-profiles\.json/);
  assert.match(source, /--arg repo/);
});

test("agent invocation interface omits unused compatibility inputs", async () => {
  const source = await readWorkflow("agent-invoke.yml");
  assert.doesNotMatch(source, /\n {6}target_sha:/);
  assert.doesNotMatch(source, /\n {6}working_branch:/);
});

test("MiniMax Codex CI runs through the tracked boundary adapter, never straight to MiniMax", async () => {
  const invoke = await readWorkflow("minimax-codex-invoke.yml");
  assert.match(invoke, /agent: mini-max-codex/);
  assert.doesNotMatch(invoke, /openai_base_url/);
  assert.doesNotMatch(invoke, /api\.minimax\.io/);
  const agentInvoke = await readWorkflow("agent-invoke.yml");
  assert.match(
    agentInvoke,
    /AUTODEV_ROOT: \$\{\{ github\.workspace \}\}\/\.autodev/
  );
  const runner = await readFile(
    path.join(root, "scripts", "run-ci-provider.sh"),
    "utf8"
  );
  // Assert against commands, not prose: the comments explain why MiniMax is never called directly.
  const marker = "  mini-max-codex)";
  const markerIndex = runner.indexOf(marker);
  const afterMarker =
    markerIndex === -1 ? "" : runner.slice(markerIndex + marker.length);
  const semiIndex = afterMarker.indexOf(";;");
  const branchSource =
    semiIndex === -1 ? afterMarker : afterMarker.slice(0, semiIndex);
  const branch = branchSource
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.match(branch, /export CODEX_HOME="\$runner_temp\/codex-home"/);
  assert.match(
    branch,
    /config\/profiles\/minimax\.config\.toml" "\$CODEX_HOME\/minimax\.config\.toml"/
  );
  assert.match(
    branch,
    /config\/catalogs\/minimax-model-catalog\.json" "\$CODEX_HOME\/minimax-model-catalog\.json"/
  );
  assert.match(
    branch,
    /node "\$AUTODEV_ROOT\/runtime\/src\/providers\/minimax\.ts"/
  );
  assert.match(
    branch,
    /MINIMAX_PROXY_HOST=127\.0\.0\.1 MINIMAX_PROXY_PORT=18765/
  );
  assert.match(branch, /\/health/);
  assert.match(branch, /export MINIMAX_API_KEY=/);
  assert.match(branch, /exec --profile=minimax --json -/);
  assert.doesNotMatch(branch, /api\.minimax\.io/);
  const profile = await readFile(
    path.join(root, "config", "profiles", "minimax.config.toml"),
    "utf8"
  );
  assert.match(profile, /base_url = "http:\/\/127\.0\.0\.1:18765\/v1"/);
  assert.match(
    profile,
    /model_catalog_json = "\.\/minimax-model-catalog\.json"/
  );
});

test("CI never stores a GitHub credential in a git remote URL", async () => {
  for (const name of [
    "agent-invoke.yml",
    "_agent-open-pr-and-ping.yml",
    "target-validation.yml"
  ]) {
    const source = await readWorkflow(name);
    assert.doesNotMatch(source, /x-access-token:\$\{/, name);
    assert.doesNotMatch(
      source,
      /https:\/\/[^\s"'/@:]+:[^\s"'/@]+@github\.com/,
      name
    );
  }
  const invoke = await readWorkflow("agent-invoke.yml");
  assert.doesNotMatch(invoke, /redact_git_remote_credentials/);
  assert.match(
    invoke,
    /git remote set-url origin "https:\/\/github\.com\/\$\{\{ inputs\.target_repository \}\}\.git"/
  );
  assert.match(
    invoke,
    /git config --local --unset-all credential\.https:\/\/github\.com\.helper \|\| true/
  );
});

test("the CI git credential helper answers from the environment without persisting the token", async () => {
  const invoke = await readWorkflow("agent-invoke.yml");
  assert.match(
    invoke,
    /git config --local --add credential\.https:\/\/github\.com\.helper ''\n/,
    "the helper list must be reset first"
  );
  const helperMatch = invoke.match(
    /--add credential\.https:\/\/github\.com\.helper '(![^']+)'/
  );
  assert.ok(helperMatch);
  const helper = helperMatch[1] ?? "";
  const repo = await mkdtemp(path.join(tmpdir(), "autodev-credential-helper-"));
  // Isolated from this machine's global/system git config and credential
  // helpers (for example the macOS keychain), so only the workflow's helper can
  // answer and no real credential is ever read.
  const isolated = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GH_TOKEN: ""
  };
  try {
    const git = (
      args: string[],
      options: { input?: string; env?: NodeJS.ProcessEnv } = {}
    ) =>
      spawnSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: isolated,
        ...options
      });
    assert.equal(git(["init", "-q"]).status, 0);
    assert.equal(
      git([
        "remote",
        "add",
        "origin",
        "https://github.com/SimulatorLife/AutoDev.git"
      ]).status,
      0
    );
    assert.equal(
      git([
        "config",
        "--local",
        "--add",
        "credential.https://github.com.helper",
        ""
      ]).status,
      0
    );
    assert.equal(
      git([
        "config",
        "--local",
        "--add",
        "credential.https://github.com.helper",
        helper
      ]).status,
      0
    );
    const token = "ghp_example_token_never_persisted";
    const fill = git(["credential", "fill"], {
      input:
        "protocol=https\nhost=github.com\npath=SimulatorLife/AutoDev.git\n\n",
      env: { ...isolated, GH_TOKEN: token }
    });
    assert.equal(fill.status, 0, fill.stderr);
    assert.match(fill.stdout, /^username=x-access-token$/m);
    assert.match(fill.stdout, new RegExp(`^password=${token}$`, "m"));
    const gitConfig = await readFile(path.join(repo, ".git", "config"), "utf8");
    assert.equal(gitConfig.includes(token), false);
    assert.equal(
      git(["remote", "get-url", "origin"]).stdout.trim(),
      "https://github.com/SimulatorLife/AutoDev.git"
    );
    const missing = git(["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n"
    });
    assert.notEqual(
      missing.status,
      0,
      "a missing token must fail loudly rather than prompt or push anonymously"
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("the canonical CI provider entrypoint is valid bash", () => {
  const script = path.join(root, "scripts", "run-ci-provider.sh");
  const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("agent-invoke.yml run: blocks are syntactically valid bash", async () => {
  const source = await readWorkflow("agent-invoke.yml");
  const blocks = extractRunBlocks(source);
  assert.ok(
    blocks.length > 10,
    "expected many run: blocks to be extracted from agent-invoke.yml"
  );
  for (const block of blocks) {
    const result = spawnSync("bash", ["-n"], {
      input: block.body,
      encoding: "utf8"
    });
    assert.equal(
      result.status,
      0,
      `run: block starting near source line ${block.startLine} failed \`bash -n\`:\n${result.stderr}`
    );
  }
});

test("Node actions use the AutoDev root .nvmrc", async () => {
  const nvmrc = await readFile(path.join(root, ".nvmrc"), "utf8");
  assert.equal(nvmrc.trim(), "24.12");
  for (const name of [
    "copilot-setup-steps.yml",
    "agent-invoke.yml",
    "target-validation.yml"
  ]) {
    const source = await readWorkflow(name);
    assert.doesNotMatch(source, /node-version:\s*["']22["']/u, name);
    assert.match(source, /node-version-file:/u, name);
  }
});

test("target-handling github-script bodies load the workspace-catalog owner without __dirname", async () => {
  // actions/github-script evaluates each script: body as a restricted
  // AsyncFunction with no __dirname/__filename in scope. Executing the
  // exact extracted bodies (not a regex over the source text) is the only
  // way to prove require(path.join(__dirname, ...)) actually works there;
  // before the fix this throws "__dirname is not defined" immediately.
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    const automergeSource = await readWorkflow("target-automerge.yml");
    const planBlock = extractScriptBlocks(automergeSource).find((block) =>
      block.body.includes("core.setOutput('matrix'")
    );
    assert.ok(planBlock, "expected to find the Plan target PRs script block");
    const planOutputs: Record<string, string> = {};
    await runGithubScriptBody(planBlock!.body, {
      env: {
        GITHUB_WORKSPACE: root,
        REQUESTED_REPOSITORY: "SimulatorLife/AutoDev",
        REQUESTED_PR: "4242"
      },
      core: {
        setOutput: (key: string, value: string) => {
          planOutputs[key] = value;
        },
        info: () => {}
      },
      github: {
        paginate: async () => {
          throw new Error(
            "the requested_pr fast path must not list pull requests"
          );
        }
      }
    });
    assert.equal(planOutputs.has_targets, "true");
    const matrix = JSON.parse(planOutputs.matrix ?? "null") as {
      include: Array<{ repository: string; pr: number }>;
    };
    assert.deepEqual(matrix.include, [
      { repository: "SimulatorLife/AutoDev", pr: 4242 }
    ]);

    const janitorSource = await readWorkflow("target-pr-janitor.yml");
    const janitorBlock = extractScriptBlocks(janitorSource).find((block) =>
      block.body.includes("Target PR janitor complete")
    );
    assert.ok(janitorBlock, "expected to find the janitor script block");
    const notices: string[] = [];
    await runGithubScriptBody(janitorBlock!.body, {
      env: {
        GITHUB_WORKSPACE: root,
        TARGET_REPOSITORY: "SimulatorLife/AutoDev",
        STALE_HOURS: ""
      },
      core: {
        notice: (message: string) => {
          notices.push(message);
        },
        warning: () => {},
        info: () => {}
      },
      github: {
        paginate: async () => [],
        rest: { pulls: { list: () => {} } }
      }
    });
    assert.ok(
      notices.some((message) => message.includes("closed 0 PR(s)")),
      "janitor must complete using the catalog owner it loaded"
    );

    const validationSource = await readWorkflow("target-validation.yml");
    const resolveBlock = extractScriptBlocks(validationSource).find((block) =>
      block.body.includes("core.setOutput('target_sha'")
    );
    assert.ok(resolveBlock, "expected to find the resolve_target script block");
    const resolveOutputs: Record<string, string> = {};
    const sha = "a".repeat(40);
    await runGithubScriptBody(resolveBlock!.body, {
      env: {
        GITHUB_WORKSPACE: root,
        TARGET_REPOSITORY: "SimulatorLife/AutoDev",
        TARGET_SHA: sha,
        PR_NUMBER: ""
      },
      core: {
        setOutput: (key: string, value: string) => {
          resolveOutputs[key] = value;
        },
        info: () => {}
      },
      github: {
        rest: {
          pulls: {
            get: async () => {
              throw new Error(
                "PR_NUMBER is unset; pulls.get must not be called"
              );
            }
          }
        }
      }
    });
    assert.equal(resolveOutputs.target_sha, sha);
  } finally {
    process.chdir(previousCwd);
  }
});
