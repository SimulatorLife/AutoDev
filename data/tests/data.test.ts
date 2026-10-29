import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadWorkspaceCatalog,
  readWorkspaceCatalogFile,
  WorkspaceCatalogError
} from "../src/config/workspace-catalog.ts";
import {
  ClickHouseTelemetryClient,
  ConfigRepository,
  parseRuleSyncCommand,
  readPermissionPolicyFile,
  RuleSyncCommandConflictError,
  RuleSyncCommandHistoryUnavailableError,
  RuleSyncCommandValidationError,
  RuleSyncHooksConflictError,
  RuleSyncHooksValidationError,
  RuleSyncRepository,
  RuleSyncSkillConflictError,
  RuleSyncSkillSourceUnavailableError,
  RuleSyncSkillValidationError
} from "../src/index.ts";

function git(repositoryRoot: string, args: readonly string[]): void {
  execFileSync("git", ["-C", repositoryRoot, ...args], { stdio: "ignore" });
}

test("the canonical parser answers what a command's source says", () => {
  // The parser is what reads a command's front matter, and it is exported
  // because a reader that has not written the source yet still has to ask the
  // same question of the same text. A second front-matter reader in that
  // reader would be a second answer to the same question.
  const parsed = parseRuleSyncCommand(
    "dry",
    "---\ntargets: [codexcli]\ndescription: Review source.\n---\n\n# Audit\n\nUse a dry run.\n"
  );
  assert.equal(parsed.name, "dry");
  assert.equal(parsed.prompt, "# Audit\n\nUse a dry run.");
  assert.equal(parsed.description, "Review source.");
  assert.deepEqual(parsed.targets, ["codexcli"]);

  assert.throws(
    () => parseRuleSyncCommand("dry", "# Audit\n\nNo frontmatter.\n"),
    RuleSyncCommandValidationError
  );
});

test("RuleSyncRepository loads canonical RuleSync sources", () => {
  const repo = new RuleSyncRepository();
  const commands = repo.loadCommands();
  assert.equal(commands.valid, true);
  assert.ok(commands.commands.length > 0);
  const dryCommand = commands.commands.find(
    (command) => command.name === "dry"
  );
  assert.ok(dryCommand);
  assert.ok(dryCommand.description?.length);
  assert.deepEqual(dryCommand.targets, ["*"]);
  assert.ok(dryCommand.prompt.length > 0);

  const hooks = repo.loadHooksState("codexcli");
  assert.equal(hooks.valid, true);
  assert.ok(hooks.events.length > 0);
  assert.ok(hooks.events.some((hook) => hook.event === "sessionStart"));

  const skills = repo.loadSkills();
  assert.equal(skills.valid, true);
  assert.ok(skills.skills.length > 0);
  assert.ok(skills.skills.some((s) => s.name === "orchestration"));
  assert.ok(
    skills.skills.every(
      (skill) =>
        skill.path === `.rulesync/skills/${skill.name}/SKILL.md` &&
        skill.description !== `RuleSync skill ${skill.name}`
    )
  );

  const mcps = repo.loadMcpState();
  assert.equal(mcps.valid, true);
  assert.ok(mcps.servers.some((server) => server.name === "lsp"));
  assert.ok(mcps.servers.some((server) => server.name === "autodev_spawn"));
  const context7 = mcps.servers.find((server) => server.name === "context7");
  assert.deepEqual(context7?.targetOverrides, [
    { target: "codexcli", enabled: false }
  ]);
});

