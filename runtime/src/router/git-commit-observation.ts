/**
 * Router-event integration for source-confirmed Git output metrics.
 *
 * The provider process executes Git and receives the bounded commit
 * identity from `gitCommitIdentityEnv`. The Router only discovers changed
 * commit objects at selected/result boundaries; identity and all actor
 * dimensions are read back from each commit by the telemetry observer.
 */

import path from "node:path";

import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import { isDirectory } from "@simulatorlife/autodev-runtime/shared/resolve-workspace";
import { safeAutoDevWorkspaceKey } from "@simulatorlife/autodev-runtime/telemetry/resource-context";

import {
  createWorkspaceCommitObserver,
  gitCommitObservationToRecordOptions,
  type WorkspaceCommitError,
  type WorkspaceCommitObserver
} from "../telemetry/workspace-commit-observer.ts";
import type { RecordGitCommitOptions } from "./telemetry.ts";

const OBSERVABLE_PHASES = new Set(["selected", "result"]);
const MAX_WORKSPACE_OBSERVERS = 128;
const observers = new Map<string, WorkspaceCommitObserver>();
const reportedFailures = new Map<string, WorkspaceCommitError["kind"]>();

interface WorkspaceContext {
  readonly key: string;
  readonly repositoryRoot: string;
}

function workspaceContext(
  workspaceKey: string | null,
  repositoryRoot: string | null
): WorkspaceContext | null {
  const key = safeAutoDevWorkspaceKey(workspaceKey);
  if (!key || !isDirectory(repositoryRoot)) return null;
  return { key, repositoryRoot: path.resolve(repositoryRoot) };
}

function observerFor(
  workspace: WorkspaceContext
): WorkspaceCommitObserver | null {
  const key = `${workspace.key}\u0000${workspace.repositoryRoot}`;
  const existing = observers.get(key);
  if (existing) return existing;
  if (observers.size >= MAX_WORKSPACE_OBSERVERS) return null;

  const observer = createWorkspaceCommitObserver({
    workspaceKey: workspace.key,
    repositoryRoot: workspace.repositoryRoot
  });
  observers.set(key, observer);
  return observer;
}

function reportObservationFailure(
  workspace: WorkspaceContext,
  error: WorkspaceCommitError,
  routerInstanceId: string
): void {
  const key = `${workspace.key}\u0000${workspace.repositoryRoot}`;
  if (reportedFailures.get(key) === error.kind) return;
  if (
    !reportedFailures.has(key) &&
    reportedFailures.size >= MAX_WORKSPACE_OBSERVERS
  ) {
    return;
  }
  reportedFailures.set(key, error.kind);
  writeErrorLine(
    JSON.stringify({
      schema: "autodev-router-event-v1",
      timestamp: new Date().toISOString(),
      routerInstanceId,
      requestId: null,
      phase: "git_commit_observation_unavailable",
      outcome: "error",
      failureClass: error.kind
    })
  );
}

/**
 * Observe one source-owned workspace boundary without delaying the provider
 * response. The observer serializes events for the same working tree; the
 * shared metric emitter owns cross-observer SHA idempotency.
 */
export function createRouterWorkspaceGitCommitObserver(
  recordGitCommit: (options: RecordGitCommitOptions) => boolean
): (args: {
  readonly phase: string;
  /** Canonical bounded workspace identity from the Router event. */
  readonly workspaceKey: string | null;
  /** Actual source-resolved repository root, never the display-only cwd label. */
  readonly repositoryRoot: string | null;
  readonly routerInstanceId: string;
}) => Promise<void> {
  return (args) => {
    if (!OBSERVABLE_PHASES.has(args.phase)) return Promise.resolve();
    const workspace = workspaceContext(args.workspaceKey, args.repositoryRoot);
    if (!workspace) return Promise.resolve();
    const observer = observerFor(workspace);
    if (!observer) {
      reportObservationFailure(
        workspace,
        {
          kind: "observer_limit",
          reason: "active workspace observer bound was reached"
        },
        args.routerInstanceId
      );
      return Promise.resolve();
    }

    return observer
      .observe()
      .then((observation) => {
        for (const commit of observation.recordableCommits) {
          recordGitCommit(
            gitCommitObservationToRecordOptions(observation, commit)
          );
        }
        if (observation.error) {
          reportObservationFailure(
            workspace,
            observation.error,
            args.routerInstanceId
          );
        } else {
          reportedFailures.delete(
            `${workspace.key}\u0000${workspace.repositoryRoot}`
          );
        }
        return undefined;
      })
      .catch(() => {
        reportObservationFailure(
          workspace,
          {
            kind: "head_unreadable",
            reason: "workspace Git observation failed"
          },
          args.routerInstanceId
        );
      });
  };
}

/** Test seam for the bounded process-local observer registry. */
export function resetRouterWorkspaceGitObserversForTest(): void {
  observers.clear();
  reportedFailures.clear();
}
