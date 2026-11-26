import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  contractSkillRoles,
  executionContractRevision
} from "@simulatorlife/autodev-data";

/**
 * The execution contract is read, never written.
 *
 * It is generated from the canonical role declarations, so the properties that
 * matter here are the ones a reader would get wrong: the global section and a
 * workspace's section are separate assignments rather than two views of one,
 * and a contract that cannot be read says so rather than reporting no roles.
 */

function contractFile(contract: unknown): { path: string; revision: string } {
  const directory = mkdtempSync(join(tmpdir(), "autodev-contract-"));
  const path = join(directory, "execution-contract.json");
  const content = `${JSON.stringify(contract, null, 2)}\n`;
  writeFileSync(path, content, "utf8");
  return { path, revision: executionContractRevision(content) };
}

const WORKSPACE = "SimulatorLife/AutoDev";

const BASE = {
  roles: {
    orchestrator: { kind: "primary", skills: ["ccc"] },
    worker: { kind: "subagent", skills: [] },
    reviewer: { kind: "subagent", skills: ["ccc"] }
  },
  providers: {}
};

const WITH_WORKSPACE = {
  ...BASE,
  workspaces: {
    [WORKSPACE]: {
      roles: {
        worker: { skills: ["autodev-request-capture"] },
        reviewer: { skills: [] }
      }
    }
  }
};

function parsedContract(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("the revision is the contract's own digest", () => {
  const file = contractFile(BASE);
  const content = readFileSync(file.path, "utf8");
  assert.equal(executionContractRevision(content), file.revision);
  // The digest is of the exact text, so a whitespace change is a change.
  assert.notEqual(executionContractRevision(`${content}\n`), file.revision);
});

test("the contract's role map is read per workspace", () => {
  const file = contractFile(WITH_WORKSPACE);
  const parsed = parsedContract(file.path);

  // The global scope is the contract's own roles section.
  assert.deepEqual(contractSkillRoles(parsed).orchestrator, ["ccc"]);
  assert.deepEqual(contractSkillRoles(parsed).worker, []);
  assert.deepEqual(contractSkillRoles(parsed).reviewer, ["ccc"]);

  // A workspace's scope is that workspace's own roles section: the roles it
  // names, and no others. A role the workspace does not name declares nothing
  // there, which is not the same as a role whose skill list is empty.
  assert.deepEqual(contractSkillRoles(parsed, WORKSPACE).worker, [
    "autodev-request-capture"
  ]);
  assert.deepEqual(contractSkillRoles(parsed, WORKSPACE).reviewer, []);
  assert.equal(contractSkillRoles(parsed, WORKSPACE).orchestrator, undefined);

  // And a workspace's scope is not a global one.
  assert.deepEqual(contractSkillRoles(parsed).worker, []);
});

test("a role with no skills reads as no skills", () => {
  const file = contractFile({
    roles: { worker: { kind: "subagent" } },
    providers: {}
  });
  assert.deepEqual(contractSkillRoles(parsedContract(file.path)).worker, []);
});

test("a role entry that is not a role declares nothing", () => {
  // The reader is given a parsed contract, so a role entry that is not a role
  // is a defect in the document rather than a parse failure. It declares
  // nothing: the role reaches nothing, and saying so is better than reading a
  // list out of something that is not one.
  assert.equal(
    contractSkillRoles({ roles: { worker: "not-a-role" } }).worker,
    undefined
  );
  // A role that is a role but names no skills reaches no skills.
  assert.deepEqual(
    contractSkillRoles({ roles: { worker: { skills: 7 } } }).worker,
    []
  );
});
