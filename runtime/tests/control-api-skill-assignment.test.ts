import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { executionContractRevision } from "@simulatorlife/autodev-data";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import { reloadExecutionContract } from "../src/router/subagents.ts";

/**
 * `PATCH /control/skills/:name` is the operation a memory promotion needed and
 * did not have, so these tests are about the ways it could report success and
 * do nothing.
 */

interface RecordedResponse extends ServerResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | number>;
  readonly body: string;
}

class ResponseRecorder {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  body = "";
  headersSent = false;
  writableEnded = false;
  errorMessage: string | null = null;
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: string | number): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.body = Buffer.concat(this.chunks).toString("utf8");
    this.writableEnded = true;
    return this;
  }
}

function responseRecorder(): RecordedResponse {
  return new ResponseRecorder() as unknown as RecordedResponse;
}

const SERVICE_TOKEN = "s".repeat(64);
const OPERATOR_ACTOR = "test-operator";

function request(
  method: string,
  url: string,
  actor: string,
  body?: Record<string, unknown>
): IncomingMessage {
  const headers: Record<string, string> = {
    host: "127.0.0.1",
    authorization: `Bearer ${SERVICE_TOKEN}`,
    "x-autodev-actor": actor
  };
  if (body) headers["content-type"] = "application/json";
  return Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), {
    method,
    url,
    headers
  }) as IncomingMessage;
}

interface Harness {
  readonly repositoryRoot: string;
  readonly contractPath: string;
  readonly revision: () => string;
  readonly skillRoles: (role: string) => string[];
  readonly restore: () => void;
  readonly call: (
    method: string,
    pathname: string,
    body?: Record<string, unknown>,
    role?: "viewer" | "operator"
  ) => Promise<{ status: number; body: Record<string, unknown> | null }>;
}

/**
 * A repository with one real RuleSync skill and one real execution contract, so
 * the route is exercised against the files it actually reads rather than
 * against stubs of them.
 */
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "autodev-skill-assign-"));
  const repositoryRoot = join(root, "repo");
  const skillDir = join(repositoryRoot, ".rulesync", "skills", "release-checklist");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: release-checklist\ndescription: Steps for cutting a release.\n---\n\nSteps.\n",
    "utf8"
  );
  const contractPath = join(root, "execution-contract.json");
  writeFileSync(
    contractPath,
    `${JSON.stringify(
      {
        roles: {
          orchestrator: { kind: "primary", skills: [] },
          worker: { kind: "subagent", skills: [] }
        },
        providers: {}
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const previousContract = process.env.CODEX_EXECUTION_CONTRACT_FILE;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.CODEX_EXECUTION_CONTRACT_FILE = contractPath;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  reloadExecutionContract();

  const restoreEnv = (name: string, previous: string | undefined): void => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };

  return {
    repositoryRoot,
    contractPath,
    revision: () => executionContractRevision(readFileSync(contractPath, "utf8")),
    skillRoles: (role) => {
      const parsed = JSON.parse(readFileSync(contractPath, "utf8")) as {
        roles: Record<string, { skills: string[] }>;
      };
      return parsed.roles[role]?.skills ?? [];
    },
    // Every request in one test shares these variables, so they are restored
    // once when the test ends rather than after each call. Restoring inside
    // `call` made the first request of a test revoke the token it was about to
    // use, and the route then answered 503 for reasons that had nothing to do
    // with what the test was checking.
    restore: () => {
      restoreEnv("CODEX_EXECUTION_CONTRACT_FILE", previousContract);
      restoreEnv("AUTODEV_CONTROL_API_TOKEN", previousToken);
      restoreEnv("AUTODEV_CONTROL_OPERATORS", previousOperators);
      reloadExecutionContract();
    },
    call: async (method, pathname, body, role = "operator") => {
      const response = responseRecorder();
      await handleControlApiRequest(
        request(
          method,
          pathname,
          role === "operator" ? OPERATOR_ACTOR : `${OPERATOR_ACTOR}-viewer`,
          body
        ),
        response,
        pathname,
        { repositoryRoot }
      );
      let parsed: Record<string, unknown> | null = null;
      if (response.body) {
        try {
          parsed = JSON.parse(response.body) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
      }
      return { status: response.statusCode, body: parsed };
    }
  };
}

test("a promoted skill can be assigned to a role, and the read reflects it", async () => {
  const h = harness();
  try {
    const before = await h.call("GET", "/control/skills/release-checklist");
    assert.equal(before.status, 200);
    assert.deepEqual((before.body?.skill as Record<string, unknown>).roles, []);

    const assigned = await h.call("PATCH", "/control/skills/release-checklist", {
      expectedRevision: (before.body?.skill as Record<string, unknown>)
        .executionContractRevision as string,
      roles: ["worker"]
    });
    assert.equal(assigned.status, 200);
    assert.deepEqual(assigned.body?.roles, ["worker"]);
    assert.deepEqual(h.skillRoles("worker"), ["release-checklist"]);
    assert.deepEqual(h.skillRoles("orchestrator"), []);

    // The catalog read is what the Console renders, and it goes through the
    // contract cache. Without the reload after the write this would still say
    // "no roles", and the assignment would appear to have done nothing.
    const after = await h.call("GET", "/control/skills/release-checklist");
    assert.deepEqual(
      (after.body?.skill as Record<string, unknown>).roles,
      ["worker"]
    );
  } finally {
    h.restore();
  }
});

test("the catalog carries the execution-contract revision a form must post", async () => {
  const h = harness();
  try {
    const before = await h.call("GET", "/control/skills");
    assert.equal(before.status, 200);
    const drawnRevision = (before.body as Record<string, unknown>)
      .executionContractRevision;
    assert.equal(
      drawnRevision,
      h.revision(),
      "the Console draws one assignment form per row from this single revision"
    );

    await h.call("PATCH", "/control/skills/release-checklist", {
      expectedRevision: h.revision(),
      roles: ["worker"]
    });

    // If the revision were cached the form on a page an operator was already
    // looking at would post a stale value and be refused forever, so this has
    // to move the moment a write lands.
    const after = await h.call("GET", "/control/skills");
    assert.equal(
      (after.body as Record<string, unknown>).executionContractRevision,
      h.revision()
    );
    assert.notEqual(
      (after.body as Record<string, unknown>).executionContractRevision,
      drawnRevision
    );
  } finally {
    h.restore();
  }
});

test("a viewer cannot assign a skill", async () => {
  const h = harness();
  try {
    const response = await h.call(
      "PATCH",
      "/control/skills/release-checklist",
      { expectedRevision: h.revision(), roles: ["worker"] },
      "viewer"
    );
    assert.equal(response.status, 403);
    assert.deepEqual(h.skillRoles("worker"), []);
  } finally {
    h.restore();
  }
});

test("a skill that is not in the catalog cannot be assigned", async () => {
  const h = harness();
  try {
    const response = await h.call("PATCH", "/control/skills/never-existed", {
      expectedRevision: h.revision(),
      roles: ["worker"]
    });
    assert.equal(response.status, 404);
    assert.deepEqual(h.skillRoles("worker"), []);
  } finally {
    h.restore();
  }
});

test("a stale execution-contract revision is refused", async () => {
  const h = harness();
  try {
    const response = await h.call("PATCH", "/control/skills/release-checklist", {
      expectedRevision: "0".repeat(64),
      roles: ["worker"]
    });
    assert.equal(response.status, 409);
    assert.deepEqual(h.skillRoles("worker"), []);
  } finally {
    h.restore();
  }
});