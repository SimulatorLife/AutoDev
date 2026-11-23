import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bridgeReadOnly,
  bridgeSkillContext,
  composeProviderPrompt,
  isOrchestratorRole,
  ORCHESTRATOR_AGENT_ROLE,
  resolveAgentRole,
  roleInstructions
} from "@simulatorlife/autodev-runtime/agents";
import { promptFromInput } from "@simulatorlife/autodev-runtime/providers/antigravity";
import { renderCodexContentBlocks } from "@simulatorlife/autodev-runtime/providers/claude-codex-tools";
import { inputText } from "@simulatorlife/autodev-runtime/providers/copilot";
import {
  elidePriorTurnsForNativePayload,
  renderCodexTranscript
} from "@simulatorlife/autodev-runtime/shared/codex-transcript";
import {
  AGENT_ROLE_HEADER,
  READ_ONLY_HEADER,
  SKILL_CONTEXT_HEADER
} from "@simulatorlife/autodev-runtime/shared/agent-context-headers";
import {
  EXECUTION_CONTRACT,
  roleContract
} from "@simulatorlife/autodev-runtime/shared/execution-contract";

import { normalizedSource } from "./source-text.ts";

// The bridge inlines the orchestration skill from its installed link, as the
// installer lays it out; give this process a home with that link only.
const skillHome = mkdtempSync(join(tmpdir(), "autodev-bridge-role-home-"));
const installedOrchestration = join(
  skillHome,
  ".agents",
  "skills",
  "orchestration"
);
mkdirSync(join(skillHome, ".agents", "skills"), { recursive: true });
symlinkSync(
  fileURLToPath(new URL("../.rulesync/skills/orchestration", import.meta.url)),
  installedOrchestration
);
process.env.HOME = skillHome;

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
  assert.equal(bridgeReadOnly({ [READ_ONLY_HEADER]: "1" }), true);
  assert.equal(bridgeReadOnly({ [READ_ONLY_HEADER]: "0" }), false);
  assert.equal(
    bridgeSkillContext({ [SKILL_CONTEXT_HEADER]: "# skill" }),
    "# skill"
  );
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

test("the role-prompt cache is bounded and eviction never changes what a role resolves to", () => {
  // The role reaches roleInstructions from a request header, so an unbounded
  // cache grew the heap once per distinct role string -- and nearly all of that
  // growth was duplication, because roleContract folds every unrecognised role
  // onto the default contract and rolePromptName folds it onto default.md.
  //
  // Two properties have to hold together: the cache must stay bounded, and
  // eviction must be invisible. A prompt is a deterministic function of the
  // role, so recomputing an evicted entry returns the identical string.
  const known = roleInstructions("explorer");
  const unknown = roleInstructions("mystery-role-a");
  // Unknown roles genuinely share one prompt; only their cache keys differed.
  assert.equal(
    roleInstructions("mystery-role-b"),
    unknown,
    "two unrecognised roles must resolve to the same prompt text"
  );

  // Push far past any plausible cache bound with distinct role strings.
  for (let index = 0; index < 500; index += 1) {
    roleInstructions(`cache-pressure-role-${index}`);
  }

  assert.equal(
    roleInstructions("explorer"),
    known,
    "a re-read after eviction must return the byte-identical prompt"
  );
  assert.equal(
    roleInstructions("mystery-role-a"),
    unknown,
    "an evicted unknown role must recompute to the same string"
  );
  assert.equal(
    roleInstructions(ORCHESTRATOR_AGENT_ROLE),
    roleInstructions(ORCHESTRATOR_AGENT_ROLE),
    "the orchestrator tier keeps its own entry"
  );
});

test("the role-prompt cache declares a limit and evicts the oldest key", () => {
  // The cache is module-private, so the bound is pinned where it is enforced.
  // Read through normalizedSource so the assertion survives reformatting.
  const text = normalizedSource(read("runtime/src/agents/bridge-role.ts"));
  assert.match(text, /const ROLE_PROMPT_CACHE_LIMIT = \d+;/u);
  assert.match(text, /cache\.size > ROLE_PROMPT_CACHE_LIMIT/u);
  assert.match(
    text,
    /cache\.keys\(\)\.next\(\)\.value/u,
    "eviction must drop the oldest key, not an arbitrary one"
  );
  assert.match(
    text,
    /const cache = new Map<string, string>\(\);/u,
    "the cache must stay typed so an evicted read cannot return undefined"
  );
});

