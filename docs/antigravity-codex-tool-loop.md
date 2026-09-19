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

## Continuation: prefer explicit Antigravity conversation resumption

A Codex-driven tool loop still needs the model to request a Codex tool, receive its result, and continue reasoning with the prior context

Current `agy` already exposes the core continuation primitive needed for this:

```text
--conversation <conversation-id>
```

Headless `stream-json` emits a `conversation_id` in the `init` event and terminal result. Antigravity documents that `--conversation <id>` starts a new process while resuming that specific prior conversation

This makes explicit conversation resumption the **preferred first correctness prototype**. AutoDev should not begin by cloning Claude's parked-process lifecycle, but it also should not assume process-per-tool resumption is the final steady-state transport until its token cost and latency are measured

### Preferred request/result loop

```text
Codex request
    |
    v
agy -p <turn> --agent autodev-bridge --output-format stream-json
    |
    +--> capture conversation_id = A
    |
    +--> model calls session-scoped AutoDev/Codex shim
    |
    v
shim records structured requested Codex tool call
    |
    +--> tells agy the request was dispatched and this turn should end
    |
    v
bridge emits the actual Responses tool call to Codex
    |
    v
Codex executes the tool
    |
    v
next /v1/responses carries *_tool_call_output
    |
    v
agy -p <structured tool result + continue instruction>
    --conversation A
    --agent autodev-bridge
    --output-format stream-json
    |
    v
same Antigravity conversation continues
```

The bridge should persist the exact Antigravity `conversation_id` against the Codex turn/conversation identity and the pending Codex call IDs needed to correlate continuation results

Use `--conversation <id>`, not `--continue`, because AutoDev must resume the exact conversation associated with the Codex turn rather than whichever Antigravity conversation happens to be most recent in the workspace

### Important semantic limitation

`--conversation` solves **model-context continuity**, but current Antigravity headless input documentation exposes ordinary user input rather than an OpenAI-style native `function_call_output` / `custom_tool_call_output` input event

Therefore the initial implementation will likely reintroduce the Codex result as a deterministic structured continuation message, for example:

```text
Codex tool result
call_id: call_123
tool: exec
status: success

<result>
...
</result>

Continue from the pending tool request
```

The tool request itself must remain structured through the session-scoped bridge/MCP shim. Do not parse tool requests from model prose

This result-injection difference is a behavior to validate, not a reason to assume conversation resumption is inadequate

### Continuation efficiency is an explicit migration gate

The external `yuting0624/antigravity-for-claude-code` project already exercises `agy` continuation in production-style headless delegation and records a useful warning: continuation preserves state, but it is not necessarily cheap

That project originally recommended `--continue` as a cost-saving way to keep working context on the Antigravity side, then retracted the recommendation after measuring a repeated-corpus case. Its recorded sample was small (`n=2`), but the continued calls cost **+82% / +277%** versus fresh calls and showed **3–14x higher `cache_read`**, because prior conversation state was carried forward while task material was still re-read

Do **not** transfer those percentages directly to AutoDev:

- The measurement used `--continue`, not AutoDev's proposed exact-ID `--conversation <id>`
- It measured coarse delegated tasks, not a Codex tool-result loop
- The sample size was deliberately small and should be treated as a warning signal, not a general performance law

However, both mechanisms resume persisted Antigravity conversation state, so AutoDev must treat context re-ingestion as a plausible steady-state cost

Before choosing the final continuation transport, benchmark the same multi-tool workload under:

| Variant | Mechanism |
| --- | --- |
| A | New `agy` process for each result using exact `--conversation <id>` |
| B | One long-lived `--input-format stream-json` process |
| C | One parked synchronous MCP/tool call resolved after Codex returns the result |

Measure at minimum:

```text
input_tokens
cache_read_tokens
output_tokens
thinking_tokens
duration_seconds
num_turns
wall-clock latency
tool/result correctness
repeated-call rate
cancellation/recovery behavior
```

Choose the steady-state mechanism from measured correctness, cost, latency, and lifecycle complexity. Simplicity alone is not enough

### Validation for conversation resumption

Before building a more complex continuation runtime, prove the exact-ID path against the installed `agy` version:

1. Start a custom AutoDev main-agent turn and force one structured shim tool request
2. Capture the emitted `conversation_id`
3. End that `agy` turn after the request has been handed to Codex
4. Simulate a successful Codex tool result
5. Launch `agy --conversation <id>` with the structured result
6. Verify the model associates the result with the pending request and continues rather than repeating the request
7. Repeat with several sequential tool calls
8. Repeat with tool errors, denied calls, large outputs, and user steering between calls
9. Inspect every resumed `init` event and verify the expected custom agent and restricted `tools` inventory remain in force
10. Verify a bridge restart can recover the mapping when the Antigravity conversation ID and pending call metadata have been persisted
11. Capture `input_tokens`, `cache_read_tokens`, `output_tokens`, `thinking_tokens`, `duration_seconds`, and `num_turns` for every resumed turn
12. Run the same representative multi-tool workload through variants A/B/C above before selecting the production continuation transport

