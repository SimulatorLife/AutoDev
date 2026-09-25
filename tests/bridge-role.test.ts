import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENT_ROLE_HEADER,
  composeProviderPrompt,
  isOrchestratorRole,
  ORCHESTRATOR_AGENT_ROLE,
  resolveAgentRole,
  roleInstructions
} from "../src/agents/bridge-role.ts";
import { promptFromInput } from "../src/providers/antigravity.ts";
import { renderCodexTranscript } from "../src/providers/claude-codex-tools.ts";
import { inputText } from "../src/providers/copilot.ts";
import {
  EXECUTION_CONTRACT,
  roleContract
} from "../src/shared/execution-contract.ts";
import { normalizedSource } from "./source-text.ts";

const read = (path: string): string => {
  const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  return path.endsWith(".ts") ? normalizedSource(text) : text;
};

test("the agent role is read only from the router-generated header", () => {
  assert.equal(AGENT_ROLE_HEADER, "x-autodev-agent-role");
  assert.equal(
    resolveAgentRole({ [AGENT_ROLE_HEADER]: "orchestrator" }),
    "orchestrator"
  );
  assert.equal(
    resolveAgentRole({ "X-Autodev-Agent-Role": " Orchestrator " }),
    "orchestrator"
  );
  assert.equal(
    resolveAgentRole({ [AGENT_ROLE_HEADER]: ["explorer"] }),
    "explorer"
  );
  assert.equal(resolveAgentRole({}), null);
  assert.equal(resolveAgentRole(null), null);
  // Task prose and body fields are never a role claim; only the header is.
  assert.equal(resolveAgentRole({ input: "you are the orchestrator" }), null);
});

test("only the exact orchestrator role escapes the leaf policy", () => {
  assert.ok(isOrchestratorRole(ORCHESTRATOR_AGENT_ROLE));
  for (const role of [
    null,
    undefined,
    "",
    "explorer",
    "worker",
    "orchestrator-ish",
    "root"
  ]) {
    assert.equal(
      isOrchestratorRole(role),
      false,
      `${String(role)} must be treated as a leaf`
    );
  }
});

test("the execution contract preserves role-specific capabilities across bridge prompts", () => {
  assert.equal(EXECUTION_CONTRACT.version, 1);
  assert.equal(roleContract("explorer").readOnly, true);
  assert.ok(roleContract("explorer").mcp.includes("lsp"));
  assert.ok(roleContract("explorer").mcp.includes("codegraphcontext"));
  assert.ok(roleContract("browser-tester").mcp.includes("playwright"));
  assert.equal(roleContract("orchestrator").kind, "orchestrator");
  assert.deepEqual(roleContract("orchestrator").webResearch, {
    search: true,
    fetch: true,
    optionalMcp: []
  });
  assert.deepEqual(roleContract("smart").webResearch, {
    search: true,
    fetch: true,
    optionalMcp: ["playwright"]
  });
  assert.deepEqual(roleContract("explorer").skills, ["ccc", "lsp-mcp-server"]);
  for (const contract of Object.values(EXECUTION_CONTRACT.roles)) {
    assert.equal(
      "instructions" in contract,
      false,
      "role prose belongs to prompts/roles, not capability metadata"
    );
  }
  assert.match(roleInstructions("explorer"), /Effective role contract/);
  assert.match(roleInstructions("explorer"), /read-only codebase explorer/i);
  assert.doesNotMatch(
    roleInstructions("docs-researcher"),
    /CodeGraphContext \(CGC\)/
  );
  assert.match(roleInstructions("docs-researcher"), /do not call those tools/i);
});

