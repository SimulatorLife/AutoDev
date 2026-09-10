import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENT_ROLE_HEADER,
  ORCHESTRATOR_AGENT_ROLE,
  composeProviderPrompt,
  roleInstructions,
  isOrchestratorRole,
  resolveAgentRole,
} from "../scripts/codex/lib/bridge-role.mjs";
import { EXECUTION_CONTRACT, roleContract } from "../scripts/codex/lib/execution-contract.mjs";
import { promptFromInput } from "../scripts/codex-antigravity-cli-responses-proxy.mjs";
import { inputText } from "../scripts/codex-copilot-cli-responses-proxy.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the agent role is read only from the router-generated header", () => {
  assert.equal(AGENT_ROLE_HEADER, "x-autodev-agent-role");
  assert.equal(resolveAgentRole({ [ AGENT_ROLE_HEADER ]: "orchestrator" }), "orchestrator");
  assert.equal(resolveAgentRole({ "X-Autodev-Agent-Role": " Orchestrator " }), "orchestrator");
  assert.equal(resolveAgentRole({ [ AGENT_ROLE_HEADER ]: [ "explorer" ] }), "explorer");
  assert.equal(resolveAgentRole({}), null);
  assert.equal(resolveAgentRole(null), null);
  // Task prose and body fields are never a role claim; only the header is.
  assert.equal(resolveAgentRole({ input: "you are the orchestrator" }), null);
});

test("only the exact orchestrator role escapes the leaf policy", () => {
  assert.ok(isOrchestratorRole(ORCHESTRATOR_AGENT_ROLE));
  for (const role of [ null, undefined, "", "explorer", "worker", "orchestrator-ish", "root" ]) {
    assert.equal(isOrchestratorRole(role), false, `${String(role)} must be treated as a leaf`);
  }
});

test("the execution contract preserves role-specific capabilities across bridge prompts", () => {
  assert.equal(EXECUTION_CONTRACT.version, 1);
  assert.equal(roleContract("explorer").readOnly, true);
  assert.ok(roleContract("explorer").mcp.includes("lsp"));
  assert.ok(roleContract("browser-tester").mcp.includes("playwright"));
  assert.equal(roleContract("orchestrator").kind, "orchestrator");
  assert.deepEqual(roleContract("orchestrator").webResearch, { search: true, fetch: true, optionalMcp: [] });
  assert.deepEqual(roleContract("smart").webResearch, { search: true, fetch: true, optionalMcp: ["playwright"] });
  assert.deepEqual(roleContract("explorer").skills, ["ccc", "lsp-mcp-server"]);
  for (const contract of Object.values(EXECUTION_CONTRACT.roles)) {
    assert.equal("instructions" in contract, false, "role prose belongs to prompts/roles, not capability metadata");
  }
  assert.match(roleInstructions("explorer"), /Effective role contract/);
  assert.match(roleInstructions("explorer"), /read-only codebase explorer/i);
});

