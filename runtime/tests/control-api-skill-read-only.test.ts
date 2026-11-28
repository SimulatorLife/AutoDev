import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { executionContractRevision } from "@simulatorlife/autodev-data";

import { handleControlApiRequest } from "../src/control-api/request-handler.ts";
import { reloadExecutionContract } from "../src/router/execution-contract.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

/**
The skill catalogue is repository-owned, so the Control API reads it and
nothing more.

The role assignments live in the execution contract and the canonical source
lives in the RuleSync catalogue; both are changed in the repository and
reconciled by the standard workflow. A write path on this API would be an
alternate way to change them, and one that no product surface uses, so the
routes that carried it are gone: the assignment route is absent, and the
source route refuses every verb but its read.
*/

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
  ) => Promise<{
    status: number;
    body: Record<string, unknown> | null;
    headers: Record<string, string | number>;
  }>;
}

/**
A repository with one real RuleSync skill and one real execution contract, so
the routes are exercised against the files they actually read rather than
against stubs of them.
*/
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "autodev-skill-readonly-"));
  const repositoryRoot = join(root, "repo");
  const skillDir = join(
    repositoryRoot,
    ".rulesync",
    "skills",
    "release-checklist"
  );
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

  const restoreEnvironment = (name: string, previous: string | undefined): void => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };

  return {
    repositoryRoot,
    contractPath,
    revision: () =>
      executionContractRevision(readFileSync(contractPath, "utf8")),
    skillRoles: (role) => {
      const parsed = JSON.parse(readFileSync(contractPath, "utf8")) as {
        roles: Record<string, { skills: string[] }>;
      };
      return parsed.roles[role]?.skills ?? [];
    },
    restore: () => {
      restoreEnvironment("CODEX_EXECUTION_CONTRACT_FILE", previousContract);
      restoreEnvironment("AUTODEV_CONTROL_API_TOKEN", previousToken);
      restoreEnvironment("AUTODEV_CONTROL_OPERATORS", previousOperators);
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
      return {
        status: response.statusCode,
        body: parsed,
        headers: response.headers
      };
    }
  };
}

test("the catalogue publishes that it is read-only and carries the facts it is drawn from", async () => {
  const h = harness();
  try {
    const response = await h.call("GET", "/control/skills");
    assert.equal(response.status, 200);
    assert.equal(response.body?.readOnly, true);
    assert.equal(response.body?.schema, "autodev-control-skills-v2");
    // The assignments the Console renders come from the contract, so the read
    // carries the contract's own revision and the roles it declares.
    assert.equal(response.body?.executionContractRevision, h.revision());
    assert.equal(response.body?.executionContractObserved, true);
    assert.deepEqual(response.body?.assignmentRoles, [
      "orchestrator",
      "worker"
    ]);
    const row = (
      response.body?.skills as { name: string; roles: string[] }[]
    ).find((entry) => entry.name === "release-checklist");
    assert.deepEqual(row?.roles, []);
  } finally {
    h.restore();
  }
});

test("the role-assignment route is absent", async () => {
  const h = harness();
  try {
    // The route carried one write and had no read of its own, so removing the
    // write removes the route: a caller gets the same answer it gets for any
    // path that does not exist.
    for (const method of ["GET", "PATCH", "POST", "PUT", "DELETE"]) {
      const response = await h.call(
        method,
        "/control/skills/release-checklist",
        {
          expectedRevision: h.revision(),
          roles: ["worker"]
        }
      );
      assert.equal(response.status, 404, method);
    }
    // And the contract is exactly as it was: nothing was assigned.
    assert.deepEqual(h.skillRoles("worker"), []);
    assert.deepEqual(h.skillRoles("orchestrator"), []);
  } finally {
    h.restore();
  }
});

test("the canonical source route reads and refuses every write", async () => {
  const h = harness();
  const sourceUrl = "/control/skills/release-checklist/content";
  try {
    const read = await h.call("GET", sourceUrl);
    assert.equal(read.status, 200);
    assert.equal(read.body?.schema, "autodev-control-skill-content-v2");

    for (const method of ["PATCH", "POST", "PUT", "DELETE"]) {
      const response = await h.call(method, sourceUrl, {
        expectedRevision: read.body?.revision,
        content:
          "---\nname: release-checklist\ndescription: Edited.\n---\n\nEdited.\n"
      });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.allow, "GET", method);
    }
  } finally {
    h.restore();
  }
});
