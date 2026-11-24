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
import { existsSync } from "node:fs";
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
import {
  type AcpProviderId,
  type AcpProviderLaunchSpec,
  buildAcpProviderLaunchSpec,
  buildGithubWorkerTaskSpec,
  GITHUB_WORKER_ROLE,
  type GithubWorkerTaskSpec,
  isGithubWorkerProvider,
  resolveAcpProviderId
} from "@simulatorlife/autodev-runtime/acp/provider-profiles";
import { evaluateReadOnlyToolCall } from "@simulatorlife/autodev-runtime/agents/read-only-policy";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  type Candidate,
  ROUTING_POLICY,
  type RoutingPolicy
} from "@simulatorlife/autodev-runtime/router/routing";
import { roleContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { opencliModel } from "@simulatorlife/autodev-runtime/shared/provider-model-ids";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

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
}

interface LiveAcpSessionHandle {
  readonly transport: AcpTransportConnection;
  readonly connection: ClientConnection;
  readonly activeSession: ActiveSession;
  readonly acpSessionId: string;
  readonly systemPrompt: string;
  readonly mcpConfigPath?: string;
}

/**
Evaluate an ACP `session/request_permission` prompt against AutoDev's role
read-only contract so read-only subagents cannot execute mutating tools even
when an autonomous CLI proposes them.
*/
export function resolveAcpPermissionResponse(
  role: string,
  request: RequestPermissionRequest
): RequestPermissionResponse {
  const isReadOnly = roleContract(role).readOnly === true;
  if (isReadOnly) {
    const decision = evaluateReadOnlyToolCall({
      toolName: request.toolCall.name ?? request.toolCall.title ?? "",
      toolInput: request.toolCall.rawInput
    });
    if (!decision.allowed) {
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

function defaultGithubWorkerRunner(
  task: GithubWorkerTaskSpec,
  signal?: AbortSignal
): Promise<GithubWorkerRunResult> {
  const parsedModel = opencliModel(task.model);
  const site =
    parsedModel?.site ??
    (task.provider === "opencli-gemini" ? "gemini" : "chatgpt");
  const commandArguments =
    site === "gemini"
      ? [
          "gemini",
          "ask",
          task.prompt,
          ...(parsedModel?.siteModel ? ["--model", parsedModel.siteModel] : []),
          "-f",
          "json"
        ]
      : ["chatgpt", "ask", task.prompt, "-f", "json"];

  return new Promise<GithubWorkerRunResult>((resolve, reject) => {
    const command = process.env.OPENCLI_BIN?.trim() || "opencli";
    const child = spawn(command, commandArguments, {
      stdio: ["ignore", "pipe", "pipe"],
      signal
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        reject(
          new Error(
            errorText ||
              output ||
              `opencli github-worker exited with code ${exitCode}`
          )
        );
        return;
      }
      resolve({ outputText: output, exitCode });
    });
  });
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
      .buildSession(launch.cwd)
      .start();
    return {
      transport,
      connection,
      activeSession,
      acpSessionId: activeSession.sessionId,
      systemPrompt: request.systemPrompt,
      ...(request.mcpConfigPath && { mcpConfigPath: request.mcpConfigPath })
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
      if (COOLDOWNS.isCooling(matching.provider, Date.now(), matching.model)) {
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
    const chosen = healthy ?? eligible[0];
    if (!chosen) {
      throw new Error(
        `No eligible provider candidate found for role '${role}'.`
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
    const existing = this.pins.get(request.sessionId);
    const chosen = this.selectCandidateForSession(
      request.sessionId,
      request.role
    );

    const session: PinnedSessionRecord = existing ?? {
      sessionId: request.sessionId,
      role: request.role,
      provider: chosen.provider,
      model: chosen.model,
      reasoningEffort: chosen.reasoningEffort ?? null,
      cwd: request.cwd,
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

    if (request.role === GITHUB_WORKER_ROLE) {
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
          repository: request.repository ?? path.basename(request.cwd),
          task: request.promptOrTask,
          sessionId: request.sessionId
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
        role: request.role,
        model: chosen.model,
        cwd: request.cwd,
        systemPrompt: request.systemPrompt,
        sessionId: request.sessionId,
        ...(request.mcpConfigPath && { mcpConfigPath: request.mcpConfigPath }),
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
    const plan = this.planDispatch(request, environment);
    try {
      if (plan.kind === "opencli-github-worker") {
        const result = await this.githubWorkerRunner(plan.task, signal);
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
          acpSessionId: null
        };
      }

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
      try {
        [promptResponse, outputText] = await Promise.all([
          handle.activeSession.prompt(request.promptOrTask),
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
      COOLDOWNS.cooldownProvider(plan.session.provider, {
        failureClass: "upstream_error",
        detail,
        model: plan.session.model
      });
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
        ...(live?.mcpConfigPath && { mcpConfigPath: live.mcpConfigPath })
      },
      environment,
      signal
    );
  }

  /**
  Cancel the active ACP turn for `sessionId` if connected.
  */
  async cancelSession(sessionId: string): Promise<boolean> {
    const live = this.liveSessions.get(sessionId);
    if (!live) return false;
    await live.connection.agent.notify(AGENT_METHODS.session_cancel, {
      sessionId: live.acpSessionId
    });
    return true;
  }

  /**
  Close any live ACP connection, release transport, and clear session pin state.
  */
  async closeSession(sessionId: string): Promise<boolean> {
    const live = this.liveSessions.get(sessionId);
    this.liveSessions.delete(sessionId);
    const hadPin = this.pins.delete(sessionId);
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
