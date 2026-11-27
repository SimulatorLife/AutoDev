#!/usr/bin/env node

/**
The read-only tier of a role's sandbox, enforced where the tools run.

Codex cannot narrow the sandbox of a spawned child. The child thread is
created from the parent's configuration -- the child inherits the parent's
sandbox, and the role layer Codex applies on top of it carries the model,
the instructions, the skills and the features, but no sandbox -- so a role
that declares `read-only` runs with the parent session's sandbox and can
write to the workspace.

Codex does run a hook for every tool call, inside the thread that made it,
and the hook is told which role that thread is. That is the point where the
role's own declaration can be enforced: this hook refuses the calls a
read-only role may not make.

The refusal is the tool call's own permission decision, so the model is
told why the call did not run and can report what it needed instead.

The policy applies only to an AutoDev session (see `HookSessionOrigin`): a
Runtime-launched provider process or a turn served through the AutoDev
model router. The same projected hooks also run in unrelated native chats
(a Claude Code or Copilot chat in this repository), whose agent types are
the host's own subagent names, not AutoDev roles; those are never governed.

An explicitly assigned orchestrator role (or the explicit AutoDev root
alias on a native Codex turn without a role) uses the orchestrator policy.
A concrete model or missing role does not identify an AutoDev orchestrator.
Within a Runtime-launched read-only session, a child thread reporting a
write-capable role cannot widen the session's read-only tier. Hook policy is
defense in depth, not an execution grant.

The role's declaration is read from the installed execution contract, which
is the projection of the role files. A contract left behind by an older
install does not carry the declaration at all, and the tier would then be
absent rather than enforced; `bash scripts/install.sh --check` reports
that drift.
*/

import { readFileSync } from "node:fs";

import {
  evaluateOrchestratorToolCall,
  isRootOrchestratorModel
} from "@simulatorlife/autodev-runtime/agents/orchestrator-policy";
import { evaluateReadOnlyToolCall } from "@simulatorlife/autodev-runtime/agents/read-only-policy";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import { isReadOnlyRole } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

import { type HookDenialPolicy, logPreToolUseDenial } from "./hook-log.ts";
import {
  extractHookContext,
  extractHookToolCall,
  formatPreToolUseDenyResponse,
  type HookSessionOrigin,
  parseHookPayload
} from "./hook-payload.ts";

interface RoleSandboxEvaluation {
  readonly denied: boolean;
  readonly reason: string | null;
  readonly policy: HookDenialPolicy | null;
  readonly origin: HookSessionOrigin;
  readonly role: string | null;
  readonly model: string | null;
  readonly session: string | null;
  readonly turn: string | null;
  readonly tool: string | null;
  readonly toolInput: unknown;
}

function emptyEvaluation(): RoleSandboxEvaluation {
  return {
    denied: false,
    reason: null,
    policy: null,
    origin: "unmanaged",
    role: null,
    model: null,
    session: null,
    turn: null,
    tool: null,
    toolInput: undefined
  };
}

function evaluateRoleSandboxDetailed(
  rawInput: string,
  environment: NodeJS.ProcessEnv
): RoleSandboxEvaluation {
  const payload = parseHookPayload(rawInput);
  if (!payload) return emptyEvaluation();
  const context = extractHookContext(payload, environment);
  if (context.origin === "unmanaged") return emptyEvaluation();
  const extracted = extractHookToolCall(payload, environment);
  const toolName = extracted?.toolName ?? "";
  const toolInput = extracted?.toolInput;
  const role = context.role;
  const model = context.model;
  const session = context.sessionId;
  const turn = context.turnId;
  const tool = toolName || null;
  const call = { toolName, toolInput };
  if (
    role === "orchestrator" ||
    (role === null && isRootOrchestratorModel(model ?? ""))
  ) {
    const decision = evaluateOrchestratorToolCall(call);
    return decision.allowed
      ? emptyEvaluation()
      : {
          denied: true,
          reason: decision.reason ?? null,
          policy: "orchestrator-git-history",
          origin: context.origin,
          role: "root",
          model,
          session,
          turn,
          tool,
          toolInput
        };
  }

  const readOnlyRole =
    role !== null && isReadOnlyRole(role)
      ? role
      : context.runtimeRole !== null && isReadOnlyRole(context.runtimeRole)
        ? context.runtimeRole
        : null;
  if (readOnlyRole === null) return emptyEvaluation();

  const decision = evaluateReadOnlyToolCall(call);
  if (decision.allowed) return emptyEvaluation();
  return {
    denied: true,
    reason: decision.reason ?? null,
    policy: "read-only",
    origin: context.origin,
    role: readOnlyRole,
    model,
    session,
    turn,
    tool,
    toolInput
  };
}

export function evaluateRoleSandboxHook(
  rawInput: string,
  environment: NodeJS.ProcessEnv = process.env
): {
  readonly denied: boolean;
  readonly reason: string | null;
} {
  const { denied, reason } = evaluateRoleSandboxDetailed(rawInput, environment);
  return { denied, reason };
}

export function runRoleSandboxHook(
  raw = readFileSync(0, "utf8"),
  environment: NodeJS.ProcessEnv = process.env
): number {
  const outcome = evaluateRoleSandboxDetailed(raw, environment);
  if (!outcome.denied) return 0;
  const reason = outcome.reason ?? "This role runs in a read-only sandbox.";
  if (outcome.policy) {
    logPreToolUseDenial({
      hook: "role-sandbox",
      policy: outcome.policy,
      origin: outcome.origin,
      role: outcome.role,
      model: outcome.model,
      session: outcome.session,
      turn: outcome.turn,
      tool: outcome.tool,
      reason,
      toolInput: outcome.toolInput
    });
  }
  writeErrorLine(reason);
  process.stdout.write(`${formatPreToolUseDenyResponse(reason)}\n`);
  return 2;
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = runRoleSandboxHook();
  } catch (error) {
    // A hook that cannot run must not take the turn down with it: the
    // session's own sandbox is still the boundary, and a failed hook is
    // reported by the host as a failure rather than as a refusal.
    //
    // The failure is reported, because a hook that cannot read the contract
    // cannot enforce a role's sandbox and the operator has to know that the
    // tier is not being enforced rather than believe it is.
    writeErrorLine(
      `The role sandbox hook could not run: ${errorMessage(error)}`
    );
    process.exitCode = 0;
  }
}
