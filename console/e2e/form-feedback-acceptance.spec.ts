import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

/**
 * The root-level form feedback, and the focus that has to survive a write.
 *
 * The target state says what this feedback has to be: it stays visible while
 * the work is pending, a completed or failed result dismisses itself after
 * five seconds with a visible seconds countdown, the countdown does not
 * announce itself over and over, the close control is reachable from the
 * keyboard, and closing or replacing the feedback cancels the pending
 * dismissal. It also says what an in-place write has to do to the operator
 * who made it: the keyboard focus stays on the control they changed.
 *
 * The unit test renders the owner in isolation and reads the markup it
 * produces. That proves the owner *can* render each state; it does not prove
 * that a real submission reaches those states, that the countdown counts down
 * and the feedback goes away, that a keyboard operator can close it, or that
 * a refused write is reported as a refusal. This spec drives a real
 * submission -- the Skills role assignment, which saves itself the moment a
 * checkbox changes -- and reads what the operator sees.
 *
 * The clock is under the test's control. A feedback that dismisses itself
 * after five seconds is indistinguishable from one the operator closed: both
 * end with nothing on the screen, so a test that waits and looks at the end
 * proves nothing about who closed it. With the page's own clock held still,
 * the only thing that can remove the feedback is the operator -- and the
 * spec says which one it was expecting.
 */

/** The Control API fixture the Console reads and writes through. */
const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
/** The skill whose role assignment is written. */
const SKILL_NAME = "code-review";
/** The skill's assignment control. */
const SKILL_ASSIGNMENT = `[data-skill-assignment="${SKILL_NAME}"]`;
/** The element that owns the root-level feedback. */
const FEEDBACK_OWNER = "[data-form-navigation-owner]";
/** The attribute that carries the feedback's status. */
const FEEDBACK_STATUS = "data-form-navigation-status";
/** The element that carries the visible countdown. */
const COUNTDOWN = "[data-feedback-countdown]";
/** The element that carries the revision the page's write carries. */
const REVISION = "[data-skill-assignment-revision]";
/** The attribute that carries the revision. */
const REVISION_ATTRIBUTE = "data-skill-assignment-revision";
/** The message the pending feedback carries. */
const PENDING_MESSAGE = "Submitting changes...";
/** The message a confirmed write carries. */
const SAVED_MESSAGE = "Changes saved.";
/** The message a refused write carries. */
const REFUSED_MESSAGE =
  "The server could not save these changes. Review the notice on this page.";
/** The notice the refused write leaves on the page itself. */
const CONFLICT_NOTICE =
  "The execution contract changed after this page was loaded, so nothing was written.";
/** The accessible name of the close control. */
const DISMISS_LABEL = "Dismiss notification";
/** The words the countdown is written with. */
const COUNTDOWN_PREFIX = "Dismisses in ";
/** The seconds the countdown starts at. */
const COUNTDOWN_START = 5;
/** One second, in the units the page's clock counts in. */
const ONE_SECOND = 1000;
/** The width the Console is read at here. */
const VIEWPORT = { width: 1280, height: 800 };

/**
 * Put the skill catalog's assignment back.
 *
 * The write is real, so the fixture's catalog keeps whatever the last write
 * left behind. The reset is here and in the `afterEach`, because a spec that
 * leaves the catalog changed answers for the specs that read it.
 */
async function resetSkillAssignment(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/skills/reset`
  );
  expect(response.ok()).toBe(true);
}

/**
 * Move the fixture's execution-contract revision on.
 *
 * The page holds the revision it loaded; a revision that moved behind the
 * page's back makes the page's write stale.
 */
async function bumpSkillRevision(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/skills/revision`
  );
  expect(response.ok()).toBe(true);
}

/**
 * The role checkbox of one skill.
 */
function roleCheckbox(page: Page, role: string): Locator {
  return page
    .locator(SKILL_ASSIGNMENT)
    .locator(`[data-skill-role-option="${role}"] input[type="checkbox"]`);
}

/**
 * Change a role checkbox, whichever way it stands.
 *
 * The assignment the fixture starts from is not the point of any of these
 * tests, and a checkbox that is already in the state a test wants to change
 * it to would not change at all -- and would not save anything either. So
 * every write here is a change away from the state the page is in.
 */
