import assert from "node:assert/strict";
import test from "node:test";

import {
  checkProvider,
  patchAgentModel,
  patchMcpServer,
  patchModel,
  patchProviderEnabled,
  patchProviderLimits,
  patchProviderRole,
  patchWorkspace,
  postWorkspacePlaytestApproval,
  postWorkspacePlaytestRevocation,
  resetProviderSettings
} from "../src/lib/server/control-api.ts";

const CONFIG = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "mutation-validation-test-token"
};

function stubFetch(payload: unknown): typeof fetch {
  return (async () => Response.json(payload)) as typeof fetch;
}

test("Control API mutation fetchers fail closed when Runtime responses drift from Core schemas", async () => {
  const missingReconciliation = {
    schema: "autodev-control-provider-role-v3",
    provider: "codex",
    role: "orchestrator",
    priority: 1,
    model: "gpt-6",
    previous: null,
    actor: "autodev-local"
  };

  const cases = await Promise.all([
    patchProviderRole(
      "codex",
      "orchestrator",
      { priority: 1, model: "gpt-6" },
      CONFIG,
      { fetchImpl: stubFetch(missingReconciliation) }
    ),
    patchAgentModel("codex", "worker", null, CONFIG, {
      fetchImpl: stubFetch({
        schema: "autodev-control-provider-agent-model-v1",
        provider: "codex",
        role: "worker",
        model: null,
        previous: null,
        actor: "autodev-local"
      })
    }),
    resetProviderSettings(CONFIG, {
      fetchImpl: stubFetch({
        schema: "autodev-control-providers-reset-v1",
        actor: "autodev-local"
      })
    }),
    patchProviderLimits(
      "claude",
      { perSession: 2, acrossSessions: null },
      CONFIG,
      {
        fetchImpl: stubFetch({
          schema: "autodev-control-provider-limits-v1",
          provider: "claude",
          agentLimits: { perSession: 2, acrossSessions: null },
          previous: null,
          actor: "autodev-local"
        })
      }
    ),
    patchProviderEnabled("claude", true, CONFIG, {
      fetchImpl: stubFetch({
        schema: "autodev-control-provider-enabled-v1",
        provider: "claude",
        disabled: true,
        previous: false,
        actor: "autodev-local"
      })
    }),
    checkProvider("claude", CONFIG, {
      fetchImpl: stubFetch({
        schema: "autodev-control-provider-check-v1",
        provider: "claude"
      })
    }),
    patchModel("sonnet", false, CONFIG, {
      fetchImpl: stubFetch({
        schema: "autodev-control-model-v1",
        model: "sonnet",
        enabled: false,
        previous: true,
        actor: "autodev-local"
      })
    }),
    patchMcpServer(
      "github",
      { expectedRevision: "a".repeat(64), launch: {} },
      CONFIG,
      {
        fetchImpl: stubFetch({
          schema: "autodev-control-mcp-server-patch-v2",
          name: "github"
        })
      }
    ),
    patchWorkspace(
      "SimulatorLife",
      "AutoDev",
      { expectedRevision: "a".repeat(64), enabled: true },
      CONFIG,
      {
        fetchImpl: stubFetch({
          schema: "autodev-control-workspace-patch-v2",
          id: "SimulatorLife/AutoDev"
        })
      }
    ),
    postWorkspacePlaytestApproval(
      "SimulatorLife/AutoDev",
      { approved: true },
      CONFIG,
      {
        fetchImpl: stubFetch({
          schema: "autodev-control-workspace-playtest-approval-v1",
          workspaceId: "SimulatorLife/OtherRepo",
          workspaceEnabled: true,
          approval: null
        })
      }
    ),
    postWorkspacePlaytestRevocation(
      "SimulatorLife/AutoDev",
      { reason: "stale" },
      CONFIG,
      {
        fetchImpl: stubFetch({
          schema: "autodev-control-workspace-playtest-approval-v1",
          workspaceId: "SimulatorLife/OtherRepo",
          workspaceEnabled: true,
          approval: null
        })
      }
    )
  ]);

  for (const result of cases) {
    assert.equal(result.kind, "invalid-response");
  }
});
