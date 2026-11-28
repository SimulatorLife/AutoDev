import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

/**
The root-level form feedback, and the focus that has to survive a write.

The target state says what this feedback has to be: it stays visible while
the work is pending, a completed or failed result dismisses itself after
five seconds with a visible seconds countdown, the countdown does not
announce itself over and over, the close control is reachable from the
keyboard, and closing or replacing the feedback cancels the pending
dismissal. It also says what an in-place write has to do to the operator
who made it: the keyboard focus stays on the control they changed.

This spec drives a real mutable auto-submitting control — Agent enablement
on `/agents` — and reads what the operator sees.
*/

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const AGENTS_URL = "/agents";
const DEFAULT_AGENT_ROLE = "default";
const FEEDBACK_OWNER = "[data-form-navigation-owner]";
const FEEDBACK_STATUS = "data-form-navigation-status";
const COUNTDOWN = "[data-feedback-countdown]";
const PENDING_MESSAGE = "Submitting changes...";
const SAVED_MESSAGE = "Changes saved.";
const REFUSED_MESSAGE =
  "The server could not save these changes. Review the notice on this page.";
const CONFLICT_DETAIL = "Reload it and decide again.";
const DISMISS_LABEL = "Dismiss notification";
const COUNTDOWN_PREFIX = "Dismisses in ";
const COUNTDOWN_START = 5;
const ONE_SECOND = 1000;
const VIEWPORT = { width: 1280, height: 800 };

async function resetAgentEnablement(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/agents/state?state=enabled`
  );
  expect(response.ok()).toBe(true);
}

async function moveAgentRevision(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/agents/state?state=revision-moved`
  );
  expect(response.ok()).toBe(true);
}

function enablementControl(page: Page): Locator {
  return page.locator(`[data-enablement-target="${DEFAULT_AGENT_ROLE}"]`);
}

async function disableAgentAndRebuild(page: Page): Promise<Locator> {
  const control = enablementControl(page);
  await control.click();
  await expect(page.locator(FEEDBACK_OWNER)).toHaveAttribute(
    FEEDBACK_STATUS,
    "completed"
  );
  await expect(control).toHaveAttribute("data-status", "disabled");
  return control;
}

async function delayAgentWrites(page: Page, delayMs: number): Promise<void> {
  await page.route("**/api/agents/**", async (route) => {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
    await route.continue();
  });
}

async function openAgents(
  page: Page,
  request: APIRequestContext
): Promise<void> {
  await resetAgentEnablement(request);
  await page.setViewportSize(VIEWPORT);
  await page.goto(AGENTS_URL);
  await waitForPageContent(page);
}

async function holdThePageClock(page: Page): Promise<void> {
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
}

test.afterEach(async ({ request }) => {
  await resetAgentEnablement(request);
});

test("the root feedback stays visible while the write is still pending", async ({
  page,
  request
}) => {
  await openAgents(page, request);
  await delayAgentWrites(page, 1500);

  const owner = page.locator(FEEDBACK_OWNER);
  await expect(owner).toHaveAttribute(FEEDBACK_STATUS, "idle");

  await enablementControl(page).click();

  await expect(owner).toHaveAttribute(FEEDBACK_STATUS, "submitting");
  await expect(owner.getByText(PENDING_MESSAGE)).toBeVisible();
  await expect(page.locator(COUNTDOWN)).toHaveCount(0);
  await expect(owner).toBeVisible();
});

test("a confirmed write counts down and dismisses itself after five seconds", async ({
  page,
  request
}) => {
  await openAgents(page, request);
  await holdThePageClock(page);

  const owner = page.locator(FEEDBACK_OWNER);
  await disableAgentAndRebuild(page);

  await expect(owner.getByText(SAVED_MESSAGE)).toBeVisible();
  await expect(page.locator(COUNTDOWN)).toHaveText(
    `${COUNTDOWN_PREFIX}${COUNTDOWN_START} seconds`
  );

  await page.clock.runFor(ONE_SECOND);
  await expect(page.locator(COUNTDOWN)).toHaveText(
    `${COUNTDOWN_PREFIX}${COUNTDOWN_START - 1} seconds`
  );

  await expect(page.locator(COUNTDOWN)).toHaveAttribute("aria-live", "off");
  await expect(
    owner.locator('[role="status"] [data-feedback-countdown]')
  ).toHaveCount(0);

  await page.clock.runFor(COUNTDOWN_START * ONE_SECOND);
  await expect(owner).toBeHidden();
});

test("the root feedback can be closed from the keyboard", async ({
  page,
  request
}) => {
  await openAgents(page, request);
  await holdThePageClock(page);

  const owner = page.locator(FEEDBACK_OWNER);
  await disableAgentAndRebuild(page);
  await expect(page.locator(COUNTDOWN)).toBeVisible();

  const dismiss = page.getByRole("button", { name: DISMISS_LABEL });
  await expect(dismiss).toBeVisible();
  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(owner).toBeHidden();
  await expect(page.locator(COUNTDOWN)).toHaveCount(0);
});

test("the operator's focus stays on the control they changed", async ({
  page,
  request
}) => {
  await openAgents(page, request);

  const control = await disableAgentAndRebuild(page);
  await expect(control).toBeFocused();
});

test("a refused write reports the failure at the root and leaves the page's own notice", async ({
  page,
  request
}) => {
  await openAgents(page, request);
  await moveAgentRevision(request);

  const owner = page.locator(FEEDBACK_OWNER);
  await enablementControl(page).click();

  await expect(owner).toHaveAttribute(FEEDBACK_STATUS, "error");
  await expect(owner.getByText(REFUSED_MESSAGE)).toBeVisible();
  await expect(owner.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.locator(COUNTDOWN)).toBeVisible();
  await expect(page.getByText(CONFLICT_DETAIL)).toBeVisible();
});

test("a second write replaces the feedback and cancels the pending dismissal", async ({
  page,
  request
}) => {
  await openAgents(page, request);
  await holdThePageClock(page);

  const owner = page.locator(FEEDBACK_OWNER);
  const control = await disableAgentAndRebuild(page);

  await page.clock.runFor(2 * ONE_SECOND);
  await expect(page.locator(COUNTDOWN)).toHaveText(
    `${COUNTDOWN_PREFIX}${COUNTDOWN_START - 2} seconds`
  );

  await control.click();
  await expect(page.locator(COUNTDOWN)).toHaveText(
    `${COUNTDOWN_PREFIX}${COUNTDOWN_START} seconds`
  );
  await expect(control).toHaveAttribute("data-status", "enabled");

  await page.clock.runFor(4 * ONE_SECOND);
  await expect(owner).toBeVisible();

  await page.clock.runFor(2 * ONE_SECOND);
  await expect(owner).toBeHidden();
});
