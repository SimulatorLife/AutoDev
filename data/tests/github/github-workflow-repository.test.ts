import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GithubWorkflowRepository } from "../../src/github/github-workflow-repository.ts";

test("GithubWorkflowRepository parses the real AutoDev workflow catalog", () => {
  const repository = new GithubWorkflowRepository();
  const catalog = repository.readWorkflowCatalog();
  assert.equal(catalog.status, "valid");
  assert.ok(catalog.workflows.length > 0);

  const scheduler = catalog.workflows.find((w) => w.id === "_scheduler.yml");
  assert.ok(scheduler);
  assert.equal(scheduler.name, "scheduler");
  assert.equal(scheduler.path, ".github/workflows/_scheduler.yml");
  assert.deepEqual(scheduler.events, ["schedule", "workflow_dispatch"]);
  assert.deepEqual(scheduler.schedules, ["*/15 * * * *"]);

  const metricsDashboard = catalog.workflows.find(
    (w) => w.id === "metrics-dashboard.yml"
  );
  assert.ok(metricsDashboard);
  assert.equal(metricsDashboard.name, "AutoDev Metrics Dashboard");
  assert.deepEqual(metricsDashboard.events, ["schedule", "workflow_dispatch"]);
  assert.deepEqual(metricsDashboard.schedules, ["17 * * * *"]);

  const agentInvoke = catalog.workflows.find(
    (w) => w.id === "agent-invoke.yml"
  );
  assert.ok(agentInvoke);
  assert.deepEqual(agentInvoke.events, ["workflow_call"]);
  assert.deepEqual(agentInvoke.schedules, []);

  const shadowDrift = catalog.workflows.find(
    (w) => w.id === "rulesync-mcp-shadow-drift.yml"
  );
  assert.ok(shadowDrift);
  assert.deepEqual(shadowDrift.events, [
    "pull_request",
    "push",
    "workflow_dispatch"
  ]);
  assert.deepEqual(shadowDrift.schedules, []);

  // weights.json is a JSON sidecar, not a workflow source; it must never be
  // mistaken for a workflow definition.
  assert.equal(
    catalog.workflows.some((w) => w.id === "weights.json"),
    false
  );
});

test("GithubWorkflowRepository reports unavailable when .github/workflows is missing", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-github-workflows-")
  );
  const repository = new GithubWorkflowRepository(repositoryRoot);
  try {
    assert.deepEqual(repository.readWorkflowCatalog(), {
      status: "unavailable",
      workflows: []
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("GithubWorkflowRepository parses cron schedules, workflow_dispatch inputs, and flow-sequence triggers", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-github-workflows-")
  );
  const workflowsDir = path.join(repositoryRoot, ".github", "workflows");
  await mkdir(workflowsDir, { recursive: true });
  try {
    await writeFile(
      path.join(workflowsDir, "nightly.yml"),
      [
        'name: "Nightly Sweep"',
        "",
        "on:",
        "  schedule:",
        '    - cron: "0 3 * * *"',
        '    - cron: "0 15 * * *"',
        "  workflow_dispatch:",
        "    inputs:",
        "      verbose:",
        "        required: false",
        "        type: boolean",
        "",
        "jobs:",
        "  sweep:",
        "    runs-on: ubuntu-latest",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workflowsDir, "shorthand.yml"),
      [
        "on: [push, pull_request]",
        "",
        "jobs:",
        "  build:",
        "    steps: []",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workflowsDir, "unnamed.yml"),
      [
        "on:",
        "  workflow_dispatch:",
        "",
        "jobs:",
        "  noop:",
        "    steps: []",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workflowsDir, "pull-request.yaml"),
      [
        'name: "Pull request checks"',
        "on:",
        "  pull_request:",
        "    branches: [main]",
        "  schedule:",
        '    - cron: "15 2 * * 1-5"',
        "jobs:",
        "  checks:",
        "    runs-on: ubuntu-latest",
        ""
      ].join("\n"),
      "utf8"
    );

    const repository = new GithubWorkflowRepository(repositoryRoot);
    const catalog = repository.readWorkflowCatalog();
    assert.equal(catalog.status, "valid");
    assert.equal(catalog.workflows.length, 4);

    const nightly = catalog.workflows.find((w) => w.id === "nightly.yml");
    assert.ok(nightly);
    assert.equal(nightly.name, "Nightly Sweep");
    assert.deepEqual(nightly.events, ["schedule", "workflow_dispatch"]);
    assert.deepEqual(nightly.schedules, ["0 15 * * *", "0 3 * * *"]);

    const shorthand = catalog.workflows.find((w) => w.id === "shorthand.yml");
    assert.ok(shorthand);
    assert.equal(shorthand.name, null);
    assert.deepEqual(shorthand.events, ["pull_request", "push"]);
    assert.deepEqual(shorthand.schedules, []);

    const unnamed = catalog.workflows.find((w) => w.id === "unnamed.yml");
    assert.ok(unnamed);
    assert.equal(unnamed.name, null);
    assert.deepEqual(unnamed.events, ["workflow_dispatch"]);

    const pullRequest = catalog.workflows.find(
      (w) => w.id === "pull-request.yaml"
    );
    assert.ok(pullRequest);
    assert.equal(pullRequest.name, "Pull request checks");
    assert.deepEqual(pullRequest.events, ["pull_request", "schedule"]);
    assert.deepEqual(pullRequest.schedules, ["15 2 * * 1-5"]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("GithubWorkflowRepository marks a workflow without a top-level on: key as invalid", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-github-workflows-")
  );
  const workflowsDir = path.join(repositoryRoot, ".github", "workflows");
  await mkdir(workflowsDir, { recursive: true });
  try {
    await writeFile(
      path.join(workflowsDir, "broken.yml"),
      ["name: broken", "", "jobs:", "  noop:", "    steps: []", ""].join("\n"),
      "utf8"
    );
    const repository = new GithubWorkflowRepository(repositoryRoot);
    assert.deepEqual(repository.readWorkflowCatalog(), {
      status: "invalid",
      workflows: []
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("GithubWorkflowRepository rejects malformed YAML instead of partially parsing it", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "autodev-github-workflows-")
  );
  const workflowsDir = path.join(repositoryRoot, ".github", "workflows");
  await mkdir(workflowsDir, { recursive: true });
  try {
    await writeFile(
      path.join(workflowsDir, "broken.yml"),
      ["name: broken", "on:", "  push: [branches: [main]", ""].join("\n"),
      "utf8"
    );
    const repository = new GithubWorkflowRepository(repositoryRoot);
    assert.deepEqual(repository.readWorkflowCatalog(), {
      status: "invalid",
      workflows: []
    });
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
