# Antigravity as a Codex-driven model backend

> Target-state recommendation and migration plan for simplifying the AutoDev Antigravity integration while preserving subscription authentication through `agy`

## Executive decision

Move Antigravity toward the same architectural boundary already used by the Claude bridge:

```text
Codex owns agency
  -> tools
  -> MCP
  -> skills
  -> sandbox and approvals
  -> hooks
  -> subagents
  -> thread history
  -> canonical tool/subagent telemetry

Antigravity supplies model reasoning
  -> requests Codex-owned tools
  -> receives their results
  -> continues reasoning
```

Keep the `agy` CLI only as the subscription-authenticated model transport unless a simpler supported transport later reaches parity

Do **not** complete this migration by merely adding Codex tools alongside Antigravity's native workspace-affecting tools. The migration is successful only when a bridged Antigravity turn cannot bypass the Codex tool boundary

The current Antigravity `codex-shim` delegation path is the first slice of this target architecture, not the final state

---

## Why change the current design

AutoDev's platform rule is that Codex is the agent runtime. Provider bridges should adapt model transport rather than create a second agent harness

The Claude bridge already implements this cleanly:

```text
Claude model
   |
   | requests one of the tools Codex offered
   v
Claude bridge
   |
   | emits Responses tool call
   v
Codex
   |
   | sandbox / approval / hooks / execution
   v
tool result
   |
   v
parked Claude turn resumes
```

Antigravity still executes much more inside the `agy` runtime. This forces the bridge to reconstruct facts that Codex would otherwise know directly, including:

- Tool request and completion state
- MCP server attribution
- Skill-file reads
- Permission denials
- Native delegation state
- Pending child lifetime
- Provider-specific tool event shapes

That reconstruction is both provider-specific and fragile. `src/providers/antigravity.ts` already tolerates multiple historical `stream-json` shapes because tool output and subagent argument locations have changed between `agy` versions

A Codex-driven tool loop would make the Codex Responses boundary authoritative instead of inferring equivalent state from Antigravity events

---

## Current AutoDev state

The repository is already partway through this transition

### Codex-owned delegation

`config/execution-contract.json` currently declares:

```json
"antigravity": {
  "spawnTools": ["invoke_subagent"],
  "permissionMode": "configured",
  "delegation": "codex-shim"
}
```

The `autodev_spawn` MCP shim lets an Antigravity orchestrator request delegation while the bridge converts that request into a synthetic Codex `exec` call. Codex then executes `multi_agent_v1__spawn_agent`, creating real Codex child threads

Relevant implementation:

- `src/agents/bridge-spawn-session.ts`
- `src/agents/spawn-tools.ts`
- `src/mcp/spawn-shim.ts`
- `.rulesync/mcp.jsonc`
- `src/providers/antigravity.ts`

This is preferable to an `agy`-native child because the child becomes a real Codex session, is visible in the app, routes through AutoDev normally, and inherits the same lifecycle/accounting semantics as other Codex subagents

### Remaining native Antigravity agency

The ordinary Antigravity turn still runs through `agy` as an agent runtime. Native Antigravity tools execute inside that process rather than through Codex

Consequences include:

- AutoDev must observe `step_update` events to recover tool telemetry
- AutoDev must parse successful skill reads because Codex hooks never see native `agy` file access
- Antigravity's global MCP registry prevents clean per-role MCP isolation
- `browser-tester` is currently rejected on Antigravity because global Playwright registration would expose it to roles that must not have it
- Read-only and write-capable roles require Antigravity-specific sandbox and permission handling
- Native subagent lifecycle historically required bridge-side tracking because the child was invisible to Codex

These are symptoms of two agent runtimes sharing ownership

---

## Verified Antigravity control surfaces

The recommendation depends on whether `agy` can be constrained enough to behave as a model backend rather than an independent execution harness

Current Antigravity documentation provides three relevant mechanisms

### 1. Custom-agent tool allowlists

Antigravity custom agents support YAML frontmatter including:

