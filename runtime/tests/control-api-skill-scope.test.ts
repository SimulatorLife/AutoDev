import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { executionContractRevision } from "@simulatorlife/autodev-data";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import { reloadExecutionContract } from "../src/router/subagents.ts";
import { getDefaultUsageTracker } from "../src/router/usage.ts";
import {
  contractRoleSkills,
  type ExecutionContract,
  workspaceIdFromKey
} from "../src/shared/execution-contract.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

/**
 * A skill's reachability comes from where it is installed, and the assignment
 * follows it: a skill inside a repository belongs to that repository's
 * workspace alone. These tests are about the read that says where a skill is
 * and the write that refuses to put it anywhere else.
 */

const SERVICE_TOKEN = "s".repeat(64);
const OPERATOR_ACTOR = "test-operator";
const WORKSPACE = "SimulatorLife/AutoDev";

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

interface SkillRow {
  readonly name: string;
  readonly roles: string[];
  readonly scope: string | null;
  readonly scopeLocation: string | null;
  readonly workspace: string | null;
  readonly observedExposure: number | null;
  readonly observedUse: number | null;
}

interface Harness {
  readonly repositoryRoot: string;
  readonly contractPath: string;
  readonly revision: () => string;
  readonly contract: () => {
    roles: Record<string, { skills?: string[] }>;
    workspaces?: Record<
      string,
      { roles?: Record<string, { skills?: string[] }> }
    >;
  };
  readonly restore: () => void;
  readonly call: (
    method: string,
    pathname: string,
    body?: Record<string, unknown>
  ) => Promise<{
    status: number;
    body: Record<string, unknown> | null;
  }>;
}

interface HarnessOptions {
  /** Whether the repository names a workspace through its own git remote. */
  readonly remote?: boolean;
}

/**
 * A repository with two catalogue skills -- one installed inside it, one
 * installed nowhere -- and the execution contract the assignment writes.
 */
