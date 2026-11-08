import "@simulatorlife/autodev-runtime/router/http";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleControlApiRequest } from "@simulatorlife/autodev-runtime/control-api";
import {
  loadRouterState,
  setDefaultPersistenceManager
} from "@simulatorlife/autodev-runtime/router/persistence";
import { ROUTING_POLICY as routing } from "@simulatorlife/autodev-runtime/router/routing";

import { POST as postProviderRole } from "../../console/app/api/providers/[provider]/roles/[role]/route.ts";
import { POST as postProviderEnabled } from "../../console/app/api/providers/[provider]/route.ts";

/**
 * A role change made in the Console reaches routing, is persisted, and is
 * still in force after the router restarts.
 *
 * Every layer is the real one: the Console's form route, its Control API
 * client, the Runtime's Control API over HTTP, the router module's own
 * persistence (writing a state file of this test's), and the routing policy
 * the router selects with. An operator set Claude's orchestrator role to
 * Disabled and a session was routed to Claude anyway; each assertion below is
 * one of the places that change could have been lost.
 */

const SERVICE_TOKEN = "role-change-persistence-token-0123456789abcdef";
const ORCHESTRATOR_TIER = routing.config.orchestrator.tier;
const ENV_KEYS = [
  "AUTODEV_CONTROL_API_TOKEN",
  "AUTODEV_CONTROL_API_BASE_URL",
  "AUTODEV_CONTROL_VIEWERS",
  "AUTODEV_CONTROL_OPERATORS",
  "AUTODEV_OPENLIT_SECRET_FILE",
  "CODEX_ROUTER_STATE_FILE"
] as const;

function orchestratorCandidates(): string[] {
  return routing.providerPriority(ORCHESTRATOR_TIER, () => 0, "orchestrator");
}

function persistedOrchestrator(file: string): unknown {
  const saved = JSON.parse(readFileSync(file, "utf8")) as {
    roleAssignments?: Record<string, Record<string, unknown>>;
  };
  return saved.roleAssignments?.claude?.orchestrator;
}

/** A restart: the routing policy is emptied and read back from the file. */
function restartRouter(): void {
  routing.restoreRuntimeState({});
  assert.equal(
    loadRouterState(),
    true,
    "the restarted router read its state file"
  );
}

function consoleForm(
  path: string,
  fields: Record<string, string>
): Request & { nextUrl?: URL } {
  return new Request(`http://127.0.0.1:3300${path}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:3300",
      origin: "http://127.0.0.1:3300",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(fields).toString()
  });
}

async function setOrchestratorRole(priority: string): Promise<string> {
  const response = await postProviderRole(
    consoleForm("/api/providers/claude/roles/orchestrator", {
      provider: "claude",
      role: "orchestrator",
      priority,
      model: "claude-opus-5-5",
      reasoningEffort: "medium",
      returnTo: "/providers"
    }) as never,
    { params: Promise.resolve({ provider: "claude", role: "orchestrator" }) }
  );
  assert.equal(response.status, 303);
  return response.headers.get("location") ?? "";
}

async function setProviderDisabled(disabled: boolean): Promise<string> {
  const response = await postProviderEnabled(
    consoleForm("/api/providers/claude", {
      provider: "claude",
      disabled: String(disabled),
      returnTo: "/providers"
    }) as never,
    { params: Promise.resolve({ provider: "claude" }) }
  );
  assert.equal(response.status, 303);
  return response.headers.get("location") ?? "";
}

test("a Console role change reaches routing, is persisted, and survives restarts", async (t) => {
  const saved = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]])
  );
  const directory = mkdtempSync(join(tmpdir(), "autodev-role-persistence-"));
  const stateFile = join(directory, "codex-router-state.json");
  const prior = routing.runtimeState();
  const server: Server = createServer((request, response) => {
    void handleControlApiRequest(
      request,
      response,
      new URL(request.url ?? "/", "http://127.0.0.1").pathname
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    routing.restoreRuntimeState(prior);
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const { port } = server.address() as AddressInfo;
  process.env.CODEX_ROUTER_STATE_FILE = stateFile;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_API_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.AUTODEV_OPENLIT_SECRET_FILE = join(directory, "absent.env");
  delete process.env.AUTODEV_CONTROL_VIEWERS;
  delete process.env.AUTODEV_CONTROL_OPERATORS;

  // The state the session met: Claude the orchestrator's first choice.
  routing.restoreRuntimeState({});
  routing.setProviderAssignment("claude", "orchestrator", {
    priority: 1,
    model: "claude-opus-5-5",
    reasoningEffort: "medium"
  });
  assert.equal(orchestratorCandidates()[0], "claude");

  // Disabled from the Console: the router stops offering Claude at once...
  assert.doesNotMatch(await setOrchestratorRole("disabled"), /control=failed/u);
  assert.equal(
    routing.assignmentFor("claude", "orchestrator")?.priority,
    "disabled"
  );
  assert.ok(!orchestratorCandidates().includes("claude"));
  // ...the file says so...
  assert.deepEqual(persistedOrchestrator(stateFile), {
    priority: "disabled",
    model: "claude-opus-5-5",
    reasoningEffort: "medium"
  });
  // ...and a restart keeps it so.
  restartRouter();
  assert.ok(!orchestratorCandidates().includes("claude"));

  // Disabling and enabling the whole provider -- what the operator did that
  // morning -- leaves the role's own Disabled in place, across a restart too.
  assert.doesNotMatch(await setProviderDisabled(true), /control=failed/u);
  assert.doesNotMatch(await setProviderDisabled(false), /control=failed/u);
  assert.equal(
    routing.assignmentFor("claude", "orchestrator")?.priority,
    "disabled"
  );
  restartRouter();
  assert.ok(!orchestratorCandidates().includes("claude"));

  // Back at P2 from the Console: it rejoins as a second choice, and stays.
  assert.doesNotMatch(await setOrchestratorRole("2"), /control=failed/u);
  restartRouter();
  assert.equal(routing.assignmentFor("claude", "orchestrator")?.priority, 2);
  const groups = routing.effectiveProviderGroups(
    ORCHESTRATOR_TIER,
    "orchestrator"
  );
  assert.ok(
    groups.findIndex((group) => group.includes("claude")) >= 0 &&
      orchestratorCandidates().includes("claude")
  );
});

test("a role change that cannot be persisted is not left steering routing", async (t) => {
  const prior = routing.runtimeState();
  const restore = setDefaultPersistenceManager({
    async persistNow() {
      return false;
    }
  } as never);
  t.after(() => {
    setDefaultPersistenceManager(restore);
    routing.restoreRuntimeState(prior);
  });
  routing.restoreRuntimeState({});
  routing.setProviderAssignment("claude", "orchestrator", {
    priority: 1,
    model: "claude-opus-5-5"
  });
  const server: Server = createServer((request, res) => {
    void handleControlApiRequest(
      request,
      res,
      new URL(request.url ?? "/", "http://127.0.0.1").pathname
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const saved = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  t.after(() => {
    if (saved === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = saved;
  });
  const reply = await fetch(
    `http://127.0.0.1:${port}/control/providers/claude/roles/orchestrator`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "x-autodev-actor": "autodev-local",
        "content-type": "application/json"
      },
      body: JSON.stringify({ priority: "disabled", model: "claude-opus-5-5" })
    }
  );
  assert.equal(reply.status, 500);
  assert.equal(routing.assignmentFor("claude", "orchestrator")?.priority, 1);
});