```yaml
name: autodev-bridge
description: Model backend for AutoDev
tools: []
mainAgent: true
subagent: false
model: inherit
commandExecutionPolicy: sandbox
mcpServers: []
skills: []
```

The documented `tools` field is an explicit list of tools permitted for the custom agent

`mainAgent: true` allows the custom agent to be selected as the primary agent, including through `agy --agent <name>`

`subagent: false` means that custom agent cannot itself be invoked through `invoke_subagent`; it does **not** by itself prevent the primary agent from spawning another subagent

The tool allowlist is therefore the important boundary

**Migration assumption to verify:** when a custom agent is selected as the primary `agy` agent, its `tools` allowlist is also the effective primary-agent tool inventory. The current docs and custom-agent execution model indicate this should be true, but AutoDev must verify it against the installed `agy` version before relying on it as a security boundary

### 2. `PreToolUse` hooks

Antigravity hooks can match tool calls before execution and return a hard `deny` decision

This can provide defense in depth for tools that must never execute inside `agy`, for example:

```text
invoke_subagent
define_subagent
manage_subagents
send_message
run_command
write/edit tools
unapproved MCP tools
```

A hook is an execution-time gate, not a replacement for removing the tool from the model's inventory. Prefer non-exposure through the custom-agent `tools` allowlist, with a denying hook as a backstop

AutoDev already manages `preToolUse` hooks through `.rulesync/hooks.jsonc`, so this does not require a new configuration mechanism

### 3. Fine-grained permissions

Antigravity CLI supports Allow / Ask / Deny rules for documented permission resources such as:

```text
read_file(...)
write_file(...)
read_url(...)
execute_url(...)
command(...)
unsandboxed(...)
mcp(...)
```

These permissions are useful for filesystem, shell, web, and MCP safety but are **not the primary solution for native subagent tools**

The documented permission resource vocabulary does not currently include `invoke_subagent`, `define_subagent`, or a generic subagent action

Do not assume an unsupported entry such as `invoke_subagent(*)` is an enforceable permission rule

---

## Rulesync fit

Rulesync now supports the Antigravity surfaces needed for this design

Its current Antigravity custom-agent schema understands:

```text
tools
mainAgent
subagent
model
commandExecutionPolicy
mcpServers
skills
plugins
```

Rulesync also supports Antigravity CLI permissions and hooks

AutoDev currently enables only:

```json
"features": [
  "skills",
  "hooks"
]
```

and `tests/rulesync-permissions-inventory.test.ts` intentionally asserts that Rulesync `permissions` and `subagents` generation remain disabled

The target should evaluate enabling the relevant Rulesync features rather than adding another hand-maintained Antigravity configuration path

Desired ownership:

```text
AutoDev role/capability intent
        |
        v
Rulesync canonical configuration
        |
        +--> Antigravity custom main agent
        +--> Antigravity hooks
        +--> Antigravity permissions
        +--> shared skills/MCP declarations where applicable
```

AutoDev should continue owning role semantics. Rulesync should translate those semantics into provider-native configuration where it can do so faithfully

---

## Target Antigravity boundary

The preferred steady state is:

```text
Codex CLI / Desktop
        |
        v
AutoDev router
        |
        v
Antigravity Responses bridge
        |
        v
agy --agent autodev-bridge
        |
        +--> model reasoning
        +--> optional provider-native web research
        |
        '--> session-scoped Codex tool shim
                  |
                  v
              Codex tools
                  |
                  +--> filesystem / shell
                  +--> MCP
                  +--> skills through normal Codex paths
                  +--> subagents
                  +--> browser tools when role allows
```

### Native Antigravity capabilities to retain

Keep a native capability only when Codex cannot provide an equivalent through the bridged tool surface

The expected exceptions are:

- `search_web`
- `read_url_content`

This mirrors the Claude bridge, which retains provider-native web research only because Codex's hosted web search cannot be driven as an ordinary bridged tool call

Every other native capability should require a demonstrated reason to remain

### Native capabilities to remove from the ordinary bridged surface

The target custom main agent should not expose:

