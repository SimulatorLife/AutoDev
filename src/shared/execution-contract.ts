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
