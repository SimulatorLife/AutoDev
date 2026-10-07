import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { executionContractRevision } from "@simulatorlife/autodev-data";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import { reloadExecutionContract } from "../src/router/subagents.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

/**
 * `PATCH /control/skills/:name` is the operation a memory promotion needed and
 * did not have, so these tests are about the ways it could report success and
 * do nothing.
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
 * A repository with one real RuleSync skill and one real execution contract, so
 * the route is exercised against the files it actually reads rather than
 * against stubs of them.
 */
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "autodev-skill-assign-"));
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

  const restoreEnv = (name: string, previous: string | undefined): void => {
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
      return {
        status: response.statusCode,
        body: parsed,
        headers: response.headers
      };
    }
  };
}

test("a promoted skill can be assigned to a role, and the read reflects it", async () => {
  const h = harness();
  // Read through the collection both times, because that is the path the
  // Console actually takes: it has no skill-by-id view. The old per-skill GET
  // was read only by this test, and a test that proves a write by reading a
  // path no product surface uses proves the write reached the wrong place.
  const rolesFromCatalog = (body: unknown): unknown[] | undefined => {
    const row = (
      body as { skills?: { name: string; roles?: unknown[] }[] }
    ).skills?.find((entry) => entry.name === "release-checklist");
    return row?.roles;
  };
  try {
    const before = await h.call("GET", "/control/skills");
    assert.equal(before.status, 200);
    assert.deepEqual(rolesFromCatalog(before.body), []);

    const assigned = await h.call(
      "PATCH",
      "/control/skills/release-checklist",
      {
        expectedRevision: (before.body as Record<string, unknown>)
          .executionContractRevision as string,
        roles: ["worker"]
      }
    );
    assert.equal(assigned.status, 200);
    assert.deepEqual(assigned.body?.roles, ["worker"]);
    assert.deepEqual(h.skillRoles("worker"), ["release-checklist"]);
    assert.deepEqual(h.skillRoles("orchestrator"), []);

    // The catalog read is what the Console renders, and it goes through the
    // contract cache. Without the reload after the write this would still say
    // "no roles", and the assignment would appear to have done nothing.
    const after = await h.call("GET", "/control/skills");
    assert.deepEqual(rolesFromCatalog(after.body), ["worker"]);
  } finally {
    h.restore();
  }
});

test("a skill is read from the catalog, not from a per-skill route", async () => {
  const h = harness();
  try {
    // There was a GET here returning `autodev-control-skill-detail-v1` that no
    // Console view read and no contract declared. Rather than leave a second
    // way to read one skill, the route refuses the method and says where the
    // read lives.
    const response = await h.call("GET", "/control/skills/release-checklist");
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "PATCH");
    assert.match(
      String(
        (response.body as { error?: { message?: string } })?.error?.message
      ),
      /Read a skill from \/control\/skills\./u
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
    const response = await h.call(
      "PATCH",
      "/control/skills/release-checklist",
      {
        expectedRevision: "0".repeat(64),
        roles: ["worker"]
      }
    );
    assert.equal(response.status, 409);
    assert.deepEqual(h.skillRoles("worker"), []);
  } finally {
    h.restore();
  }
});