- Native shell execution
- Native workspace mutation
- Native file inspection when the same read can be performed by Codex
- Native arbitrary MCP access
- Native subagent creation or management
- Provider-specific tool surfaces duplicating a Codex-owned capability

The exact list must be generated from observed `agy` tool inventory rather than hard-coded from assumptions

---

## Capability verification

Antigravity headless `stream-json` begins with an `init` event whose `tools` array contains the names of all tools available to that run

Use this as the authoritative migration probe

A pilot must launch the proposed custom main agent and assert that `init.tools` contains only the intended native capabilities plus the AutoDev bridge surface

At minimum verify absence of:

```text
invoke_subagent
define_subagent
manage_subagents
send_message
run_command
write/edit tools
unexpected MCP tools
```

and verify presence of each intentionally retained native tool

Do not infer success because the model happened not to call a forbidden tool

---

## The remaining hard problem: synchronous tool continuation

Tool exposure is only one half of the Claude-style architecture

The model must also be able to request a Codex tool, wait for its result, and continue the **same reasoning turn**

Claude currently does this by parking the CLI process:

```text
Claude requests tool
        |
bridge emits Responses tool call
        |
Codex executes tool
        |
next Responses request contains tool result
        |
bridge finds parked Claude turn
        |
MCP call resolves
        |
Claude continues
```

The current Antigravity spawn shim does not prove this general mechanism because delegation is deliberately dispatched rather than awaited. The bridge can collect the spawn request and emit a synthetic `exec` call after the `agy` turn finishes

That works for:

```text
delegate -> end turn
```

It does not solve:

```text
read file -> inspect result -> run command -> inspect result -> edit -> continue
```

A full migration therefore requires an Antigravity continuation design

### Preferred continuation approach

First test whether current `agy` stream-json interactive mode can support a bridge-owned request/result loop without restarting the model context

The CLI supports a long-lived process with:

```text
--input-format stream-json
--output-format stream-json
```

and documents sending additional user events over stdin while retaining one `conversation_id`

Determine whether a session-scoped MCP call can remain pending while the bridge:

1. Emits the corresponding Responses tool call to Codex
2. Ends or suspends the current Responses exchange without terminating `agy`
3. Receives the Codex tool output on the continuation request
4. Resolves the pending MCP call or otherwise injects its result into the same Antigravity session
5. Lets `agy` continue naturally

If Antigravity cannot support this safely, do not fake a synchronous loop by replaying guessed context or silently executing native tools

---

## Shared bridge implementation

Do not create an independent second implementation of the Claude machinery if the underlying abstractions are reusable

Prefer extracting provider-neutral components from:

- `src/providers/claude-codex-tools.ts`
- `src/providers/claude-turn.ts`
- `src/shared/responses-continuation.ts`

Candidate shared responsibilities:

```text
Codex tool-surface parsing
MCP tool-definition adaptation
Responses tool-call item construction
tool-call/result correlation
parked turn registry
continuation result matching
keepalive and cancellation semantics
tool telemetry emitted from canonical Codex results
```

Provider adapters should own only provider-specific process/session transport and event parsing

---

## Phased implementation

### Phase 0 — freeze and measure

Before behavior changes:

- Capture the current Antigravity Responses contract
- Capture default and proposed custom-agent `init.tools`
- Capture tool names and MCP exposure for each AutoDev role
- Capture current delegation behavior and child visibility
- Capture existing provider/tool/skill/subagent telemetry projections
- Record the installed `agy` version used for validation

Exit condition: the before-state is reproducible without depending on model choice

### Phase 1 — custom main-agent pilot

Create an AutoDev Antigravity custom main agent with:

```yaml
mainAgent: true
subagent: false
tools:
  # minimal deliberate allowlist only
```

Run it with `agy --agent <generated-name>`

Validate through `init.tools` that forbidden native tools are genuinely absent

Add a `PreToolUse` deny hook for forbidden workspace/subagent tools as defense in depth

Exit condition: a bridge run cannot execute a forbidden native action even when directly prompted to do so

### Phase 2 — make Codex delegation canonical

