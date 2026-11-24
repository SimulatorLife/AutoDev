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

import { existsSync } from "node:fs";
import path from "node:path";

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
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  type Candidate,
  ROUTING_POLICY,
  type RoutingPolicy
} from "@simulatorlife/autodev-runtime/router/routing";
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

/**
In-memory registry pinning each session to its chosen provider and enforcing
role/provider eligibility boundaries (`github-worker` <-> `opencli`, all other
roles <-> ACP providers).
*/
export class XacpxSessionManager {
  private readonly pins = new Map<string, PinnedSessionRecord>();
  private readonly policy: RoutingPolicy;
  private readonly consoleSink: AcpConsoleSink | null;

  constructor(options?: {
    readonly policy?: RoutingPolicy;
    readonly consoleSink?: AcpConsoleSink | null;
  }) {
    this.policy = options?.policy ?? ROUTING_POLICY;
    this.consoleSink = options?.consoleSink ?? null;
  }

  getPinnedSession(sessionId: string): PinnedSessionRecord | null {
    return this.pins.get(sessionId) ?? null;
  }

  listPinnedSessions(): PinnedSessionRecord[] {
    return this.pins.values().toArray();
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
}