test("RuleSyncRepository reads bounded Git command history and compares it with the working tree", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-history-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = path.join(commandsDir, "audit.md");
    const first =
      "---\ntargets: [codexcli]\ndescription: Audit source.\n---\n\n# Audit\n\nReview the source.\n";
    const second = first.replace(
      "Review the source.",
      "Review the canonical source."
    );
    const workingTree = second.replace(
      "Review the canonical source.",
      "Review the current canonical source."
    );
    await writeFile(commandPath, first);
    git(repositoryRoot, ["init", "-q"]);
    git(repositoryRoot, ["config", "user.name", "AutoDev Tests"]);
    git(repositoryRoot, [
      "config",
      "user.email",
      "autodev-tests@example.invalid"
    ]);
    git(repositoryRoot, ["add", ".rulesync/commands/audit.md"]);
    git(repositoryRoot, ["commit", "-q", "-m", "Initial command"]);

    await writeFile(commandPath, second);
    git(repositoryRoot, ["add", ".rulesync/commands/audit.md"]);
    git(repositoryRoot, ["commit", "-q", "-m", "Update command"]);
    await writeFile(commandPath, workingTree);

    const repo = new RuleSyncRepository(repositoryRoot);
    const history = repo.loadCommandHistory("audit");
    assert.ok(history);
    assert.equal(history.status, "available");
    assert.equal(history.hasMore, false);
    assert.equal(history.versions.length, 2);
    assert.equal(history.versions[0]?.versionHash.length, 40);
    assert.ok(
      Number.isFinite(Date.parse(history.versions[0]?.updatedAt ?? ""))
    );

    const previous = history.versions[1];
    assert.ok(previous);
    const version = repo.loadCommandVersion("audit", previous.versionHash);
    assert.ok(version);
    assert.equal(version.content, first);
    assert.match(version.diff, /-Review the source\./u);
    assert.match(version.diff, /\+Review the current canonical source\./u);
    assert.equal(repo.loadCommandVersion("audit", "0".repeat(40)), null);
    assert.equal(repo.loadCommandHistory("../audit"), null);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository bounds command history and reports older revisions", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-history-bound-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = path.join(commandsDir, "audit.md");
    git(repositoryRoot, ["init", "-q"]);
    git(repositoryRoot, ["config", "user.name", "AutoDev Tests"]);
    git(repositoryRoot, [
      "config",
      "user.email",
      "autodev-tests@example.invalid"
    ]);

    for (let revision = 0; revision < 21; revision += 1) {
      await writeFile(
        commandPath,
        `---\ntargets: [codexcli]\ndescription: Audit revision ${revision}.\n---\n\n# Audit\n\nRevision ${revision}.\n`
      );
      git(repositoryRoot, ["add", ".rulesync/commands/audit.md"]);
      git(repositoryRoot, [
        "commit",
        "-q",
        "-m",
        `Command revision ${revision}`
      ]);
    }

    const history = new RuleSyncRepository(repositoryRoot).loadCommandHistory(
      "audit"
    );
    assert.ok(history);
    assert.equal(history.status, "available");
    assert.equal(history.versions.length, 20);
    assert.equal(history.hasMore, true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository pages a command's committed history and opens a revision from an older page", async () => {
  // The history is one ordered list, so a page is a window onto it: the first
  // page answers "what are the newest revisions", the second "what comes
  // after them", and the last says there is nothing after it. A revision an
  // operator reached by paging back is older than the newest page, so it has
  // to be openable even though no single page lists it and the first.
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-history-page-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = path.join(commandsDir, "audit.md");
    git(repositoryRoot, ["init", "-q"]);
    git(repositoryRoot, ["config", "user.name", "AutoDev Tests"]);
    git(repositoryRoot, [
      "config",
      "user.email",
      "autodev-tests@example.invalid"
    ]);

    const revisions: string[] = [];
    for (let revision = 0; revision < 25; revision += 1) {
      await writeFile(
        commandPath,
        `---\ntargets: [codexcli]\ndescription: Audit revision ${revision}.\n---\n\n# Audit\n\nRevision ${revision}.\n`
      );
      git(repositoryRoot, ["add", ".rulesync/commands/audit.md"]);
      git(repositoryRoot, [
        "commit",
        "-q",
        "-m",
        `Command revision ${revision}`
      ]);
      revisions.push(
        execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
          encoding: "utf8"
        }).trim()
      );
    }

    const repo = new RuleSyncRepository(repositoryRoot);
    const newest = repo.loadCommandHistory("audit");
    assert.ok(newest);
    assert.equal(newest.status, "available");
    assert.equal(newest.versions.length, 20);
    assert.equal(newest.hasMore, true);
    assert.equal(newest.versions[0]?.versionHash, revisions[24]);

    const older = repo.loadCommandHistory("audit", { offset: 20, limit: 20 });
    assert.ok(older);
    assert.equal(older.status, "available");
    assert.equal(older.versions.length, 5);
    assert.equal(older.hasMore, false);
    assert.equal(older.versions[0]?.versionHash, revisions[4]);

    // The oldest revision is on the second page only, and it still opens.
    const oldest = revisions[0];
    assert.ok(oldest);
    const version = repo.loadCommandVersion("audit", oldest);
    assert.ok(version);
    assert.equal(version.versionHash, oldest);
    assert.match(version.content, /Revision 0\./u);

    // A page that is not a window onto the history is refused rather than
    // clamped: a clamped page would answer a different question.
    assert.throws(
      () => repo.loadCommandHistory("audit", { offset: -1, limit: 20 }),
      RuleSyncCommandValidationError
    );
    assert.throws(
      () => repo.loadCommandHistory("audit", { offset: 0, limit: 0 }),
      RuleSyncCommandValidationError
    );
    assert.throws(
      () => repo.loadCommandHistory("audit", { offset: 0, limit: 101 }),
      RuleSyncCommandValidationError
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository does not offer a commit that never changed the command as a version of it", async () => {
  // A commit hash is well formed and the file exists at that commit, but the
  // commit never touched the command -- so it is not a version of the
  // command, and offering it would show an operator a "revision" that never
  // changed the prompt.
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-untouched-commit-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = path.join(commandsDir, "audit.md");
    git(repositoryRoot, ["init", "-q"]);
    git(repositoryRoot, ["config", "user.name", "AutoDev Tests"]);
    git(repositoryRoot, [
      "config",
      "user.email",
      "autodev-tests@example.invalid"
    ]);
    await writeFile(
      commandPath,
      "---\ndescription: Audit source.\n---\n\n# Audit\n\nRevision 0.\n"
    );
    git(repositoryRoot, ["add", ".rulesync/commands/audit.md"]);
    git(repositoryRoot, ["commit", "-q", "-m", "Command revision 0"]);
    await writeFile(path.join(repositoryRoot, "README.md"), "# Repo\n");
    git(repositoryRoot, ["add", "README.md"]);
    git(repositoryRoot, ["commit", "-q", "-m", "An unrelated commit"]);
    const unrelated = execFileSync(
      "git",
      ["-C", repositoryRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" }
    ).trim();

    const repo = new RuleSyncRepository(repositoryRoot);
    assert.equal(repo.loadCommandVersion("audit", unrelated), null);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository distinguishes unavailable Git history from an empty command history", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-no-git-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      path.join(commandsDir, "audit.md"),
      "---\ndescription: Audit source.\n---\n\n# Audit\n"
    );
    const repo = new RuleSyncRepository(repositoryRoot);
    assert.deepEqual(repo.loadCommandHistory("audit"), {
      status: "unavailable",
      versions: [],
      hasMore: false
    });
    assert.throws(
      () => repo.loadCommandVersion("audit", "a".repeat(40)),
      RuleSyncCommandHistoryUnavailableError
    );
    git(repositoryRoot, ["init", "-q"]);
    assert.deepEqual(repo.loadCommandHistory("audit"), {
      status: "available",
      versions: [],
      hasMore: false
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository reports a committed repository whose command file has no history yet as available and empty", async () => {
  // The third "no history" shape, and the one that does not go through the
  // unavailable probe at all: `git log -- <path>` succeeds with no output
  // because the repository has commits but never had this file. It must not be
  // reported as unavailable -- nothing is broken -- and it must not be
  // reported as a version either. Pinned because it shares its outcome
  // ("available", no versions) with the empty-repository case while arriving by
  // a different path, so a refactor that collapsed the two would still pass the
  // other two tests.
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-untracked-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(
      path.join(commandsDir, "audit.md"),
      "---\ndescription: Audit source.\n---\n\n# Audit\n"
    );
    git(repositoryRoot, ["init", "-q"]);
    git(repositoryRoot, ["config", "user.name", "AutoDev Tests"]);
    git(repositoryRoot, [
      "config",
      "user.email",
      "autodev-tests@example.invalid"
    ]);
    // One commit, but it does not include the command file.
    await writeFile(path.join(repositoryRoot, "README.md"), "# Repo\n");
    git(repositoryRoot, ["add", "README.md"]);
    git(repositoryRoot, ["commit", "-q", "-m", "Initial commit"]);

    const repo = new RuleSyncRepository(repositoryRoot);
    assert.deepEqual(repo.loadCommandHistory("audit"), {
      status: "available",
      versions: [],
      hasMore: false
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository updates an existing command with revision checks", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-update-")
  );
  try {
    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    const commandPath = path.join(commandsDir, "audit.md");
    const original =
      "---\ntargets: [codexcli]\ndescription: Inspect the repository.\n---\n\n# Audit\n\nReview the source.\n";
    const updated =
      "---\ntargets: [codexcli, claudecode]\ndescription: Audit canonical input.\n---\n\n# Audit\n\nReview canonical source and verify the generated result.\n";
    await writeFile(commandPath, original);

    const repo = new RuleSyncRepository(repositoryRoot);
    const originalCommand = repo.loadCommands().commands[0];
    assert.ok(originalCommand);
    const saved = await repo.updateCommand({
      name: "audit",
      expectedRevision: originalCommand.revision,
      content: updated
    });
    assert.equal(saved.content, updated);
    assert.equal(saved.description, "Audit canonical input.");
    assert.deepEqual(saved.targets, ["codexcli", "claudecode"]);
    assert.notEqual(saved.revision, originalCommand.revision);
    assert.equal(await readFile(commandPath, "utf8"), updated);

    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: originalCommand.revision,
        content: original
      }),
      RuleSyncCommandConflictError
    );
    await assert.rejects(
      repo.updateCommand({
        name: "../outside",
        expectedRevision: saved.revision,
        content: updated
      }),
      RuleSyncCommandValidationError
    );
    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: saved.revision,
        content: "Invalid frontmatter"
      }),
      RuleSyncCommandValidationError
    );
    assert.equal(await readFile(commandPath, "utf8"), updated);

    const competingContents = ["First writer.", "Second writer."].map(
      (description) =>
        `---\ntargets: [codexcli]\ndescription: ${description}\n---\n\n# Audit\n${description}\n`
    );
    const competingUpdates = competingContents.map((content) =>
      repo.updateCommand({
        name: "audit",
        expectedRevision: saved.revision,
        content
      })
    );
    const outcomes = await Promise.allSettled(competingUpdates);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1
    );
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected"
    );
    assert.ok(rejected?.reason instanceof RuleSyncCommandConflictError);
    const finalSource = await readFile(commandPath, "utf8");
    assert.ok(competingContents.includes(finalSource));
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository rejects a symlinked canonical command root before writes", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-root-")
  );
  const externalRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-external-")
  );
  try {
    const externalCommands = path.join(externalRoot, ".rulesync", "commands");
    await mkdir(externalCommands, { recursive: true });
    const content =
      "---\ntargets: [codexcli]\ndescription: External command.\n---\n\nReview.\n";
    await writeFile(path.join(externalCommands, "audit.md"), content);
    await symlink(
      path.join(externalRoot, ".rulesync"),
      path.join(repositoryRoot, ".rulesync"),
      "dir"
    );

    const repo = new RuleSyncRepository(repositoryRoot);
    assert.equal(repo.loadCommands().valid, false);
    await assert.rejects(
      repo.updateCommand({
        name: "audit",
        expectedRevision: "0".repeat(64),
        content
      }),
      RuleSyncCommandValidationError
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("RuleSync command catalog distinguishes an absent, empty, and invalid source", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-commands-state-")
  );
  try {
    const repo = new RuleSyncRepository(repositoryRoot);
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: null,
      issues: [],
      commands: []
    });

    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: true,
      issues: [],
      commands: []
    });

    const commandPath = path.join(commandsDir, "audit.md");
    await writeFile(commandPath, "No command frontmatter.");
    // The parser names the command; that string is what an operator searches
    // for, so it is carried through instead of a generic walk failure.
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: false,
      issues: [
        {
          location: ".rulesync/commands/audit.md",
          message: 'Command "audit" must have valid YAML frontmatter.'
        }
      ],
      commands: []
    });

    await writeFile(
      commandPath,
      "---\ntargets: [codexcli, claudecode]\ndescription: Review canonical sources.\n---\n\n# Audit\n\nCheck the source tree.\n"
    );
    const state = repo.loadCommands();
    assert.equal(state.valid, true);
    assert.deepEqual(state.commands, [
      {
        name: "audit",
        path: ".rulesync/commands/audit.md",
        kind: "command",
        content:
          "---\ntargets: [codexcli, claudecode]\ndescription: Review canonical sources.\n---\n\n# Audit\n\nCheck the source tree.\n",
        prompt: "# Audit\n\nCheck the source tree.",
        revision: createHash("sha256")
          .update(
            "---\ntargets: [codexcli, claudecode]\ndescription: Review canonical sources.\n---\n\n# Audit\n\nCheck the source tree.\n",
            "utf8"
          )
          .digest("hex"),
        description: "Review canonical sources.",
        targets: ["codexcli", "claudecode"]
      }
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository tells an absent command from one it could not read", async () => {
  // The detail read answers three different questions -- is the prompt there,
  // is it not there, or could it not be read -- and a caller that collapses
  // the last two tells an operator their prompt is gone when the file is
  // there and unreadable. The catalogue already tells them apart; the detail
  // read has to as well.
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-read-")
  );
  try {
    const repo = new RuleSyncRepository(repositoryRoot);
    // An absent commands directory holds no command, so the prompt is not
    // there: a measured absence, not a failed read.
    assert.deepEqual(repo.loadCommand("audit"), { status: "not-found" });

    const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
    await mkdir(commandsDir, { recursive: true });
    // The directory is there and holds no such command.
    assert.deepEqual(repo.loadCommand("audit"), { status: "not-found" });

    const commandPath = path.join(commandsDir, "audit.md");
    await writeFile(commandPath, "No command frontmatter.");
    // The file is there and could not be parsed. The catalogue says the same
    // thing about it, and names the command, so the detail names it too.
    const unreadable = repo.loadCommand("audit");
    assert.equal(unreadable.status, "unreadable");
    assert.match(
      unreadable.status === "unreadable" ? unreadable.reason : "",
      /must have valid YAML frontmatter/u
    );

    await writeFile(
      commandPath,
      "---\ntargets: [codexcli]\ndescription: Review canonical sources.\n---\n\n# Audit\n\nCheck the source tree.\n"
    );
    const found = repo.loadCommand("audit");
    assert.equal(found.status, "found");
    assert.equal(found.status === "found" ? found.command.name : "", "audit");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync catalogs reject a symlinked canonical .rulesync root", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-root-")
  );
  const externalRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-external-")
  );
  try {
    await mkdir(path.join(externalRoot, ".rulesync", "commands"), {
      recursive: true
    });
    await mkdir(path.join(externalRoot, ".rulesync", "skills", "audit"), {
      recursive: true
    });
    await writeFile(
      path.join(externalRoot, ".rulesync", "commands", "audit.md"),
      "---\ntargets: [codexcli]\ndescription: External command.\n---\n\nReview.\n"
    );
    await writeFile(
      path.join(externalRoot, ".rulesync", "skills", "audit", "SKILL.md"),
      "---\nname: audit\ndescription: External skill.\n---\n\nReview.\n"
    );
    await symlink(
      path.join(externalRoot, ".rulesync"),
      path.join(repositoryRoot, ".rulesync"),
      "dir"
    );

    const repo = new RuleSyncRepository(repositoryRoot);
    // Asserting `valid === false` alone is what let this defect exist: the flag
    // said "the catalog is broken" without saying that the *canonical root* is a
    // symlink, which is a different repair from a bad file inside a real one.
    assert.deepEqual(repo.loadCommands().issues, [
      {
        location: ".rulesync",
        message:
          '".rulesync" is a symbolic link, and canonical RuleSync sources are read from the repository itself.'
      }
    ]);
    assert.equal(repo.loadCommands().valid, false);
    assert.deepEqual(repo.loadSkills().issues, [
      {
        location: ".rulesync",
        message:
          '".rulesync" is a symbolic link, and canonical RuleSync sources are read from the repository itself.'
      }
    ]);
    assert.equal(repo.loadSkills().valid, false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("RuleSync catalogs name the canonical directory fault, not just an invalid flag", async () => {
  const holder = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-canonical-")
  );
  const repositoryRoot = path.join(holder, "repository-root");
  try {
    // A repository root that is a regular file cannot contain `.rulesync`, so
    // resolving the canonical directory fails with ENOTDIR. That is neither
    // "absent" nor "an invalid catalog", and used to be reported as the latter.
    await writeFile(repositoryRoot, "This repository root is a file.");
    const fileRootState = new RuleSyncRepository(repositoryRoot).loadCommands();
    assert.equal(fileRootState.valid, false);
    assert.equal(fileRootState.commands.length, 0);
    // The resolver resolves symlinks before it joins `.rulesync`, so the test
    // asserts what the operator is shown rather than rebuilding that path here.
    assert.equal(fileRootState.issues.length, 1);
    assert.match(
      String(fileRootState.issues[0]?.location),
      /[/\\]\.rulesync$/u
    );
    assert.match(
      String(fileRootState.issues[0]?.message),
      /could not be read: a path component is not a directory\.$/u
    );

    const repo = new RuleSyncRepository(holder);
    await mkdir(path.join(holder, ".rulesync"), { recursive: true });

    // ".rulesync" present but not a directory.
    await rm(path.join(holder, ".rulesync"), { recursive: true });
    await writeFile(path.join(holder, ".rulesync"), "Not a directory.");
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: false,
      issues: [
        {
          location: ".rulesync",
          message: '".rulesync" exists but is not a directory.'
        }
      ],
      skills: []
    });

    // The child being a regular file is a different path and a different
    // message from the root above.
    await rm(path.join(holder, ".rulesync"));
    await mkdir(path.join(holder, ".rulesync"), { recursive: true });
    await writeFile(path.join(holder, ".rulesync", "commands"), "x");
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: false,
      issues: [
        {
          location: ".rulesync/commands",
          message: '".rulesync/commands" exists but is not a directory.'
        }
      ],
      commands: []
    });

    // A child symlink names the child, so an operator is not sent to fix the
    // root when the root is fine.
    await rm(path.join(holder, ".rulesync", "commands"));
    await mkdir(path.join(holder, "external", "commands"), {
      recursive: true
    });
    await symlink(
      path.join(holder, "external", "commands"),
      path.join(holder, ".rulesync", "commands"),
      "dir"
    );
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: false,
      issues: [
        {
          location: ".rulesync/commands",
          message:
            '".rulesync/commands" is a symbolic link, and canonical RuleSync sources are read from the repository itself.'
        }
      ],
      commands: []
    });

    // A repository root that does not exist is not observed and carries no
    // fault: nothing about its contents was observed to be wrong.
    const absentRepo = new RuleSyncRepository(path.join(holder, "absent"));
    assert.deepEqual(absentRepo.loadCommands(), {
      source: ".rulesync/commands",
      valid: null,
      issues: [],
      commands: []
    });
  } finally {
    await rm(holder, { recursive: true, force: true });
  }
});

