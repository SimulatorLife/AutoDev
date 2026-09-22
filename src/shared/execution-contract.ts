import { readFileSync } from "node:fs";

export interface RoleContract {
  mcp: string[];
  webResearch?: { search?: boolean; fetch?: boolean };
  [key: string]: unknown;
}
export interface ProviderContract {
  spawnTools: string[];
  delegation: "native" | "codex-shim" | "bridge-native" | "none";
  permissionMode: string;
  [key: string]: unknown;
}
export interface ExecutionContract {
  roles: Record<string, RoleContract>;
  providers: Record<string, ProviderContract>;
  [key: string]: unknown;
}

export type SandboxMode = "read-only" | "workspace-write";

const CONTRACT_URL = new URL(
  "../../config/execution-contract.json",
  import.meta.url
);
const CONTRACT = Object.freeze(
  JSON.parse(readFileSync(CONTRACT_URL, "utf8")) as ExecutionContract
);

export const EXECUTION_CONTRACT = CONTRACT;

export function roleContract(role: unknown): RoleContract {
  const key =
    typeof role === "string" && role.trim()
      ? role.trim().toLowerCase()
      : "default";
  return CONTRACT.roles[key] ?? CONTRACT.roles.default ?? { mcp: [] };
}

export function providerContract(provider: string): ProviderContract {
  return (
    CONTRACT.providers[provider] ?? {
      spawnTools: [],
      delegation: "none",
      permissionMode: "unknown"
    }
  );
}

/**
 * Resolve the role's sandbox mode from the execution contract.
 *
 * The contract's `readOnly` flag is the authoritative source. The orchestrator
 * tier is never read-only by design (it owns the workspace-write budget for
 * the session); unknown / empty role names return null so callers can decide
 * whether to default to workspace-write or refuse.
 *
 *   readOnly: true               -> "read-only"
 *   readOnly: false, any tier    -> "workspace-write"
 *   unknown / empty role         -> null
 */
export function resolveSandboxMode(
  role: string | null | undefined
): SandboxMode | null {
  if (typeof role !== "string") return null;
  const key = role.trim().toLowerCase();
  if (!key) return null;
  const contract = CONTRACT.roles[key];
  if (!contract) return null;
  if (contract.readOnly === true) return "read-only";
  if (contract.readOnly === false) return "workspace-write";
  return null;
}
