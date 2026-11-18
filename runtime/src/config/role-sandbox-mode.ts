/**
 * The sandbox a role runs in.
 *
 * A role declares a sandbox in its own file, and the session declares one in
 * the portable source. A role may narrow the sandbox it runs in and never
 * widen it: the session's sandbox is the ceiling, and the effective mode is
 * the stricter of the two. That is the rule Codex applies to a spawned child,
 * and it is the rule the product's role declarations are read under.
 *
 * The mode itself is Core's vocabulary: `core/src/permissions/types.ts` owns
 * the product's names for the modes and the order they carry authority in.
 * This module owns the composition -- a role's declaration and a session's
 * policy -- so that the CLI and the Control API cannot reach different
 * answers.
 */

import {
  codexSandboxMode,
  effectiveSandboxMode,
  isCodexSandboxMode,
  productSandboxMode,
  type SandboxMode
} from "@simulatorlife/autodev-core";
import { readPermissionPolicyFile } from "@simulatorlife/autodev-data";

/**
 * The sandbox a role declares, in the product's vocabulary.
 *
 * Null when the role declares none: it inherits the session's sandbox. A
 * declaration the product does not support is null as well -- a role that
 * cannot be sandboxed the way it asks is not a role whose sandbox is known.
 */
export function declaredRoleSandboxMode(
  declared: string | null | undefined
): SandboxMode | null {
  return isCodexSandboxMode(declared) ? productSandboxMode(declared) : null;
}

/**
 * The sandbox a role-scoped session runs in, in the vocabulary the Codex CLI
 * configures a session in.
 *
 * The session's own sandbox is the policy the portable source declares, and a
 * role may narrow it but never widen it: a role that declares
 * `danger-full-access` under a workspace-write policy runs workspace-write,
 * exactly as a child spawned inside that session would.
 *
 * An empty string means the mode could not be observed -- neither the
 * declaration nor the policy could be read -- and the caller is left with the
 * configuration it already has rather than a mode nobody stated.
 */
export function roleSessionSandboxMode(
  declared: string | null | undefined,
  policyFile: string
): string {
  const policy = readPermissionPolicyFile(policyFile);
  const session = policy.status === "valid" ? policy.policy.sandboxMode : null;
  const effective = effectiveSandboxMode(
    declaredRoleSandboxMode(declared),
    session
  );
  return effective === null ? "" : codexSandboxMode(effective);
}
