/**
AutoDev's `xacpx` / ACP orchestration and session-pinning layer.

AutoDev Router retains sole authority for role -> tier -> provider/model/effort
allocation, concurrency admission, and request-outcome cooldowns. Each session
pins strictly to one provider at creation (no mid-session cross-provider hops),
letting each autonomous CLI manage its own context window and native compaction.

Every turn the manager executes is reported through one `XacpxTurnEventSink`
(started, then completed or failed), so the Runtime observes agent turns --
their telemetry and the commits they made -- without `/responses` proxying.
*/

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import {
  type ActiveSession,
  AGENT_METHODS,
  type AgentApp,
  ClientApp,
  type ClientConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type Stream
} from "@agentclientprotocol/sdk";
import { isPathWithin } from "@simulatorlife/autodev-data/files";
import {
  type AcpProviderId,
  type AcpProviderLaunchSpec,
  buildAcpProviderLaunchSpec,
  resolveAcpProviderId
} from "@simulatorlife/autodev-runtime/acp/provider-profiles";
import {
  evaluateReadOnlyToolCall,
  isShellToolName,
  normalizeToolName
} from "@simulatorlife/autodev-runtime/agents/read-only-policy";
import { isDisabledNativeFileTool } from "@simulatorlife/autodev-runtime/hooks/file-surface";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  type Candidate,
  ROUTING_POLICY,
  type RoutingPolicy
} from "@simulatorlife/autodev-runtime/router/routing";
import { runtimeBinDirectory } from "@simulatorlife/autodev-runtime/shared/executables";
import {
  hasRoleContract,
  providerContract,
  roleContract
} from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { resolveChatgptMcpApp } from "@simulatorlife/autodev-runtime/shared/opencli-mcp-app";
import { composeRoleSystemPrompt } from "@simulatorlife/autodev-runtime/shared/role-prompts";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import { mcpToolName } from "@simulatorlife/autodev-runtime/shared/tool-names";

import {
  buildOpencliRoleTaskSpec,
  isOpencliProvider,
  type OpencliRoleTaskSpec,
  type OpencliRunner,
  type OpencliRunResult,
  runOpencliRoleTurn
} from "../providers/opencli-role.ts";

export interface XacpxBinaries {
  readonly xacpxBin: string;
  readonly acpxBin: string;
}

export interface PinnedSessionRecord {
  readonly sessionId: string;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly cwd: string;
  readonly parentSessionId: string | null;
  readonly createdAt: string;
}

export type SessionDispatchPlan =
  | {
      readonly kind: "acp";
      readonly session: PinnedSessionRecord;
      readonly launch: AcpProviderLaunchSpec;
    }
  | {
      readonly kind: "opencli";
      readonly session: PinnedSessionRecord;
      readonly task: OpencliRoleTaskSpec;
    };

/**
Token usage a provider reported for one turn; absent fields were not
reported and stay unavailable rather than zero.
*/
export interface XacpxTurnUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
}

/**
One session turn's lifecycle, as the manager executes it. Each turn starts
once and ends once, completed or failed; the session fields are the pinned
session's own.
*/
export type XacpxTurnEvent = {
  /**
  Unique per turn; the start and the end of one turn share it.
  */
  readonly turnId: string;
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  /**
  The directory the session works in.
  */
  readonly cwd: string;
  readonly transport: "acp" | "opencli";
} & (
  | { readonly type: "turn_started" }
  | {
      readonly type: "turn_completed";
      readonly stopReason: string;
      readonly usage: XacpxTurnUsage | null;
    }
  | {
      readonly type: "turn_failed";
      readonly cancelled: boolean;
      /**
      Whether the turn reached a running executor: a live ACP session, or
      an OpenCLI run handed to its site. False when the executor never
      started (not installed, failed ACP initialize or session/new), so the
      failure is a launch failure rather than a failure of the work.
      */
      readonly started: boolean;
      readonly detail: string;
    }
);

