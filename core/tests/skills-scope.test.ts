import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_SKILLS_DIRECTORY,
  skillScopeCandidates,
  type SkillScopeRoots
} from "../src/skills/scope.ts";

const ROOTS: SkillScopeRoots = {
  home: "/home/operator",
  codexHome: "/home/operator/.codex",
  repositoryRoot: "/work/AutoDev"
};

test("the candidates are the places Codex looks, in the order it prefers them", () => {
  assert.deepEqual(skillScopeCandidates("opentelemetry", ROOTS), [
    { scope: "repo", directory: "/work/AutoDev/.agents/skills/opentelemetry" },
    { scope: "user", directory: "/home/operator/.agents/skills/opentelemetry" },
    { scope: "user", directory: "/home/operator/.codex/skills/opentelemetry" },
    { scope: "admin", directory: "/etc/codex/skills/opentelemetry" },
    {
      scope: "system",
      directory: "/home/operator/.codex/skills/.system/opentelemetry"
    }
  ]);
});

test("a repository skill outranks a user skill of the same name", () => {
  // Codex takes the copy with the highest precedence, so a skill that exists
  // in two places is one skill with one scope. The order of the candidates is
  // that precedence, and the Console reports the copy that wins.
  const scopes = skillScopeCandidates("opentelemetry", ROOTS).map(
    (candidate) => candidate.scope
  );
  assert.equal(scopes.indexOf("repo") < scopes.indexOf("user"), true);
});

test("a user skill outranks an admin skill, and an admin skill outranks a system one", () => {
  const scopes = skillScopeCandidates("opentelemetry", ROOTS).map(
    (candidate) => candidate.scope
  );
  assert.equal(scopes.indexOf("user") < scopes.indexOf("admin"), true);
  assert.equal(scopes.indexOf("admin") < scopes.indexOf("system"), true);
});

test("the machine's shared skills live where Codex reads them", () => {
  // `/etc/codex/skills` is the machine's, not the operator's: there is no
  // setting that moves it, so it is a constant rather than a root argument.
  assert.equal(ADMIN_SKILLS_DIRECTORY, "/etc/codex/skills");
  const admin = skillScopeCandidates("opentelemetry", ROOTS).find(
    (candidate) => candidate.scope === "admin"
  );
  assert.equal(admin?.directory, "/etc/codex/skills/opentelemetry");
});

test("the skills Codex ships with are read from the system directory", () => {
  const system = skillScopeCandidates("skill-creator", ROOTS).find(
    (candidate) => candidate.scope === "system"
  );
  assert.equal(
    system?.directory,
    "/home/operator/.codex/skills/.system/skill-creator"
  );
});

test("a candidate names the skill it is looking for", () => {
  for (const candidate of skillScopeCandidates(
    "autodev-codex-request-capture",
    ROOTS
  )) {
    assert.match(candidate.directory, /autodev-codex-request-capture$/u);
  }
});
