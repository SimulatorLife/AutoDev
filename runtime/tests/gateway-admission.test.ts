import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempDisposableSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";

import { startChatgptBackendPool } from "../src/mcp/chatgpt-backend-pool.ts";
import { probeSupergateway } from "../src/mcp/chatgpt-supergateway-probe.ts";
import {
  createGatewayAdmission,
  ensureLocalAdmission
} from "../src/mcp/gateway-admission.ts";
import {
  getFinishedSpans,
  setTestExporter,
  shutdownTelemetryForTest
} from "../src/mcp/mcp-telemetry.ts";
import {
  admitWorkspace,
  issueSessionGrant,
  newGrantSession,
  SESSION_GRANT_META_KEY,
  verifySessionGrant
} from "../src/mcp/session-grant.ts";

const SECRET = "test-admission-secret";

test.before(async () => {
  await shutdownTelemetryForTest();
  setTestExporter(new InMemorySpanExporter());
});

test.after(async () => {
  await shutdownTelemetryForTest();
  setTestExporter(null);
});

test("catalogue discovery reuses the reviewed workspace, not the gateway secret directory", () => {
  using root = mkdtempDisposableSync(path.join(tmpdir(), "autodev-discovery-"));
  const home = realpathSync(root.path);
  const codexHome = path.join(home, ".codex");
  const reviewed = path.join(home, "reviewed");
  const adHoc = path.join(home, "ad-hoc");
  for (const directory of [codexHome, reviewed, adHoc]) mkdirSync(directory);
  ensureLocalAdmission(codexHome);
  const provisioned: string[] = [];
  const admission = createGatewayAdmission({
    repositoryRoot: path.resolve(import.meta.dirname, "../.."),
    node: process.execPath,
    home,
    codexHome,
    catalogueWorkspace: reviewed,
    runtimeSource: path.resolve(import.meta.dirname, "../src"),
    backend: (_server, _repository, workspace) => {
      provisioned.push(workspace);
      return { command: process.execPath, args: [] };
    }
  });
  assert.equal(admission.catalogueWorkspace, reviewed);
  assert.equal(admission.provision("commands", "worker", reviewed).cwd, reviewed);
  assert.equal(admission.provision("commands", "worker", adHoc).cwd, adHoc);
  assert.deepEqual(provisioned, [reviewed, adHoc]);
});

test("preflight exposes a safe phase when staged configuration cannot be read", async () => {
  using root = mkdtempDisposableSync(path.join(tmpdir(), "autodev-probe-phase-"));
  const phases: string[] = [];
  await assert.rejects(
    probeSupergateway(
      process.execPath,
      path.join(root.path, "missing.json"),
      {},
      (phase) => phases.push(phase)
    )
  );
  assert.deepEqual(phases, ["read staged gateway configuration"]);
});

test("a session grant verifies only unaltered, unexpired and correctly signed", () => {
  const claims = {
    workspace: "/work/a",
    role: "worker",
    session: newGrantSession()
  };
  const grant = issueSessionGrant(SECRET, claims, 1000, 500);
  assert.deepEqual(verifySessionGrant(SECRET, grant, 1200), {
    ...claims,
    expiresAt: 1500
  });
  assert.equal(verifySessionGrant(SECRET, grant, 1500), null, "expired");
  assert.equal(
    verifySessionGrant("other-secret", grant, 1200),
    null,
    "wrong key"
  );
  const [version, , mac] = grant.split(".", 3);
  const widened = Buffer.from(
    JSON.stringify({ ...claims, role: "orchestrator", expiresAt: 1500 })
  ).toString("base64url");
  assert.equal(
    verifySessionGrant(SECRET, `${version}.${widened}.${mac}`, 1200),
    null,
    "forged role"
  );
  for (const malformed of [
    undefined,
    42,
    "",
    "v1.x",
    `${grant}.extra`,
    "v2." + grant.slice(3)
  ])
    assert.equal(verifySessionGrant(SECRET, malformed, 1200), null);
});