export interface XacpxTurnEventSink {
  emit(event: XacpxTurnEvent): void;
}

function reportedTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
The turn usage an ACP agent reported in its prompt response (an unstable
ACP field many agents omit), or null when it reported none.
*/
function reportedTurnUsage(response: object): XacpxTurnUsage | null {
  const usage: unknown = "usage" in response ? response.usage : null;
  if (!usage || typeof usage !== "object") return null;
  const fields = usage as Record<string, unknown>;
  const reported: XacpxTurnUsage = {
    input: reportedTokenCount(fields.inputTokens),
    output: reportedTokenCount(fields.outputTokens),
    cacheRead: reportedTokenCount(fields.cachedReadTokens)
  };
  return reported.input === null &&
    reported.output === null &&
    reported.cacheRead === null
    ? null
    : reported;
}

export interface PlanSessionRequest {
  readonly sessionId: string;
  readonly role: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly promptOrTask: string;
  readonly repository?: string;
  readonly parentSessionId?: string | null;
  readonly authorizedWorkspaceRoot?: string | null;
}

export interface AcpTransportConnection {
  readonly target: Stream | AgentApp;
  close?: () => void | Promise<void>;
}

export type AcpTransportFactory = (
  launch: AcpProviderLaunchSpec
) => AcpTransportConnection | Promise<AcpTransportConnection>;

export interface SessionTurnResult {
  readonly session: PinnedSessionRecord;
  readonly kind: "acp" | "opencli";
  readonly outputText: string;
  readonly stopReason: string;
  readonly acpSessionId: string | null;
  readonly conversationId?: string;
}

interface LiveOpencliSessionHandle {
  readonly repository: string;
  conversationId: string | null;
  active: { controller: AbortController; settled: Promise<void> } | null;
  uncertain: boolean;
}

interface LiveAcpSessionHandle {
  readonly transport: AcpTransportConnection;
  readonly connection: ClientConnection;
  readonly activeSession: ActiveSession;
  readonly acpSessionId: string;
  readonly systemPrompt: string;
  readonly injectSystemPromptOnFirstTurn: boolean;
  promptSent: boolean;
}

function rejectPermissionResponse(
  request: RequestPermissionRequest
): RequestPermissionResponse {
  const rejectOption = request.options.find(
    (option) => option.kind === "reject_once" || option.kind === "reject_always"
  );
  if (rejectOption) {
    return {
      outcome: { outcome: "selected", optionId: rejectOption.optionId }
    };
  }
  return { outcome: { outcome: "cancelled" } };
}

// ACP sessions see each AutoDev MCP server under its own canonical name.
function parseQualifiedMcpTool(
  rawName: string
): { server: string; tool: string } | null {
  const qualified = /^mcp__([a-zA-Z0-9_-]+?)__([a-zA-Z0-9_.-]+)$/u.exec(
    rawName.trim()
  );
  return qualified?.[1] && qualified[2]
    ? { server: qualified[1], tool: qualified[2] }
    : null;
}

/**
Validate that a delegated child role exists in the canonical execution contract
and cannot escalate to an orchestrator role.
*/
export function validateDelegatedRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (!hasRoleContract(normalized)) {
    throw new Error(`Unknown delegated agent role '${role}'.`);
  }
  const contract = roleContract(normalized);
  if (contract.kind === "orchestrator" || normalized === "orchestrator") {
    throw new Error(
      `Role escalation denied: delegated child agents cannot run as '${normalized}'.`
    );
  }
  return normalized;
}

