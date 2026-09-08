import { readFileSync } from "node:fs";

const CONTRACT_URL = new URL("../execution-contract.json", import.meta.url);
const CONTRACT = Object.freeze(JSON.parse(readFileSync(CONTRACT_URL, "utf8")));

export const EXECUTION_CONTRACT = CONTRACT;

export function roleContract(role) {
  const key = typeof role === "string" && role.trim() ? role.trim().toLowerCase() : "default";
  return CONTRACT.roles[key] ?? CONTRACT.roles.default;
}

export function providerContract(provider) {
  return CONTRACT.providers[provider] ?? { spawnTools: [], permissionMode: "unknown" };
}
