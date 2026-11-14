import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ControlApiProvidersResponse } from "@simulatorlife/autodev-core";

const CONTROL_API_TOKEN = "quota-axi-integration-test-token-0123456789";
const CONTROL_API_ACTOR = "quota-viewer";
const QUOTA_AXI_SNAPSHOT = fileURLToPath(
  new URL("../fixtures/quota-axi-snapshot.json", import.meta.url)
);
const RUNTIME_ROOT = fileURLToPath(new URL("../../runtime", import.meta.url));
const QUOTA_AXI_BIN = join(RUNTIME_ROOT, "node_modules", ".bin", "quota-axi");
const ROUTER_ENTRY = join(RUNTIME_ROOT, "src", "router", "server.ts");

test("the router publishes quota-axi CLI output unchanged on the providers API", async () => {
  const temporaryHome = realpathSync(
    mkdtempSync(join(tmpdir(), "autodev-quota-axi-test-"))
  );
  const expectedQuotaAxi = JSON.parse(
    execFileSync(QUOTA_AXI_BIN, ["--json", "--no-credential-refresh"], {
      cwd: RUNTIME_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: temporaryHome,
        QUOTA_AXI_SNAPSHOT,
        PATH: [path.dirname(process.execPath), process.env.PATH]
          .filter(Boolean)
          .join(path.delimiter)
      }
    })
  ) as NonNullable<ControlApiProvidersResponse["quotaAxi"]>;
  const portReservation = createServer();
  portReservation.listen(0, "127.0.0.1");
  await once(portReservation, "listening");
  const address = portReservation.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => {
    portReservation.close((error) => (error ? reject(error) : resolve()));
  });

  const child = spawn(process.execPath, [ROUTER_ENTRY], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_MODEL_ROUTER_HOST: "127.0.0.1",
      CODEX_MODEL_ROUTER_PORT: "0",
      CODEX_HOME: temporaryHome,
      CODEX_ROUTER_STATE_FILE: join(temporaryHome, "router-state.json"),
      OPENCLI_BROWSER_SETTING_FILE: join(temporaryHome, "opencli-browser.json"),
      AUTODEV_CONTROL_API_LISTEN_HOST: "127.0.0.1",
      AUTODEV_CONTROL_API_LISTEN_PORT: String(address.port),
      AUTODEV_CONTROL_API_TOKEN: CONTROL_API_TOKEN,
      AUTODEV_CONTROL_VIEWERS: CONTROL_API_ACTOR,
      AUTODEV_CONTROL_OPERATORS: "",
      QUOTA_AXI_SNAPSHOT
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let processOutput = "";
  child.stdout.on("data", (chunk: Buffer) => {
    processOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    processOutput += chunk.toString();
  });

  try {
    const endpoint = `http://127.0.0.1:${address.port}/control/providers`;
    let report: ControlApiProvidersResponse | null = null;
    let lastResponse = "no response";
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(
          `Router exited with ${child.exitCode}: ${processOutput}`
        );
      }
      try {
        const response = await fetch(endpoint, {
          headers: {
            authorization: `Bearer ${CONTROL_API_TOKEN}`,
            "x-autodev-actor": CONTROL_API_ACTOR
          }
        });
        if (response.ok) {
          const body = (await response.json()) as ControlApiProvidersResponse;
          if (body.quotaAxi !== null) {
            report = body;
            break;
          }
          lastResponse = `200 with null quotaAxi`;
        } else {
          lastResponse = `${response.status}: ${await response.text()}`;
        }
      } catch {
        // The router's HTTP listeners are started separately during boot.
      }
      await delay(100);
    }

    assert.ok(
      report,
      `quota-axi report was not published (${lastResponse}): ${processOutput}`
    );
    assert.equal(report.schema, "autodev-control-providers-v5");
    assert.equal(report.quotaAxi?.schemaVersion, 5);
    assert.ok(Number.isFinite(Date.parse(report.quotaAxi!.generatedAt)));
    assert.deepEqual(report.quotaAxi?.providers, expectedQuotaAxi.providers);
    assert.ok(
      report.quotaAxi!.providers.some(({ provider }) => provider === "agy")
    );
    const quotaProviderIds: readonly string[] = report.quotaAxi!.providers.map(
      ({ provider }) => provider
    );
    assert.equal(
      quotaProviderIds.includes("antigravity-gemini"),
      false,
      "quota-axi provider identities are not rewritten to AutoDev route ids"
    );

    const agy = report.quotaAxi!.providers.find(
      ({ provider }) => provider === "agy"
    );
    assert.ok(agy);
    assert.deepEqual(
      agy.windows.map(({ id, kind, percentRemaining, resetsAt }) => ({
        id,
        kind,
        percentRemaining,
        resetsAt
      })),
      [
        {
          id: "gemini_weekly",
          kind: "weekly",
          percentRemaining: 37.25,
          resetsAt: "2040-11-13T18:00:00.000Z"
        },
        {
          id: "unmeasured",
          kind: "unknown",
          percentRemaining: undefined,
          resetsAt: undefined
        }
      ]
    );
    assert.deepEqual(agy.state, {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-11-13T17:00:00.000Z",
      reused: true
    });
    assert.equal(agy.quotaSemantics?.status, "partial");
    assert.equal(agy.quotaSemantics?.effectiveAvailability[0]?.status, "known");
    assert.deepEqual(agy.quotaSemantics?.unresolvedWindowIds, ["unmeasured"]);

    const claude = report.quotaAxi!.providers.find(
      ({ provider }) => provider === "claude"
    );
    assert.ok(claude, "Claude quota windows reach the providers API");
    assert.deepEqual(
      claude.windows.map(({ id, kind, percentRemaining, resetsAt }) => ({
        id,
        kind,
        percentRemaining,
        resetsAt
      })),
      [
        {
          id: "five_hour",
          kind: "session",
          percentRemaining: 72,
          resetsAt: "2040-11-13T18:00:00.000Z"
        },
        {
          id: "seven_day",
          kind: "weekly",
          percentRemaining: 41,
          resetsAt: "2040-11-13T18:00:00.000Z"
        }
      ]
    );
    assert.ok(
      report.providers.every(
        (provider) =>
          !("quota" in provider) && !("quota" in (provider.health ?? {}))
      ),
      "quota reports remain separate from routing health"
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, delay(5000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
    rmSync(temporaryHome, { recursive: true, force: true });
  }
});