Keep the existing `autodev_spawn` -> synthetic Codex `exec` -> `multi_agent_v1__spawn_agent` path

Remove or disable fallback to Antigravity-native children after parity is established

Update stale documentation that still describes Antigravity as `bridge-native` when the generated execution contract says `codex-shim`

Exit condition: all AutoDev Antigravity child agents are real Codex child threads

### Phase 3 — general Codex tool loop

Generalize the session-scoped shim so Antigravity can request any tool Codex offered for the turn

Implement the continuation lifecycle using shared bridge primitives where possible

Validate sequential and multi-step calls, including:

- Read -> reason -> second read
- Read -> shell -> reason
- MCP -> result -> follow-up MCP
- Tool failure -> model recovery
- User steering while a tool is running
- Cancellation while parked
- Provider timeout while parked
- Multiple tool calls in one model message if supported

Exit condition: Antigravity can complete normal coding turns without native file/shell/MCP execution

### Phase 4 — move role enforcement to Codex

Once all workspace actions pass through Codex:

- Remove Antigravity-specific read-only sandbox branching where redundant
- Let Codex role TOMLs determine filesystem/sandbox behavior
- Let Codex tool/MCP exposure determine role capabilities
- Re-enable Antigravity for roles previously blocked only by global MCP isolation, including `browser-tester`, after explicit parity tests

Exit condition: changing providers does not change which role capabilities the agent can exercise

### Phase 5 — simplify telemetry and bridge code

After canonical Codex execution is proven, remove reconstruction paths that have become redundant

Likely removal candidates include:

- Native Antigravity tool observer logic
- Shell-command parsing used only to infer skill reads
- Native MCP attribution reconstruction
- Native delegation child tracking
- Permission-denial interpretation that duplicates Codex execution results
- `subagent_wait` handling needed only for `agy`-owned children

Retain provider process/limit/error telemetry that Codex cannot observe

Exit condition: the Antigravity bridge reports provider transport facts, while Codex/AutoDev owns action semantics

---

## Migration gates

Do not retire a current behavior until the replacement proves all applicable properties

| Gate | Required result |
| --- | --- |
| Tool isolation | Forbidden native tools absent from `init.tools` and hard-blocked by hook backstop |
| Tool fidelity | Codex custom/function/freeform tools retain exact names, schemas, arguments, IDs, and outputs |
| Continuation | Tool call -> result -> continued model reasoning works without lost context |
| Permissions | Codex remains the sole effective sandbox/approval boundary for bridged actions |
| MCP isolation | Role-specific MCP exposure matches Codex role policy |
| Skills | Skill visibility and usage semantics match native Codex expectations |
| Delegation | Children are Codex sessions using canonical role aliases |
| Browser role | Playwright is exposed only where the Codex role permits it |
| Telemetry | Tool/skill/MCP/subagent metrics retain or improve current attribution |
| Failure handling | Cancellation, timeout, provider limits, permission denial, and disconnects preserve current error semantics |
| Privacy | Prompts, tool arguments, outputs, credentials, and absolute paths are not newly exported through telemetry |
| Upgrade safety | Tool inventory validation fails closed when a new `agy` release changes the expected surface |

---

## Non-goals

| Non-goal | Instead |
| --- | --- |
| Removing `agy` immediately | Keep it for subscription authentication/model transport until a supported replacement proves parity |
| Running Codex tools and native Antigravity equivalents side by side permanently | Establish one owner for each capability, preferring Codex |
| Reimplementing Antigravity's entire agent runtime in AutoDev | Use only the minimal bridge needed to expose the model through Codex |
| Treating prompt rules as a security boundary | Remove tools from the inventory and use hard hooks/permissions as backstops |
| Inventing unsupported Antigravity permission resources | Use documented permission actions only |
| Moving AutoDev role semantics into Rulesync | Keep semantics in AutoDev and use Rulesync for portable translation |
| Adding provider-specific telemetry for data Codex already observes canonically | Prefer Codex/OTel evidence and retain bridge telemetry only for provider-internal facts |
| Replacing native web research without an equivalent Codex execution path | Keep narrow provider-native exceptions when necessary |