function harness(options: HarnessOptions = {}): Harness {
  // The temporary directory is resolved before use: the machine's own temporary
  // directory is a symlink on macOS, and a path that resolves through one is
  // not a real local directory to the stores that own these roots.
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "autodev-skill-scope-")
  );
  const repositoryRoot = join(root, "repo");
  for (const name of ["release-checklist", "repo-only"]) {
    const skillDir = join(repositoryRoot, ".rulesync", "skills", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nBody.\n`,
      "utf8"
    );
  }
  // The repo scope: a real directory inside the repository, which is where
  // Codex looks for a project's own skills.
  mkdirSync(join(repositoryRoot, ".agents", "skills", "repo-only"), {
    recursive: true
  });
  if (options.remote !== false) {
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    writeFileSync(
      join(repositoryRoot, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/SimulatorLife/AutoDev.git\n',
      "utf8"
    );
  }
  // The workspace catalogue: a remote names a project, and the catalogue is
  // what says which projects are workspaces here.
  mkdirSync(join(repositoryRoot, "config"), { recursive: true });
  writeFileSync(
    join(repositoryRoot, "config", "workspaces.json"),
    `${JSON.stringify(
      {
        schema: "autodev-workspaces-v1",
        workspaces: [
          {
            id: WORKSPACE,
            baseBranch: "main",
            enabled: true,
            agentRoles: null
          }
        ]
      },
      null,
      2
    )}\n`,
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

  const previous = {
    contract: process.env.CODEX_EXECUTION_CONTRACT_FILE,
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    operators: process.env.AUTODEV_CONTROL_OPERATORS,
    home: process.env.HOME,
    codexHome: process.env.CODEX_HOME
  };
  process.env.CODEX_EXECUTION_CONTRACT_FILE = contractPath;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  // The scope read looks at the operator's own skills as well as the
  // repository's, so a test that left the real home in place would read the
  // machine's installation rather than the fixture's.
  process.env.HOME = join(root, "home");
  process.env.CODEX_HOME = join(root, "codex-home");
  mkdirSync(process.env.HOME, { recursive: true });
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  reloadExecutionContract();
  getDefaultUsageTracker().resetUsageTelemetry();

  const restoreEnv = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  return {
    repositoryRoot,
    contractPath,
    revision: () =>
      executionContractRevision(readFileSync(contractPath, "utf8")),
    contract: () =>
      JSON.parse(readFileSync(contractPath, "utf8")) as {
        roles: Record<string, { skills?: string[] }>;
        workspaces?: Record<
          string,
          { roles?: Record<string, { skills?: string[] }> }
        >;
      },
    restore: () => {
      restoreEnv("CODEX_EXECUTION_CONTRACT_FILE", previous.contract);
      restoreEnv("AUTODEV_CONTROL_API_TOKEN", previous.token);
      restoreEnv("AUTODEV_CONTROL_OPERATORS", previous.operators);
      restoreEnv("HOME", previous.home);
      restoreEnv("CODEX_HOME", previous.codexHome);
      reloadExecutionContract();
      getDefaultUsageTracker().resetUsageTelemetry();
    },
    call: async (method, pathname, body) => {
      const response = responseRecorder();
      await handleControlApiRequest(
        request(method, pathname, OPERATOR_ACTOR, body),
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

function skillRows(body: unknown): SkillRow[] {
  return (body as { skills?: SkillRow[] }).skills ?? [];
}

function skillRow(body: unknown, name: string): SkillRow | undefined {
  return skillRows(body).find((row) => row.name === name);
}

test("the read says where a skill is installed and which workspace it belongs to", async () => {
  const h = harness();
  try {
    const response = await h.call("GET", "/control/skills");
    assert.equal(response.status, 200);

    const repoOnly = skillRow(response.body, "repo-only");
    assert.equal(repoOnly?.scope, "repo");
    assert.equal(
      repoOnly?.scopeLocation,
      join(h.repositoryRoot, ".agents", "skills", "repo-only")
    );
    assert.equal(repoOnly?.workspace, WORKSPACE);

    // In the catalogue and installed nowhere: a skill no agent can reach.
    const uninstalled = skillRow(response.body, "release-checklist");
    assert.equal(uninstalled?.scope, null);
    assert.equal(uninstalled?.scopeLocation, null);
    assert.equal(uninstalled?.workspace, null);
  } finally {
    h.restore();
  }
});

test("a repo-scoped skill cannot be assigned without its workspace", async () => {
  const h = harness();
  try {
    const response = await h.call("PATCH", "/control/skills/repo-only", {
      expectedRevision: h.revision(),
      roles: ["worker"]
    });
    assert.equal(response.status, 400);
    assert.equal(
      (response.body as { error?: { code?: string } })?.error?.code,
      "autodev_control_execution_contract_invalid"
    );
    assert.deepEqual(h.contract().roles.worker?.skills, []);
    assert.equal(h.contract().workspaces, undefined);
  } finally {
    h.restore();
  }
});

test("a repo-scoped skill is assigned inside its own workspace", async () => {
  const h = harness();
  try {
    const response = await h.call("PATCH", "/control/skills/repo-only", {
      expectedRevision: h.revision(),
      roles: ["worker"],
      workspace: WORKSPACE
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body?.desiredRoles, ["worker"]);
    assert.deepEqual(response.body?.actualRoles, ["worker"]);

    const contract = h.contract();
    assert.deepEqual(contract.workspaces?.[WORKSPACE]?.roles?.worker?.skills, [
      "repo-only"
    ]);
    // The global list is that skill's no-other-workspace claim, and it stays
    // empty: the skill belongs to the workspace alone.
    assert.deepEqual(contract.roles.worker?.skills, []);

    // The collection reports the roles from the place the skill belongs to.
    const after = await h.call("GET", "/control/skills");
    assert.deepEqual(skillRow(after.body, "repo-only")?.roles, ["worker"]);
    assert.deepEqual(skillRow(after.body, "release-checklist")?.roles, []);
  } finally {
    h.restore();
  }
});

test("a skill that is not repo-scoped cannot be assigned to a workspace", async () => {
  const h = harness();
  try {
    const response = await h.call(
      "PATCH",
      "/control/skills/release-checklist",
      {
        expectedRevision: h.revision(),
        roles: ["worker"],
        workspace: WORKSPACE
      }
    );
    assert.equal(response.status, 400);
    assert.deepEqual(h.contract().roles.worker?.skills, []);
    assert.equal(h.contract().workspaces, undefined);
  } finally {
    h.restore();
  }
});

test("a repo-scoped skill in a repository that is no workspace has nowhere to go", async () => {
  const h = harness({ remote: false });
  try {
    const read = await h.call("GET", "/control/skills");
    const repoOnly = skillRow(read.body, "repo-only");
    assert.equal(repoOnly?.scope, "repo");
    assert.equal(repoOnly?.workspace, null);

    const response = await h.call("PATCH", "/control/skills/repo-only", {
      expectedRevision: h.revision(),
      roles: ["worker"],
      workspace: WORKSPACE
    });
    assert.equal(response.status, 400);
    assert.deepEqual(h.contract().roles.worker?.skills, []);
  } finally {
    h.restore();
  }
});

test("a body carrying a key the route does not understand is refused", async () => {
  const h = harness();
  try {
    const response = await h.call(
      "PATCH",
      "/control/skills/release-checklist",
      {
        expectedRevision: h.revision(),
        roles: ["worker"],
        unexpected: true
      }
    );
    assert.equal(response.status, 400);
    assert.deepEqual(h.contract().roles.worker?.skills, []);
  } finally {
    h.restore();
  }
});

test("the exposure and use the Runtime observed are reported per skill", async () => {
  const h = harness();
  try {
    const tracker = getDefaultUsageTracker();
    const bucket = tracker.workspaceBucket("ws-skill-scope");
    const skill = tracker.workspaceSkillBucket(bucket, "release-checklist");
    skill.total += 3;
    skill.uses += 1;

    const response = await h.call("GET", "/control/skills");
    assert.equal(response.body?.telemetryObserved, true);
    assert.equal(
      skillRow(response.body, "release-checklist")?.observedExposure,
      3
    );
    assert.equal(skillRow(response.body, "release-checklist")?.observedUse, 1);
    // A skill the Runtime has never seen is not observed, which is not the
    // same as being observed and never happening.
    assert.equal(skillRow(response.body, "repo-only")?.observedExposure, null);
    assert.equal(skillRow(response.body, "repo-only")?.observedUse, null);
  } finally {
    h.restore();
  }
});

test("no skill telemetry at all is reported as not observed", async () => {
  const h = harness();
  try {
    const response = await h.call("GET", "/control/skills");
    assert.equal(response.body?.telemetryObserved, false);
    assert.equal(
      skillRow(response.body, "release-checklist")?.observedExposure,
      null
    );
    assert.equal(
      skillRow(response.body, "release-checklist")?.observedUse,
      null
    );
  } finally {
    h.restore();
  }
});

test("a workspace adds skills to a role and changes nothing else", () => {
  const contract = {
    roles: {
      worker: { mcp: ["one"], skills: ["global-skill"], readOnly: false }
    },
    workspaces: {
      [WORKSPACE]: {
        roles: { worker: { skills: ["repo-only"] } }
      }
    }
  } as unknown as ExecutionContract;

  assert.deepEqual(contractRoleSkills(contract, "worker", WORKSPACE), [
    "repo-only"
  ]);
  // A workspace that declares nothing for the role grants it nothing, and a
  // workspace the contract does not know is not a workspace.
  assert.deepEqual(contractRoleSkills(contract, "worker", null), []);
  assert.deepEqual(contractRoleSkills(contract, "worker", "other/project"), []);
  assert.deepEqual(contractRoleSkills(contract, "orchestrator", WORKSPACE), []);
});

test("only an owner/repository key names a workspace", () => {
  assert.equal(workspaceIdFromKey("SimulatorLife/AutoDev"), WORKSPACE);
  assert.equal(workspaceIdFromKey(" AutoDev "), null);
  assert.equal(workspaceIdFromKey("ws_0123456789ab"), null);
  assert.equal(workspaceIdFromKey(undefined), null);
  assert.equal(workspaceIdFromKey(["SimulatorLife/AutoDev"]), null);
});
