/**
AutoDev's `xacpx` / ACP orchestration and session-pinning layer.

AutoDev Router retains sole authority for role -> tier -> provider/model/effort
allocation, concurrency admission, and request-outcome cooldowns. Each session
pins strictly to one provider at creation (no mid-session cross-provider hops),
letting each autonomous CLI manage its own context window and native compaction.

The `AcpConsoleSink` interface keeps session transport decoupled so AutoDev
Console or an external ACP console can attach directly without `/responses`
proxying.
*/

import { type ChildProcess, spawn } from "node:child_process";
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
  type AcpSupergatewayEndpoint,
  buildAcpProviderLaunchSpec,
  buildGithubWorkerTaskSpec,
  GITHUB_WORKER_ROLE,
  type GithubWorkerTaskSpec,
  isGithubWorkerProvider,
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
import {
  hasRoleContract,
  roleContract
} from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { opencliModel } from "@simulatorlife/autodev-runtime/shared/provider-model-ids";
import { composeRoleSystemPrompt } from "@simulatorlife/autodev-runtime/shared/role-prompts";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import { execa } from "execa";

import {
  geminiConversationId,
  parseOpencliOutput,
  replyFromRow
} from "../providers/opencli-turn.ts";

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
      readonly kind: "opencli-github-worker";
      readonly session: PinnedSessionRecord;
      readonly task: GithubWorkerTaskSpec;
    };

export interface AcpConsoleSessionEvent {
  readonly type:
    | "session_started"
    | "session_resumed"
    | "session_failed"
    | "session_completed";
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  readonly detail?: string;
}

export interface AcpConsoleSink {
  emit(event: AcpConsoleSessionEvent): void;
}

export interface PlanSessionRequest {
  readonly sessionId: string;
  readonly role: string;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly promptOrTask: string;
  readonly repository?: string;
  readonly parentSessionId?: string | null;
  readonly mcpConfigPath?: string;
  readonly supergateway?: AcpSupergatewayEndpoint;
  readonly authorizedWorkspaceRoot?: string | null;
}

export interface AcpTransportConnection {
  readonly target: Stream | AgentApp;
  close?: () => void | Promise<void>;
}

export type AcpTransportFactory = (
  launch: AcpProviderLaunchSpec
) => AcpTransportConnection | Promise<AcpTransportConnection>;

export interface GithubWorkerRunResult {
  readonly outputText: string;
  readonly exitCode: number;
  readonly conversationId: string;
}

export type GithubWorkerRunner = (
  task: GithubWorkerTaskSpec,
  signal?: AbortSignal
) => Promise<GithubWorkerRunResult>;

export interface SessionTurnResult {
  readonly session: PinnedSessionRecord;
  readonly kind: "acp" | "opencli-github-worker";
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
  readonly mcpConfigPath?: string;
  readonly supergateway?: AcpSupergatewayEndpoint;
  readonly injectSystemPromptOnFirstTurn: boolean;
  promptSent: boolean;
}

function rejectPermissionResponse(
  request: RequestPermissionRequest
): RequestPermissionResponse {
  const rejectOption = request.options.find(
    (option) =>
      option.kind === "reject_once" || option.kind === "reject_always"
  );
  if (rejectOption) {
    return {
      outcome: { outcome: "selected", optionId: rejectOption.optionId }
    };
  }
  return { outcome: { outcome: "cancelled" } };
}

function parseQualifiedMcpTool(
  rawName: string
): { server: string; tool: string } | null {
  const normalized = rawName.trim();
  const prefixed = /^mcp__([a-zA-Z0-9_-]+)__([a-zA-Z0-9_.-]+)$/u.exec(
    normalized
  );
  if (prefixed?.[1] && prefixed[2]) {
    return { server: prefixed[1], tool: prefixed[2] };
  }
  return null;
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
  const toolName = request.toolCall.name ?? request.toolCall.title ?? "";
  if (isDisabledNativeFileTool(toolName)) {
    return rejectPermissionResponse(request);
  }
  if (contract.shell === false && isShellToolName(normalizeToolName(toolName))) {
    return rejectPermissionResponse(request);
  }
  const mcpTool = parseQualifiedMcpTool(toolName);
  if (mcpTool) {
    if (!contract.mcp.includes(mcpTool.server)) {
      return rejectPermissionResponse(request);
    }
    const roleTools = contract.mcpTools as
      | Record<string, string[]>
      | undefined;
    const serverAllowlist = roleTools?.[mcpTool.server];
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
      toolName,
      toolInput: request.toolCall.rawInput
    });
    if (!decision.allowed) {
      return rejectPermissionResponse(request);
    }
  }
  const allowOption =
    request.options.find((option) => option.kind === "allow_once") ??
    request.options.find((option) => option.kind === "allow_always") ??
    request.options[0];
  if (!allowOption) {
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
}

