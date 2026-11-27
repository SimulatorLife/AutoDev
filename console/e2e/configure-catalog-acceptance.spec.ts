import { type APIRequestContext, expect, test } from "@playwright/test";

import {
  documentFitsViewport,
  waitForPageContent
} from "./acceptance-helpers.ts";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const SKILL_NAME = "code-review";
const NOT_OBSERVED = "Not observed";
const STAT_GRID = "[data-stat-grid]";
/**
The live agent count, read as the label and the value it carries.

The list page renders the pair as one string ("Active instances: Not
observed") and the detail page as a definition list -- an "Active instances"
term beside a "Not observed" value -- so the assertion has to accept both
shapes rather than one of them.
*/
const ACTIVE_INSTANCES_NOT_OBSERVED = /Active instances:?\s*Not observed/u;
const SKILL_SOURCE_PATTERN = /Review a diff for defects\./u;
const PROMPT_SOURCE_PATTERN =
  /Review the pending diff and report what changed\./u;

/**
The skill assignment the fixture starts from.

The write is real, so the fixture's catalog keeps the roles the last write
left behind. Resetting it puts the catalog back without touching the rest
of the fixture's state, which another session's specs also use.
*/
async function resetSkillAssignment(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/skills/reset`
  );
  expect(response.ok()).toBe(true);
}

test("the Agents list keeps the enabled agent apart from the one the Runtime could not report", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/agents");

  const agentStats = page.locator(STAT_GRID);
  await expect(
    agentStats.getByText("Ready Agents", { exact: true })
  ).toBeVisible();
  await expect(
    agentStats.getByText("Converged Agents", { exact: true })
  ).toBeVisible();
  await expect(
    agentStats.getByText("In-Flight Requests", { exact: true })
  ).toBeVisible();
  await expect(
    agentStats.getByText("Active Agent Instances", { exact: true })
  ).toBeVisible();

  // The Runtime published no live projection, so the live counts are not
  // observed rather than measured as zero.
  await expect(page.locator('[data-live-agent-role="default"]')).toContainText(
    ACTIVE_INSTANCES_NOT_OBSERVED
  );

  // The enablement the Runtime reported and the enablement it could not
  // report are different facts, and the page does not collapse them.
  await expect(
    page.locator('[data-enablement-target="default"]')
  ).toHaveAttribute("data-status", "enabled");
  await expect(
    page.locator('[data-enablement-target="worker"]')
  ).toHaveAttribute("data-status", "not-observed");
  await expect(
    page.locator(
      '[data-enablement-target="worker"][data-enablement-unavailable]'
    )
  ).toHaveCount(1);

  // The MCP exposure of an agent is the configuration it declares, not a live
  // inventory.
  await expect(page.locator('[data-agent-mcps="default"]')).toContainText(
    "lsp"
  );
  // The enablement the Runtime did not report cannot be changed from the
  // Console either, so the control says so instead of offering a write.
  await expect(
    page.locator('[data-enablement-target="worker"]')
  ).toBeDisabled();
});

test("the Skills catalog shows read-only role assignments", async ({
  page,
  request
}) => {
  await resetSkillAssignment(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/skills");
  await expect(page.locator("[data-skill-source-validity]")).toHaveAttribute(
    "data-skill-source-validity",
    "true"
  );
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: SKILL_NAME, exact: true }) });
  await expect(row.getByText("worker", { exact: true })).toBeVisible();
  await expect(row.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(page.locator('form[method="POST"]')).toHaveCount(0);
});

test("the Hooks list shows the declaration it read", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  const hookStats = page.locator(STAT_GRID);
  await expect(
    hookStats.getByText("Hook Events", { exact: true })
  ).toBeVisible();
  await expect(
    hookStats.getByText("Total Handlers", { exact: true })
  ).toBeVisible();
  await expect(
    hookStats.getByText("Source validation", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Configured Lifecycle Hooks" })
  ).toBeVisible();
  // The event's name is the product's own vocabulary -- `preToolUse`, the way
  // the execution contract spells it -- and the assertion used to ask for
  // "PreToolUse", a spelling the Console has never produced and cannot
  // produce. The name also appears twice on the page, once in the declaration
  // and once in the projection the Runtime published, so the assertion names
  // the declaration's own row rather than the text.
  await expect(page.locator('[data-hook-event="preToolUse"]')).toBeVisible();
  const declared = page.locator('[data-hook-event="preToolUse"]');
  await expect(declared.getByText("Bash", { exact: true })).toBeVisible();
  await expect(declared.getByLabel("Hook command")).toHaveText("echo guarded");
  await expect(declared.locator("form, input, textarea")).toHaveCount(0);
  expect(await documentFitsViewport(page)).toBe(true);
});

test("the Prompts list shows the canonical commands and the role prompts", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/prompts");

  const promptStats = page.locator(STAT_GRID);
  await expect(
    promptStats.getByText("Canonical Prompts", { exact: true })
  ).toBeVisible();
  await expect(
    promptStats.getByText("RuleSync Commands", { exact: true })
  ).toBeVisible();
  await expect(
    promptStats.getByText("Agent Role Prompts", { exact: true })
  ).toBeVisible();
  await expect(
    promptStats.getByText("Authority", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open prompt review" })
  ).toBeVisible();
  await expect(page.getByText("Review the pending diff.")).toBeVisible();
  expect(await documentFitsViewport(page)).toBe(true);
});

test("the agent detail shows the agent's own configuration and its convergence", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/agents/default");

  await expect(page.locator('[data-section="agent-enablement"]')).toBeVisible();
  await expect(
    page.locator('[data-enablement-target="default"]')
  ).toHaveAttribute("data-status", "enabled");
  // The Runtime published no live projection, so the live count is not
  // observed rather than measured as zero.
  await expect(page.locator('[data-live-agent-role="default"]')).toContainText(
    ACTIVE_INSTANCES_NOT_OBSERVED
  );
  // The value on its own is the not-observed label rather than a count.
  await expect(
    page
      .locator('[data-live-agent-role="default"]')
      .getByText(NOT_OBSERVED, { exact: true })
  ).toBeVisible();

  await expect(
    page.locator('[data-section="agent-reconciliation"]')
  ).toBeVisible();
  await expect(page.getByText("Convergence", { exact: true })).toBeVisible();
  // The reconciliation is the Runtime's own verdict on this agent, and the
  // generations behind it -- not a restatement of the configuration.
  await expect(
    page.getByText("The agent matches the canonical source.")
  ).toBeVisible();
  await expect(page.locator('[data-field="desired-generation"]')).toHaveText(
    "agent-default"
  );
  await expect(page.locator('[data-field="observed-generation"]')).toHaveText(
    "agent-default"
  );
  // The role prompt is the agent's own source, under its own heading and in
  // a block that names itself.
  await expect(
    page.getByRole("heading", { name: "System prompt", exact: true })
  ).toBeVisible();
  await expect(
    page.locator('pre[aria-label="Agent system prompt"]')
  ).toContainText("You are the AutoDev orchestrator.");
  expect(await documentFitsViewport(page)).toBe(true);
});

for (const { path, pattern } of [
  { path: "/skills/code-review", pattern: SKILL_SOURCE_PATTERN },
  { path: "/prompts/review", pattern: PROMPT_SOURCE_PATTERN }
]) {
  test(`${path} switches between the same rendered and source document without mutation`, async ({
    page
  }) => {
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/") && request.method() !== "GET")
        mutations.push(request.url());
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(path);
    await waitForPageContent(page);
    const view = page.locator("[data-source-view]");
    await expect(view).toHaveAttribute("data-source-view", "rendered");
    await expect(
      view.getByRole("button", { name: "Rendered", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    const url = page.url();
    const source = view.getByRole("button", { name: "Source", exact: true });
    await source.click();
    await expect(view).toHaveAttribute("data-source-view", "source");
    await expect(view.getByLabel("Canonical source")).toHaveText(pattern);
    await expect(source).toBeFocused();
    await view.getByRole("button", { name: "Rendered", exact: true }).click();
    await expect(view.locator("[data-source-rendered]")).toBeVisible();
    await expect(page.locator("textarea, form[method=POST]")).toHaveCount(0);
    expect(page.url()).toBe(url);
    expect(mutations).toEqual([]);
    expect(await documentFitsViewport(page)).toBe(true);
  });
}

test("the Permissions list shows the policy and the role capability matrix", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/permissions");

  const policy = page.getByRole("region", { name: "Permission Policy" });
  await expect(policy.getByText("on-request", { exact: true })).toBeVisible();
  await expect(policy.getByText("Disabled", { exact: true })).toBeVisible();
  await expect(policy.getByText("operator", { exact: true })).toBeVisible();
  await expect(policy.locator("form, input, select, textarea")).toHaveCount(0);

  // The capability matrix is a real projection: a role's reach into an MCP
  // server is not permission to call everything on it.
  await expect(
    page.getByRole("heading", { name: "Effective Role Capability Matrix" })
  ).toBeVisible();
  await expect(page.locator('[data-tool-role="default"]')).toBeVisible();
  await expect(
    page.locator('[data-tool-role="default"] [data-tool-server="lsp"]')
  ).toBeVisible();
  expect(await documentFitsViewport(page)).toBe(true);
});
