/** Review identity and effective grant selection for the managed MCP gateway. */
import { createHash } from "node:crypto";

interface ReviewedPolicy {
  role: string;
  policyFile: string;
  policyDigest: string;
  reviewed: Record<string, string[]>;
}

interface GatewayGrantState {
  role: string;
  policyFile: string;
  reviewed: Record<string, string[]>;
  grants: Record<string, string[]>;
  grantSelection?: Record<string, string[]> | undefined;
}

export function computePolicyDigest(
  role: string,
  rawContract: string,
  rawPolicy: string,
  catalogue: Record<string, Record<string, unknown>>,
  secretAvailability: Record<string, boolean>,
  commandCatalogue: string | null,
  runtimeGeneration: string,
  workspace: string
): string {
  return createHash("sha256")
    .update(role)
    .update("\n")
    .update(rawContract)
    .update("\n")
    .update(rawPolicy)
    .update("\n")
    .update(JSON.stringify(catalogue))
    .update("\n")
    .update(JSON.stringify(secretAvailability))
    .update("\n")
    .update(commandCatalogue ?? "")
    // The discovered surface belongs to the installed immutable backend
    // release and workspace, not just the policy that authorizes it.
    .update("\n")
    .update(runtimeGeneration)
    .update("\n")
    .update(workspace)
    .digest("hex");
}

/**
A positive review may be reused only for the same policy identity and when
every required server has a nonempty reviewed inventory. In particular a
degraded discovery result must not become a permanent negative cache.
*/
export function canReuseReviewedPolicy(
  prior: ReviewedPolicy | undefined,
  role: string,
  policyFile: string,
  policyDigest: string,
  requiredServers: readonly string[]
): prior is ReviewedPolicy {
  return (
    prior !== undefined &&
    prior.role === role &&
    prior.policyFile === policyFile &&
    prior.policyDigest === policyDigest &&
    requiredServers.every((server) => (prior.reviewed[server]?.length ?? 0) > 0)
  );
}

/**
Re-reviewing backend discovery must not silently widen an operator's
previous narrowing. An unmodified default follows the current reviewed
surface; an explicit subset retains only grants that remain available.
*/
export function previousGrantSelection(
  prior: GatewayGrantState | undefined,
  role: string,
  policyFile: string
): Record<string, string[]> | undefined {
  if (!prior || prior.role !== role || prior.policyFile !== policyFile)
    return undefined;
  if (prior.grantSelection) return prior.grantSelection;
  const followsDefault =
    Object.keys(prior.reviewed).length === Object.keys(prior.grants).length &&
    Object.entries(prior.reviewed).every(([server, tools]) => {
      const granted = new Set(prior.grants[server] ?? []);
      return (
        tools.length === granted.size &&
        tools.every((tool) => granted.has(tool))
      );
    });
  return followsDefault ? undefined : prior.grants;
}

export function availableGrantSelection(
  selection: Record<string, string[]>,
  reviewed: Record<string, string[]>
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(selection)
      .map(([server, tools]) => {
        const available = new Set(reviewed[server] ?? []);
        return [server, tools.filter((tool) => available.has(tool))] as const;
      })
      .filter(([, tools]) => tools.length > 0)
  );
}
