import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import {
  makeRequest,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "m".repeat(64);
const OPERATOR_ACTOR = "mcp-applied-operator";

/**
 * The canonical declaration the test applies.
 *
 * Two servers, one stdio and one http, so the comparison has to read both
 * shapes of launch configuration rather than one shape it happens to know.
 */
const DECLARATION = `{
  "mcpServers": {
    "lsp": {
      "command": "bash",
      "args": ["-lc", "exec lsp"]
    },
    "docs": {
      "url": "https://example.test/mcp",
      "bearer_token_env_var": "DOCS_TOKEN"
    }
  },
  "codexcli": {
    "mcpServers": {
      "lsp": {
        "command": "bash",
        "args": ["-lc", "exec lsp"]
      },
      "docs": {
        "url": "https://example.test/mcp",
        "bearer_token_env_var": "DOCS_TOKEN"
      }
    }
  }
}`;

/** The catalogue the installer writes from that declaration. */
const APPLIED = {
  lsp: { command: "bash", args: ["-lc", "exec lsp"] },
  docs: {
    url: "https://example.test/mcp",
    bearer_token_env_var: "DOCS_TOKEN"
  }
};

function request(method: string, url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method,
    url,
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-autodev-actor": OPERATOR_ACTOR
    }
  }) as unknown as IncomingMessage;
}

/**
 * A repository root and a Codex home, with the canonical declaration written
 * and the applied catalogue written from `catalogue`.
 *
 * `catalogue` of `null` writes no catalogue at all, which is the state of a
 * machine that has never had the MCP configuration applied.
 */
function fixture(catalogue: unknown): {
  readonly repositoryRoot: string;
  readonly codexHome: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-mcp-applied-"));
  const repositoryRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex");
  mkdirSync(path.join(repositoryRoot, ".rulesync"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, ".rulesync", "mcp.jsonc"),
    DECLARATION,
    "utf8"
  );
  if (catalogue !== null) {
    mkdirSync(path.join(codexHome, "provider-runtime"), { recursive: true });
    writeFileSync(
      path.join(codexHome, "provider-runtime", "mcp-servers.json"),
      typeof catalogue === "string" ? catalogue : JSON.stringify(catalogue),
      "utf8"
    );
  }
  return { repositoryRoot, codexHome };
}

/**
 * The credential the Control API requires, installed for the duration of the
 * read and removed again afterwards.
 */
function withControlApiCredential<T>(run: () => Promise<T>): Promise<T> {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  return run().finally(() => {
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  });
}

async function readApplied(options: {
  readonly repositoryRoot: string;
  readonly codexHome: string;
}): Promise<Record<string, unknown>> {
  const response = responseRecorder();
  await withControlApiCredential(async () => {
    await handleControlApiRequest(
      request("GET", "/control/mcp-applied"),
      response,
      "/control/mcp-applied",
      options
    );
  });
  assert.equal(response.statusCode, 200);
  const body = responseBody(response);
  assert.ok(body, "the applied read must answer with a body");
  return body;
}

test("the applied MCP read converges when the applied catalogue matches the declaration", async () => {
  const options = fixture(APPLIED);
  const body = await readApplied(options);
  assert.equal(body.schema, "autodev-control-mcp-applied-v2");
  assert.equal(body.declarationSource, ".rulesync/mcp.jsonc");
  assert.equal(body.target, "codexcli");
  assert.equal(body.available, true);
  assert.deepEqual(
    (body.servers as { name: string }[]).map((server) => server.name),
    ["docs", "lsp"]
  );
  // The launch configuration is published as it was applied, not as a summary.
  const docs = (
    body.servers as { name: string; bearerTokenEnvVar: string }[]
  ).find((server) => server.name === "docs");
  assert.equal(docs?.bearerTokenEnvVar, "DOCS_TOKEN");

  const reconciliation = body.reconciliation as {
    status: { convergence: string };
  };
  // The declaration and the applied catalogue say the same thing, so the
  // runtime's own verdict is that they have converged.
  assert.equal(reconciliation.status.convergence, "converged");
});

test("the applied MCP read reports a divergence when the applied catalogue drifts", async () => {
  const options = fixture({
    lsp: { command: "bash", args: ["-lc", "exec a different lsp"] },
    docs: APPLIED.docs
  });
  const body = await readApplied(options);
  const reconciliation = body.reconciliation as {
    status: {
      convergence: string;
      desiredGeneration: string;
      observedGeneration: string;
    };
  };
  // The applied launch configuration is not the declared one, so the two
  // generations differ and the runtime says so rather than reporting a
  // convergence it did not observe.
  assert.equal(reconciliation.status.convergence, "pending");
  assert.notEqual(
    reconciliation.status.desiredGeneration,
    reconciliation.status.observedGeneration
  );
});

test("the applied MCP read reports an unapplied configuration as unobserved", async () => {
  const options = fixture(null);
  const body = await readApplied(options);
  assert.equal(body.available, false);
  assert.deepEqual(body.servers, []);
  const reconciliation = body.reconciliation as {
    status: { convergence: string; observedGeneration: string | null };
  };
  // Nothing has been applied, so there is no observed generation to compare
  // against and the verdict is unknown rather than converged.
  assert.equal(reconciliation.status.convergence, "not-observed");
  assert.equal(reconciliation.status.observedGeneration, null);
});

test("the applied MCP read reports an unreadable catalogue as an error", async () => {
  const options = fixture("{not json");
  const body = await readApplied(options);
  assert.equal(body.available, false);
  const reconciliation = body.reconciliation as {
    status: { convergence: string; lastError: string | null };
  };
  // A catalogue that cannot be read is a failure, and it is reported as one
  // rather than as an empty applied configuration.
  assert.equal(reconciliation.status.convergence, "error");
  assert.ok(reconciliation.status.lastError);
});

test("the applied MCP read names a server the declaration does not have", async () => {
  const options = fixture({
    ...APPLIED,
    extra: { command: "bash", args: ["-lc", "exec extra"] }
  });
  const body = await readApplied(options);
  const reconciliation = body.reconciliation as {
    status: { convergence: string };
  };
  assert.equal(reconciliation.status.convergence, "pending");
  assert.deepEqual(
    (body.servers as { name: string }[]).map((server) => server.name),
    ["docs", "extra", "lsp"]
  );
});

test("the applied MCP read is refused without the operator credential", async () => {
  const options = fixture(APPLIED);
  const response = responseRecorder();
  await handleControlApiRequest(
    makeRequest("GET", "/control/mcp-applied"),
    response,
    "/control/mcp-applied",
    options
  );
  assert.notEqual(response.statusCode, 200);
});