/**
Validate that a delegated workspace directory is an existing absolute directory
and stays confined within `authorizedWorkspaceRoot` when provided.
*/
export function validateDelegatedWorkspace(
  cwd: string,
  authorizedWorkspaceRoot?: string | null
): string {
  const trimmed = cwd.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`Delegated workspace must be an absolute path: '${cwd}'.`);
  }
  let resolvedCwd: string;
  try {
    resolvedCwd = realpathSync(trimmed);
  } catch {
    throw new Error(`Delegated workspace does not exist: '${trimmed}'.`);
  }
  if (!statSync(resolvedCwd).isDirectory()) {
    throw new Error(`Delegated workspace must be a directory: '${trimmed}'.`);
  }
  if (authorizedWorkspaceRoot?.trim()) {
    const resolvedRoot = realpathSync(authorizedWorkspaceRoot.trim());
    if (!isPathWithin(resolvedCwd, resolvedRoot)) {
      throw new Error(
        `Workspace confinement violation: '${trimmed}' is outside authorized workspace '${resolvedRoot}'.`
      );
    }
  }
  return resolvedCwd;
}

/**
Compose the canonical leaf and role-specific system prompt for a delegated role
from `agents/prompts/`, delegating to the single shared prompt composer.
*/
export function renderRoleSystemPrompt(
  role: string,
  repositoryRoot: string = resolveRuntimeSourceRoot(
    import.meta.dirname,
    process.env.AUTODEV_REPO_ROOT
  )
): string {
  return composeRoleSystemPrompt(role, repositoryRoot);
}

/**
Evaluate an ACP `session/request_permission` prompt against AutoDev's canonical
role contract (unknown-role fail-closed, native file-surface block, shell
enablement, role MCP/tool allowlists, and read-only boundary) so delegated
subagents receive exactly their contracted permissions regardless of provider.
*/
export function resolveAcpPermissionResponse(
  role: string,
  request: RequestPermissionRequest
): RequestPermissionResponse {
  if (!hasRoleContract(role)) {
    return rejectPermissionResponse(request);
  }
  const contract = roleContract(role);
  const toolName = (
    request.toolCall.name ??
    request.toolCall.title ??
    ""
  ).trim();
  if (!toolName || isDisabledNativeFileTool(toolName)) {
    return rejectPermissionResponse(request);
  }
  if (
    contract.shell === false &&
    isShellToolName(normalizeToolName(toolName))
  ) {
    return rejectPermissionResponse(request);
  }
  const mcpTool = parseQualifiedMcpTool(toolName);
  let policyToolName = toolName;
  if (toolName.trimStart().startsWith("mcp__") && !mcpTool) {
    return rejectPermissionResponse(request);
  }
  if (mcpTool) {
    const matches = contract.mcp.filter((server) => server === mcpTool.server);
    if (matches.length !== 1) {
      return rejectPermissionResponse(request);
    }
    const server = matches[0]!;
    policyToolName = mcpToolName(server, mcpTool.tool);
    const roleTools = contract.mcpTools;
    const serverAllowlist =
      roleTools && Object.hasOwn(roleTools, server)
        ? roleTools[server]
        : undefined;
    if (
      Array.isArray(serverAllowlist) &&
      !serverAllowlist.includes(mcpTool.tool)
    ) {
      return rejectPermissionResponse(request);
    }
  }
  const isReadOnly = contract.readOnly === true;
  if (isReadOnly) {
    const decision = evaluateReadOnlyToolCall({
      toolName: policyToolName,
      toolInput: request.toolCall.rawInput
    });
    if (!decision.allowed) {
      return rejectPermissionResponse(request);
    }
  }
  const allowOption =
    request.options.find((option) => option.kind === "allow_once") ??
    request.options.find((option) => option.kind === "allow_always");
  if (!allowOption) {
    return rejectPermissionResponse(request);
  }
  return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
}

