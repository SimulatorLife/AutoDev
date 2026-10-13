import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
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

import { handleControlApiRequest } from "../src/control-api/index.ts";
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

function harness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-skill-content-"));
  const repositoryRoot = path.join(root, "repo");
  const skillPath = path.join(repositoryRoot, SKILL_PATH);
  mkdirSync(path.dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, ORIGINAL_SOURCE, "utf8");
  cpSync(
    path.resolve(process.cwd(), "rulesync.jsonc"),
    path.join(repositoryRoot, "rulesync.jsonc")
  );
  symlinkSync(
    path.resolve(process.cwd(), "node_modules"),
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

  const restoreEnv = (name: string, previous: string | undefined): void => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };

  return {
    repositoryRoot,
    skillPath,
    restore: () => {
      restoreEnv("CODEX_EXECUTION_CONTRACT_FILE", previousContract);
      restoreEnv("AUTODEV_CONTROL_API_TOKEN", previousToken);
      restoreEnv("AUTODEV_CONTROL_OPERATORS", previousOperators);
      restoreEnv("AUTODEV_CONTROL_VIEWERS", previousViewers);
      reloadExecutionContract();
      rmSync(root, { recursive: true, force: true });
    },
    call: async (method, pathname, body, role = "operator") => {
      const response = responseRecorder();
      await handleControlApiRequest(
        request(method, pathname, body, role),
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

test("skill source PATCH validates, applies, and verifies the RuleSync skill projections", async () => {
  const h = harness();
  const sourceUrl = `/control/skills/${SKILL_NAME}/content`;
  const updatedSource =
    "---\nname: release-checklist\ndescription: Updated release steps.\n---\n\n# Updated release checklist\n\nRun the checks.\n";
  try {
    const read = await h.call("GET", sourceUrl);
    assert.equal(read.status, 200);
    assert.equal(read.body?.schema, "autodev-control-skill-content-v1");
    assert.equal(read.body?.path, SKILL_PATH);
    assert.equal(read.body?.content, ORIGINAL_SOURCE);
    const revision = read.body?.revision;
    assert.equal(typeof revision, "string");

    const updated = await h.call("PATCH", sourceUrl, {
      expectedRevision: revision,
      content: updatedSource
    });
    assert.equal(updated.status, 200);
    assert.equal(
      updated.body?.schema,
      "autodev-control-skill-content-patch-v1"
    );
    assert.equal(
      updated.body?.revision,
      createHash("sha256").update(updatedSource, "utf8").digest("hex")
    );
    assert.equal(updated.body?.changed, true);
    assert.equal(updated.body?.projectionApplied, true);
    assert.equal(
      (updated.body?.reconciliation as { status?: { convergence?: string } })
        ?.status?.convergence,
      "converged"
    );
    assert.equal(readFileSync(h.skillPath, "utf8"), updatedSource);
    for (const projection of [
      ".agents/skills",
      ".claude/skills",
      ".github/skills"
    ]) {
      const projectedSource = readFileSync(
        path.join(h.repositoryRoot, projection, SKILL_NAME, "SKILL.md"),
        "utf8"
      );
      assert.match(projectedSource, /name: release-checklist/u);
      assert.match(projectedSource, /description: Updated release steps\./u);
      assert.match(projectedSource, /# Updated release checklist/u);
      assert.match(projectedSource, /Run the checks\./u);
      assert.doesNotMatch(projectedSource, /Check the release\./u);
    }

    const skills = await h.call("GET", "/control/skills");
    const skill = (
      skills.body?.skills as { name: string; roles: string[] }[]
    ).find((entry) => entry.name === SKILL_NAME);
    assert.deepEqual(skill?.roles, ["worker"]);

    const stale = await h.call("PATCH", sourceUrl, {
      expectedRevision: revision,
      content: ORIGINAL_SOURCE
    });
    assert.equal(stale.status, 409);
    assert.equal(
      (stale.body?.error as { code?: string })?.code,
      "autodev_control_skill_content_conflict"
    );
    assert.equal(readFileSync(h.skillPath, "utf8"), updatedSource);
  } finally {
    h.restore();
  }
});

test("skill source writes require an operator and reject invalid or oversized input without replacing the source", async () => {
  const h = harness();
  const sourceUrl = `/control/skills/${SKILL_NAME}/content`;
  try {
    const revision = (await h.call("GET", sourceUrl)).body?.revision as string;
    const denied = await h.call(
      "PATCH",
      sourceUrl,
      { expectedRevision: revision, content: ORIGINAL_SOURCE },
      "viewer"
    );
    assert.equal(denied.status, 403);
    assert.equal(readFileSync(h.skillPath, "utf8"), ORIGINAL_SOURCE);

    const invalid = await h.call("PATCH", sourceUrl, {
      expectedRevision: revision,
      content: "---\nname: other\ndescription: Wrong directory.\n---\nBody\n"
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (invalid.body?.error as { code?: string })?.code,
      "autodev_control_skill_source_invalid"
    );
    assert.equal(readFileSync(h.skillPath, "utf8"), ORIGINAL_SOURCE);

    const oversized = await h.call("PATCH", sourceUrl, {
      expectedRevision: revision,
      content: `---\nname: release-checklist\ndescription: Oversized.\n---\n${"x".repeat(300_001)}`
    });
    assert.equal(oversized.status, 413);
    assert.match(
      String((oversized.body?.error as { message?: string })?.message),
      /300000 bytes/u
    );
    assert.equal(readFileSync(h.skillPath, "utf8"), ORIGINAL_SOURCE);
  } finally {
    h.restore();
  }
});

test("failed RuleSync skill projection apply is explicit after the canonical write", async () => {
  const h = harness();
  const sourceUrl = `/control/skills/${SKILL_NAME}/content`;
  const updatedSource =
    "---\nname: release-checklist\ndescription: Updated but unapplied.\n---\n\nBody.\n";
  try {
    const binary = path.join(
      h.repositoryRoot,
      "node_modules",
      ".bin",
      "rulesync"
    );
    rmSync(path.join(h.repositoryRoot, "node_modules"), {
      recursive: true,
      force: true
    });
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    chmodSync(binary, 0o755);
    const revision = (await h.call("GET", sourceUrl)).body?.revision as string;
    const result = await h.call("PATCH", sourceUrl, {
      expectedRevision: revision,
      content: updatedSource
    });
    assert.equal(result.status, 503);
    assert.equal(
      (result.body?.error as { code?: string })?.code,
      "autodev_control_skill_apply_failed"
    );
    assert.equal(readFileSync(h.skillPath, "utf8"), updatedSource);
    assert.equal(result.body?.projectionApplied, undefined);
  } finally {
    h.restore();
  }
});