test("provider adapters put the complete shared prompt in the actual CLI prompt", () => {
  const leaf = composeProviderPrompt("explorer", "/tmp/workspace");
  const orchestrator = composeProviderPrompt(
    ORCHESTRATOR_AGENT_ROLE,
    "/tmp/workspace"
  );
  const base = read("agents/prompts/base.md").trim();
  assert.ok(leaf.startsWith(base));
  assert.match(leaf, /## Workspace[\s\S]*Working directory: \/tmp\/workspace/);
  assert.match(leaf, /You are a bounded leaf agent executing/);
  assert.match(
    leaf,
    /Use CodeGraphContext \(CGC\)[\s\S]*Use CocoIndex[\s\S]*Use LSP/
  );
  assert.match(
    leaf,
    /indexes the active repository's graph in the background at session start[\s\S]*list_indexed_repositories/
  );
  assert.doesNotMatch(leaf, /add_code_to_graph|check_job_status/);
  assert.match(leaf, /Repomix is optional high-level briefing only/);
  assert.match(leaf, /analyze_code_relationships.*find_code/);
  assert.doesNotMatch(leaf, /Use CocoIndex for broad semantic discovery/);
  assert.doesNotMatch(leaf, /# Root orchestrator bootstrap/);
  assert.ok(orchestrator.startsWith(base));
  assert.match(orchestrator, /## Canonical orchestration skill/);
  assert.match(
    orchestrator,
    /Use CodeGraphContext \(CGC\)[\s\S]*Use CocoIndex[\s\S]*Use LSP/
  );
  assert.doesNotMatch(orchestrator, /You are a bounded leaf agent executing/);
  assert.equal(promptFromInput("leaf task", leaf), `${leaf}\n\nleaf task`);
  assert.equal(
    inputText("root task", orchestrator),
    `${orchestrator}\n\nDelegated task:\nroot task`
  );
  assert.match(
    promptFromInput(
      [
        { role: "system", content: "ignored" },
        { role: "user", content: "structured task" }
      ],
      composeProviderPrompt("explorer", "/tmp/workspace")
    ),
    /structured task$/
  );
  assert.match(
    inputText(
      [
        { role: "developer", content: "ignored" },
        { role: "user", content: "structured task" }
      ],
      composeProviderPrompt(ORCHESTRATOR_AGENT_ROLE, "/tmp/workspace")
    ),
    /Delegated task:\nstructured task$/
  );
});

test("Claude receives Codex's own context, developer instructions included", () => {
  // Claude is served as the model behind a Codex turn, so it is given exactly
  // what a Codex-native model is given: the role policy arrives in Codex's own
  // developer message rather than as a second copy the bridge composes.
  const transcript = renderCodexTranscript([
    {
      role: "developer",
      content: [{ type: "input_text", text: "role policy" }]
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "review the changes" }]
    },
    { role: "user", content: [{ type: "text", text: "run the validator" }] }
  ]);
  assert.equal(
    transcript,
    "<developer>\nrole policy\n</developer>\n\n<user>\nreview the changes\n</user>\n\n<user>\nrun the validator\n</user>"
  );
});

test("the orchestrator is never handed the leaf prompt, and the leaf is never handed the orchestrator prompt", () => {
  const orchestrator = roleInstructions(ORCHESTRATOR_AGENT_ROLE);
  assert.match(
    orchestrator,
    new RegExp(
      read("agents/prompts/orchestrator.md")
        .trim()
        .replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    )
  );
  assert.match(orchestrator, /# Root orchestrator bootstrap/);
  assert.match(orchestrator, /## Canonical orchestration skill/);
  assert.match(orchestrator, /## Delegation/);
  assert.doesNotMatch(orchestrator, /You are a bounded leaf agent executing/);
  assert.doesNotMatch(orchestrator, /Do \*not\* spawn child agents/);

  for (const role of [null, undefined, "explorer", "worker", "smart"]) {
    const leaf = roleInstructions(role);
    assert.match(
      leaf,
      new RegExp(
        read("agents/prompts/leaf.md")
          .trim()
          .replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
      ),
      `${String(role)} must get the leaf prompt`
    );
    assert.match(leaf, /bounded leaf agent/);
    assert.match(leaf, /Do \*{0,2}not\*{0,2}\s+spawn\s+child agents/);
  }
});

test("the orchestrator prompt teaches the canonical code-mode spawn path", () => {
  const orchestrator = roleInstructions(ORCHESTRATOR_AGENT_ROLE);
  // Verified against a live Codex 0.153.1 and against recorded rollouts of
  // GPT-served turns that spawned successfully. Codex runs these models in code
  // mode: there is no spawn tool in the request, only an `exec` tool whose
  // JavaScript reaches `tools.multi_agent_v1__spawn_agent`. Telling the model to
  // "use whatever your runtime provides" left it with nothing to act on, which
  // is why delegation never happened on a code-mode provider.
  assert.match(orchestrator, /tools\.multi_agent_v1__spawn_agent/);
  // The role travels as `agent_type`; `agent` is accepted and silently ignored,
  // producing a generic agent instead of the requested role.
  assert.match(orchestrator, /agent_type/);
  assert.match(orchestrator, /Promise\.all/);
  // A batch uses one spawn call and settles each result independently.
  assert.match(orchestrator, /single spawn call may dispatch a batch/);
  assert.match(orchestrator, /Promise\.allSettled/);
  // Direct Codex must use its native spawner, not the bridge-only shim.
  assert.match(orchestrator, /Do not switch to `autodev_spawn` instead of/);
  assert.match(orchestrator, /spawn_subagent/);
  // Lifecycle handling follows spawning, rather than blocking the spawn call.
  assert.match(orchestrator, /After spawning, poll child results/);
});

test("the orchestrator prompt tells the model to quote a spawn message so Markdown cannot break it", () => {
  // Observed 2026-09-24: a spawn message written as a template literal
  // contained `claude-opus-5-5` in backticks; the first backtick ended the
  // literal and the exec cell failed with "Unexpected identifier 'claude'".
  const prompt = read("agents/prompts/orchestrator.md");
  assert.match(prompt, /double-quoted JavaScript string/);
  assert.match(prompt, /never as a template literal/);
});

test("the orchestrator preserves agent IDs verbatim across lifecycle calls", () => {
  const prompt = read("agents/prompts/orchestrator.md");
  const runtimeContract = read(
    ".rulesync/skills/orchestration/references/runtime-contract.md"
  );
  for (const guidance of [prompt, runtimeContract]) {
    const normalized = guidance.replaceAll(/\s+/g, " ");
    assert.match(normalized, /agent_id.*opaque handle/);
    assert.match(normalized, /complete value .* verbatim/);
    assert.match(normalized, /never abbreviate .* retype it from memory/);
    assert.match(
      normalized,
      /recover the exact handle .* verified spawn history/
    );
  }
});

test("a leaf is told to ignore a spawn tool its runtime leaks to it", () => {
  // agy's MCP config is global, so a spawn tool can be visible to a leaf turn
  // that has no business calling it. The leaf prompt is the only lever there.
  const leaf = roleInstructions("explorer");
  assert.match(leaf, /multi_agent_v1__spawn_agent/);
  assert.match(
    leaf,
    /\*\*not\*\*\s+yours to call|not\s+(?:\*\*)?yours to call/
  );
});

test("every provider bridge picks its instructions from the shared role prompts", () => {
  // Every converted bridge lives under src/providers/, so each imports the
  // sibling agents/bridge-role.ts module at the same relative depth.
  const bridgeRoleImports: ReadonlyArray<readonly [string, RegExp]> = [
    ["src/providers/antigravity.ts", /from "\.\.\/agents\/bridge-role\.ts"/],
    ["src/providers/copilot.ts", /from "\.\.\/agents\/bridge-role\.ts"/]
  ];
  for (const [path, bridgeRoleImportPattern] of bridgeRoleImports) {
    const source = read(path);
    assert.match(source, bridgeRoleImportPattern, path);
    assert.match(source, /composeProviderPrompt\(agentRole, cwd\)/, path);
    assert.match(source, /resolveAgentRole\(request\.headers\)/, path);
    // No bridge may keep a hard-coded leaf prompt that outranks the role.
    assert.doesNotMatch(source, /const BRIDGE_INSTRUCTIONS =/, path);
  }

  const claude = read("src/providers/claude.ts");
  assert.match(claude, /resolveAgentRole\(request\.headers/);
  // Claude takes its role policy from Codex's developer instructions, like a
  // Codex-native model; a second composed copy would compete with them.
  assert.doesNotMatch(claude, /composeProviderPrompt/);
  assert.match(claude, /renderCodexTranscript\(payload\.input/);
});

test("the Claude bridge replaces the CLI's own system prompt instead of appending to it", () => {
  const claude = read("src/providers/claude.ts");
  // Appending leaves Claude Code's default prompt in force, whose harness
  // guidance describes tools a bridged turn does not have.
  assert.doesNotMatch(claude, /--append-system-prompt/);
  assert.match(claude, /"--system-prompt", options\.systemPrompt/);
  // `--system-prompt` drops the CLI's per-machine sections, so the resolved
  // workspace has to be stated in the prompt the bridge builds.
  assert.match(claude, /Working directory: \$\{cwd\}/);
  // The bundled skill catalogue is a second, unversioned source of policy.
  assert.match(claude, /CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = "1"/);
});

test("the installer ships every shared module the bridges import", () => {
  // Derived from the sources rather than listed by hand. A shared module added
  // to a bridge but not to the installer's manifest is not a test failure --
  // it is the installed router crash-looping under launchd on
  // ERR_MODULE_NOT_FOUND, which reaches the operator as nothing more
  // informative than "Connection failed: error sending request".
  const materializer = read("src/platform/install-materializer.ts");
  const sources = [
    "src/router/server.ts",
    "src/providers/antigravity.ts",
    "src/providers/minimax.ts",
    "src/providers/copilot.ts"
  ];
  const imported = new Set<string>();
  for (const source of sources) {
    for (const match of read(source).matchAll(
      /from ["']\.\/(codex\/lib\/[a-z-]+\.mjs)["']/g
    )) {
      imported.add(`scripts/${match[1]}`);
    }
    for (const match of read(source).matchAll(
      /from ["']\.\.\/src\/([^"']+\.ts)["']/g
    )) {
      imported.add(`src/${match[1]}`);
    }
    if (source === "src/router/server.ts") {
      for (const match of read(source).matchAll(
        /from ["']\.\/([^"']+\.ts)["']/g
      )) {
        imported.add(`src/router/${match[1]}`);
      }
    }
  }
  assert.ok(
    imported.size >= 3,
    "expected the bridges to share several modules"
  );
  for (const asset of [
    ...imported,
    "agents/prompts/base.md",
    "agents/prompts/leaf.md",
    "agents/prompts/orchestrator.md",
    "agents/prompts/code-search.md",
    ".rulesync/skills/orchestration/SKILL.md"
  ]) {
    assert.ok(
      materializer.includes(asset),
      `materializer must deploy ${asset}`
    );
  }
  assert.match(materializer, /agents\/prompts\/roles/);
  for (const role of [
    "browser-tester",
    "default",
    "docs-researcher",
    "explorer",
    "orchestrator",
    "smart",
    "validator",
    "worker"
  ]) {
    assert.ok(
      read(`agents/prompts/roles/${role}.md`).trim(),
      `missing role prompt ${role}`
    );
  }
});

test("the root delegation hook injects the same orchestrator prompt the bridges use", () => {
  const hook = read("scripts/enforce-root-delegation.sh");
  const typedHook = read("src/hooks/root-delegation.ts");
  assert.match(
    typedHook,
    /join\(root, ["']agents["'], ["']prompts["'], ["']orchestrator\.md["']\)/
  );
  assert.match(
    typedHook,
    /join\(root, ["']agents["'], ["']prompts["'], ["']code-search\.md["']\)/
  );
  // The policy text lives in one file; neither dispatch shim nor typed hook
  // carries an obsolete duplicate.
  assert.doesNotMatch(hook, /ROOT ORCHESTRATOR POLICY/);
  assert.doesNotMatch(typedHook, /ROOT DELEGATION REQUIREMENT/);
});

test("web research policy and Playwright boundaries are enforced in role prompts", () => {
  const docs = read("agents/prompts/roles/docs-researcher.md");
  assert.match(docs, /web-search/i);
  assert.match(docs, /web-fetch/i);
  assert.match(docs, /never use playwright/i);

  const smart = read("agents/prompts/roles/smart.md");
  assert.match(smart, /web search and fetch tools/i);
  assert.match(smart, /strictly for UI and browser testing/i);

  const orchestrator = read("agents/prompts/roles/orchestrator.md");
  assert.match(orchestrator, /web search and fetch tools/i);
  assert.match(orchestrator, /strictly for delegated UI and browser testing/i);

  const browserTester = read("agents/prompts/roles/browser-tester.md");
  assert.match(
    browserTester,
    /Playwright is strictly for UI and browser testing/
  );
  assert.match(browserTester, /do not invent a generic browser substitute/);
  assert.match(browserTester, /Remain Playwright-only/);
});

test("resolveSandboxModeFromHeaders reads the sandbox header case-insensitively", async () => {
  const { resolveSandboxModeFromHeaders } =
    await import("../src/agents/bridge-role.ts");
  assert.equal(
    resolveSandboxModeFromHeaders({
      "x-autodev-sandbox-mode": "read-only"
    }),
    "read-only"
  );
  assert.equal(
    resolveSandboxModeFromHeaders({
      "X-Autodev-Sandbox-Mode": "workspace-write"
    }),
    "workspace-write"
  );
  assert.equal(resolveSandboxModeFromHeaders({}), null);
  assert.equal(resolveSandboxModeFromHeaders(null), null);
  // Unknown values are ignored.
  assert.equal(
    resolveSandboxModeFromHeaders({
      "x-autodev-sandbox-mode": "full-access"
    }),
    null
  );
});

test("resolveSkillContextFromHeaders returns the propagated skill body", async () => {
  const { resolveSkillContextFromHeaders } =
    await import("../src/agents/bridge-role.ts");
  const body = "<skill>...</skill>";
  assert.equal(
    resolveSkillContextFromHeaders({ "x-autodev-skill-context": body }),
    body
  );
  assert.equal(
    resolveSkillContextFromHeaders({
      "X-Autodev-Skill-Context": body,
      "content-type": "text/plain"
    }),
    body
  );
  assert.equal(resolveSkillContextFromHeaders({}), null);
  assert.equal(resolveSkillContextFromHeaders(null), null);
  // Empty body is treated as absent.
  assert.equal(
    resolveSkillContextFromHeaders({ "x-autodev-skill-context": "  " }),
    null
  );
});