/**
Start the executor and wait until it is running. A child that cannot start
(an executor that is not installed, or not executable) reports that as an
`error` event rather than a throw; waiting for `spawn` turns it into a failed
turn instead of an unhandled event that would take the Runtime down.
*/
async function startedExecutor(
  launch: AcpProviderLaunchSpec
): Promise<ChildProcess> {
  const child: ChildProcess = spawn(launch.program, [...launch.args], {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  try {
    await once(child, "spawn");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `ACP executor '${launch.command}' for provider '${launch.provider}' is not installed.`
        : `ACP executor '${launch.command}' for provider '${launch.provider}' could not start (${code ?? "unknown error"}).`,
      { cause: error }
    );
  }
  // A running child can still fail later (a broken pipe on exit); the
  // connection observes that through its streams, so the event is only
  // kept from becoming unhandled.
  child.on("error", () => {});
  return child;
}

async function defaultAcpTransportFactory(
  launch: AcpProviderLaunchSpec
): Promise<AcpTransportConnection> {
  const child = await startedExecutor(launch);
  if (!child.stdin || !child.stdout) {
    child.kill("SIGTERM");
    throw new Error(
      `ACP transport '${launch.command}' failed to open stdio pipes.`
    );
  }
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  );
  return {
    target: stream,
    close: () => {
      if (!child.stdin?.destroyed) {
        child.stdin?.end();
      }
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      }
    }
  };
}

/**
A Runtime dependency's bin shim, from the dependency tree this module
resolves through -- the installed Runtime's protected closure, never a
configured repository root.
*/
function resolvePackageBinary(
  packageName: string,
  name: string,
  environmentKey: string,
  environment: NodeJS.ProcessEnv
): string {
  const configured = environment[environmentKey]?.trim();
  if (configured) return configured;
  const binDirectory = runtimeBinDirectory(packageName);
  const candidate = binDirectory ? path.join(binDirectory, name) : null;
  if (candidate && existsSync(candidate)) return candidate;
  throw new Error(
    `${name} binary is not in the Runtime dependency tree; reinstall AutoDev or set ${environmentKey}.`
  );
}

export function resolveXacpxBinaries(
  environment: NodeJS.ProcessEnv = process.env
): XacpxBinaries {
  return {
    xacpxBin: resolvePackageBinary(
      "@ganglion/xacpx",
      "xacpx",
      "AUTODEV_XACPX_BIN",
      environment
    ),
    acpxBin: resolvePackageBinary(
      "acpx",
      "acpx",
      "AUTODEV_ACPX_BIN",
      environment
    )
  };
}

function connectAgentAppTarget(
  client: ClientApp,
  target: AgentApp
): ClientConnection {
  return client.connect(target);
}

function connectStreamTarget(
  client: ClientApp,
  target: Stream
): ClientConnection {
  return client.connect(target);
}

async function connectLiveAcpSession(
  request: PlanSessionRequest,
  launch: AcpProviderLaunchSpec,
  acpTransportFactory: AcpTransportFactory
): Promise<LiveAcpSessionHandle> {
  const transport = await acpTransportFactory(launch);
  const client = new ClientApp({
    name: `autodev-xacpx-${launch.provider}`
  }).onRequest("session/request_permission", ({ params }) =>
    Promise.resolve(resolveAcpPermissionResponse(request.role, params))
  );

  const connection =
    "builder" in transport.target
      ? connectAgentAppTarget(client, transport.target)
      : connectStreamTarget(client, transport.target);
  try {
    await connection.agent.request(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}
    });
    const activeSession = await connection.agent
      .buildSession({
        cwd: launch.cwd,
        mcpServers: [...launch.acpMcpServers]
      })
      .start();
    return {
      transport,
      connection,
      activeSession,
      acpSessionId: activeSession.sessionId,
      systemPrompt: launch.systemPrompt,
      injectSystemPromptOnFirstTurn:
        launch.isolation.systemPromptInjection === "initial_turn",
      promptSent: false
    };
  } catch (error) {
    connection.close(error);
    await transport.close?.();
    throw error;
  }
}

/**
In-memory registry pinning each session to its chosen provider and enforcing
role/provider eligibility boundaries.

Eligibility is a capability question, never a transport question: a provider
serves a role when its transport can reach that role's MCP surface, and the
orchestrator tier additionally requires the canonical XACPX delegation path.
*/
export class XacpxSessionManager {
  private readonly pins = new Map<string, PinnedSessionRecord>();
  private readonly liveSessions = new Map<string, LiveAcpSessionHandle>();
  private readonly opencliSessions = new Map<
    string,
    LiveOpencliSessionHandle
  >();
  private readonly policy: RoutingPolicy;
  private readonly eventSink: XacpxTurnEventSink | null;
  private readonly acpTransportFactory: AcpTransportFactory;
  private readonly opencliRunner: OpencliRunner;

