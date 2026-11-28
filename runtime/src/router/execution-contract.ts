/**
The Runtime's read of the canonical execution contract, and what it says
about each provider's transport.
*/
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type ExecutionContract,
  type ProviderMcpIngress,
  SITE_NATIVE_MCP_SERVERS
} from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

export interface ProviderCapabilities {
  subagentSpawn: boolean;
  /**
  How this provider's transport reaches the role-scoped MCP surfaces.
  */
  mcpIngress: ProviderMcpIngress;
}

/**
The in-memory read of the execution contract document. The shared contract
type uses `[key: string]: unknown` for both providers and roles, which keeps
unknown fields addressable without resorting to `any`.

`observed` records whether the last read observed a contract.

The accessor falls back to an empty contract when the read fails, so an
empty contract and a contract that could not be read look the same to a
caller. They are not the same claim: the first says the contract declares no
roles, and the second says nobody read it. A count over the contract's roles
is over a scope that was only partly read when the read failed -- the
number is exactly right for the roles that were read and merely incomplete
for the ones that were not -- so a caller that counts them has to be able to
tell the two apart.
*/
const contractRead: { contract: ExecutionContract | null; observed: boolean } =
  { contract: null, observed: false };

/**
Whether the execution contract was observed by the last read.

True when a contract was read and parsed, and false when the read failed
and the accessor fell back to an empty contract. A contract set for a test
is observed: the caller was given the document, so nothing was left unread.
*/
export function isExecutionContractObserved(): boolean {
  return contractRead.observed;
}

/**
The execution-contract file a read resolves to now, or `null` when none
exists.

Exposed because a mutation has to write the file it read. Reading the contract
through a cached accessor and writing through a separately-computed path is how
a change lands in one file while the process keeps serving another, and the
mutation would report success for an edit nothing reads.

Resolution is repeated rather than remembered, so the path is the one this
call would use now -- including after a reload invalidated the document.
*/
export function executionContractFile(): string | null {
  const codexHome =
    process.env.CODEX_HOME ?? `${process.env.HOME ?? process.cwd()}/.codex`;
  const defaultContract = path.join(
    resolveRuntimeSourceRoot(import.meta.dirname),
    "config",
    "execution-contract.json"
  );
  return (
    [
      process.env.CODEX_EXECUTION_CONTRACT_FILE,
      defaultContract,
      `${codexHome}/config/execution-contract.json`
    ].find(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        candidate.length > 0 &&
        existsSync(candidate)
    ) ?? null
  );
}

export function getDefaultExecutionContract(): ExecutionContract {
  if (contractRead.contract) {
    contractRead.observed = true;
    return contractRead.contract;
  }
  const file = executionContractFile();
  if (file) {
    try {
      const contract = JSON.parse(
        readFileSync(file, "utf8")
      ) as ExecutionContract;
      contractRead.contract = contract;
      contractRead.observed = true;
      return contract;
    } catch {
      /*
      fallthrough to empty
      */
    }
  }
  contractRead.observed = false;
  return { roles: {}, providers: {} };
}

export function setExecutionContractForTests(
  contract: ExecutionContract | null
): void {
  contractRead.contract = contract;
  // A contract handed to the runtime was observed; a null contract drops the
  // cache so the next read goes to the file, which has not been read yet.
  contractRead.observed = contract !== null;
}

/**
Drop the cached contract so the next read comes from disk.

Called after a successful write and nowhere else. A cache that outlives its
own mutation is the difference between an assignment that takes effect and one
that appears to have succeeded and then quietly does nothing.
*/
export function reloadExecutionContract(): void {
  contractRead.contract = null;
  contractRead.observed = false;
}

export function providerCapabilities(
  provider: string,
  executionContract: ExecutionContract = getDefaultExecutionContract()
): ProviderCapabilities {
  // The canonical execution contract is the single source of truth for whether
  // a provider can orchestrate children through the shared XACPX MCP gateway,
  // and for how its transport reaches the role-scoped MCP surfaces at all.
  const contract = executionContract.providers?.[provider];
  const delegation = contract?.delegation;
  const mcpIngress = contract?.mcpIngress ?? "local";
  return {
    subagentSpawn: delegation === "xacpx",
    mcpIngress
  };
}

/**
Whether a provider's transport can deliver a role's MCP surface.

A `gateway` or `local` transport reaches every role's MCP surface. A
`site-native` transport reaches only the roles whose tools the site itself
provides. A transport with no ingress reaches no role that needs tools.
*/
export function doesProviderDeliverRoleMcp(
  provider: string,
  roleMcpServers: readonly string[],
  executionContract: ExecutionContract = getDefaultExecutionContract()
): boolean {
  const ingress = providerCapabilities(provider, executionContract).mcpIngress;
  if (ingress === "gateway" || ingress === "local") return true;
  if (ingress === "site-native") {
    return roleMcpServers.every((server) =>
      SITE_NATIVE_MCP_SERVERS.includes(server)
    );
  }
  return false;
}
