import assert from "node:assert/strict";
import test from "node:test";

import {
  doesProviderDeliverRoleMcp,
  providerCapabilities
} from "@simulatorlife/autodev-runtime/router/execution-contract";
import type { ExecutionContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";

const contract: ExecutionContract = {
  providers: {
    claude: { delegation: "xacpx", permissionMode: "native" },
    "opencli-chatgpt": {
      delegation: "none",
      permissionMode: "upstream",
      mcpIngress: "site-native"
    },
    gateway: {
      delegation: "xacpx",
      permissionMode: "configured",
      mcpIngress: "gateway"
    },
    sealed: {
      delegation: "none",
      permissionMode: "configured",
      mcpIngress: "none"
    }
  },
  roles: {}
};

test("a provider can delegate only when the contract routes it through XACPX", () => {
  assert.equal(providerCapabilities("claude", contract).subagentSpawn, true);
  assert.equal(
    providerCapabilities("opencli-chatgpt", contract).subagentSpawn,
    false
  );
  // A provider the contract does not declare is not granted delegation.
  assert.equal(providerCapabilities("missing", contract).subagentSpawn, false);
});

test("a provider's MCP ingress defaults to local and is read from the contract", () => {
  assert.equal(providerCapabilities("claude", contract).mcpIngress, "local");
  assert.equal(
    providerCapabilities("opencli-chatgpt", contract).mcpIngress,
    "site-native"
  );
});

test("a role's MCP surface is delivered only by a transport that can reach it", () => {
  for (const provider of ["claude", "gateway"]) {
    assert.equal(
      doesProviderDeliverRoleMcp(provider, ["serena", "github"], contract),
      true
    );
  }
  // A site-native transport reaches only the servers the site provides.
  assert.equal(
    doesProviderDeliverRoleMcp("opencli-chatgpt", ["github"], contract),
    true
  );
  assert.equal(
    doesProviderDeliverRoleMcp(
      "opencli-chatgpt",
      ["github", "serena"],
      contract
    ),
    false
  );
  assert.equal(
    doesProviderDeliverRoleMcp("sealed", ["github"], contract),
    false
  );
});
