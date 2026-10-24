import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

import { documentFitsViewport } from "./acceptance-helpers.ts";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const SKILL_NAME = "code-review";
const NOT_OBSERVED = "Not observed";
const CONFLICT_OUTCOME = "conflict";
const PENDING_OUTCOME = "pending";
const SKILL_CATALOG_URL = /\/skills\?save=/u;
const SAVE_BUTTON_NAME = /save/iu;
const STAT_GRID = "[data-stat-grid]";
/**
 * The live agent count, read as the label and the value it carries.
 *
 * The list page renders the pair as one string ("Active instances: Not
 * observed") and the detail page as a definition list -- an "Active instances"
 * term beside a "Not observed" value -- so the assertion has to accept both
 * shapes rather than one of them.
 */
const ACTIVE_INSTANCES_NOT_OBSERVED = /Active instances:?\s*Not observed/u;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const SKILL_SOURCE_PATTERN = /Review a diff for defects\./u;
const PROMPT_SOURCE_PATTERN =
  /Review the pending diff and report what changed\./u;
const CONFLICT_MESSAGE =
  "The execution contract changed after this page was loaded, so nothing was written.";

/** The role checkbox of one skill. */
function roleCheckbox(page: Page, role: string): Locator {
  return page
    .locator(`[data-skill-assignment="${SKILL_NAME}"]`)
    .locator(`[data-skill-role-option="${role}"] input[type="checkbox"]`);
}

/**
 * One click on a role checkbox, and the page it lands on.
 *
 * The assignment control submits the whole role set the moment a checkbox
 * changes, so the click is a navigation rather than a request the page waits
 * on: the Console answers the write with a redirect back to the catalog, and
 * the outcome it reports is the only evidence of what the write did.
 */
async function changeRoleAssignment(
  page: Page,
  role: string,
  checked: boolean
): Promise<void> {
  const checkbox = roleCheckbox(page, role);
  await checkbox.setChecked(checked);
  await expect(page).toHaveURL(SKILL_CATALOG_URL);
}

