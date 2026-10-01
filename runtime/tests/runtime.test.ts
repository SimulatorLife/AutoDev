import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_PATHS,
  getDefaultConcurrencyManager,
  getDefaultExecutionContract,
  getDefaultPersistenceManager,
  getDefaultRouterLifecycle,
  ROUTES,
  ROUTING_POLICY
} from "../src/index.ts";

test("runtime exports canonical Control API paths", () => {
  assert.equal(CONTROL_API_PATHS.agents, "/control/agents");
  assert.equal(CONTROL_API_PATHS.providers, "/control/providers");
  assert.equal(CONTROL_API_PATHS.models, "/control/models");
  assert.equal(CONTROL_API_PATHS.mcps, "/control/mcps");
  assert.equal(CONTROL_API_PATHS.skills, "/control/skills");
  assert.equal(CONTROL_API_PATHS.hooks, "/control/hooks");
  assert.equal(CONTROL_API_PATHS.permissions, "/control/permissions");
  assert.equal(CONTROL_API_PATHS.prompts, "/control/prompts");
  assert.equal(CONTROL_API_PATHS.workspaces, "/control/workspaces");
  assert.equal(CONTROL_API_PATHS.routing, "/control/routing");
  assert.equal(CONTROL_API_PATHS.runtime, "/control/runtime");
});

test("runtime router exports policy and routes", () => {
  assert.ok(ROUTES);
  assert.ok(ROUTING_POLICY);
  assert.ok(typeof getDefaultConcurrencyManager === "function");
  assert.ok(typeof getDefaultExecutionContract === "function");
  assert.ok(typeof getDefaultRouterLifecycle === "function");
  assert.ok(typeof getDefaultPersistenceManager === "function");
});
