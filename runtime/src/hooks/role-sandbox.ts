#!/usr/bin/env node

/**
 * The read-only tier of a role's sandbox, enforced where the tools run.
 *
 * Codex cannot narrow the sandbox of a spawned child. The child thread is
 * created from the parent's configuration -- the child inherits the parent's
 * sandbox, and the role layer Codex applies on top of it carries the model,
 * the instructions, the skills and the features, but no sandbox -- so a role
 * that declares `read-only` runs with the parent session's sandbox and can
 * write to the workspace.
 *
 * Codex does run a hook for every tool call, inside the thread that made it,
 * and the hook is told which role that thread is. That is the point where the
 * role's own declaration can be enforced: this hook refuses the calls a
 * read-only role may not make.
 *
 * The refusal is the tool call's own permission decision, so the model is
 * told why the call did not run and can report what it needed instead.
 *
 * The role's declaration is read from the installed execution contract, which
 * is the projection of the role files. A contract left behind by an older
 * install does not carry the declaration at all, and the tier would then be
 * absent rather than enforced; `bash scripts/install.sh --check` reports
 * that drift.
 */

import { readFileSync } from "node:fs";

import { evaluateReadOnlyToolCall } from "@simulatorlife/autodev-runtime/agents/read-only-policy";
import { isHookEntryPoint } from "@simulatorlife/autodev-runtime/hooks/entry-point";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import { roleSandboxMode } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";

interface HookPayload {
  readonly agent_type?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The role the tool call was made in.
 *
 * Null for the root session's own turns: the root session runs in the
 * session's sandbox, which is the policy the product declares, and nothing
 * here narrows it.
 */
function roleOf(payload: HookPayload): string | null {
  const role = payload.agent_type;
  if (typeof role !== "string") return null;
  const trimmed = role.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function evaluateRoleSandboxHook(rawInput: string): {
  readonly denied: boolean;
  readonly reason: string | null;
} {
  let payload: HookPayload;
  try {
    const parsed: unknown = JSON.parse(rawInput);
    if (!isRecord(parsed)) return { denied: false, reason: null };
    payload = parsed as HookPayload;
  } catch {
    // A payload that cannot be read is not a decision this hook can make. The
    // session's own sandbox still governs the call, so the call is left alone
    // rather than refused for a reason nobody can read.
    return { denied: false, reason: null };
  }

  const role = roleOf(payload);
  if (role === null) return { denied: false, reason: null };

  const declared = roleSandboxMode(role);
  if (declared !== "read-only") return { denied: false, reason: null };

  const toolName =
    typeof payload.tool_name === "string" ? payload.tool_name : "";
  const decision = evaluateReadOnlyToolCall({
    toolName,
    toolInput: payload.tool_input
  });
  if (decision.allowed) return { denied: false, reason: null };
  return { denied: true, reason: decision.reason };
}

export function runRoleSandboxHook(raw = readFileSync(0, "utf8")): number {
  const outcome = evaluateRoleSandboxHook(raw);
  if (!outcome.denied) return 0;
  const reason = outcome.reason ?? "This role runs in a read-only sandbox.";
  writeErrorLine(reason);
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    })}\n`
  );
  return 2;
}

if (isHookEntryPoint(import.meta.url)) {
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