/**
 * The skill assignment the fixture starts from.
 *
 * The write is real, so the fixture's catalog keeps the roles the last write
 * left behind. Resetting it puts the catalog back without touching the rest
 * of the fixture's state, which another session's specs also use.
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

test("the Skills catalog shows the assignment and saves the whole role set on change", async ({
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
  // The Runtime has not reported the assignment back, so the page says so
  // rather than claiming the catalog is empty.
  await expect(page.locator("[data-skill-runtime-observed]")).toHaveAttribute(
    "data-skill-runtime-observed",
    "false"
  );
  await expect(page.locator("[data-skill-assignment-roles]")).toHaveAttribute(
    "data-skill-assignment-roles",
    "2"
  );
  await expect(
    page.getByRole("link", { name: SKILL_NAME, exact: true })
  ).toBeVisible();
  await expect(page.getByText("Review a diff for defects.")).toBeVisible();

  // There is no Save button: a change saves itself.
  await expect(
    page.getByRole("button", { name: SAVE_BUTTON_NAME })
  ).toHaveCount(0);

  // The role set the catalog holds is the one the checkboxes show.
  await expect(roleCheckbox(page, "default")).not.toBeChecked();
  await expect(roleCheckbox(page, "worker")).toBeChecked();

  await changeRoleAssignment(page, "default", true);
  await expect(page.locator("[data-save-outcome]")).toHaveAttribute(
    "data-save-outcome",
    PENDING_OUTCOME
  );
  // The whole set travelled, so the role that was already assigned is still
  // assigned and the one that was added joined it.
  await expect(roleCheckbox(page, "default")).toBeChecked();
  await expect(roleCheckbox(page, "worker")).toBeChecked();

  await changeRoleAssignment(page, "worker", false);
  await expect(roleCheckbox(page, "default")).toBeChecked();
  await expect(roleCheckbox(page, "worker")).not.toBeChecked();
});

test("a stale skill assignment is refused rather than overwriting somebody else's", async ({
  page,
  request
}) => {
  await resetSkillAssignment(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/skills");
  const revision = await page
    .locator("[data-skill-assignment-revision]")
    .getAttribute("data-skill-assignment-revision");
  expect(revision).toBeTruthy();

  // Another operator writes the canonical roles while this page is open, so
  // the revision this page holds is stale.
  const bumped = await request.post(
    `${FIXTURE_BASE_URL}/fixture/skills/revision`
  );
  expect(bumped.ok()).toBe(true);

  await changeRoleAssignment(page, "default", true);
  await expect(page.locator("[data-save-outcome]")).toHaveAttribute(
    "data-save-outcome",
    CONFLICT_OUTCOME
  );
  await expect(page.getByText(CONFLICT_MESSAGE)).toBeVisible();
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
  // The declaration is edited, so its matcher and its command are the editor's
  // fields rather than prose. The assertion reads them the way an operator
  // reads them: by what the field holds. Every event carries its own action,
  // so the fields are read inside the event's own panel.
  const declared = page.locator('[data-hook-event="preToolUse"]');
  await expect(
    declared.locator('[data-hook-action="0"]').getByText("Matcher", {
      exact: true
    })
  ).toBeVisible();
  await expect(declared.locator('[data-hook-action-matcher="0"]')).toHaveValue(
    "Bash"
  );
  await expect(declared.locator('[data-hook-action-command="0"]')).toHaveValue(
    "echo guarded"
  );
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

test("the skill detail is the canonical source, edited against the revision it loaded", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/skills/code-review");

  await expect(page.locator("[data-skill-content]")).toHaveAttribute(
    "data-skill-content",
    SKILL_NAME
  );
  const revision = await page
    .locator("[data-skill-revision]")
    .getAttribute("data-skill-revision");
  expect(revision).toMatch(REVISION_PATTERN);
  if (revision === null) {
    throw new Error("The skill detail carries no source revision.");
  }

  // The editor carries the source the page loaded, and the revision it was
  // loaded at, so a write can be checked against it.
  const editor = page.locator("[data-skill-content-editor]");
  await expect(editor).toHaveValue(SKILL_SOURCE_PATTERN);
  // The write is a compare-and-swap, so the form carries the revision this
  // page loaded rather than one it read at submit time.
  await expect(page.locator('input[name="expectedRevision"]')).toHaveValue(
    revision
  );
  await expect(
    page.getByRole("heading", { name: "Canonical RuleSync source" })
  ).toBeVisible();
  expect(await documentFitsViewport(page)).toBe(true);
});

test("the prompt detail shows the canonical source beside its rendered preview", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/prompts/review");

  // The editor carries the canonical source the page loaded.
  await expect(page.locator('[data-prompt-content="observed"]')).toHaveValue(
    PROMPT_SOURCE_PATTERN
  );
  // The write is a compare-and-swap, so the form carries the revision this
  // page loaded and the page reports that same revision.
  const expectedRevision = page.locator('input[name="expectedRevision"]');
  await expect(expectedRevision).toHaveValue(REVISION_PATTERN);
  const revision = (await expectedRevision.getAttribute("value")) ?? "";
  await expect(page.getByText(`rev ${revision.slice(0, 12)}`)).toBeVisible();
  // The rendered preview is a disclosure, so it is opened rather than
  // asserted to be on the page.
  await page.getByText("Preview rendered Markdown").click();
  await expect(
    page.locator('[data-prompt-preview-body="observed"]')
  ).toBeVisible();
  await expect(
    page
      .locator('[data-prompt-preview-body="observed"]')
      .getByText("Review the pending diff and report what changed.")
  ).toBeVisible();
  expect(await documentFitsViewport(page)).toBe(true);
});

test("the Permissions list shows the policy and the role capability matrix", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/permissions");

  const permissionStats = page.locator(STAT_GRID);
  await expect(
    permissionStats.getByText("Approval Policy", { exact: true })
  ).toBeVisible();
  await expect(
    permissionStats.getByText("Default Sandbox", { exact: true })
  ).toBeVisible();
  await expect(
    permissionStats.getByText("Network Access", { exact: true })
  ).toBeVisible();
  await expect(
    permissionStats.getByText("Web Search", { exact: true })
  ).toBeVisible();
  // The policy is the one the canonical source declares, not a default.
  await expect(page.getByText("Blocked", { exact: true })).toBeVisible();

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
