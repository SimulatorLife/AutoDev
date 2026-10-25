import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  projectIdFromRemoteUrl,
  readRepositoryWorkspaceId,
  resolveSkillScopes
} from "../src/skills/scope.ts";

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly codexHome: string;
  readonly repositoryRoot: string;
  readonly workspaces: readonly string[];
}

function sandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-skill-scope-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const repositoryRoot = path.join(root, "AutoDev");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(repositoryRoot, { recursive: true });
  return {
    root,
    home,
    codexHome,
    repositoryRoot,
    workspaces: ["SimulatorLife/AutoDev"]
  };
}

function skillDirectory(base: string, name: string): string {
  const directory = path.join(base, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "SKILL.md"), "---\nname: x\n---\n");
  return directory;
}

function writeGitConfig(repositoryRoot: string, url: string): void {
  const dotGit = path.join(repositoryRoot, ".git");
  mkdirSync(dotGit, { recursive: true });
  writeFileSync(
    path.join(dotGit, "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "autodev"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/autodev/*\n`
  );
}

test("a skill installed in the repository is repo-scoped, and belongs to that repository's workspace", () => {
  const box = sandbox();
  try {
    writeGitConfig(box.repositoryRoot, "https://github.com/SimulatorLife/AutoDev.git");
    skillDirectory(
      path.join(box.repositoryRoot, ".agents", "skills"),
      "autodev-codex-request-capture"
    );

    const scopes = resolveSkillScopes(["autodev-codex-request-capture"], {
      roots: {
        home: box.home,
        codexHome: box.codexHome,
        repositoryRoot: box.repositoryRoot
      },
      workspaces: box.workspaces
    });

    const facts = scopes.get("autodev-codex-request-capture");
    assert.equal(facts?.scope, "repo");
    assert.equal(
      facts?.location,
      path.join(
        box.repositoryRoot,
        ".agents",
        "skills",
        "autodev-codex-request-capture"
      )
    );
    // The workspace comes from the repository itself, not from a setting: a
    // skill's scope follows the repository it lives in.
    assert.equal(facts?.workspace, "SimulatorLife/AutoDev");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a skill installed in the operator's home is user-scoped and belongs to no workspace", () => {
  const box = sandbox();
  try {
    skillDirectory(path.join(box.home, ".agents", "skills"), "ccc");
    const scopes = resolveSkillScopes(["ccc"], {
      roots: {
        home: box.home,
        codexHome: box.codexHome,
        repositoryRoot: box.repositoryRoot
      },
      workspaces: box.workspaces
    });
    assert.equal(scopes.get("ccc")?.scope, "user");
    assert.equal(scopes.get("ccc")?.workspace, null);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a skill the operator keeps in the Codex home is user-scoped", () => {
  const box = sandbox();
  try {
    skillDirectory(path.join(box.codexHome, "skills"), "playwright-helper");
    const scopes = resolveSkillScopes(["playwright-helper"], {
      roots: {
        home: box.home,
        codexHome: box.codexHome,
        repositoryRoot: box.repositoryRoot
      }
    });
    assert.equal(scopes.get("playwright-helper")?.scope, "user");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a skill Codex ships with is system-scoped", () => {
  const box = sandbox();
  try {
    skillDirectory(path.join(box.codexHome, "skills", ".system"), "skill-creator");
    const scopes = resolveSkillScopes(["skill-creator"], {
      roots: {
        home: box.home,
        codexHome: box.codexHome,
        repositoryRoot: box.repositoryRoot
      }
    });
    assert.equal(scopes.get("skill-creator")?.scope, "system");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a skill installed in both the repository and the home is the repository's", () => {
  const box = sandbox();
  try {
    skillDirectory(path.join(box.repositoryRoot, ".agents", "skills"), "opentelemetry");
    skillDirectory(path.join(box.home, ".agents", "skills"), "opentelemetry");
    const scopes = resolveSkillScopes(["opentelemetry"], {
      roots: {
        home: box.home,
        codexHome: box.codexHome,
        repositoryRoot: box.repositoryRoot
      }
    });
    assert.equal(scopes.get("opentelemetry")?.scope, "repo");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a skill installed nowhere is absent rather than scope-less", () => {
  // "Not installed" is not a scope. A caller that has to tell the two apart
  // should not have to read a null to do it.
  const box = sandbox();
  try {
    const scopes = resolveSkillScopes(["game-playtesting"], {
      roots: {
        home: box.home,
        codexHome: box.codexHome,
        repositoryRoot: box.repositoryRoot
      }
    });
    assert.equal(scopes.has("game-playtesting"), false);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a repository that is not a configured workspace belongs to no workspace", () => {
  const box = sandbox();
  try {
    writeGitConfig(box.repositoryRoot, "https://github.com/other/OtherProject.git");
    skillDirectory(path.join(box.repositoryRoot, ".agents", "skills"), "opentelemetry");
    const scopes = resolveSkillScopes(["opentelemetry"], {
      roots: {
        home: box.home,
        codexHome: box.codexHome,
        repositoryRoot: box.repositoryRoot
      },
      workspaces: box.workspaces
    });
    assert.equal(scopes.get("opentelemetry")?.scope, "repo");
    assert.equal(scopes.get("opentelemetry")?.workspace, null);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("the workspace is read from the repository's own remote", () => {
  const box = sandbox();
  try {
    writeGitConfig(box.repositoryRoot, "git@github.com:SimulatorLife/AutoDev.git");
    assert.equal(
      readRepositoryWorkspaceId(box.repositoryRoot, box.workspaces),
      "SimulatorLife/AutoDev"
    );
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a repository with no remote belongs to no workspace", () => {
  const box = sandbox();
  try {
    assert.equal(
      readRepositoryWorkspaceId(box.repositoryRoot, box.workspaces),
      null
    );
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("the remote a repository names is matched against the workspace catalogue", () => {
  const box = sandbox();
  try {
    writeGitConfig(box.repositoryRoot, "https://github.com/SimulatorLife/AutoDev.git");
    assert.equal(
      readRepositoryWorkspaceId(box.repositoryRoot, ["SimulatorLife/RacingGame"]),
      null
    );
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a remote URL names an owner and a repository", () => {
  assert.equal(
    projectIdFromRemoteUrl("https://github.com/SimulatorLife/AutoDev.git"),
    "SimulatorLife/AutoDev"
  );
  assert.equal(
    projectIdFromRemoteUrl("git@github.com:SimulatorLife/AutoDev.git"),
    "SimulatorLife/AutoDev"
  );
  assert.equal(
    projectIdFromRemoteUrl("https://github.com/SimulatorLife/AutoDev"),
    "SimulatorLife/AutoDev"
  );
  assert.equal(
    projectIdFromRemoteUrl("https://token@github.com/SimulatorLife/AutoDev.git"),
    "SimulatorLife/AutoDev"
  );
});

test("a URL that names no project names no workspace", () => {
  assert.equal(projectIdFromRemoteUrl("https://github.com/"), null);
  assert.equal(projectIdFromRemoteUrl("not a url"), null);
});
