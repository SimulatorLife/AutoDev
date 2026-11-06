import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { reloadExecutionContract } from "@simulatorlife/autodev-runtime/router/subagents";

/**
 * Point the Runtime at a copy of the shipped execution contract in which one
 * provider declares no delegation path.
 *
 * Every shipped provider can delegate -- Codex natively, MiniMax and opencli
 * through Codex's own `exec` tool, the CLI bridges through their spawn shims
 * -- so the "a provider that cannot delegate is not an orchestrator" behaviour
 * is exercised against a contract that says one cannot, rather than by
 * pretending a real provider is incapable. Returns the restore function.
 */
export function useNonDelegatingContract(provider: string): () => void {
  const shipped = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../config/execution-contract.json"),
      "utf8"
    )
  ) as { providers: Record<string, Record<string, unknown>> };
  shipped.providers[provider] = {
    ...shipped.providers[provider],
    spawnTools: [],
    delegation: "none"
  };
  const directory = mkdtempSync(join(tmpdir(), "autodev-contract-"));
  const file = join(directory, "execution-contract.json");
  writeFileSync(file, JSON.stringify(shipped));
  const previous = process.env.CODEX_EXECUTION_CONTRACT_FILE;
  process.env.CODEX_EXECUTION_CONTRACT_FILE = file;
  reloadExecutionContract();
  return () => {
    if (previous === undefined)
      delete process.env.CODEX_EXECUTION_CONTRACT_FILE;
    else process.env.CODEX_EXECUTION_CONTRACT_FILE = previous;
    reloadExecutionContract();
    rmSync(directory, { recursive: true, force: true });
  };
}