function defaultAcpTransportFactory(
  launch: AcpProviderLaunchSpec
): AcpTransportConnection {
  const child: ChildProcess = spawn(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
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

async function defaultGithubWorkerRunner(
  task: GithubWorkerTaskSpec,
  signal?: AbortSignal
): Promise<GithubWorkerRunResult> {
  const parsedModel = opencliModel(task.model);
  if (!parsedModel || parsedModel.provider !== task.provider) {
    throw new Error("OpenCLI model does not match the pinned provider.");
  }
  const { site, siteModel } = parsedModel;
  const commandArguments = [
    site,
    "ask",
    task.prompt,
    ...(site === "gemini" ? ["--model", siteModel] : []),
    ...(task.conversationId
      ? ["--conversation", task.conversationId]
      : ["--new", "true"]),
    "-f",
    "json"
  ];

  const command = process.env.OPENCLI_BIN?.trim() || "opencli";
  const result = await execa(command, commandArguments, {
    stdin: "ignore",
    reject: false,
    ...(signal ? { cancelSignal: signal } : {})
  });
  const output = result.stdout.trim();
  const errorText = result.stderr.trim();
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) {
    throw new Error(
      errorText || output || `opencli github-worker exited with code ${exitCode}`
    );
  }
  const row = parseOpencliOutput(output, exitCode)[0];
  if (!row) throw new Error("OpenCLI returned no response row.");
  const reply = replyFromRow(row);
  const conversationId =
    site === "gemini" ? geminiConversationId(row.url) : reply.conversationId;
  if (!conversationId) {
    throw new Error("OpenCLI response has no verifiable conversation identity.");
  }
  return { outputText: reply.response, exitCode, conversationId };
}

function resolvePackageBinary(
  name: string,
  environmentKey: string,
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot: string = resolveRuntimeSourceRoot(
    import.meta.dirname,
    environment.AUTODEV_REPO_ROOT
  )
): string {
  const configured = environment[environmentKey]?.trim();
  if (configured) return configured;
  const candidates = [
    path.join(repositoryRoot, "runtime", "node_modules", ".bin", name),
    path.join(repositoryRoot, "src", "node_modules", ".bin", name),
    path.join(repositoryRoot, "node_modules", ".bin", name)
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `${name} binary not found under ${repositoryRoot}; run pnpm install or set ${environmentKey}.`
  );
}

export function resolveXacpxBinaries(
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot?: string
): XacpxBinaries {
  return {
    xacpxBin: resolvePackageBinary(
      "xacpx",
      "AUTODEV_XACPX_BIN",
      environment,
      repositoryRoot
    ),
    acpxBin: resolvePackageBinary(
      "acpx",
      "AUTODEV_ACPX_BIN",
      environment,
      repositoryRoot
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
      ...(request.mcpConfigPath && { mcpConfigPath: request.mcpConfigPath }),
      ...(request.supergateway && { supergateway: request.supergateway }),
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
role/provider eligibility boundaries (`github-worker` <-> `opencli`, all other
roles <-> ACP providers).
*/
export class XacpxSessionManager {
  private readonly pins = new Map<string, PinnedSessionRecord>();
  private readonly liveSessions = new Map<string, LiveAcpSessionHandle>();
  private readonly opencliSessions = new Map<string, LiveOpencliSessionHandle>();
  private readonly policy: RoutingPolicy;
  private readonly consoleSink: AcpConsoleSink | null;
  private readonly acpTransportFactory: AcpTransportFactory;
  private readonly githubWorkerRunner: GithubWorkerRunner;

  constructor(options?: {
    readonly policy?: RoutingPolicy;
    readonly consoleSink?: AcpConsoleSink | null;
    readonly acpTransportFactory?: AcpTransportFactory;
    readonly githubWorkerRunner?: GithubWorkerRunner;
  }) {
    this.policy = options?.policy ?? ROUTING_POLICY;
    this.consoleSink = options?.consoleSink ?? null;
    this.acpTransportFactory =
      options?.acpTransportFactory ?? defaultAcpTransportFactory;
    this.githubWorkerRunner =
      options?.githubWorkerRunner ?? defaultGithubWorkerRunner;
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
  strict per-session pinning and the `github-worker` <-> `opencli` boundary.
  */
  selectCandidateForSession(sessionId: string, role: string): Candidate {
    const pinned = this.pins.get(sessionId);
    const rawCandidates =
      role === "orchestrator"
        ? this.policy.orchestratorCandidates()
        : this.policy.roleCandidates(role);

    const eligible = rawCandidates.filter((candidate) => {
      if (role === GITHUB_WORKER_ROLE) {
        return isGithubWorkerProvider(candidate.provider);
      }
      if (isGithubWorkerProvider(candidate.provider)) {
        return false;
      }
      return resolveAcpProviderId(candidate.provider) !== null;
    });

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
      const blockedOpencli = rawCandidates
        .filter((candidate) => isGithubWorkerProvider(candidate.provider))
        .map((candidate) => candidate.provider);
      if (role !== GITHUB_WORKER_ROLE && blockedOpencli.length > 0) {
        throw new Error(
          `No eligible provider candidate found for role '${role}'. OpenCLI integration parity gap (${[...new Set(blockedOpencli)].join(", ")}): native MCP conversation-specific role, workspace and coordinator binding to Supergateway/XACPX is not verified.`
        );
      }
      const tier =
        role === "orchestrator"
          ? this.policy.config.orchestrator.tier
          : this.policy.tierForRole(role);
      const scope = role === "orchestrator" ? "orchestrator" : "subagent";
      const blockers = tier ? this.policy.tierServingBlockers(tier, scope) : null;
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
      const details = [...reasons]
        .map(([provider, reason]) => `${provider}: ${reason}`)
        .join("; ");
      throw new Error(
        `No eligible provider candidate found for role '${role}'.${details ? ` ${details}.` : ""}`
      );
    }
    return chosen;
  }

  /**
  Plan an ACP or `github-worker` session dispatch, pinning newly created sessions.
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
      throw new Error("Pinned session workspace or parent identity cannot change.");
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

    this.consoleSink?.emit({
      type: existing ? "session_resumed" : "session_started",
      sessionId: session.sessionId,
      provider: session.provider,
      model: session.model,
      role: session.role
    });

    if (role === GITHUB_WORKER_ROLE) {
      if (!isGithubWorkerProvider(chosen.provider)) {
        throw new Error(
          `github-worker must route to opencli; got '${chosen.provider}'.`
        );
      }
      return {
        kind: "opencli-github-worker",
        session,
        task: buildGithubWorkerTaskSpec({
          provider: chosen.provider,
          model: chosen.model,
          repository:
            opencli?.repository ?? request.repository ?? path.basename(cwd),
          task: request.promptOrTask,
          sessionId: request.sessionId,
          conversationId: opencli?.conversationId ?? null
        })
      };
    }

    const acpProvider: AcpProviderId | null = resolveAcpProviderId(
      chosen.provider
    );
    if (!acpProvider) {
      throw new Error(
        `Provider '${chosen.provider}' does not map to a supported ACP executor.`
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
        ...(request.mcpConfigPath && { mcpConfigPath: request.mcpConfigPath }),
        ...(request.supergateway && { supergateway: request.supergateway }),
        reasoningEffort: chosen.reasoningEffort ?? null,
        env: environment
      })
    };
  }

  /**
  Dispatch and execute one turn for a session via native ACP or direct `opencli`
  (`github-worker`), reusing pinned live sessions across follow-up turns.
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
    let opencliCancelled = false;
    let opencli: LiveOpencliSessionHandle | undefined;
    if (plan.kind === "opencli-github-worker") {
      opencli = this.opencliSessions.get(request.sessionId) ?? {
        repository: plan.task.repository,
        conversationId: null,
        active: null,
        uncertain: false
      };
      this.opencliSessions.set(request.sessionId, opencli);
    }
    try {
      if (plan.kind === "opencli-github-worker" && opencli) {
        const controller = new AbortController();
        const { promise: settled, resolve: settle } =
          Promise.withResolvers<void>();
        opencli.active = { controller, settled };
        const abort = (): void => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        let result: GithubWorkerRunResult;
        try {
          result = await this.githubWorkerRunner(plan.task, controller.signal);
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
          opencliCancelled = controller.signal.aborted;
          opencli.uncertain = true;
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          opencli.active = null;
          settle();
        }
        this.consoleSink?.emit({
          type: "session_completed",
          sessionId: plan.session.sessionId,
          provider: plan.session.provider,
          model: plan.session.model,
          role: plan.session.role
        });
        return {
          session: plan.session,
          kind: "opencli-github-worker",
          outputText: result.outputText,
          stopReason: "end_turn",
          acpSessionId: null,
          conversationId: result.conversationId
        };
      }
      if (plan.kind !== "acp") throw new Error("Missing OpenCLI session state.");

      let handle = this.liveSessions.get(request.sessionId);
      if (!handle) {
        handle = await connectLiveAcpSession(
          request,
          plan.launch,
          this.acpTransportFactory
        );
        this.liveSessions.set(request.sessionId, handle);
      }

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
      this.consoleSink?.emit({
        type: "session_completed",
        sessionId: plan.session.sessionId,
        provider: plan.session.provider,
        model: plan.session.model,
        role: plan.session.role,
        detail: promptResponse.stopReason
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
      if (!signal?.aborted && !opencliCancelled) {
        COOLDOWNS.cooldownProvider(plan.session.provider, {
          failureClass: "upstream_error",
          detail,
          model: plan.session.model
        });
      }
      this.consoleSink?.emit({
        type: "session_failed",
        sessionId: plan.session.sessionId,
        provider: plan.session.provider,
        model: plan.session.model,
        role: plan.session.role,
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
        }),
        ...(live?.mcpConfigPath && { mcpConfigPath: live.mcpConfigPath }),
        ...(live?.supergateway && { supergateway: live.supergateway })
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