  constructor(options?: {
    readonly policy?: RoutingPolicy;
    readonly eventSink?: XacpxTurnEventSink | null;
    readonly acpTransportFactory?: AcpTransportFactory;
    readonly opencliRunner?: OpencliRunner;
  }) {
    this.policy = options?.policy ?? ROUTING_POLICY;
    this.eventSink = options?.eventSink ?? null;
    this.acpTransportFactory =
      options?.acpTransportFactory ?? defaultAcpTransportFactory;
    this.opencliRunner = options?.opencliRunner ?? runOpencliRoleTurn;
  }

  getPinnedSession(sessionId: string): PinnedSessionRecord | null {
    return this.pins.get(sessionId) ?? null;
  }

  listPinnedSessions(): PinnedSessionRecord[] {
    return this.pins.values().toArray();
  }

  hasLiveAcpSession(sessionId: string): boolean {
    return this.liveSessions.has(sessionId);
  }

  clearPinnedSession(sessionId: string): boolean {
    if (this.opencliSessions.get(sessionId)?.active) return false;
    this.opencliSessions.delete(sessionId);
    return this.pins.delete(sessionId);
  }

  /**
  Select an eligible provider/model via AutoDev's RoutingPolicy while honoring
  strict per-session pinning.

  Eligibility is the routing policy's own capability verdict: a candidate is
  eligible when the provider is enabled, ranked for the tier, can reach the
  role's MCP surface, and -- for the orchestrator -- holds the canonical
  XACPX delegation path. The transport (ACP or an opencli site) is never a
  reason to reject a candidate.
  */
  selectCandidateForSession(sessionId: string, role: string): Candidate {
    const pinned = this.pins.get(sessionId);
    const rawCandidates =
      role === "orchestrator"
        ? this.policy.orchestratorCandidates()
        : this.policy.roleCandidates(role);

    const eligible = rawCandidates.filter((candidate) =>
      this.policy.providerReachesRoleMcp(candidate.provider, role)
    );

    if (pinned) {
      if (pinned.role !== role) {
        throw new Error(
          `Session ${sessionId} is pinned to role '${pinned.role}' and cannot switch to '${role}'.`
        );
      }
      const matching = eligible.find(
        (candidate) => candidate.provider === pinned.provider
      );
      if (!matching) {
        throw new Error(
          `Pinned provider '${pinned.provider}' is no longer eligible for session ${sessionId} (${role}).`
        );
      }
      if (COOLDOWNS.isCooling(pinned.provider, Date.now(), pinned.model)) {
        throw new Error(
          `Pinned provider '${matching.provider}' is cooling down; start a new session instead of hopping mid-session.`
        );
      }
      return {
        ...matching,
        model: pinned.model,
        reasoningEffort: pinned.reasoningEffort
      };
    }

    const now = Date.now();
    const healthy = eligible.find(
      (candidate) =>
        !COOLDOWNS.isCooling(candidate.provider, now, candidate.model)
    );
    if (!healthy && eligible.length > 0) {
      throw new Error(
        `All eligible provider candidates for role '${role}' are cooling down: ${eligible.map((candidate) => candidate.provider).join(", ")}.`
      );
    }
    const chosen = healthy;
    if (!chosen) {
      const tier =
        role === "orchestrator"
          ? this.policy.config.orchestrator.tier
          : this.policy.tierForRole(role);
      const scope = role === "orchestrator" ? "orchestrator" : "subagent";
      const blockers = tier
        ? this.policy.tierServingBlockers(tier, scope)
        : null;
      const excluded = tier ? this.policy.excludedProviders(tier, scope) : [];
      const reasons = new Map(
        excluded.map(({ provider, reason }) => [provider, reason])
      );
      for (const provider of blockers?.disabled ?? []) {
        if (!reasons.has(provider)) reasons.set(provider, "disabled");
      }
      for (const provider of blockers?.cannotDelegate ?? []) {
        reasons.set(provider, "delegation unavailable");
      }
      for (const provider of blockers?.servable ?? []) {
        if (!reasons.has(provider)) {
          reasons.set(provider, "no eligible model or execution transport");
        }
      }
      // A provider that is ranked and enabled but whose transport cannot reach
      // this role's MCP surface is named with the reason, so the refusal says
      // what the operator has to change rather than that nothing is enabled.
      const genericReason = "no eligible model or execution transport";
      const tierProviders = tier
        ? this.policy.effectiveProviderGroups(tier, scope).flat()
        : [];
      for (const provider of tierProviders) {
        const known = reasons.get(provider);
        if (known !== undefined && known !== genericReason) continue;
        if (this.policy.providerReachesRoleMcp(provider, role)) continue;
        reasons.set(
          provider,
          `its transport cannot reach the MCP surface of role '${role}'`
        );
      }
      const details = Array.from(
        reasons,
        ([provider, reason]) => `${provider}: ${reason}`
      ).join("; ");
      throw new Error(
        `No eligible provider candidate found for role '${role}'.${details ? ` ${details}.` : ""}`
      );
    }
    return chosen;
  }

