import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface RoleContract {
  mcp: string[];
  webResearch?: { search?: boolean; fetch?: boolean };
  [key: string]: unknown;
}
export interface ProviderContract {
  spawnTools: string[];
  permissionMode: string;
  [key: string]: unknown;
}
export interface ExecutionContract {
  roles: Record<string, RoleContract>;
  providers: Record<string, ProviderContract>;
  [key: string]: unknown;
}

const contractUrls = [
  new URL("../../scripts/codex/execution-contract.json", import.meta.url),
  new URL("../../hooks/codex/execution-contract.json", import.meta.url),
];
const CONTRACT_URL = contractUrls.find((url) => existsSync(fileURLToPath(url))) ?? contractUrls[0]!;
const CONTRACT = Object.freeze(JSON.parse(readFileSync(CONTRACT_URL, "utf8")) as ExecutionContract);

export const EXECUTION_CONTRACT = CONTRACT;

export function roleContract(role: unknown): RoleContract {
  const key = typeof role === "string" && role.trim() ? role.trim().toLowerCase() : "default";
  return CONTRACT.roles[key] ?? CONTRACT.roles.default ?? { mcp: [] };
}

export function providerContract(provider: string): ProviderContract {
  return CONTRACT.providers[provider] ?? { spawnTools: [], permissionMode: "unknown" };
}