test("RuleSync command entries that are not regular files name themselves", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-command-entry-")
  );
  const commandsDir = path.join(repositoryRoot, ".rulesync", "commands");
  try {
    await mkdir(commandsDir, { recursive: true });
    const repo = new RuleSyncRepository(repositoryRoot);

    // A directory named like a command is not a command with a bad header.
    await mkdir(path.join(commandsDir, "notes.md"));
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: false,
      issues: [
        {
          location: ".rulesync/commands/notes.md",
          message:
            '".rulesync/commands/notes.md" exists but is not a regular file.'
        }
      ],
      commands: []
    });
    await rm(path.join(commandsDir, "notes.md"), { recursive: true });

    const command =
      "---\ntargets: [codexcli]\ndescription: Audit command.\n---\n\nReview.\n";
    await writeFile(path.join(repositoryRoot, "outside.md"), command);
    await symlink(
      path.join(repositoryRoot, "outside.md"),
      path.join(commandsDir, "linked.md")
    );
    assert.deepEqual(repo.loadCommands(), {
      source: ".rulesync/commands",
      valid: false,
      issues: [
        {
          location: ".rulesync/commands/linked.md",
          message:
            '".rulesync/commands/linked.md" is a symbolic link, and canonical commands are read from the repository itself.'
        }
      ],
      commands: []
    });
    assert.equal(repo.loadCommands().valid, false);

    // Entries that are not commands are not faults and do not stop the walk.
    await rm(path.join(commandsDir, "linked.md"));
    await writeFile(path.join(commandsDir, "notes.txt"), "Ignore me.");
    await writeFile(path.join(commandsDir, "audit.md"), command);
    const state = repo.loadCommands();
    assert.equal(state.valid, true);
    assert.deepEqual(state.issues, []);
    assert.deepEqual(
      state.commands.map((item) => item.name),
      ["audit"]
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync skill frontmatter faults name the field that is wrong", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-skill-frontmatter-")
  );
  const skillsDir = path.join(repositoryRoot, ".rulesync", "skills");
  try {
    await mkdir(path.join(skillsDir, "audit"), { recursive: true });
    const skillPath = path.join(skillsDir, "audit", "SKILL.md");
    const repo = new RuleSyncRepository(repositoryRoot);

    // A name that disagrees with its directory means the skill cannot be
    // addressed by the name it declares, which is a different repair from a
    // missing description and was previously the same bare flag.
    await writeFile(
      skillPath,
      "---\nname: Release\ndescription: Cut a release.\n---\n\nSteps.\n"
    );
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: false,
      issues: [
        {
          location: ".rulesync/skills/audit/SKILL.md",
          message:
            'The skill frontmatter declares "Release", but the directory is "audit". A skill must be addressable by the name it declares.'
        }
      ],
      skills: []
    });

    // A missing description, an empty one, and frontmatter that is not a
    // mapping are three faults that otherwise all render as a blank cell.
    await writeFile(skillPath, "---\nname: audit\n---\n\nSteps.\n");
    assert.equal(
      repo.loadSkills().issues[0]?.message,
      "The skill frontmatter must declare a description string."
    );

    await writeFile(
      skillPath,
      '---\nname: audit\ndescription: "  "\n---\n\nSteps.\n'
    );
    assert.equal(
      repo.loadSkills().issues[0]?.message,
      "The skill frontmatter declares an empty description."
    );

    await writeFile(skillPath, "---\n- audit\n- release\n---\n\nSteps.\n");
    assert.equal(
      repo.loadSkills().issues[0]?.message,
      "The skill frontmatter must be a mapping of fields."
    );

    // Frontmatter that is not YAML names the file, like every other fault here.
    await writeFile(skillPath, "---\nname: [audit\n---\n\nSteps.\n");
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: false,
      issues: [
        {
          location: ".rulesync/skills/audit/SKILL.md",
          message:
            '".rulesync/skills/audit/SKILL.md" frontmatter is not valid YAML.'
        }
      ],
      skills: []
    });

    // A directory name the loader cannot address is named as such rather than
    // skipped, which would report a shorter catalog than the directory holds.
    await rm(path.join(skillsDir, "audit"), { recursive: true });
    await mkdir(path.join(skillsDir, "Not A Name"), { recursive: true });
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: false,
      issues: [
        {
          location: ".rulesync/skills/Not A Name",
          message:
            '"Not A Name" is not a usable skill directory name: expected lowercase letters, digits, and hyphens.'
        }
      ],
      skills: []
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync skill catalog distinguishes an absent, empty, and invalid source", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-rulesync-skills-state-")
  );
  try {
    const repo = new RuleSyncRepository(repositoryRoot);
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: null,
      issues: [],
      skills: []
    });

    const skillsDir = path.join(repositoryRoot, ".rulesync", "skills");
    await mkdir(skillsDir, { recursive: true });
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: true,
      issues: [],
      skills: []
    });

    const skillDir = path.join(skillsDir, "audit");
    await mkdir(skillDir);
    const skillPath = path.join(skillDir, "SKILL.md");
    await writeFile(skillPath, "Not a RuleSync skill document.");
    // A SKILL.md with no frontmatter is a different repair from a symlinked
    // directory or a name mismatch, and the page could not tell them apart.
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: false,
      issues: [
        {
          location: ".rulesync/skills/audit/SKILL.md",
          message:
            '".rulesync/skills/audit/SKILL.md" must have YAML frontmatter.'
        }
      ],
      skills: []
    });

    await writeFile(
      skillPath,
      "---\nname: audit\ndescription: Check the source catalog.\n---\n\nInspect source state.\n"
    );
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: true,
      issues: [],
      skills: [
        {
          name: "audit",
          description: "Check the source catalog.",
          path: ".rulesync/skills/audit/SKILL.md"
        }
      ]
    });

    const externalSkillPath = path.join(repositoryRoot, "external-SKILL.md");
    await writeFile(
      externalSkillPath,
      "---\nname: audit\ndescription: External content.\n---\n"
    );
    await rm(skillPath);
    await symlink(externalSkillPath, skillPath);
    // A symlinked SKILL.md and a symlinked skill directory are different faults
    // at different paths, and the page reported both as one flag.
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: false,
      issues: [
        {
          location: ".rulesync/skills/audit/SKILL.md",
          message:
            '".rulesync/skills/audit/SKILL.md" is not a regular file in the skill directory.'
        }
      ],
      skills: []
    });

    await rm(skillPath);
    await rm(skillDir, { recursive: true });
    await symlink(externalSkillPath, skillDir, "dir");
    assert.deepEqual(repo.loadSkills(), {
      source: ".rulesync/skills",
      valid: false,
      issues: [
        {
          location: ".rulesync/skills/audit",
          message:
            '".rulesync/skills/audit" is a symbolic link, and canonical skills are read from the repository itself.'
        }
      ],
      skills: []
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository reads and revision-checks exact canonical skill source", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-skill-source-")
  );
  try {
    const skillDir = path.join(repositoryRoot, ".rulesync", "skills", "audit");
    await mkdir(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    const original =
      '---\nname: audit\ndescription: "An exact description."\ncustom: [one, two]\n---\n\n# Audit\n\nPreserve  exact markdown.\n';
    const updated =
      '---\r\nname: audit\r\ndescription: "Updated description."\r\ncustom: [two, one]\r\n---\r\n\r\n# Audit\r\n\r\nPreserve  every space and CRLF.\r\n';
    await writeFile(skillPath, original);
    const repo = new RuleSyncRepository(repositoryRoot);
    const detail = repo.readSkillSource("audit");
    assert.equal(detail.content, original);
    assert.equal(detail.path, ".rulesync/skills/audit/SKILL.md");
    assert.equal(
      detail.revision,
      createHash("sha256").update(original, "utf8").digest("hex")
    );

    const saved = await repo.updateSkillSource({
      name: "audit",
      expectedRevision: detail.revision,
      content: updated
    });
    assert.equal(saved.content, updated);
    assert.equal(
      saved.revision,
      createHash("sha256").update(updated, "utf8").digest("hex")
    );
    assert.equal(await readFile(skillPath, "utf8"), updated);
    assert.equal(
      repo.loadSkills().skills[0]?.description,
      "Updated description."
    );
    await assert.rejects(
      repo.updateSkillSource({
        name: "audit",
        expectedRevision: detail.revision,
        content: original
      }),
      RuleSyncSkillConflictError
    );
    await assert.rejects(
      repo.updateSkillSource({
        name: "audit",
        expectedRevision: "invalid",
        content: updated
      }),
      RuleSyncSkillValidationError
    );
    await assert.rejects(
      repo.updateSkillSource({
        name: "missing",
        expectedRevision: saved.revision,
        content: updated.replace("name: audit", "name: missing")
      }),
      RuleSyncSkillConflictError
    );

    const unchanged = await readFile(skillPath, "utf8");
    for (const content of [
      "not frontmatter",
      "---\nname: other\ndescription: Valid description.\n---\nBody\n",
      '---\nname: audit\ndescription: "  "\n---\nBody\n',
      `---\nname: audit\ndescription: Valid description.\n---\n${"x".repeat(48_001)}`,
      "---\nname: audit\ndescription: Valid description.\n---\nBad\u0000control\n"
    ]) {
      await assert.rejects(
        repo.updateSkillSource({
          name: "audit",
          expectedRevision: saved.revision,
          content
        }),
        RuleSyncSkillValidationError
      );
      assert.equal(await readFile(skillPath, "utf8"), unchanged);
    }

    const contenders = ["First edit.", "Second edit."].map((body) =>
      repo.updateSkillSource({
        name: "audit",
        expectedRevision: saved.revision,
        content: `---\nname: audit\ndescription: Concurrent edit.\n---\n${body}\n`
      })
    );
    const outcomes = await Promise.allSettled(contenders);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1
    );
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected"
    );
    assert.ok(rejected?.reason instanceof RuleSyncSkillConflictError);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync skill source updates refuse invalid catalogs and symlinked source files", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-skill-source-safe-")
  );
  try {
    const skillsDir = path.join(repositoryRoot, ".rulesync", "skills");
    const skillDir = path.join(skillsDir, "audit");
    await mkdir(skillDir, { recursive: true });
    const source =
      "---\nname: audit\ndescription: Valid description.\n---\nBody.\n";
    const outside = path.join(repositoryRoot, "outside.md");
    const skillPath = path.join(skillDir, "SKILL.md");
    await writeFile(outside, source);
    await symlink(outside, skillPath);
    const repo = new RuleSyncRepository(repositoryRoot);
    assert.throws(
      () => repo.readSkillSource("audit"),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RuleSyncSkillValidationError)
    );
    await assert.rejects(
      repo.updateSkillSource({
        name: "audit",
        expectedRevision: "0".repeat(64),
        content: source
      }),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RuleSyncSkillValidationError)
    );
    assert.equal(await readFile(outside, "utf8"), source);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync skill source reads and writes preserve an unobserved catalog as unavailable", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-skill-source-unobserved-")
  );
  try {
    const repository = new RuleSyncRepository(repositoryRoot);
    assert.throws(
      () => repository.readSkillSource("audit"),
      RuleSyncSkillSourceUnavailableError
    );
    await assert.rejects(
      repository.updateSkillSource({
        name: "audit",
        expectedRevision: "0".repeat(64),
        content:
          "---\nname: audit\ndescription: Valid description.\n---\nBody.\n"
      }),
      RuleSyncSkillSourceUnavailableError
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync skill catalog rejects oversized sources before reading their contents", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-skill-source-oversized-")
  );
  try {
    const skillDir = path.join(repositoryRoot, ".rulesync", "skills", "audit");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: audit\ndescription: Too large.\n---\n${"x".repeat(48_001)}`
    );
    const state = new RuleSyncRepository(repositoryRoot).loadSkills();
    assert.equal(state.valid, false);
    assert.match(state.issues[0]?.message ?? "", /48000-byte source limit/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync MCP state parses canonical JSONC and target overrides without exposing config", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "autodev-mcp-"));
  const sourcePath = path.join(repositoryRoot, ".rulesync", "mcp.jsonc");
  const repo = new RuleSyncRepository(repositoryRoot);
  try {
    assert.deepEqual(repo.loadMcpState(), {
      source: ".rulesync/mcp.jsonc",
      valid: null,
      issues: [],
      servers: []
    });

    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      `{
        // Credential values and credential references (env values, bearer_token_env_var)
        // are never returned by this read model; launch descriptors like command, url,
        // and env key names are.
        "mcpServers": {
          "local": { "command": "node", "env": { "TOKEN": "secret" }, },
          "remote": { "url": "https://mcp.example.test", "bearer_token_env_var": "MCP_TOKEN" },
          "default-disabled": { "command": "node", "disabled": true },
        },
        "codexcli": {
          "mcpServers": {
            "remote": null,
            "local": { "command": "node", "args": ["local"], },
            "codex-only": { "command": "node", "disabled": false, },
            "target-disabled": { "command": "node", "disabled": true, },
          },
        },
        "copilotcli": { "mcpServers": { "local": null, }, },
      }`,
      "utf8"
    );

    assert.deepEqual(repo.loadMcpState(), {
      source: ".rulesync/mcp.jsonc",
      valid: true,
      issues: [],
      servers: [
        {
          name: "codex-only",
          enabled: null,
          transport: "stdio",
          targetOverrides: [{ target: "codexcli", enabled: true }]
        },
        {
          name: "default-disabled",
          enabled: false,
          transport: "stdio",
          command: "node",
          targetOverrides: []
        },
        {
          name: "local",
          enabled: true,
          transport: "stdio",
          command: "node",
          envKeys: ["TOKEN"],
          targetOverrides: [
            { target: "codexcli", enabled: true },
            { target: "copilotcli", enabled: false }
          ]
        },
        {
          name: "remote",
          enabled: true,
          transport: "http",
          url: "https://mcp.example.test",
          targetOverrides: [{ target: "codexcli", enabled: false }]
        },
        {
          name: "target-disabled",
          enabled: null,
          transport: "stdio",
          targetOverrides: [{ target: "codexcli", enabled: false }]
        }
      ]
    });

    await writeFile(
      sourcePath,
      `{"mcpServers":{"bad":{"command":"node"}},"codexcli":{"mcpServers":{"bad":{"command":"node","disabled":"yes"}}}}`,
      "utf8"
    );
    assert.deepEqual(repo.loadMcpState(), {
      source: ".rulesync/mcp.jsonc",
      valid: false,
      // The base declaration of `bad` is fine; it is the per-target override
      // that cannot be applied, so the reason names the target too.
      issues: [
        {
          location: "codexcli.mcpServers.bad",
          message:
            'The override for "bad" under "codexcli" is not a usable MCP server declaration.'
        }
      ],
      servers: []
    });

    await writeFile(sourcePath, `{"mcpServers": []}`, "utf8");
    assert.deepEqual(repo.loadMcpState(), {
      source: ".rulesync/mcp.jsonc",
      valid: false,
      issues: [
        {
          location: "mcpServers",
          message: 'The MCP source must have an "mcpServers" object.'
        }
      ],
      servers: []
    });
    await writeFile(sourcePath, "{", "utf8");
    const truncated = repo.loadMcpState();
    assert.equal(truncated.valid, false);
    assert.deepEqual(truncated.servers, []);
    // A truncated document is reported by line, like every other RuleSync
    // source, so an operator is sent to the fault rather than to the file.
    assert.match(
      truncated.issues[0]?.location ?? "",
      /^line \d+$/u,
      `expected a line number, got ${JSON.stringify(truncated.issues[0]?.location)}`
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync hook state is the declaration the target actually receives", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-hooks-target-")
  );
  const sourcePath = path.join(repositoryRoot, ".rulesync", "hooks.jsonc");
  const repo = new RuleSyncRepository(repositoryRoot);
  try {
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      `{
        // The shared declaration is what every target inherits.
        "hooks": {
          "sessionStart": [{
            "type": "command",
            "command": "node shared-session-start.ts"
          }],
          "preToolUse": [{
            "type": "command",
            "matcher": "shared-matcher",
            "command": "node shared-pre-tool-use.ts"
          }]
        },
        "codexcli": {
          "hooks": {
            "preToolUse": [{
              "type": "command",
              "command": "node codex-pre-tool-use.ts"
            }],
            "sessionEnd": [{
              "type": "command",
              "command": "node codex-session-end.ts"
            }]
          }
        }
      }`,
      "utf8"
    );

    const codex = repo.loadHooksState("codexcli");
    assert.equal(codex.valid, true);
    assert.deepEqual(codex.issues, []);
    assert.deepEqual(
      codex.events.map((event) => event.event),
      ["sessionStart", "preToolUse", "sessionEnd"]
    );
    const preToolUse = codex.events.find(
      (event) => event.event === "preToolUse"
    );
    // RuleSync merges the target's own declaration over the shared one, one
    // event at a time, and a target's own declaration of an event replaces the
    // shared one rather than adding to it. Reading the union of the two lists
    // would report an action the Runtime never installs.
    assert.deepEqual(preToolUse?.actions, [
      { type: "command", command: "node codex-pre-tool-use.ts" }
    ]);
    assert.equal(preToolUse?.origin, "target");
    assert.equal(
      codex.events.find((event) => event.event === "sessionStart")?.origin,
      "shared"
    );
    assert.equal(
      codex.events.find((event) => event.event === "sessionEnd")?.origin,
      "target"
    );

    // Another target inherits the shared declaration and none of the Codex
    // one, so the same document reads differently for it.
    const other = repo.loadHooksState("claudecode");
    assert.deepEqual(
      other.events.map((event) => event.event),
      ["sessionStart", "preToolUse"]
    );
    assert.equal(
      other.events.find((event) => event.event === "preToolUse")?.origin,
      "shared"
    );

    // The revision is the handle a write compares against, so it is read from
    // the document itself.
    const revision = repo.loadHooksRevision();
    assert.equal(revision.source, ".rulesync/hooks.jsonc");
    assert.equal(revision.valid, true);
    assert.equal(
      revision.revision,
      createHash("sha256")
        .update(await readFile(sourcePath, "utf8"), "utf8")
        .digest("hex")
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync hook writes are revision-guarded and land where the event lives", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-hooks-write-")
  );
  const sourcePath = path.join(repositoryRoot, ".rulesync", "hooks.jsonc");
  const repo = new RuleSyncRepository(repositoryRoot);
  const write = async (
    event: "sessionStart" | "preToolUse" | "sessionEnd",
    actions: readonly {
      readonly type: "command";
      readonly command: string;
      readonly matcher?: string;
      readonly statusMessage?: string;
    }[],
    expectedRevision: string
  ) =>
    repo.updateHookEvent({
      event,
      target: "codexcli",
      actions,
      expectedRevision
    });
  try {
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      `{
        // A comment the write must not eat.
        "hooks": {
          "sessionStart": [{
            "type": "command",
            "command": "node shared-session-start.ts"
          }]
        },
        "codexcli": {
          "hooks": {
            "sessionEnd": [{
              "type": "command",
              "command": "node codex-session-end.ts"
            }]
          }
        }
      }`,
      "utf8"
    );

    const first = repo.loadHooksRevision().revision;
    assert.ok(first);

    // A stale revision is refused rather than applied over a newer document.
    await assert.rejects(
      write(
        "sessionStart",
        [{ type: "command", command: "node other.ts" }],
        "0".repeat(64)
      ),
      RuleSyncHooksConflictError
    );

    // An action the declaration cannot hold is refused before the document is
    // touched.
    await assert.rejects(
      write("sessionStart", [{ type: "command", command: "  " }], first),
      RuleSyncHooksValidationError
    );

    // The event the target inherits is written to the shared declaration,
    // because that is where it lives.
    const shared = await write(
      "sessionStart",
      [
        {
          type: "command",
          command: "node shared-session-start.ts",
          statusMessage: "Starting the session"
        }
      ],
      first
    );
    assert.equal(shared.origin, "shared");
    assert.notEqual(shared.revision, first);
    const afterShared = await readFile(sourcePath, "utf8");
    assert.match(afterShared, /A comment the write must not eat\./u);
    assert.match(afterShared, /"statusMessage": "Starting the session"/u);
    // The target's own block is not touched by a write to the shared one.
    assert.match(afterShared, /"codexcli": \{\s*"hooks": \{\s*"sessionEnd"/u);

    // The event the target declares is written to the target's own
    // declaration, and the shared one is left alone.
    const target = await write(
      "sessionEnd",
      [{ type: "command", command: "node codex-session-end.ts" }],
      shared.revision
    );
    assert.equal(target.origin, "target");
    assert.deepEqual(target.actions, [
      { type: "command", command: "node codex-session-end.ts" }
    ]);
    const afterTarget = await readFile(sourcePath, "utf8");
    assert.match(afterTarget, /"codexcli"/u);
    assert.match(afterTarget, /"sessionEnd"/u);

    // An empty action list removes the event rather than declaring an event
    // with nothing in it.
    const removed = await write("sessionEnd", [], target.revision);
    assert.deepEqual(removed.actions, []);
    const afterRemoval = await readFile(sourcePath, "utf8");
    assert.doesNotMatch(afterRemoval, /"sessionEnd"/u);
    assert.match(afterRemoval, /"sessionStart"/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSync hook state distinguishes absent, valid JSONC, and invalid source", async () => {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), "autodev-hooks-"));
  const sourcePath = path.join(repositoryRoot, ".rulesync", "hooks.jsonc");
  const repo = new RuleSyncRepository(repositoryRoot);
  try {
    const absent = repo.loadHooksState("codexcli");
    assert.equal(absent.valid, null);
    assert.deepEqual(
      absent.issues,
      [],
      "an unobserved source has no faults to report and must not invent any"
    );

    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(
      sourcePath,
      `{
        // JSONC comments and trailing commas are valid RuleSync source.
        "hooks": {
          "sessionStart": [{
            "type": "command",
            "command": "node hook.ts",
          }],
        },
      }`,
      "utf8"
    );
    const valid = repo.loadHooksState("codexcli");
    assert.equal(valid.valid, true);
    assert.deepEqual(valid.issues, []);
    assert.equal(valid.events[0]?.actions[0]?.command, "node hook.ts");

    // Every one of these faults was located by the loader before it answered
    // `valid: false`. Reporting only the flag left the operator to re-find a
    // position the system had already computed.
    await writeFile(
      sourcePath,
      `{"hooks":{"sessionStart":[{"type":"command"}]}}`,
      "utf8"
    );
    const missingCommand = repo.loadHooksState("codexcli");
    assert.equal(missingCommand.valid, false);
    assert.deepEqual(missingCommand.events, []);
    assert.deepEqual(missingCommand.issues, [
      {
        location: "sessionStart action 1",
        message:
          'Action 1 of "sessionStart" is not a command hook with a non-empty command string.'
      }
    ]);

    // The index is the point: the first action is fine, the second is not, and
    // both faults would otherwise be reported as "an action under sessionStart".
    await writeFile(
      sourcePath,
      `{"hooks":{"sessionStart":[{"type":"command","command":"ok"},{"type":"command","command":"   "}]}}`,
      "utf8"
    );
    const secondAction = repo.loadHooksState("codexcli");
    assert.deepEqual(secondAction.issues, [
      {
        location: "sessionStart action 2",
        message:
          'Action 2 of "sessionStart" is not a command hook with a non-empty command string.'
      }
    ]);

    await writeFile(sourcePath, `{"hooks":{"SessionStartt":[]}}`, "utf8");
    const unknownEvent = repo.loadHooksState("codexcli");
    assert.deepEqual(unknownEvent.issues, [
      {
        location: "SessionStartt",
        message: '"SessionStartt" is not a hook event the Codex runtime runs.'
      }
    ]);

    await writeFile(sourcePath, `{"hooks":{"sessionStart":"nope"}}`, "utf8");
    const actionsNotAnArray = repo.loadHooksState("codexcli");
    assert.equal(actionsNotAnArray.valid, false);
    assert.deepEqual(actionsNotAnArray.issues, [
      {
        location: "sessionStart",
        message: 'The actions for "sessionStart" must be an array.'
      }
    ]);

    await writeFile(sourcePath, `{"other":true}`, "utf8");
    assert.deepEqual(repo.loadHooksState("codexcli").issues, [
      {
        location: "hooks",
        message: 'The hook source must have a "hooks" object.'
      }
    ]);

    await writeFile(sourcePath, `[1,2,3]`, "utf8");
    assert.deepEqual(repo.loadHooksState("codexcli").issues, [
      {
        location: ".rulesync/hooks.jsonc",
        message: "The hook source must be a JSON object."
      }
    ]);

    // A syntax fault reports a line an operator can navigate to, not a character
    // offset they would have to convert themselves.
    await writeFile(
      sourcePath,
      `{\n  "hooks": {\n    "sessionStart": [,]\n  }\n}`,
      "utf8"
    );
    const syntax = repo.loadHooksState("codexcli");
    assert.equal(syntax.valid, false);
    assert.ok(syntax.issues.length > 0, "a syntax fault must say something");
    assert.match(
      syntax.issues[0]?.location ?? "",
      /^line \d+$/u,
      `expected a line number, got ${JSON.stringify(syntax.issues[0]?.location)}`
    );
    assert.ok(
      (syntax.issues[0]?.message.length ?? 0) > 0,
      "a reported line with no explanation is not actionable"
    );

    await writeFile(sourcePath, "{", "utf8");
    assert.equal(repo.loadHooksState("codexcli").valid, false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("ConfigRepository reads agent role identifiers and workspaces", () => {
  const repo = new ConfigRepository();
  const agentRoles = repo.loadAgentRoles();
  assert.ok(agentRoles.length > 0);
  assert.ok(agentRoles.includes("orchestrator"));

  const workspaceCatalog = repo.readWorkspaceCatalog();
  assert.equal(workspaceCatalog.status, "valid");
  const workspaces = workspaceCatalog.workspaces;
  assert.ok(workspaces.length > 0);
  assert.ok(workspaces.some((w) => w.id === "SimulatorLife/AutoDev"));

  const policy = readPermissionPolicyFile(repo.permissionPolicyPath());
  assert.equal(policy.status, "valid");
  if (policy.status === "valid") {
    assert.ok(policy.policy.approvalPolicy);
    assert.ok(policy.policy.sandboxMode);
  }
});

test("ConfigRepository does not derive Agent roles from a malformed contract section", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-config-agent-roles-")
  );
  const configDirectory = path.join(repositoryRoot, "config");
  await mkdir(configDirectory, { recursive: true });
  const contractPath = path.join(configDirectory, "execution-contract.json");
  const repository = new ConfigRepository(repositoryRoot);
  try {
    for (const roles of [null, [], "playtester"]) {
      await writeFile(contractPath, JSON.stringify({ roles }), "utf8");
      assert.deepEqual(repository.loadAgentRoles(), []);
    }
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("ConfigRepository distinguishes missing and invalid workspace sources from an empty catalog", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-config-workspaces-")
  );
  const repository = new ConfigRepository(repositoryRoot);
  try {
    assert.deepEqual(repository.readWorkspaceCatalog(), {
      status: "unavailable",
      workspaces: [],
      revision: null
    });

    const configDirectory = path.join(repositoryRoot, "config");
    await mkdir(configDirectory, { recursive: true });
    const catalogPath = path.join(configDirectory, "workspaces.json");
    await writeFile(
      catalogPath,
      JSON.stringify({ schema: "autodev-workspaces-v1", workspaces: [] }),
      "utf8"
    );
    // The revision is the handle a write is compared against: the sha256 of
    // the catalog's exact bytes.
    assert.deepEqual(repository.readWorkspaceCatalog(), {
      status: "valid",
      workspaces: [],
      revision: createHash("sha256")
        .update(await readFile(catalogPath))
        .digest("hex")
    });

    await writeFile(
      catalogPath,
      JSON.stringify({
        schema: "autodev-workspaces-v1",
        workspaces: [{ id: "SimulatorLife/AutoDev" }]
      }),
      "utf8"
    );
    assert.deepEqual(repository.readWorkspaceCatalog(), {
      status: "invalid",
      workspaces: [],
      revision: createHash("sha256")
        .update(await readFile(catalogPath))
        .digest("hex")
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("ConfigRepository and the catalog owner agree about the same file", async () => {
  // The repository used to carry its own copy of the catalog's rules, and
  // the CI's script carried another. Two readers of one file that can
  // disagree are two answers to one question, so the repository now asks the
  // owner. This is the guard on that: whatever the repository says about a
  // catalog, the owner says the same.
  const canonicalPath = fileURLToPath(
    new URL("../../config/workspaces.json", import.meta.url)
  );
  const repository = new ConfigRepository();
  const read = repository.readWorkspaceCatalog();
  assert.equal(read.status, "valid");
  const catalog = loadWorkspaceCatalog(canonicalPath);
  assert.deepEqual(
    read.workspaces.map((workspace) => ({
      id: workspace.id,
      baseBranch: workspace.baseBranch,
      enabled: workspace.enabled,
      agentRoles: workspace.agentRoles
    })),
    catalog.list.map((workspace) => ({
      id: workspace.id,
      baseBranch: workspace.baseBranch,
      enabled: workspace.enabled,
      agentRoles: workspace.agentRoles
    }))
  );

  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-config-workspaces-agree-")
  );
  try {
    const configDirectory = path.join(repositoryRoot, "config");
    await mkdir(configDirectory, { recursive: true });
    const catalogPath = path.join(configDirectory, "workspaces.json");
    await writeFile(
      catalogPath,
      JSON.stringify({
        schema: "autodev-workspaces-v1",
        workspaces: [{ id: "SimulatorLife/AutoDev" }]
      }),
      "utf8"
    );
    const brokenRepository = new ConfigRepository(repositoryRoot);
    assert.equal(brokenRepository.readWorkspaceCatalog().status, "invalid");
    assert.equal(readWorkspaceCatalogFile(catalogPath).status, "invalid");
    assert.throws(
      () => loadWorkspaceCatalog(catalogPath),
      WorkspaceCatalogError
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

const SERVICE_PARAM_PATTERN = /ServiceName = \{service:String\}/;
const SPAN_ATTR_PATTERN = /SpanAttributes\['gen_ai.system'\] = \{f_0:String\}/;

test("ClickHouseTelemetryClient constructs safe parameterized queries", () => {
  const client = new ClickHouseTelemetryClient();
  const pq = client.buildTraceQuery({
    serviceName: "autodev-router",
    startTime: "2026-09-30 00:00:00",
    endTime: "2026-09-30 23:59:59",
    filters: { "gen_ai.system": "openai" }
  });
  assert.match(pq.query, SERVICE_PARAM_PATTERN);
  assert.match(pq.query, SPAN_ATTR_PATTERN);
  assert.equal(pq.params.service, "autodev-router");
  assert.equal(pq.params.f_0, "openai");
});

test("RuleSyncRepository promotes skills by creating an idempotent canonical source file", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-skill-promotion-")
  );
  try {
    const repo = new RuleSyncRepository(repositoryRoot);
    const input = {
      name: "verified-memory-workflow",
      description: "Validate current evidence before changing memory.",
      content:
        "## Steps\n\n1. Re-check the repository evidence.\n2. Run the focused tests."
    };
    const artifact = await repo.createSkill(input);
    assert.equal(
      artifact.path,
      ".rulesync/skills/verified-memory-workflow/SKILL.md"
    );
    assert.equal(
      artifact.uri,
      "rulesync://skills/verified-memory-workflow/SKILL.md"
    );
    assert.match(artifact.revision, /^[a-f0-9]{64}$/u);
    assert.equal(
      (
        await readFile(path.join(repositoryRoot, artifact.path), "utf8")
      ).includes(input.content),
      true
    );
    const promoted = repo
      .loadSkills()
      .skills.find((skill) => skill.name === input.name);
    assert.equal(promoted?.description, input.description);

    const repeated = await repo.createSkill(input);
    assert.deepEqual(repeated, artifact);
    await assert.rejects(
      repo.createSkill({ ...input, content: "Different instructions." }),
      RuleSyncSkillConflictError
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("RuleSyncRepository refuses unsafe skill names and symlinked canonical directories", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-skill-promotion-safe-")
  );
  const externalRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-skill-external-")
  );
  try {
    const repo = new RuleSyncRepository(repositoryRoot);
    const valid = {
      name: "safe-skill",
      description: "A safe skill.",
      content: "Do the documented safe steps."
    };
    await assert.rejects(
      repo.createSkill({ ...valid, name: "../escape" }),
      TypeError
    );
    await mkdir(path.join(repositoryRoot, ".rulesync"), { recursive: true });
    await symlink(
      externalRoot,
      path.join(repositoryRoot, ".rulesync", "skills")
    );
    await assert.rejects(repo.createSkill(valid), RuleSyncSkillConflictError);
    assert.equal(existsSync(path.join(externalRoot, "safe-skill")), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("RuleSync MCP state names the declaration or override it could not apply", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-mcp-issues-")
  );
  const sourcePath = path.join(repositoryRoot, ".rulesync", "mcp.jsonc");
  const repo = new RuleSyncRepository(repositoryRoot);
  const load = async (content: string) => {
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, content, "utf8");
    return repo.loadMcpState();
  };

  try {
    // A base declaration that is not an MCP server object. The name is the
    // thing an operator can act on, and the loader had it in hand.
    const badDisabled = await load(`{"mcpServers":{"lsp":{"disabled":"yes"}}}`);
    assert.equal(badDisabled.valid, false);
    assert.deepEqual(badDisabled.servers, []);
    assert.deepEqual(badDisabled.issues, [
      {
        location: "mcpServers.lsp",
        message: '"lsp" is not a usable MCP server declaration.'
      }
    ]);

    // A server name no target can address. Distinct from a malformed
    // declaration: the declaration is fine and the name is the fault.
    const emptyName = await load(`{"mcpServers":{"":{"command":"x"}}}`);
    assert.equal(emptyName.valid, false);
    assert.deepEqual(emptyName.issues, [
      {
        location: "mcpServers",
        message:
          "The MCP source has an empty server name, which no target can address."
      }
    ]);

    // A target's override block that is not an object. The base file is valid,
    // so reporting only the file would point at the wrong edit.
    const badOverrides = await load(
      `{"mcpServers":{},"codexcli":{"mcpServers":"none"}}`
    );
    assert.equal(badOverrides.valid, false);
    assert.deepEqual(badOverrides.issues, [
      {
        location: "codexcli.mcpServers.mcpServers",
        message: 'The overrides for "codexcli" must be an object of servers.'
      }
    ]);

    // An override naming a server that is not a usable declaration. Both halves
    // of the location are reported because they are different edits in the same
    // file: the base `mcpServers` entry and the per-target one.
    const badOverrideServer = await load(
      `{"mcpServers":{"lsp":{"command":"x"}},"codexcli":{"mcpServers":{"lsp":{"disabled":1}}}}`
    );
    assert.equal(badOverrideServer.valid, false);
    assert.deepEqual(badOverrideServer.issues, [
      {
        location: "codexcli.mcpServers.lsp",
        message:
          'The override for "lsp" under "codexcli" is not a usable MCP server declaration.'
      }
    ]);

    const noBlock = await load(`{"servers":{}}`);
    assert.deepEqual(noBlock.issues, [
      {
        location: "mcpServers",
        message: 'The MCP source must have an "mcpServers" object.'
      }
    ]);

    const notAnObject = await load(`[1,2,3]`);
    assert.deepEqual(notAnObject.issues, [
      {
        location: ".rulesync/mcp.jsonc",
        message: "The MCP source must be a JSON object."
      }
    ]);

    // A syntax fault reports a line, matching the hook loader, because the two
    // are read by the same operator editing the same directory.
    const syntax = await load(`{\n  "mcpServers": {\n    "lsp": [,]\n  }\n}`);
    assert.equal(syntax.valid, false);
    assert.match(
      syntax.issues[0]?.location ?? "",
      /^line \d+$/u,
      `expected a line number, got ${JSON.stringify(syntax.issues[0]?.location)}`
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