async function changeRole(page: Page, role: string): Promise<Locator> {
  const checkbox = roleCheckbox(page, role);
  await checkbox.setChecked(!(await checkbox.isChecked()));
  return checkbox;
}

/**
 * Change a role and wait until the page has been rebuilt around the write.
 *
 * The write is confirmed -- the feedback says so -- and then the page is
 * rebuilt around it, which is when it carries the new revision. Waiting for
 * the rebuild is what makes the rest of the test deterministic: the focus
 * the write restores lands before the rebuild, and a test that reaches for
 * the keyboard before the rebuild has finished is reaching for it in the
 * middle of the page changing underneath it.
 */
async function changeRoleAndRebuild(
  page: Page,
  role: string
): Promise<Locator> {
  const revision = page.locator(REVISION);
  const before = (await revision.getAttribute(REVISION_ATTRIBUTE)) ?? "";
  const checkbox = await changeRole(page, role);
  await expect(page.locator(FEEDBACK_OWNER)).toHaveAttribute(
    FEEDBACK_STATUS,
    "completed"
  );
  await expect(revision).not.toHaveAttribute(REVISION_ATTRIBUTE, before);
  return checkbox;
}

/**
 * Hold the write open for a while, so the pending feedback can be read.
 *
 * The submission is a fetch the Console makes itself, so delaying it here
 * delays the whole round trip: the operator is looking at a write that has
 * not come back yet, which is exactly the state the pending feedback is for.
 */
async function delaySkillWrites(page: Page, delayMs: number): Promise<void> {
  await page.route("**/api/skills/**", async (route) => {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
    await route.continue();
  });
}

/**
 * Open the Skills catalog with the assignment the fixture starts from.
 */
async function openSkillsCatalog(page: Page): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/skills");
}

/**
 * Hold the page's clock still, so only the operator can move the feedback.
 *
 * The clock is installed and paused before the write, so the countdown and
 * the dismissal it schedules are the page's own -- under the test's control
 * rather than under the wall clock's. An installed clock still ticks with
 * real time, so it is paused explicitly; a paused clock also means that
 * `page.evaluate` cannot be used, because the round trip waits on a page
 * timer that will not come due.
 */
async function holdThePageClock(page: Page): Promise<void> {
  await page.clock.install();
  await page.clock.pauseAt(Date.now());
}

test.afterEach(async ({ request }) => {
  await resetSkillAssignment(request);
});

test("the root feedback stays visible while the write is still pending", async ({
  page
}) => {
  await openSkillsCatalog(page);
  await delaySkillWrites(page, 1500);

  const owner = page.locator(FEEDBACK_OWNER);
  await expect(owner).toHaveAttribute(FEEDBACK_STATUS, "idle");

  await changeRole(page, "default");

  await expect(owner).toHaveAttribute(FEEDBACK_STATUS, "submitting");
  await expect(owner.getByText(PENDING_MESSAGE)).toBeVisible();
  // A write that has not come back yet has nothing to report, so the
  // feedback does not count down and does not dismiss itself.
  await expect(page.locator(COUNTDOWN)).toHaveCount(0);
  await expect(owner).toBeVisible();
});

test("a confirmed write counts down and dismisses itself after five seconds", async ({
  page
}) => {
  await openSkillsCatalog(page);
  await holdThePageClock(page);

  const owner = page.locator(FEEDBACK_OWNER);
  await changeRoleAndRebuild(page, "default");

  await expect(owner.getByText(SAVED_MESSAGE)).toBeVisible();
  await expect(page.locator(COUNTDOWN)).toHaveText(
    `${COUNTDOWN_PREFIX}${COUNTDOWN_START} seconds`
  );

  // The countdown is not a decoration: it moves.
  await page.clock.runFor(ONE_SECOND);
  await expect(page.locator(COUNTDOWN)).toHaveText(
    `${COUNTDOWN_PREFIX}${COUNTDOWN_START - 1} seconds`
  );

  // A countdown that is announced every second is a screen reader that
  // cannot be shut up, so the countdown sits outside the live region and
  // turns its own announcements off.
  await expect(page.locator(COUNTDOWN)).toHaveAttribute("aria-live", "off");
  await expect(
    owner.locator('[role="status"] [data-feedback-countdown]')
  ).toHaveCount(0);

  // And the feedback goes away on its own, without the operator closing it.
  await page.clock.runFor(COUNTDOWN_START * ONE_SECOND);
  await expect(owner).toBeHidden();
});