Do not rely on conversation history alone to preserve the security boundary. Resumed runs must continue to prove the expected tool inventory

### Alternative continuation designs

Start with exact-ID resumption because it is the simplest correctness probe. Move to another mechanism if it materially improves fidelity, latency, token/cache-read cost, cancellation, or recovery enough to justify the added lifecycle complexity

**Alternative B — long-lived stream-json process**

Antigravity supports:

```text
--input-format stream-json
--output-format stream-json
```

which maintains one continuous process/conversation and accepts one user event per turn over stdin. This can avoid process startup overhead and may simplify repeated tool-result injection, but introduces a live process lifecycle that AutoDev must own

**Alternative C — parked synchronous MCP call**

Keep the `agy` process and MCP call blocked while Codex executes the tool, then resolve that exact pending call with the result. This most closely resembles Claude's current bridge but is also the highest-complexity option and should be justified by a concrete fidelity problem with the simpler designs

### Why this differs from Claude

Claude's current bridge keeps a CLI process parked because that adapter already has a synchronous MCP-to-Codex continuation mechanism

Antigravity provides durable conversation IDs and explicit `--conversation` resumption, so its cleanest implementation may instead allow each `agy` process to finish and use Antigravity's own persisted conversation as the model-context store

If validated, that avoids:

```text
long-lived parked CLI processes
park timers
process registries solely for context preservation
keeping one provider process alive while Codex executes an arbitrary tool
```

The architecture should share Responses/tool-surface adaptation with Claude without forcing both providers to share the same process-lifetime strategy

---

## Lessons from `antigravity-for-claude-code`

Reference implementation inspected: `yuting0624/antigravity-for-claude-code` at commit `088b7db8a58b611a5eb6e87995f885f0a1121c94` (2026-09-19)

Its top-level architecture is intentionally different from AutoDev's target:

```text
antigravity-for-claude-code

Claude conductor
    |
    +--> Bash wrapper
             |
             '--> agy as a separate autonomous executor
                    +--> native files/shell
                    +--> native MCP
                    '--> native subagents


AutoDev target

Codex agent harness
    |
    '--> Antigravity bridge
             |
             '--> agy as model/session transport
                    '--> requests Codex-owned actions
```

Do **not** copy its conductor/executor ownership model. Its useful contribution is the operational evidence it has accumulated around headless `agy`

### Structured failure normalization

Prefer structured Antigravity fields over stderr pattern matching

The reference wrapper has observed newer `agy` releases return permission denials with:

```json
{
  "status": "SUCCESS",
  "response": "",
  "denied_actions": [
    {
      "action": "write_file",
      "display_name": "WriteToFile"
    }
  ]
}
```

while the process can still exit successfully

AutoDev's current bridge primarily derives permission denial from stderr. The target adapter should instead classify in this order:

```text
1. structured denied_actions
2. structured status / error
3. exit code / signal
4. stderr compatibility patterns
```

Keep stderr parsing only as a version-compatibility fallback

### Partial timeout must not become success

The reference project measured `agy` releases where `--print-timeout` can expire mid-turn and still produce:

```text
process exit = 0
status = SUCCESS
response = partial non-empty text
usage counters = 0
stderr = "print timeout after ... returning partial output"
```

AutoDev must not convert that shape into a completed Responses turn

Until Antigravity exposes a structured partial/incomplete field, detect the provider timeout diagnostic separately from model output, preserve any partial text as incomplete output where useful, and classify the turn as timeout/incomplete rather than success

Never scan model-generated response text for failure trigger strings

### Use an independent outer process deadline

Do not rely only on `--print-timeout`

The reference wrapper has encountered headless startup/MCP/TTY hangs that occur outside the normal turn timeout path, so it adds a second wall-clock guard around the child process

AutoDev should have three distinguishable deadlines:

```text
agy --print-timeout
bridge child-process hard deadline
router/request deadline
```

Each should produce a distinct diagnostic so a provider timeout, process hang, and client/router cancellation are not collapsed into one failure class

### Preserve Antigravity-native usage and identity fields

Capture and retain these provider observations when available:

```text
conversation_id
input_tokens
output_tokens
thinking_tokens
cache_read_tokens
total_tokens
duration_seconds
num_turns
model
```