test("any project directory is admitted; home, its ancestors and AutoDev homes are not", () => {
  using root = mkdtempDisposableSync(path.join(tmpdir(), "autodev-admit-"));
  const base = realpathSync(root.path);
  const home = path.join(base, "home");
  const codexHome = path.join(home, ".codex");
  const project = path.join(home, "Desktop", "something");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(codexHome, "src"), { recursive: true });
  const roots = { home, configuration: [codexHome] };
  assert.deepEqual(admitWorkspace(project, roots), { workspace: project });
  for (const refused of [
    home,
    base,
    codexHome,
    path.join(codexHome, "src"),
    path.join(base, "missing"),
    "relative"
  ])
    assert.ok("refused" in admitWorkspace(refused, roots), refused);
  writeFileSync(path.join(project, "file"), "");
  assert.ok("refused" in admitWorkspace(path.join(project, "file"), roots));
});

test("admission respects physical protected boundaries before configuration exists", () => {
  using root = mkdtempDisposableSync(
    path.join(tmpdir(), "autodev-admit-physical-")
  );
  const base = realpathSync(root.path);
  const home = path.join(base, "home");
  const project = path.join(home, "project");
  const alias = path.join(base, "alias");
  mkdirSync(path.join(project, "..allowed"), { recursive: true });
  symlinkSync(project, alias);
  const config = path.join(alias, "future", "config");
  assert.ok(
    "refused" in admitWorkspace(project, { home, configuration: [config] })
  );
  const protectedRoot = path.join(home, "protected");
  mkdirSync(path.join(protectedRoot, "..secret"), { recursive: true });
  const roots = { home, configuration: [protectedRoot] };
  assert.ok(
    "refused" in admitWorkspace(path.join(protectedRoot, "..secret"), roots)
  );
  assert.deepEqual(admitWorkspace(path.join(project, "..allowed"), roots), {
    workspace: path.join(project, "..allowed")
  });
  assert.deepEqual(admitWorkspace(alias, roots), { workspace: project });
  const dangling = path.join(base, "dangling");
  symlinkSync(path.join(base, "missing-target"), dangling);
  assert.ok(
    "refused" in
      admitWorkspace(project, {
        home,
        configuration: [path.join(dangling, "config")]
      })
  );
});

