import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_METHODS,
  AgentApp,
  PROTOCOL_VERSION
} from "@agentclientprotocol/sdk";
import {
  ACP_PIN_LEDGER_SCHEMA,
  extractCoordinatorThreadId,
  parseAcpPinLedger
} from "@simulatorlife/autodev-core";

import {
  ensureLocalAdmission,
  localAdmissionPaths,
  readLocalAdmission
} from "../src/mcp/gateway-admission.ts";
import { resolveGatewayClient } from "../src/mcp/gateway-client.ts";
import { verifySessionGrant } from "../src/mcp/session-grant.ts";
import { XacpxSessionManager } from "../src/xacpx/manager.ts";
import { AcpPinLedgerPublisher, acpPinsFile } from "../src/xacpx/pin-ledger.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function answeringAgent(acpSessionId: string): AgentApp {
  return new AgentApp({ name: "acp-pin-ledger-agent" })
    .onRequest(AGENT_METHODS.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false }
    }))
    .onRequest(AGENT_METHODS.session_new, async () => ({
      sessionId: acpSessionId
    }))
    .onRequest(AGENT_METHODS.session_prompt, async () => ({
      stopReason: "end_turn"
    }))
    .onRequest(AGENT_METHODS.session_close, async () => ({}));
}

test("XacpxSessionManager publishes private ACP pin ledger across create, connect, and close", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-pin-ledger-"));
  try {
    ensureLocalAdmission(home);
    const ledgerPath = acpPinsFile(home);
    const manager = new XacpxSessionManager({
      acpTransportFactory: () => ({
        target: answeringAgent("01a0b677-0000-7000-8000-000000000042")
      }),
      pinLedger: new AcpPinLedgerPublisher(ledgerPath)
    });

    const result = await manager.executeTurn(
      {
        sessionId: "child-worker-xyz",
        parentSessionId:
          "local:orchestrator:AutoDev:01a0b662-0000-7000-8000-000000000001",
        role: "worker",
        cwd: REPO_ROOT,
        systemPrompt: "Worker",
        promptOrTask: "Inspect status"
      },
      { ...process.env, CODEX_HOME: home }
    );
    assert.equal(result.acpSessionId, "01a0b677-0000-7000-8000-000000000042");

    const activeRaw = JSON.parse(readFileSync(ledgerPath, "utf8")) as unknown;
    const activeLedger = parseAcpPinLedger(activeRaw);
    assert.ok(activeLedger);
    assert.equal(activeLedger.schema, ACP_PIN_LEDGER_SCHEMA);
    assert.equal(activeLedger.pins.length, 1);
    assert.equal(activeLedger.pins[0]?.sessionId, "child-worker-xyz");
    assert.equal(
      activeLedger.pins[0]?.acpSessionId,
      "01a0b677-0000-7000-8000-000000000042"
    );
    assert.equal(activeLedger.pins[0]?.closedAt, null);
    assert.equal(statSync(ledgerPath).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(ledgerPath)).mode & 0o777, 0o700);

    await manager.closeSession("child-worker-xyz");
    assert.equal(manager.getPinnedSession("child-worker-xyz"), null);
    const closedLedger = parseAcpPinLedger(
      JSON.parse(readFileSync(ledgerPath, "utf8"))
    );
    assert.ok(closedLedger);
    assert.equal(closedLedger.pins.length, 1);
    assert.ok(closedLedger.pins[0]?.closedAt !== null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveGatewayClient carries CODEX_THREAD_ID in launch grants without claiming runtimeSession", () => {
  const home = mkdtempSync(path.join(tmpdir(), "autodev-gateway-thread-"));
  try {
    ensureLocalAdmission(home);
    const gatewayFile = path.join(
      path.dirname(localAdmissionPaths(home).keyFile),
      "gateway.json"
    );
    writeFileSync(gatewayFile, JSON.stringify({ mcpPort: 4101 }), {
      mode: 0o600
    });
    chmodSync(gatewayFile, 0o600);
    const admission = readLocalAdmission(home);
    assert.ok(admission);
    const rootThreadId = "01a0b662-0000-7000-8000-000000000001";
    const resolved = resolveGatewayClient({
      server: "xacpx",
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CODEX_HOME: home,
        CODEX_THREAD_ID: rootThreadId
      }
    });
    const claims = verifySessionGrant(admission.secret, resolved.grant());
    assert.ok(claims);
    assert.equal(claims.session, rootThreadId);
    assert.equal(claims.runtimeSession, undefined);
    assert.equal(
      extractCoordinatorThreadId(
        `local:${claims.role}:AutoDev:${claims.session}`
      ),
      rootThreadId
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
