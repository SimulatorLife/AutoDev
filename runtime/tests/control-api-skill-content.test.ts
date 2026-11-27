import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  handleControlApiRequest,
  resetOperationHistoryForTests
} from "../src/control-api/request-handler.ts";
import { reloadExecutionContract } from "../src/router/subagents.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "s".repeat(64);
const OPERATOR_ACTOR = "skill-content-operator";
const SKILL_NAME = "release-checklist";
const SKILL_PATH = `.rulesync/skills/${SKILL_NAME}/SKILL.md`;
const ORIGINAL_SOURCE =
  "---\nname: release-checklist\ndescription: Steps for cutting a release.\n---\n\n# Release checklist\n\nCheck the release.\n";

interface Harness {
  readonly repositoryRoot: string;
  readonly home: string;
  readonly skillPath: string;
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

function request(
  method: string,
  url: string,
  body?: Record<string, unknown>,
  role: "viewer" | "operator" = "operator"
): IncomingMessage {
  const headers: Record<string, string> = {
    host: "127.0.0.1",
    authorization: `Bearer ${SERVICE_TOKEN}`,
    "x-autodev-actor":
      role === "operator" ? OPERATOR_ACTOR : `${OPERATOR_ACTOR}-viewer`
  };
  if (body) headers["content-type"] = "application/json";
  return Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), {
    method,
    url,
    headers
  }) as IncomingMessage;
}

function harness(options: { readonly installed?: boolean } = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-skill-content-"));
  const repositoryRoot = path.join(root, "repo");
  const home = path.join(root, "home");
  const skillPath = path.join(repositoryRoot, SKILL_PATH);
  mkdirSync(path.dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, ORIGINAL_SOURCE, "utf8");
  // The installer links the canonical source into the user's skills
  // directory, so the runtime reads the canonical source itself. That link is
  // the runtime's observation of the skill, so the harness has to be able to
  // leave it out as well as lay it down.
  if (options.installed !== false) {
    const installed = path.join(home, ".agents", "skills", SKILL_NAME);
    mkdirSync(path.dirname(installed), { recursive: true });
    symlinkSync(path.dirname(skillPath), installed, "dir");
  }
  cpSync(
    path.resolve(import.meta.dirname, "../../rulesync.jsonc"),
    path.join(repositoryRoot, "rulesync.jsonc")
  );
  symlinkSync(
    path.resolve(import.meta.dirname, "../../node_modules"),
    path.join(repositoryRoot, "node_modules"),
    "dir"
  );

  const contractPath = path.join(root, "execution-contract.json");
  writeFileSync(
    contractPath,
    `${JSON.stringify(
      {
        roles: {
          orchestrator: { kind: "primary", skills: [] },
          worker: { kind: "subagent", skills: [SKILL_NAME] }
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
  const previousViewers = process.env.AUTODEV_CONTROL_VIEWERS;
  process.env.CODEX_EXECUTION_CONTRACT_FILE = contractPath;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  process.env.AUTODEV_CONTROL_VIEWERS = `${OPERATOR_ACTOR}-viewer`;
  reloadExecutionContract();

  const restoreEnvironment = (name: string, previous: string | undefined): void => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };

  return {
    repositoryRoot,
    home,
    skillPath,
    restore: () => {
      restoreEnvironment("CODEX_EXECUTION_CONTRACT_FILE", previousContract);
      restoreEnvironment("AUTODEV_CONTROL_API_TOKEN", previousToken);
      restoreEnvironment("AUTODEV_CONTROL_OPERATORS", previousOperators);
      restoreEnvironment("AUTODEV_CONTROL_VIEWERS", previousViewers);
      reloadExecutionContract();
      rmSync(root, { recursive: true, force: true });
    },
    call: async (method, pathname, body, role = "operator") => {
      const response = responseRecorder();
      await handleControlApiRequest(
        request(method, pathname, body, role),
        response,
        pathname,
        { repositoryRoot, home }
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

test("the canonical skill source is read-only: a write is refused and the source is untouched", async () => {
  const h = harness();
  const sourceUrl = `/control/skills/${SKILL_NAME}/content`;
  try {
    const read = await h.call("GET", sourceUrl);
    assert.equal(read.status, 200);
    assert.equal(read.body?.schema, "autodev-control-skill-content-v2");

    // The canonical source is repository-owned. A write on this route is
    // refused with the one method it does have, and the file on disk is not
    // touched: a refused write must not half-apply.
    const written = await h.call("PATCH", sourceUrl, {
      expectedRevision: read.body?.revision,
      content:
        "---\nname: release-checklist\ndescription: Edited.\n---\n\nEdited.\n"
    });
    assert.equal(written.status, 405);
    assert.equal(written.headers.allow, "GET");
    assert.equal(
      (written.body?.error as { code?: string })?.code,
      "autodev_control_api_method_not_allowed"
    );
    assert.equal(readFileSync(h.skillPath, "utf8"), ORIGINAL_SOURCE);

    // Every other verb is refused the same way.
    for (const method of ["POST", "PUT", "DELETE"]) {
      const refused = await h.call(method, sourceUrl, {});
      assert.equal(refused.status, 405, method);
      assert.equal(refused.headers.allow, "GET", method);
    }
    assert.equal(readFileSync(h.skillPath, "utf8"), ORIGINAL_SOURCE);
  } finally {
    h.restore();
  }
});

test("the skill read reports the runtime's observation of the canonical source", async () => {
  const sourceUrl = `/control/skills/${SKILL_NAME}/content`;
  // The audit ring is process-wide, so an earlier spec's failure for the same
  // resource would otherwise decide what this one observes.
  resetOperationHistoryForTests();
  const installed = harness();
  try {
    const read = await installed.call("GET", sourceUrl);
    assert.equal(read.status, 200);
    const status = (
      read.body?.reconciliation as {
        status?: {
          convergence?: string;
          desiredGeneration?: string | null;
          observedGeneration?: string | null;
        };
      }
    )?.status;
    // The runtime reads the canonical source itself, so it has observed this
    // very source: the two generations are the same revision.
    assert.equal(status?.convergence, "converged");
    assert.equal(status?.desiredGeneration, read.body?.revision);
    assert.equal(status?.observedGeneration, read.body?.revision);
  } finally {
    installed.restore();
  }

  const missing = harness({ installed: false });
  try {
    const read = await missing.call("GET", sourceUrl);
    assert.equal(read.status, 200);
    const status = (
      read.body?.reconciliation as {
        status?: {
          convergence?: string;
          desiredGeneration?: string | null;
          observedGeneration?: string | null;
        };
      }
    )?.status;
    // Without the installed link the runtime is running something else, so
    // the read says the observation is unknown rather than claiming the two
    // agree.
    assert.equal(status?.convergence, "not-observed");
    assert.equal(status?.desiredGeneration, read.body?.revision);
    assert.equal(status?.observedGeneration, null);
  } finally {
    missing.restore();
  }
});