test("distinct roles do not retain heap once per role", () => {
  // Runs the committed measurement in a child process because it needs
  // --expose-gc, which the test runner does not pass through. The budget is
  // chosen to separate the two implementations rather than to pin a number:
  // bounded retains 131 bytes/role (0.25 MiB over 2000 roles, identical across
  // repeated runs), unbounded retained 2840 (5.49 MiB). 400 sits ~3x above
  // bounded and ~7x below unbounded, so a regression fails clearly rather than
  // flaking in either direction.
  const script = fileURLToPath(
    new URL("../scripts/role-prompt-cache-memory.mjs", import.meta.url)
  );
  const output = execFileSync(
    process.execPath,
    ["--expose-gc", script, "2000"],
    { encoding: "utf8" }
  );
  const bytesPerRole = Number.parseInt(
    /retained per new role\s*:\s*(\d+)/u.exec(output)?.[1] ?? ""
  );
  assert.ok(
    Number.isFinite(bytesPerRole),
    `measurement output was not understood:\n${output}`
  );
  assert.ok(
    bytesPerRole <= 400,
    `retained ${bytesPerRole} bytes per distinct role; the cache is unbounded again\n${output}`
  );
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
  assert.match(leaf, /normal completion channel is the visible final text/);
  assert.match(
    leaf,
    /stop using tools and return a concise, evidence-backed final summary directly in visible text/
  );
  assert.match(
    leaf,
    /If a required tool is denied, unavailable, fails, or the turn reaches limits[\s\S]*end the turn/
  );
  assert.match(
    leaf,
    /Do not search for a parent conversation ID or call provider-local messaging tools/
  );
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

test("a web-chat orchestrator is taught the canonical code-mode spawn path", () => {
  // opencli roots delegate through Codex's own `exec`, so the bridge inlines
  // the code-mode reference with the skill instead of making the model read it
  // at a minute a turn.
  const orchestrator = roleInstructions(ORCHESTRATOR_AGENT_ROLE, "web-chat");
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
  assert.match(
    orchestrator,
    /independent spawns in one cell with\s+`await Promise\.allSettled/
  );
  assert.match(orchestrator, /### references\/web-chat\.md \(inlined/);
  assert.doesNotMatch(orchestrator, /### references\/provider-bridges\.md/);
  // Generic child lifecycle stays in the runtime contract the skill names.
  assert.doesNotMatch(orchestrator, /Wait timeouts and running children/);
  const runtimeContract = read(
    ".rulesync/skills/orchestration/references/runtime-contract.md"
  );
  assert.match(runtimeContract, /Wait timeouts and running children/);
  assert.match(runtimeContract, /Parking and session reuse/);
  assert.match(
    runtimeContract,
    /pass their IDs together to one `wait_agent` call/
  );
  assert.match(
    runtimeContract,
    /returns when the first target reaches a final status/
  );
  assert.match(runtimeContract, /minutes when appropriate.*repeated short/);
  assert.match(runtimeContract, /Never perform global cleanup/);
});

test("the orchestration skill core names each reference with the situation that needs it", () => {
  const skill = read(".rulesync/skills/orchestration/SKILL.md");
  for (const reference of [
    "runtime-contract",
    "codex-code-mode",
    "web-chat",
    "recovery",
    "validation",
    "development-lifecycle",
    "playtesting",
    "tool-names"
  ])
    assert.match(
      skill,
      new RegExp(String.raw`\| \`references/${reference}\.md\` \| \S`),
      reference
    );
  // Provider-specific rules live in their references, not the core every
  // provider reads.
  assert.doesNotMatch(skill, /round trip through a\s+web chat/);
  assert.doesNotMatch(skill, /INCOMPLETE_REASON_CLIENT_DISCONNECTED/);
  assert.doesNotMatch(skill, /MachPortRendezvousServer/);
  assert.ok(skill.length < 9000, `SKILL.md is ${skill.length} chars`);
  // The parent host may not list the role MCP, while the routed provider does.
  const validation = read(
    ".rulesync/skills/orchestration/references/validation.md"
  );
  assert.match(validation, /Root and child MCP capabilities can differ/);
  assert.match(
    validation,
    /do not infer exposure from root tools or\s+telemetry/
  );
  assert.match(validation, /`browser-tester` -> Playwright/);
  // The dedicated runner remains restricted to trusted Runtime context.
  assert.match(
    read(".rulesync/skills/orchestration/references/playtesting.md"),
    /Playtest requires Runtime-bound authorization/
  );
});

test("the orchestration skill tells the model to quote a spawn message so Markdown cannot break it", () => {
  // Observed 2026-09-24: a spawn message written as a template literal
  // contained `claude-opus-5-5` in backticks; the first backtick ended the
  // literal and the exec cell failed with "Unexpected identifier 'claude'".
  const prompt = read(
    ".rulesync/skills/orchestration/references/codex-code-mode.md"
  );
  assert.match(prompt, /double-quoted JavaScript string/);
  assert.match(prompt, /never as a template literal/);
});

test("the orchestrator preserves agent IDs verbatim across lifecycle calls", () => {
  const runtimeContract = read(
    ".rulesync/skills/orchestration/references/runtime-contract.md"
  );
  const normalized = runtimeContract.replaceAll(/\s+/g, " ");
  assert.match(normalized, /agent_id.*opaque handle/);
  assert.match(normalized, /complete value .* verbatim/);
  assert.match(normalized, /never abbreviate .* retype it from memory/);
  assert.match(
    normalized,
    /recover the exact handle .* verified spawn history/
  );
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
  // Runtime bridges use the package Agents contract rather than sibling source imports.
  const bridgeRoleImports: ReadonlyArray<readonly [string, RegExp]> = [
    [
      "runtime/src/providers/antigravity.ts",
      /from "@simulatorlife\/autodev-runtime\/agents"/
    ],
    [
      "runtime/src/providers/copilot.ts",
      /from "@simulatorlife\/autodev-runtime\/agents"/
    ]
  ];
  for (const [path, bridgeRoleImportPattern] of bridgeRoleImports) {
    const source = read(path);
    assert.match(source, bridgeRoleImportPattern, path);
    assert.match(source, /composeProviderPrompt\(agentRole, cwd\)/, path);
    assert.match(source, /resolveAgentRole\(request\.headers\)/, path);
    // No bridge may keep a hard-coded leaf prompt that outranks the role.
    assert.doesNotMatch(source, /const BRIDGE_INSTRUCTIONS =/, path);
  }

  const claude = read("runtime/src/providers/claude.ts");
  assert.match(claude, /resolveAgentRole\(request\.headers/);
  // Claude takes its role policy from Codex's developer instructions, like a
  // Codex-native model; a second composed copy would compete with them.
  assert.doesNotMatch(claude, /composeProviderPrompt/);
  assert.match(claude, /renderCodexContentBlocks\(payload\.input/);
});

test("the Claude bridge replaces the CLI's own system prompt and disables native settings and skills", async () => {
  const claude = read("runtime/src/providers/claude.ts");
  // Appending leaves Claude Code's default prompt in force, whose harness
  // guidance describes tools a bridged turn does not have.
  assert.doesNotMatch(claude, /--append-system-prompt/);
  assert.match(claude, /"--system-prompt", options\.systemPrompt/);
  // `--system-prompt` drops the CLI's per-machine sections, so the resolved
  // workspace has to be stated in the prompt the bridge builds.
  assert.match(claude, /Working directory: \$\{cwd\}/);
  // The bundled skill catalogue is a second, unversioned source of policy.
  assert.match(claude, /CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = "1"/);

  const { claudeCliArgs } =
    await import("@simulatorlife/autodev-runtime/providers/claude");
  const args = claudeCliArgs("sonnet", "medium", {
    systemPrompt: "custom-prompt",
    turnId: "turn-1",
    filesystem: null,
    webSearch: false
  });
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--system-prompt") + 1], "custom-prompt");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.ok(args.includes("--disable-slash-commands"));
});

test("the installer ships every shared module the bridges import", () => {
  // Derived from the sources rather than listed by hand. A shared module added
  // to a bridge but not to the installer's manifest is not a test failure --
  // it is the installed router crash-looping under launchd on
  // ERR_MODULE_NOT_FOUND, which reaches the operator as nothing more
  // informative than "Connection failed: error sending request".
  const materializer = read("runtime/src/platform/install-materializer.ts");
  const sources = [
    "runtime/src/router/server.ts",
    "runtime/src/providers/antigravity.ts",
    "runtime/src/providers/minimax.ts",
    "runtime/src/providers/copilot.ts"
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
    if (source === "runtime/src/router/server.ts") {
      for (const match of read(source).matchAll(
        /from ["']\.\/([^"']+\.ts)["']/g
      )) {
        imported.add(`runtime/src/router/${match[1]}`);
      }
    }
    if (source === "runtime/src/router/server.ts") {
      for (const match of read(source).matchAll(
        /from ["']\.\.\/([^"']+\.ts)["']/g
      )) {
        imported.add(`runtime/src/${match[1]}`);
      }
    }
  }
  assert.ok(
    imported.size >= 3,
    "expected the bridges to share several modules"
  );
  for (const asset of [
    ...imported,
    "runtime/src/mcp/tool-filter.ts",
    "agents/prompts/base.md",
    "agents/prompts/leaf.md",
    "agents/prompts/orchestrator.md",
    "agents/prompts/code-search.md"
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
  const typedHook = read("runtime/src/hooks/root-delegation.ts");
  const bootstrap = read("runtime/src/shared/root-bootstrap.ts");
  assert.match(typedHook, /buildRootOrchestratorBootstrap/);
  assert.match(
    bootstrap,
    /path\.join\(\s*repoRoot,\s*["']agents["'],\s*["']prompts["'],\s*["']orchestrator\.md["']\s*\)/
  );
  assert.match(
    bootstrap,
    /path\.join\(\s*repoRoot,\s*["']agents["'],\s*["']prompts["'],\s*["']code-search\.md["']\s*\)/
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
  assert.match(browserTester, /provider's native MCP\s+interface/i);
  assert.match(browserTester, /generic MCP-call operation/i);
  assert.match(
    browserTester,
    /absence of direct `browser_\*` declarations alone is not an exposure failure/i
  );
  assert.match(browserTester, /Remain Playwright-only/);
});

test("resolveReadOnlyFromHeaders reads the read-only header case-insensitively", async () => {
  const { resolveReadOnlyFromHeaders } =
    await import("@simulatorlife/autodev-runtime/agents");
  assert.equal(
    resolveReadOnlyFromHeaders({
      "x-autodev-read-only": "1"
    }),
    true
  );
  assert.equal(
    resolveReadOnlyFromHeaders({
      "X-Autodev-Read-Only": "0"
    }),
    false
  );
  assert.equal(resolveReadOnlyFromHeaders({}), null);
  assert.equal(resolveReadOnlyFromHeaders(null), null);
  // Unknown values are ignored.
  assert.equal(
    resolveReadOnlyFromHeaders({
      "x-autodev-read-only": "full-access"
    }),
    null
  );
});

test("resolveSkillContextFromHeaders returns the propagated skill body", async () => {
  const { resolveSkillContextFromHeaders } =
    await import("@simulatorlife/autodev-runtime/agents");
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

test("the orchestrator's inlined skill names the installed directory its references resolve against", () => {
  const orchestrator = roleInstructions("orchestrator");
  assert.ok(
    orchestrator.includes(
      `Installed at ${installedOrchestration}; resolve its relative \`references/\``
    )
  );
  const references = Array.from(
    orchestrator.matchAll(/`(references\/[^`]+\.md)`/g),
    (match) => match[1]!
  );
  assert.ok(references.length > 0, "the inlined skill names its references");
  for (const reference of references)
    assert.ok(existsSync(join(installedOrchestration, reference)), reference);
});

test("code and orchestration prompts surface the macOS Seatbelt MachPortRendezvousServer browser recovery path", () => {
  for (const instructions of [
    composeProviderPrompt("worker", "/tmp/workspace"),
    composeProviderPrompt("validator", "/tmp/workspace"),
    roleInstructions(ORCHESTRATOR_AGENT_ROLE)
  ]) {
    assert.match(instructions, /MachPortRendezvousServer/);
    assert.match(instructions, /playwright\.config\.\*/);
    assert.match(instructions, /single-process/i);
  }
});

test("mid-turn steering keeps the active turn intact across renderCodexTranscript, Antigravity, Copilot, and Claude", () => {
  const input = [
    { type: "message", role: "user", content: "Build feature X" },
    { type: "message", role: "assistant", content: "Inspecting code first." },
    {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_steer_1",
      input: "rg -n featureX src/"
    },
    {
      type: "custom_tool_call_output",
      call_id: "call_steer_1",
      output: "src/x.ts:1: export const x = 1;"
    },
    { type: "message", role: "user", content: "Wait, also check Y." }
  ];

  const transcript = renderCodexTranscript(input);
  assert.doesNotMatch(transcript, /<conversation_history/);
  assert.match(transcript, /<user>\nBuild feature X\n<\/user>/);
  assert.match(transcript, /call_steer_1/);
  assert.match(
    transcript,
    /<mid_turn_steer>\nWait, also check Y\.\n<\/mid_turn_steer>/
  );

  const agyPrompt = promptFromInput(input, "sys");
  const copilotPrompt = inputText(input, "sys");
  const claudeBlocks = renderCodexContentBlocks(input);
  assert.match(
    agyPrompt,
    /<mid_turn_steer>\nWait, also check Y\.\n<\/mid_turn_steer>/
  );
  assert.match(
    copilotPrompt,
    /<mid_turn_steer>\nWait, also check Y\.\n<\/mid_turn_steer>/
  );
  assert.equal(claudeBlocks[0]?.type, "text");
  if (claudeBlocks[0]?.type === "text") {
    assert.equal(claudeBlocks[0].text, transcript);
  }
});

test("follow-up framing bounds oversized older replies and providerHop elides earlier active-turn tools", () => {
  const longOlderReply = "A".repeat(2000);
  const input = [
    { type: "message", role: "user", content: "Old task 1" },
    { type: "message", role: "assistant", content: longOlderReply },
    { type: "message", role: "user", content: "Old task 2" },
    {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_old_2",
      input: "echo old2"
    },
    {
      type: "custom_tool_call_output",
      call_id: "call_old_2",
      output: "old2-output"
    },
    { type: "message", role: "assistant", content: "Task 2 summary." },
    { type: "message", role: "user", content: "Follow up on Task 2" },
    {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_cur_1",
      input: "1"
    },
    { type: "custom_tool_call_output", call_id: "call_cur_1", output: "out1" },
    {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_cur_2",
      input: "2"
    },
    { type: "custom_tool_call_output", call_id: "call_cur_2", output: "out2" },
    {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_cur_3",
      input: "3"
    },
    { type: "custom_tool_call_output", call_id: "call_cur_3", output: "out3" }
  ];

  const normal = renderCodexTranscript(input);
  assert.match(normal, /Use them as context for follow-ups/);
  assert.match(normal, /\[\.\.\. 750 chars of earlier reply omitted \.\.\.\]/);
  assert.match(normal, /<assistant>\nTask 2 summary\.\n<\/assistant>/);
  assert.match(normal, /call_cur_1/);
  assert.match(normal, /call_cur_3/);

  const hopped = renderCodexTranscript(input, { providerHop: true });
  assert.match(
    hopped,
    /\[earlier current-turn tool activity omitted: 1 call\(s\), 1 output\(s\)\]/
  );
  assert.doesNotMatch(hopped, /call_cur_1/);
  assert.match(hopped, /call_cur_2/);
  assert.match(hopped, /call_cur_3/);
  assert.match(
    promptFromInput(input, "sys", { providerHop: true }),
    /\[earlier current-turn tool activity omitted: 1 call\(s\), 1 output\(s\)\]/
  );
  assert.match(
    inputText(input, "sys", { providerHop: true }),
    /\[earlier current-turn tool activity omitted: 1 call\(s\), 1 output\(s\)\]/
  );
});

test("elidePriorTurnsForNativePayload strips prior tool pairs while keeping call_id pairing in active tail", () => {
  const input = [
    { type: "message", role: "user", content: "Old task" },
    { type: "function_call", call_id: "c_old", name: "exec", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "c_old",
      output: "huge old output"
    },
    { type: "message", role: "assistant", content: "Old task complete." },
    { type: "message", role: "user", content: "New task" },
    { type: "function_call", call_id: "c_1", name: "exec", arguments: "{}" },
    { type: "function_call_output", call_id: "c_1", output: "out1" },
    { type: "function_call", call_id: "c_2", name: "exec", arguments: "{}" },
    { type: "function_call_output", call_id: "c_2", output: "out2" },
    { type: "function_call", call_id: "c_3", name: "exec", arguments: "{}" },
    { type: "function_call_output", call_id: "c_3", output: "out3" }
  ];
  const compacted = elidePriorTurnsForNativePayload(input) as Array<
    Record<string, unknown>
  >;
  const serialized = JSON.stringify(compacted);
  assert.doesNotMatch(serialized, /c_old/);
  assert.doesNotMatch(serialized, /huge old output/);
  assert.match(
    serialized,
    /prior tool activity omitted: 1 call\(s\), 1 output\(s\)/
  );
  assert.doesNotMatch(serialized, /c_1/);
  assert.match(serialized, /c_2/);
  assert.match(serialized, /c_3/);
  // Every retained function_call_output has its matching function_call.
  const calls = new Set(
    compacted.filter((i) => i.type === "function_call").map((i) => i.call_id)
  );
  for (const out of compacted.filter(
    (i) => i.type === "function_call_output"
  )) {
    assert.ok(
      calls.has(out.call_id),
      `missing call for ${String(out.call_id)}`
    );
  }
});

test("codex-code-mode documents target/targets parameters for agent lifecycle calls", () => {
  const codexCodeMode = read(
    ".rulesync/skills/orchestration/references/codex-code-mode.md"
  );
  assert.match(codexCodeMode, /multi_agent_v1__send_input\(\{\s*target:/);
  assert.match(codexCodeMode, /multi_agent_v1__wait_agent\(\{\s*targets:/);
  assert.match(codexCodeMode, /multi_agent_v1__close_agent\(\{\s*target:/);
});