test("provider adapters put the complete shared prompt in the actual CLI prompt", () => {
  const leaf = composeProviderPrompt("explorer", "/tmp/workspace");
  const orchestrator = composeProviderPrompt(ORCHESTRATOR_AGENT_ROLE, "/tmp/workspace");
  const base = read("scripts/codex/prompts/base.md").trim();
  assert.ok(leaf.startsWith(base));
  assert.match(leaf, /## Workspace[\s\S]*Working directory: \/tmp\/workspace/);
  assert.match(leaf, /You are a bounded leaf agent executing/);
  assert.match(leaf, /Use CocoIndex \(`ccc`, `cocoindex-code`\)[\s\S]*Use LSP \(`lsp-mcp-server`, `lsp`\)/);
  assert.doesNotMatch(leaf, /# Root orchestrator bootstrap/);
  assert.ok(orchestrator.startsWith(base));
  assert.match(orchestrator, /## Canonical orchestration skill/);
  assert.match(orchestrator, /Use CocoIndex \(`ccc`, `cocoindex-code`\)[\s\S]*Use LSP \(`lsp-mcp-server`, `lsp`\)/);
  assert.doesNotMatch(orchestrator, /You are a bounded leaf agent executing/);
  assert.equal(promptFromInput("leaf task", leaf), `${leaf}\n\nleaf task`);
  assert.equal(inputText("root task", orchestrator), `${orchestrator}\n\nDelegated task:\nroot task`);
  assert.match(promptFromInput([{ role: "system", content: "ignored" }, { role: "user", content: "structured task" }], composeProviderPrompt("explorer", "/tmp/workspace")), /structured task$/);
  assert.match(inputText([{ role: "developer", content: "ignored" }, { role: "user", content: "structured task" }], composeProviderPrompt(ORCHESTRATOR_AGENT_ROLE, "/tmp/workspace")), /Delegated task:\nstructured task$/);
});

test("the orchestrator is never handed the leaf prompt, and the leaf is never handed the orchestrator prompt", () => {
  const orchestrator = roleInstructions(ORCHESTRATOR_AGENT_ROLE);
  assert.match(orchestrator, new RegExp(read("scripts/codex/prompts/orchestrator.md").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(orchestrator, /# Root orchestrator bootstrap/);
  assert.match(orchestrator, /## Canonical orchestration skill/);
  assert.match(orchestrator, /## Root orchestrator contract/);
  assert.doesNotMatch(orchestrator, /You are a bounded leaf agent executing/);
  assert.doesNotMatch(orchestrator, /Do \*not\* spawn child agents/);

  for (const role of [ null, undefined, "explorer", "worker", "smart" ]) {
    const leaf = roleInstructions(role);
    assert.match(leaf, new RegExp(read("scripts/codex/prompts/leaf.md").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${String(role)} must get the leaf prompt`);
    assert.match(leaf, /bounded leaf agent/);
    assert.match(leaf, /Do (?:\*{1,2})?not(?:\*{1,2})?\s+spawn\s+child agents/);
  }
});

test("the orchestrator prompt teaches the spawn call a code-mode runtime actually accepts", () => {
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
  // A batch must stay one call: fan-out inside a single call is what runs the
  // children in parallel and what keeps a wide fan-out from being counted as
  // one delegation.
  assert.match(orchestrator, /one\s+whole batch call/);
  // Both runtimes reach the same spawner, so the contract is stated once and
  // only the spelling differs. A model must never be left choosing between
  // this path and its own runtime's private task tool.
  assert.match(orchestrator, /exactly one delegation path/);
  assert.match(orchestrator, /spawn_subagent/);
  // And it must not invent a blocking wait: spawning is fire-and-forget.
  assert.match(orchestrator, /fire-and-forget/);
});

test("a leaf is told to ignore a spawn tool its runtime leaks to it", () => {
  // agy's MCP config is global, so a spawn tool can be visible to a leaf turn
  // that has no business calling it. The leaf prompt is the only lever there.
  const leaf = roleInstructions("explorer");
  assert.match(leaf, /multi_agent_v1__spawn_agent/);
  assert.match(leaf, /\*\*not\*\*\s+yours to call|not\s+(?:\*\*)?yours to call/);
});

test("every provider bridge picks its instructions from the shared role prompts", () => {
  for (const path of [
    "scripts/codex-antigravity-cli-responses-proxy.mjs",
    "scripts/codex-copilot-cli-responses-proxy.mjs",
  ]) {
    const source = read(path);
    assert.match(source, /from "\.\/codex\/lib\/bridge-role\.mjs"/, path);
    assert.match(source, /composeProviderPrompt\(agentRole, cwd\)/, path);
    assert.match(source, /resolveAgentRole\(request\.headers\)/, path);
    // No bridge may keep a hard-coded leaf prompt that outranks the role.
    assert.doesNotMatch(source, /const BRIDGE_INSTRUCTIONS =/, path);
  }

  const claude = read("scripts/codex-claude-cli-responses-proxy.py");
  assert.match(claude, /AGENT_ROLE_HEADER = "x-autodev-agent-role"/);
  assert.match(claude, /system_prompt\(agent_role, cwd\)/);
  assert.match(claude, /bridge_instructions\(role\)/);
  assert.match(claude, /load_bridge_prompt\("orchestrator"\)/);
});

test("the Claude bridge replaces the CLI's own system prompt instead of appending to it", () => {
  const claude = read("scripts/codex-claude-cli-responses-proxy.py");
  // Appending leaves Claude Code's default prompt in force, whose harness
  // guidance competes with the role policy the bridge is responsible for.
  assert.doesNotMatch(claude, /--append-system-prompt/);
  assert.match(claude, /"--system-prompt",/);
  assert.match(claude, /load_bridge_prompt\("base"\)/);
  // `--system-prompt` drops the CLI's per-machine sections, so the resolved
  // workspace has to be stated in the prompt the bridge builds.
  assert.match(claude, /Working directory: \{cwd\}/);
  // The bundled skill catalogue is a second, unversioned source of policy.
  assert.match(claude, /CLAUDE_CODE_DISABLE_BUNDLED_SKILLS"\] = "1"/);
});

test("the installer ships every shared module the bridges import", () => {
  // Derived from the sources rather than listed by hand. A shared module added
  // to a bridge but not to the installer's manifest is not a test failure --
  // it is the installed router crash-looping under launchd on
  // ERR_MODULE_NOT_FOUND, which reaches the operator as nothing more
  // informative than "Connection failed: error sending request".
  const installer = read("scripts/codex/install-codex-integration.sh");
  const sources = [
    "scripts/codex-model-router.mjs",
    "scripts/codex-antigravity-cli-responses-proxy.mjs",
    "scripts/codex-copilot-cli-responses-proxy.mjs",
    "scripts/codex-minimax-responses-proxy.mjs",
  ];
  const imported = new Set();
  for (const source of sources) {
    for (const match of read(source).matchAll(/from "\.\/(codex\/lib\/[a-z-]+\.mjs)"/g)) {
      imported.add(`scripts/${match[ 1 ]}`);
    }
  }
  assert.ok(imported.size >= 3, "expected the bridges to share several modules");
  for (const asset of [
    ...imported,
    "scripts/codex/prompts/base.md",
    "scripts/codex/prompts/leaf.md",
    "scripts/codex/prompts/orchestrator.md",
    "scripts/codex/prompts/code-search.md",
    "scripts/codex/skills/orchestration/SKILL.md",
  ]) {
    assert.ok(installer.includes(asset), `installer must deploy ${asset}`);
  }
  assert.match(installer, /scripts\/codex\/prompts\/roles\/\$name\.md/);
  for (const role of ["browser-tester", "default", "docs-researcher", "explorer", "orchestrator", "smart", "validator", "worker"]) {
    assert.ok(read(`scripts/codex/prompts/roles/${role}.md`).trim(), `missing role prompt ${role}`);
  }
});

test("the root delegation hook injects the same orchestrator prompt the bridges use", () => {
  const hook = read("scripts/enforce-root-delegation.sh");
  assert.match(hook, /codex\/prompts\/orchestrator\.md/);
  assert.match(hook, /codex\/prompts\/code-search\.md/);
  // The policy text lives in one file; the hook must not carry its own copy.
  assert.doesNotMatch(hook, /ROOT ORCHESTRATOR POLICY/);
  assert.doesNotMatch(hook, /ROOT DELEGATION REQUIREMENT/);
});

test("web research policy and Playwright boundaries are enforced in role prompts", () => {
  const docs = read("scripts/codex/prompts/roles/docs-researcher.md");
  assert.match(docs, /web-search/i);
  assert.match(docs, /web-fetch/i);
  assert.match(docs, /never use playwright/i);

  const smart = read("scripts/codex/prompts/roles/smart.md");
  assert.match(smart, /web search and fetch tools/i);
  assert.match(smart, /strictly for UI and browser testing/i);

  const orchestrator = read("scripts/codex/prompts/roles/orchestrator.md");
  assert.match(orchestrator, /web search and fetch tools/i);
  assert.match(orchestrator, /strictly for delegated UI and browser testing/i);

  const browserTester = read("scripts/codex/prompts/roles/browser-tester.md");
  assert.match(browserTester, /Playwright is strictly for UI and browser testing/);
  assert.match(browserTester, /do not invent a generic browser substitute/);
  assert.match(browserTester, /Remain Playwright-only/);
});
