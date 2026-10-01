import assert from "node:assert/strict";
import test from "node:test";

import {
  safeAutoDevAgentRole,
  safeAutoDevWorkspaceKey,
  validatedAutoDevOtelResourceAttributes,
  withAutoDevOtelResourceContext
} from "../src/shared/otel-resource-context.ts";

test("AutoDev OTel resource context is bounded, source-owned, and preserves other attributes", () => {
  const env = {
    OTEL_RESOURCE_ATTRIBUTES:
      "service.name=copilot,autodev.workspace=stale,custom.label=one%2Ctwo,autodev.agent.role=old"
  };
  const updated = withAutoDevOtelResourceContext(
    env,
    "SimulatorLife/AutoDev",
    "worker"
  );

  assert.equal(
    updated.OTEL_RESOURCE_ATTRIBUTES,
    "service.name=copilot,custom.label=one%2Ctwo,autodev.workspace=SimulatorLife%2FAutoDev,autodev.agent.role=worker"
  );
  assert.equal(
    env.OTEL_RESOURCE_ATTRIBUTES,
    "service.name=copilot,autodev.workspace=stale,custom.label=one%2Ctwo,autodev.agent.role=old",
    "per-request context must not mutate the parent environment"
  );
});

test("missing or unsafe context cannot inherit stale AutoDev resource identity", () => {
  const updated = withAutoDevOtelResourceContext(
    {
      OTEL_RESOURCE_ATTRIBUTES:
        "service.name=bridge,autodev.workspace=stale,autodev.agent.role=old"
    },
    "/Users/private/AutoDev",
    "unattributed"
  );

  assert.equal(updated.OTEL_RESOURCE_ATTRIBUTES, "service.name=bridge");
  assert.equal(safeAutoDevWorkspaceKey("file:///Users/private/AutoDev"), null);
  assert.equal(safeAutoDevWorkspaceKey("unknown"), null);
  assert.equal(safeAutoDevAgentRole("unattributed"), null);
  assert.equal(safeAutoDevAgentRole("worker"), "worker");
});

test("child MCP resource context forwards only validated AutoDev identity", () => {
  assert.equal(
    validatedAutoDevOtelResourceAttributes({
      OTEL_RESOURCE_ATTRIBUTES:
        "service.name=claude,autodev.workspace=SimulatorLife%2FAutoDev,autodev.agent.role=worker,custom.value=secret"
    }),
    "autodev.workspace=SimulatorLife%2FAutoDev,autodev.agent.role=worker"
  );
  assert.equal(
    validatedAutoDevOtelResourceAttributes({
      OTEL_RESOURCE_ATTRIBUTES:
        "autodev.workspace=%2FUsers%2Fprivate,autodev.agent.role=unknown"
    }),
    null
  );
  assert.equal(
    validatedAutoDevOtelResourceAttributes({
      OTEL_RESOURCE_ATTRIBUTES:
        "autodev.workspace=valid,autodev.workspace=%2FUsers%2Fprivate,autodev.agent.role=worker"
    }),
    "autodev.agent.role=worker",
    "a later invalid duplicate fails closed instead of falling back to an earlier value"
  );
});
