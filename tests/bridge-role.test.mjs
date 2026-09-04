import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENT_ROLE_HEADER,
  ORCHESTRATOR_AGENT_ROLE,
  bridgeInstructions,
  isOrchestratorRole,
  resolveAgentRole,
} from "../scripts/codex/lib/bridge-role.mjs";

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

test("the orchestrator is never handed the leaf prompt, and the leaf is never handed the orchestrator prompt", () => {
  const orchestrator = bridgeInstructions(ORCHESTRATOR_AGENT_ROLE);
  assert.equal(orchestrator, read("scripts/codex/prompts/orchestrator.md").trim());
  assert.match(orchestrator, /ROOT ORCHESTRATOR POLICY/);
  assert.doesNotMatch(orchestrator, /leaf agent|Do not spawn child agents/);

  for (const role of [ null, undefined, "explorer", "worker", "smart" ]) {
    const leaf = bridgeInstructions(role);
    assert.equal(leaf, read("scripts/codex/prompts/leaf.md").trim(), `${String(role)} must get the leaf prompt`);
    assert.match(leaf, /bounded leaf agent/);
    assert.match(leaf, /Do not spawn\s+child agents/);
  }
});

test("every provider bridge picks its instructions from the shared role prompts", () => {
  for (const path of [
    "scripts/codex-antigravity-cli-responses-proxy.mjs",
    "scripts/codex-copilot-cli-responses-proxy.mjs",
  ]) {
    const source = read(path);
    assert.match(source, /from "\.\/codex\/lib\/bridge-role\.mjs"/, path);
    assert.match(source, /bridgeInstructions\(agentRole\)/, path);
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

test("the installer ships the shared role prompts beside the bridges that load them", () => {
  const installer = read("scripts/codex/install-codex-integration.sh");
  for (const asset of [
    "scripts/codex/lib/bridge-role.mjs",
    "scripts/codex/prompts/base.md",
    "scripts/codex/prompts/leaf.md",
    "scripts/codex/prompts/orchestrator.md",
  ]) {
    assert.ok(installer.includes(asset), `installer must deploy ${asset}`);
  }
});

test("the root delegation hook injects the same orchestrator prompt the bridges use", () => {
  const hook = read("scripts/enforce-root-delegation.sh");
  assert.match(hook, /codex\/prompts\/orchestrator\.md/);
  // The policy text lives in one file; the hook must not carry its own copy.
  assert.doesNotMatch(hook, /ROOT ORCHESTRATOR POLICY/);
  assert.doesNotMatch(hook, /ROOT DELEGATION REQUIREMENT/);
});