Use `conversation_id` for state/log/trace correlation, never as a metric dimension

Keep provider-native usage alongside canonical Codex tool/action telemetry; they describe different layers

### Use trajectory logs as pilot evidence, not production truth

The reference project joins `conversation_id` to Antigravity's readable trajectory:

```text
~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl
```

Use this during the migration pilot to independently verify:

- Which native tools actually ran
- Whether a forbidden tool escaped the custom-agent allowlist
- Whether a resumed conversation repeated a requested action
- Whether an overall SUCCESS hid failed internal operations

Do not make the trajectory file a production semantic dependency. The canonical target remains Codex/Responses evidence for actions, with Antigravity logs used for provider debugging

### Version and capability discipline

The reference project documents multiple incompatible historical shapes for permission denials, model selection, timeout behavior, stream output, and inherited file descriptors

AutoDev should prefer a **minimum supported and tested `agy` version** plus explicit capability/startup probes over carrying every historical compatibility branch indefinitely

At startup or installation, validate at least:

```text
required --output-format support
required --conversation support
custom-agent support
expected init.tools behavior
structured denied_actions availability if required
supported model
installed agy version
```

Fail closed or disable Antigravity routing when a required capability is absent

### Test the inherited-stdout/MCP issue before copying its workaround

The reference project found older `agy` versions could leave stdio MCP children holding the parent's stdout file descriptor, causing pipe-based callers to wait forever after `agy` exited. It routes stdout through a temporary file for backward compatibility and records that upstream fixed the underlying behavior in later `agy`

AutoDev needs live `stream-json` output, so do not replace streaming with temporary files merely to copy that workaround

Instead:

- Reproduce the issue against AutoDev's minimum supported `agy`
- Require a fixed version if practical
- Add explicit process/MCP lifecycle handling only if the supported version still demonstrates the problem

### What not to adapt

Do not adopt these reference-project patterns into the target bridge:

- A separate autonomous `agy` executor with native filesystem/shell/MCP ownership
- Native Antigravity subagents
- Shell command parsing as the model-to-Codex tool protocol
- `--dangerously-skip-permissions` as the normal bridged execution boundary
- Digest/cost-routing policy as provider infrastructure
- Claude-specific background delegation jobs

AutoDev can use a structured session-scoped MCP/tool shim and therefore should not inherit the shell-parser security machinery required by that project

If AutoDev copies substantial implementation code rather than reimplementing the ideas, preserve the upstream MIT license and copyright notice as required by that repository's license

---

## Shared bridge implementation

Reuse Claude bridge machinery where the protocol abstractions are genuinely shared, but do not force Antigravity to inherit Claude's parked-process lifecycle when `--conversation` provides a simpler provider-native continuation primitive

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
provider-neutral continuation result matching
Codex call/result correlation
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
- Capture structured `denied_actions`, timeout, partial-output, usage, and conversation-ID behavior for the supported `agy` version
- Record the provider trajectory path for pilot-only auditing by `conversation_id`

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

Implement exact Antigravity conversation resumption first as the simplest correctness prototype:

- Capture and persist the `conversation_id` from each bridged `agy` turn
- Correlate it with the Codex conversation/turn and pending tool call IDs
- Emit the requested action as the normal Responses tool call
- On `*_tool_call_output`, resume the exact Antigravity conversation with `agy --conversation <id>`
- Inject the result using a deterministic structured continuation format
- Revalidate the resumed custom-agent identity and `init.tools` inventory
- Capture full Antigravity usage and timing fields for every continuation

Do not use `--continue` because it resolves the most recent workspace conversation rather than the exact conversation AutoDev is servicing

Once correctness is proven, benchmark the same representative multi-tool workloads under all three continuation variants:

```text
A. process-per-result + --conversation <id>
B. long-lived --input-format stream-json process
C. parked synchronous MCP/tool call
```

Do not select A merely because it requires the least bridge state. The external reference implementation has measured substantial context/cache-read amplification when resuming Antigravity conversations, so the production choice must include token cost and latency

Validate sequential and multi-step calls, including:

- Read -> reason -> second read
- Read -> shell -> reason
- MCP -> result -> follow-up MCP
- Tool failure -> model recovery
- User steering between the tool request and result
- Cancellation between tool request and continuation
- Provider timeout on an initial or resumed turn
- Partial `--print-timeout` output that must remain incomplete
- Bridge restart followed by persisted-conversation recovery
- Multiple tool calls in one model message if supported
- Repeated continuation without duplicate/replayed tool requests
- Cost and latency across A/B/C using the same workload

