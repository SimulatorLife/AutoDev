import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { chatgptSupergatewayEnvironment } from "../src/config/render-chatgpt-supergateway.ts";
import { externalMcpBackend } from "../src/mcp/chatgpt-filesystem-sandbox.ts";
import { withXacpxDiscoveryProbe } from "../src/xacpx/discovery-probe.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test(
  "isolated XACPX discovery lists real vendor tools without altering live configuration",
  { timeout: 30_000 },
  async () => {
    const home = mkdtempSync(path.join(tmpdir(), "xacpx-discovery-test-"));
    const codexHome = path.join(home, ".codex");
    const workspace = path.join(home, "workspace");
    const liveDirectory = path.join(codexHome, "run", "xacpx");
    mkdirSync(liveDirectory, { recursive: true });
    mkdirSync(workspace);
    const environment = chatgptSupergatewayEnvironment(
      { home, codexHome, repositoryRoot },
      workspace,
      process.execPath,
      process.env.PATH ?? "/usr/bin:/bin"
    );
    const liveConfig = path.join(liveDirectory, "config.json");
    const liveState = path.join(liveDirectory, "state.json");
    // Simulate a stale inherited vendor config/state from a previous install.
    const staleEnvironment = {
      ...environment,
      XACPX_CONFIG: liveConfig,
      XACPX_STATE: liveState
    };
    writeFileSync(liveConfig, "live config sentinel");
    writeFileSync(liveState, "live state sentinel");
    let probeDirectory = "";
    try {
      await withXacpxDiscoveryProbe(
        workspace,
        repositoryRoot,
        staleEnvironment,
        async (probe) => {
          probeDirectory = path.dirname(probe.XACPX_ORCHESTRATION_SOCKET!);
          assert.equal(statSync(probeDirectory).mode & 0o777, 0o700);
          assert.notEqual(
            probe.XACPX_ORCHESTRATION_SOCKET,
            environment.XACPX_ORCHESTRATION_SOCKET
          );
          const backend =
            process.platform === "darwin"
              ? externalMcpBackend(
                  "xacpx",
                  repositoryRoot,
                  workspace,
                  process.execPath,
                  home,
                  codexHome,
                  { role: "orchestrator" }
                )
              : {
                  command: process.execPath,
                  args: [
                    path.join(repositoryRoot, "runtime/src/mcp/launcher.ts"),
                    "xacpx"
                  ]
                };
          const client = new Client({
            name: "xacpx-discovery-regression",
            version: "1.0.0"
          });
          const transport = new StdioClientTransport({
            ...backend,
            env: probe,
            cwd: workspace,
            stderr: "pipe"
          });
          try {
            await client.connect(transport, { timeout: 20_000 });
            const listed = new Set(
              (await client.listTools()).tools.map((tool) => tool.name)
            );
            for (const tool of [
              "delegate_request",
              "delegate_batch",
              "task_get",
              "task_list",
              "task_watch",
              "agent_list"
            ]) {
              assert.ok(listed.has(tool), tool);
            }
            // Exercise the real vendor tool dispatcher, not only the listing.
            const list = await client.callTool({
              name: "task_list",
              arguments: {}
            });
            assert.notEqual(list.isError, true);
            assert.deepEqual(list.structuredContent, { tasks: [] });
            const missing = await client.callTool({
              name: "task_get",
              arguments: { taskId: "missing-fixture-task" }
            });
            assert.notEqual(missing.isError, true);
            assert.deepEqual(missing.structuredContent, { task: null });
          } finally {
            await Promise.allSettled([client.close(), transport.close()]);
          }
        }
      );
      assert.ok(probeDirectory);
      assert.equal(existsSync(probeDirectory), false);
      assert.equal(readFileSync(liveConfig, "utf8"), "live config sentinel");
      assert.equal(readFileSync(liveState, "utf8"), "live state sentinel");

      await assert.rejects(
        withXacpxDiscoveryProbe(
          workspace,
          repositoryRoot,
          environment,
          (probe) => {
            probeDirectory = path.dirname(probe.XACPX_ORCHESTRATION_SOCKET!);
            return Promise.reject(new Error("fixture discovery failure"));
          }
        ),
        /fixture discovery failure/u
      );
      assert.equal(existsSync(probeDirectory), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
);