test(
  "admitted servers run each grant's calls in a backend confined to its workspace",
  {
    timeout: 15_000
  },
  async () => {
    using root = mkdtempDisposableSync(
      path.join(tmpdir(), "autodev-admitted-")
    );
    const base = realpathSync(root.path);
    const script = path.join(base, "backend.mjs");
    writeFileSync(
      script,
      String.raw`import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "initialize") {
    reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: "admitted-fixture", version: "1" } });
  } else if (request.method === "tools/list") {
    reply({ tools: [{ name: "where", inputSchema: { type: "object" } }] });
  } else if (request.method === "tools/call") {
    reply({ content: [{ type: "text", text: JSON.stringify({ cwd: process.cwd(),
      session: process.env.FIXTURE_SESSION ?? null, meta: request.params._meta ?? null }) }] });
  }
});
`
    );
    const catalogue = path.join(base, "catalogue");
    const alpha = path.join(base, "alpha");
    const beta = path.join(base, "beta");
    for (const directory of [catalogue, alpha, beta]) mkdirSync(directory);
    const provisioned: string[] = [];
    const pool = await startChatgptBackendPool(
      {
        version: 1,
        servers: {
          "local.worker.fixture": {
            kind: "admitted",
            role: "worker",
            server: "fixture",
            tools: ["where"]
          }
        }
      },
      {
        gatewayEnv: {},
        admission: {
          secret: SECRET,
          catalogueWorkspace: catalogue,
          provision: (server, role, workspace, session) => {
            provisioned.push(`${role}:${server}:${path.basename(workspace)}`);
            return {
              server,
              command: process.execPath,
              args: [script],
              cwd: workspace,
              ...(session && { env: { FIXTURE_SESSION: session } })
            };
          }
        }
      }
    );
    try {
      const url = `http://127.0.0.1:${pool.port}/mcp/local.worker.fixture`;
      const headers = {
        authorization: `Bearer ${pool.token}`,
        "content-type": "application/json"
      };
      const post = async (
        session: string | null,
        method: string,
        parameters: unknown
      ) => {
        const response = await fetch(url, {
          method: "POST",
          headers: session
            ? { ...headers, "mcp-session-id": session }
            : headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: parameters
          }),
          signal: AbortSignal.timeout(5000)
        });
        return {
          session: response.headers.get("mcp-session-id"),
          body: await response.json()
        };
      };
      const opened = await post(null, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {}
      });
      const session = opened.session!;
      const listed = await post(session, "tools/list", {});
      assert.deepEqual(
        listed.body.result.tools.map((tool: { name: string }) => tool.name),
        ["where"]
      );

      const call = (grant: unknown) =>
        post(session, "tools/call", {
          name: "where",
          arguments: {},
          _meta: { [SESSION_GRANT_META_KEY]: grant, progressToken: undefined }
        });
      const where = async (grant: string) => {
        const { body } = await call(grant);
        return JSON.parse(body.result.content[0].text);
      };
      const grantFor = (workspace: string, role = "worker") =>
        issueSessionGrant(SECRET, {
          workspace,
          role,
          session: newGrantSession()
        });

      const inAlpha = await where(grantFor(alpha));
      assert.equal(inAlpha.cwd, alpha);
      assert.equal(
        inAlpha.meta[SESSION_GRANT_META_KEY],
        undefined,
        "the grant never reaches the backend"
      );
      assert.equal((await where(grantFor(beta))).cwd, beta);
      assert.equal(
        (await where(grantFor(alpha))).cwd,
        alpha,
        "a workspace's backend is shared by its sessions"
      );
      // Each call's span names what its grant verified: the role, a bounded
      // workspace label (never the path) and the session only when it is the
      // Runtime's AutoDev session.
      await where(
        issueSessionGrant(SECRET, {
          workspace: beta,
          role: "worker",
          session: "runtime-session-1",
          runtimeSession: true
        })
      );
      const correlated = getFinishedSpans().map((span) => ({
        server: span.attributes["autodev.mcp.server"],
        role: span.attributes["autodev.agent.role"],
        workspace: span.attributes["autodev.workspace"],
        session: span.attributes["autodev.session.id"]
      }));
      assert.deepEqual(correlated, [
        { server: "fixture", role: "worker", workspace: "alpha", session: undefined },
        { server: "fixture", role: "worker", workspace: "beta", session: undefined },
        { server: "fixture", role: "worker", workspace: "alpha", session: undefined },
        {
          server: "fixture",
          role: "worker",
          workspace: "beta",
          session: "runtime-session-1"
        }
      ]);
      assert.ok(!JSON.stringify(correlated).includes(base));
      assert.deepEqual(provisioned, [
        "worker:fixture:catalogue",
        "worker:fixture:alpha",
        "worker:fixture:beta"
      ]);

      assert.match(
        (await call(undefined)).body.error.message,
        /valid AutoDev session grant/u
      );
      assert.match(
        (await call("v1.forged.grant")).body.error.message,
        /valid AutoDev session grant/u
      );
      assert.match(
        (await call(grantFor(alpha, "orchestrator"))).body.error.message,
        /orchestrator role, not worker/u
      );
      assert.match(
        (
          await call(
            issueSessionGrant("stolen-elsewhere", {
              workspace: alpha,
              role: "worker",
              session: newGrantSession()
            })
          )
        ).body.error.message,
        /valid AutoDev session grant/u
      );
    } finally {
      await pool.close();
    }
  }
);