---

## Expected deletions and simplification

If the target state is achieved, the Antigravity adapter should converge toward the same conceptual size and responsibility as the Claude adapter rather than remaining a second runtime integration

The bridge should primarily own:

```text
subscription-authenticated agy process/session lifecycle
model and reasoning selection
Responses translation
provider-native web exception
provider error / rate-limit classification
Codex tool-loop transport
```

It should not own:

```text
workspace mutation semantics
role-specific filesystem permissions
role-specific MCP authorization
skill-read inference
subagent lifecycle semantics
generic tool execution telemetry
parallel agent runtime policy
```

---

## Rollback

Keep the current Antigravity bridge path available until each migration gate is proven against real `agy` traffic

Each phase should be independently reversible

Do not delete native compatibility logic in the same change that first introduces its replacement unless the replacement has already been exercised against the frozen contract

The final switch should be an explicit execution-mode change, not an accidental consequence of generated configuration

---

## Open questions to resolve during the pilot

- Does a custom agent's `tools` allowlist remain authoritative when that agent is selected as the primary agent through `agy --agent`
- Can the custom main agent expose only the session-scoped AutoDev MCP shim plus selected native web tools
- Does `agy` expose any non-tool execution path that can mutate the workspace despite the custom-agent allowlist
- Can interactive stream-json support a pending MCP call across a Responses continuation cleanly
- Can one `agy` process remain parked without its own timeout or client lifecycle conflicting with Codex's continuation lifecycle
- Can the Claude parked-turn implementation be generalized without provider-specific conditionals dominating the shared abstraction
- Which current Antigravity telemetry paths become provably redundant once Codex executes every action
- Can Rulesync become the canonical generator for the custom main agent and Antigravity permissions without weakening AutoDev's existing role contract
- Which provider-native web capabilities must remain after the Codex tool loop is available

---

## Documentation cleanup required with implementation

The current repository contains transitional terminology

`config/execution-contract.json` identifies Antigravity delegation as `codex-shim`, while portions of `docs/provider-routing.md` still describe Antigravity as `bridge-native`

As implementation phases land, update the canonical routing documentation so it describes the actual execution path rather than preserving the historical model

Do not update those statements speculatively before the corresponding runtime behavior is proven

---

## Target-state invariant

The migration is complete when changing the selected model provider does not change who owns the agent's actions:

```text
OpenAI/Codex ----Claude -----------Antigravity -------+--> Codex agent harness --> tools / MCP / skills / subagents
Copilot -----------/
MiniMax ----------/
```

Provider bridges may retain transport-specific capabilities that cannot be represented through Codex, but **Codex remains the single owner of agency**

---

## References

AutoDev:

- `src/providers/antigravity.ts`
- `src/providers/claude.ts`
- `src/providers/claude-codex-tools.ts`
- `src/providers/claude-turn.ts`
- `src/agents/bridge-spawn-session.ts`
- `src/agents/spawn-tools.ts`
- `src/platform/antigravity-settings.ts`
- `config/execution-contract.json`
- `.rulesync/hooks.jsonc`
- `.rulesync/mcp.jsonc`
- `rulesync.jsonc`
- `docs/provider-routing.md`
- `docs/AUTODEV_PLATFORM_MIGRATION.md`

Upstream:

- Antigravity custom agents: https://antigravity.google/docs/subagents?tab=cli
- Antigravity CLI headless/stream-json: https://antigravity.google/docs/cli/headless/
- Antigravity hooks: https://antigravity.google/docs/hooks
- Antigravity permissions: https://antigravity.google/docs/permissions?tab=cli
- Antigravity CLI reference: https://antigravity.google/docs/cli/reference/
- Rulesync Antigravity custom-agent implementation: https://github.com/dyoshikawa/rulesync/blob/main/src/features/subagents/antigravity-shared-subagent.ts
- Rulesync Antigravity CLI permissions implementation: https://github.com/dyoshikawa/rulesync/blob/main/src/features/permissions/antigravity-cli-permissions.ts