  /**
  Plan a session dispatch, pinning newly created sessions.

  The transport follows the provider the routing policy chose: an ACP
  provider runs the role's contracted MCP servers itself, and an opencli
  provider drives the site with the role's MCP app selected.
  */
  planDispatch(
    request: PlanSessionRequest,
    environment: NodeJS.ProcessEnv = process.env
  ): SessionDispatchPlan {
    const role = request.parentSessionId
      ? validateDelegatedRole(request.role)
      : request.role.trim().toLowerCase();
    if (!hasRoleContract(role)) {
      throw new Error(`Unknown agent role '${request.role}'.`);
    }
    const cwd = request.authorizedWorkspaceRoot
      ? validateDelegatedWorkspace(request.cwd, request.authorizedWorkspaceRoot)
      : request.cwd;
    const systemPrompt =
      request.systemPrompt.trim() || renderRoleSystemPrompt(role);
    const existing = this.pins.get(request.sessionId);
    if (
      existing &&
      (existing.cwd !== cwd ||
        existing.parentSessionId !== (request.parentSessionId ?? null))
    ) {
      throw new Error(
        "Pinned session workspace or parent identity cannot change."
      );
    }
    const opencli = this.opencliSessions.get(request.sessionId);
    if (opencli?.active) {
      throw new Error("An OpenCLI turn is already active for this session.");
    }
    if (opencli?.uncertain) {
      throw new Error(
        "Previous OpenCLI turn outcome is uncertain; reconcile it before starting another session."
      );
    }
    if (
      opencli &&
      request.repository &&
      request.repository !== opencli.repository
    ) {
      throw new Error("Pinned OpenCLI session repository cannot change.");
    }
    const chosen = this.selectCandidateForSession(request.sessionId, role);

    const session: PinnedSessionRecord = existing ?? {
      sessionId: request.sessionId,
      role,
      provider: chosen.provider,
      model: chosen.model,
      reasoningEffort: chosen.reasoningEffort ?? null,
      cwd,
      parentSessionId: request.parentSessionId ?? null,
      createdAt: new Date().toISOString()
    };
    if (!existing) {
      this.pins.set(request.sessionId, session);
    }

    if (isOpencliProvider(chosen.provider)) {
      // The site's MCP app is what carries this role's tool surface, so the
      // app is selected by the role: the conversation's tools are the role's
      // canonical contract and the coordinator that owns its delegated
      // children is that role's own.
      const mcpApp =
        providerContract(chosen.provider).mcpIngress === "gateway"
          ? resolveChatgptMcpApp(role, environment)
          : null;
      return {
        kind: "opencli",
        session,
        task: buildOpencliRoleTaskSpec({
          role,
          provider: chosen.provider,
          model: chosen.model,
          reasoningEffort: chosen.reasoningEffort ?? null,
          repository:
            opencli?.repository ?? request.repository ?? path.basename(cwd),
          task: request.promptOrTask,
          sessionId: request.sessionId,
          conversationId: opencli?.conversationId ?? null,
          workspace: cwd,
          mcpApp,
          systemPrompt
        })
      };
    }

    const acpProvider: AcpProviderId | null = resolveAcpProviderId(
      chosen.provider
    );
    if (!acpProvider) {
      throw new Error(
        `Provider '${chosen.provider}' does not map to a supported execution transport.`
      );
    }
    return {
      kind: "acp",
      session,
      launch: buildAcpProviderLaunchSpec({
        provider: acpProvider,
        role,
        model: chosen.model,
        cwd,
        systemPrompt,
        sessionId: request.sessionId,
        reasoningEffort: chosen.reasoningEffort ?? null,
        env: environment
      })
    };
  }