test("the root feedback can be closed from the keyboard", async ({ page }) => {
  await openSkillsCatalog(page);
  await holdThePageClock(page);

  const owner = page.locator(FEEDBACK_OWNER);
  await changeRoleAndRebuild(page, "default");
  await expect(page.locator(COUNTDOWN)).toBeVisible();

  const dismiss = page.getByRole("button", { name: DISMISS_LABEL });
  await expect(dismiss).toBeVisible();
  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  await page.keyboard.press("Enter");

  // The page's clock has not moved, so the countdown's own dismissal has not
  // come due: the operator is the one who closed the feedback.
  await expect(owner).toBeHidden();
  await expect(page.locator(COUNTDOWN)).toHaveCount(0);
});

test("the operator's focus stays on the control they changed", async ({
  page
}) => {
  await openSkillsCatalog(page);

  // The second role's checkbox, because it shares its name with the first
  // one: a form that restores the focus by name alone cannot tell them
  // apart, and the operator ends up on a control they never touched.
  const worker = await changeRoleAndRebuild(page, "worker");

  // The write rebuilt the page around the assignment -- the revision the
  // page holds moved with it -- and the focus is still on the control the
  // operator changed.
  await expect(worker).toBeFocused();
});

test("a refused write reports the failure at the root and leaves the page's own notice", async ({
  page,
  request
}) => {
  await openSkillsCatalog(page);
  // Another operator writes the canonical roles while this page is open, so
  // the revision this page holds is stale and the write is refused.
  await bumpSkillRevision(request);

  const owner = page.locator(FEEDBACK_OWNER);
  await changeRole(page, "default");

  await expect(owner).toHaveAttribute(FEEDBACK_STATUS, "error");
  await expect(owner.getByText(REFUSED_MESSAGE)).toBeVisible();
  // A failure is announced, not whispered.
  await expect(owner.locator('[role="alert"]')).toHaveCount(1);
  // A failure is also a result the operator can read later, so it dismisses
  // itself the same way a confirmed write does.
  await expect(page.locator(COUNTDOWN)).toBeVisible();
  // The root feedback sends the operator to the page's own notice, so that
  // notice has to be there.
  await expect(page.getByText(CONFLICT_NOTICE)).toBeVisible();
});

test("a second write replaces the feedback and cancels the pending dismissal", async ({
  page
}) => {
  await openSkillsCatalog(page);
  await holdThePageClock(page);

  const owner = page.locator(FEEDBACK_OWNER);
  const checkbox = roleCheckbox(page, "default");

  // The page has to be rebuilt around the first write before the second one
  // is made: the revision the second write carries is the one the rebuilt
  // page holds, and a write made against the revision before the first one
  // is a conflict rather than a replacement.
  await changeRoleAndRebuild(page, "default");

  // The second write lands two seconds later, so the first feedback's own
  // five-second deadline passes before the second feedback's does.
  await page.clock.runFor(2 * ONE_SECOND);
  await expect(page.locator(COUNTDOWN)).toHaveText(
    `${COUNTDOWN_PREFIX}${COUNTDOWN_START - 2} seconds`
  );

  await changeRole(page, "default");
  // The second write replaced the feedback rather than leaving the first one
  // counting down: the countdown starts again, and the page shows the
  // assignment the second write made.
  await expect(page.locator(COUNTDOWN)).toHaveText(
    `${COUNTDOWN_PREFIX}${COUNTDOWN_START} seconds`
  );
  await expect(checkbox).not.toBeChecked();

  // The first feedback's dismissal was cancelled by the replacement, so the
  // feedback is still here after that first deadline went by.
  await page.clock.runFor(4 * ONE_SECOND);
  await expect(owner).toBeVisible();

  // And the feedback that replaced it dismisses itself on its own schedule.
  await page.clock.runFor(2 * ONE_SECOND);
  await expect(owner).toBeHidden();
});