Exit condition: Antigravity can complete normal coding turns without native file/shell/MCP execution, the restricted AutoDev agent/tool surface survives every continuation, and the chosen continuation transport has measured acceptable correctness, token/cache-read cost, latency, cancellation, and recovery behavior

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

Retain provider process/limit/error/usage/session telemetry that Codex cannot observe, including Antigravity conversation identity, cache/thinking usage, provider timeout state, and process-level failures

Exit condition: the Antigravity bridge reports provider transport facts, while Codex/AutoDev owns action semantics

---

## Migration gates

Do not retire a current behavior until the replacement proves all applicable properties

| Gate | Required result |
| --- | --- |
| Tool isolation | Forbidden native tools absent from `init.tools` and hard-blocked by hook backstop |
| Tool fidelity | Codex custom/function/freeform tools retain exact names, schemas, arguments, IDs, and outputs |
| Continuation | Tool call -> result -> `agy --conversation <id>` -> continued model reasoning works without lost context, duplicated calls, or weakened tool restrictions |
| Continuation economics | The chosen A/B/C continuation transport has measured acceptable input/cache-read cost and wall-clock latency on representative multi-tool workloads |
| Provider envelope | Structured `denied_actions`, status/error, usage, and conversation identity are consumed before stderr heuristics |
| Partial timeout | A provider timeout returning partial text with rc 0 / SUCCESS cannot be reported as a completed response |
| Process deadline | A hung `agy` child is bounded independently of both `--print-timeout` and the router request deadline |
| Version contract | Unsupported `agy` versions/capabilities are detected before serving normal traffic |
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
- Does `agy --conversation <id>` reliably associate a structured resumed tool result with the immediately preceding shim request across repeated tool cycles
- How much input/cache-read amplification does exact-ID `--conversation` create in AutoDev's real multi-tool loop compared with long-lived stream-json and parked MCP variants
- Does a resumed `--conversation` invocation preserve or correctly reapply the selected custom agent and its restricted `init.tools` inventory
- What minimal state must AutoDev persist to recover `Codex conversation -> agy conversation_id -> pending call IDs` after a bridge restart
- Does long-lived `--input-format stream-json` reduce token/cache-read re-ingestion or latency enough to justify owning a persistent process after exact-ID resumption works
- Is a parked synchronous MCP call needed for any fidelity case that explicit conversation resumption cannot satisfy
- Which current Antigravity action telemetry paths become redundant once Codex executes every action, and which provider-native usage/session fields must remain
- What minimum supported `agy` version lets AutoDev delete historical compatibility branches safely
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
OpenAI/Codex ----\
Claude -----------\
Antigravity -------+--> Codex agent harness --> tools / MCP / skills / subagents
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
- Antigravity CLI headless/stream-json and conversation continuation: https://antigravity.google/docs/cli/headless/
- Antigravity conversation resume command: https://antigravity.google/docs/cli/commands/resume
- Antigravity hooks: https://antigravity.google/docs/hooks
- Antigravity permissions: https://antigravity.google/docs/permissions?tab=cli
- Antigravity CLI reference: https://antigravity.google/docs/cli/reference/
- Rulesync Antigravity custom-agent implementation: https://github.com/dyoshikawa/rulesync/blob/main/src/features/subagents/antigravity-shared-subagent.ts
- Rulesync Antigravity CLI permissions implementation: https://github.com/dyoshikawa/rulesync/blob/main/src/features/permissions/antigravity-cli-permissions.ts
- `antigravity-for-claude-code` inspected implementation (pinned): https://github.com/yuting0624/antigravity-for-claude-code/tree/088b7db8a58b611a5eb6e87995f885f0a1121c94
- Reference `agy-delegate.sh`: https://github.com/yuting0624/antigravity-for-claude-code/blob/088b7db8a58b611a5eb6e87995f885f0a1121c94/scripts/agy-delegate.sh
- Reference continuation measurement/changelog: https://github.com/yuting0624/antigravity-for-claude-code/blob/088b7db8a58b611a5eb6e87995f885f0a1121c94/CHANGELOG.md
- Reference headless troubleshooting: https://github.com/yuting0624/antigravity-for-claude-code/blob/088b7db8a58b611a5eb6e87995f885f0a1121c94/docs/TROUBLESHOOTING.md
- Reference trajectory tooling: https://github.com/yuting0624/antigravity-for-claude-code/blob/088b7db8a58b611a5eb6e87995f885f0a1121c94/scripts/agy-trace.sh
- Reference MIT license: https://github.com/yuting0624/antigravity-for-claude-code/blob/088b7db8a58b611a5eb6e87995f885f0a1121c94/LICENSE