  /**
  Dispatch and execute one turn for a session via native ACP or an opencli
  site, reusing pinned live sessions across follow-up turns.
  */
  async executeTurn(
    request: PlanSessionRequest,
    environment: NodeJS.ProcessEnv = process.env,
    signal?: AbortSignal
  ): Promise<SessionTurnResult> {
    if (signal?.aborted) {
      throw new Error("Session turn cancelled before dispatch.");
    }
    const plan = this.planDispatch(request, environment);
    const turn = {
      turnId: randomUUID(),
      sessionId: plan.session.sessionId,
      parentSessionId: plan.session.parentSessionId,
      provider: plan.session.provider,
      model: plan.session.model,
      role: plan.session.role,
      cwd: plan.session.cwd,
      transport: plan.kind
    } as const;
    this.eventSink?.emit({ ...turn, type: "turn_started" });
    let isOpencliCancelled = false;
    let executorStarted = false;
    let opencli: LiveOpencliSessionHandle | undefined;
    if (plan.kind === "opencli") {
      opencli = this.opencliSessions.get(request.sessionId) ?? {
        repository: plan.task.repository ?? "",
        conversationId: null,
        active: null,
        uncertain: false
      };
      this.opencliSessions.set(request.sessionId, opencli);
    }
    try {
      if (plan.kind === "opencli" && opencli) {
        const controller = new AbortController();
        const { promise: settled, resolve: settle } =
          Promise.withResolvers<void>();
        opencli.active = { controller, settled };
        const abort = (): void => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        let result: OpencliRunResult;
        executorStarted = true;
        try {
          result = await this.opencliRunner(plan.task, controller.signal);
          if (controller.signal.aborted) {
            throw new Error("OpenCLI turn cancelled.");
          }
          if (
            result.exitCode !== 0 ||
            typeof result.conversationId !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(result.conversationId) ||
            (opencli.conversationId !== null &&
              result.conversationId !== opencli.conversationId)
          ) {
            throw new Error(
              "OpenCLI response does not match the pinned conversation."
            );
          }
          opencli.conversationId = result.conversationId;
        } catch (error) {
          isOpencliCancelled = controller.signal.aborted;
          opencli.uncertain = true;
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          opencli.active = null;
          settle();
        }
        this.eventSink?.emit({
          ...turn,
          type: "turn_completed",
          stopReason: "end_turn",
          usage: null
        });
        return {
          session: plan.session,
          kind: "opencli",
          outputText: result.outputText,
          stopReason: "end_turn",
          acpSessionId: null,
          conversationId: result.conversationId
        };
      }
      if (plan.kind !== "acp")
        throw new Error("Missing OpenCLI session state.");

      let handle = this.liveSessions.get(request.sessionId);
      if (!handle) {
        handle = await connectLiveAcpSession(
          request,
          plan.launch,
          this.acpTransportFactory
        );
        this.liveSessions.set(request.sessionId, handle);
      }
      executorStarted = true;

      const onAbort = (): void => {
        void this.cancelSession(request.sessionId).catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      let promptResponse: Awaited<ReturnType<ActiveSession["prompt"]>>;
      let outputText: string;
      const turnPrompt =
        !handle.promptSent &&
        handle.injectSystemPromptOnFirstTurn &&
        handle.systemPrompt.trim().length > 0
          ? `<system_instructions>\n${handle.systemPrompt.trim()}\n</system_instructions>\n\n${request.promptOrTask}`
          : request.promptOrTask;
      handle.promptSent = true;
      try {
        [promptResponse, outputText] = await Promise.all([
          handle.activeSession.prompt(turnPrompt),
          handle.activeSession.readText()
        ]);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      this.eventSink?.emit({
        ...turn,
        type: "turn_completed",
        stopReason: promptResponse.stopReason,
        usage: reportedTurnUsage(promptResponse)
      });
      return {
        session: plan.session,
        kind: "acp",
        outputText,
        stopReason: promptResponse.stopReason,
        acpSessionId: handle.acpSessionId
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const cancelled = signal?.aborted === true || isOpencliCancelled;
      if (!cancelled) {
        COOLDOWNS.cooldownProvider(plan.session.provider, {
          failureClass: "upstream_error",
          detail,
          model: plan.session.model
        });
      }
      this.eventSink?.emit({
        ...turn,
        type: "turn_failed",
        cancelled,
        started: executorStarted,
        detail
      });
      throw error;
    }
  }

  /**
  Send a prompt turn on an already-pinned session without re-specifying routing inputs.
  */
  promptSession(
    sessionId: string,
    promptText: string,
    environment: NodeJS.ProcessEnv = process.env,
    signal?: AbortSignal
  ): Promise<SessionTurnResult> {
    const pinned = this.pins.get(sessionId);
    if (!pinned) {
      throw new Error(`No pinned session found for '${sessionId}'.`);
    }
    const live = this.liveSessions.get(sessionId);
    return this.executeTurn(
      {
        sessionId: pinned.sessionId,
        role: pinned.role,
        cwd: pinned.cwd,
        systemPrompt: live?.systemPrompt ?? "",
        promptOrTask: promptText,
        ...(pinned.parentSessionId && {
          parentSessionId: pinned.parentSessionId
        })
      },
      environment,
      signal
    );
  }

  /**
  Request cancellation of the active ACP or OpenCLI turn for `sessionId`.
  */
  async cancelSession(sessionId: string): Promise<boolean> {
    const opencli = this.opencliSessions.get(sessionId);
    if (opencli?.active) {
      opencli.active.controller.abort();
      return true;
    }
    const live = this.liveSessions.get(sessionId);
    if (!live) return false;
    await live.connection.agent.notify(AGENT_METHODS.session_cancel, {
      sessionId: live.acpSessionId
    });
    return true;
  }

  /**
  Close live transport, settle any cancelled OpenCLI turn, and clear session pin state.
  */
  async closeSession(sessionId: string): Promise<boolean> {
    const activeOpencli = this.opencliSessions.get(sessionId)?.active;
    if (activeOpencli) {
      activeOpencli.controller.abort();
      await activeOpencli.settled;
    }
    const live = this.liveSessions.get(sessionId);
    this.liveSessions.delete(sessionId);
    const hadPin = this.clearPinnedSession(sessionId);
    if (!live) return hadPin;
    try {
      await live.connection.agent.request(AGENT_METHODS.session_close, {
        sessionId: live.acpSessionId
      });
    } catch {
      // Agent may already have closed the session or not implement session/close.
    }
    live.activeSession.dispose();
    live.connection.close();
    await live.transport.close?.();
    return true;
  }

  async closeAllSessions(): Promise<void> {
    const ids = [
      ...new Set([...this.liveSessions.keys(), ...this.pins.keys()])
    ];
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }
}
