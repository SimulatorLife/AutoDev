import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const NOT_OBSERVED = "Not observed";

/**
 * The command the declaration gives the shared event.
 *
 * It is the value the editor has to be filled from. The Runtime published an
 * older command for the same event, so the two are not the same string and an
 * editor showing the published one would be showing the wrong side.
 */
const DECLARED_COMMAND = "echo guarded";
const EDITED_COMMAND = "echo edited guarded";

/**
 * The event every target inherits, and the event the target declares alone.
 *
 * The page has to tell them apart, because it is the difference between an
 * edit that reaches every target and an edit that reaches one.
 */
const SHARED_EVENT = "preToolUse";
const TARGET_EVENT = "sessionEnd";

async function resetHookDeclaration(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/hooks/reset`
  );
  expect(response.ok()).toBe(true);
}

/**
 * One event's editor on the page.
 *
 * The editor is found by the event it belongs to rather than by its position,
 * so a page that grows an event does not turn one editor's assertions into
 * another's.
 */
function eventEditor(page: Page, event: string): Locator {
  return page.locator(`[data-hook-event-editor="${event}"]`);
}

test.beforeEach(async ({ request }) => {
  await resetHookDeclaration(request);
});

test.afterEach(async ({ request }) => {
  await resetHookDeclaration(request);
});

test("the hooks page shows the target's effective events and where each is declared", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  // The events the target receives are on the page, and each one says where
  // it is declared.
  await expect(
    page.locator(`[data-hook-event="${SHARED_EVENT}"]`)
  ).toBeVisible();
  await expect(
    page.locator(`[data-hook-event="${TARGET_EVENT}"]`)
  ).toBeVisible();
  await expect(
    page.locator(`[data-hook-origin="${SHARED_EVENT}"]`)
  ).toContainText("Declared for every target");
  await expect(
    page.locator(`[data-hook-origin="${TARGET_EVENT}"]`)
  ).toContainText("Declared for Codex only");

  // The editor is filled from the declaration, not from what the Runtime
  // published. The two differ here -- the Runtime is behind the declaration --
  // so the field can only be showing one of them.
  const command = eventEditor(page, SHARED_EVENT).locator(
    '[data-hook-action-command="0"]'
  );
  await expect(command).toHaveValue(DECLARED_COMMAND);
});

test("the hooks page keeps the declaration and the applied configuration apart", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  // The applied side is the Runtime's own reading of what it published, and
  // the verdict on it is the Runtime's too.
  await expect(
    page.locator(`[data-hook-applied-event="${SHARED_EVENT}"]`)
  ).toBeVisible();
  await expect(page.locator('[data-feature="reconciliation"]')).toBeVisible();
  await expect(
    page.getByText("Desired generation", { exact: true })
  ).toBeVisible();
  // The Runtime has not caught up with the declaration yet, and the page says
  // so rather than reporting convergence.
  await expect(
    page.getByText("Pending", { exact: true }).first()
  ).toBeVisible();
});

test("the hooks page keeps the operator's unfinished work in another event", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  // The operator starts editing one event...
  const unfinished = eventEditor(page, SHARED_EVENT).locator(
    '[data-hook-action-command="0"]'
  );
  await unfinished.fill(EDITED_COMMAND);

  // ...and then saves a different one. The page answers the save with a
  // redirect, so every editor on it is rebuilt -- and the one they had not
  // finished yet must come back with their text in it.
  await eventEditor(page, TARGET_EVENT)
    .getByRole("button", { name: "Save and apply" })
    .click();
  await page.waitForURL(/event=/u);

  await expect(
    eventEditor(page, SHARED_EVENT).locator('[data-hook-action-command="0"]')
  ).toHaveValue(EDITED_COMMAND);
});

test("the hooks page edits the canonical declaration and reports what the runtime published", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  const editor = eventEditor(page, SHARED_EVENT);
  const command = editor.locator('[data-hook-action-command="0"]');
  await expect(command).toHaveValue(DECLARED_COMMAND);
  await command.fill(EDITED_COMMAND);
  await editor.getByRole("button", { name: "Save and apply" }).click();

  // The write answers with a redirect back to the page, so the page that
  // answers it is the evidence of what the write did: the Runtime applied the
  // projection and reported what it published.
  await expect(page.getByText(EDITED_COMMAND)).toBeVisible();
  await expect(
    page.locator(`[data-hook-applied-event="${SHARED_EVENT}"]`)
  ).toContainText(EDITED_COMMAND);
  await expect(
    page.getByText("Converged", { exact: true }).first()
  ).toBeVisible();
});

test("the hooks page adds an action to an event", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  const editor = eventEditor(page, TARGET_EVENT);
  await editor.getByRole("button", { name: "Add action" }).click();
  const added = editor.locator('[data-hook-action-command="1"]');
  await expect(added).toBeVisible();
  await added.fill("echo second-action");
  await editor.getByRole("button", { name: "Save and apply" }).click();

  // The declaration holds the whole list, so the action that was added is
  // there beside the one that was already declared.
  await expect(page.getByText("echo second-action")).toBeVisible();
});

test("the hooks page refuses a write against a declaration that moved under it", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  const editor = eventEditor(page, SHARED_EVENT);
  const command = editor.locator('[data-hook-action-command="0"]');
  await expect(command).toHaveValue(DECLARED_COMMAND);
  const revision = await editor
    .locator('input[name="expectedRevision"]')
    .inputValue();
  await command.fill(EDITED_COMMAND);

  // The declaration moves while the page holds the revision it loaded.
  const moved = await request.post(`${FIXTURE_BASE_URL}/fixture/hooks/move`);
  expect(moved.ok()).toBe(true);

  await editor.getByRole("button", { name: "Save and apply" }).click();

  // The conflict is the Runtime's verdict, and the page says which one it is
  // rather than reporting a generic failure.
  const outcome = page.locator('[data-hook-declaration-save="conflict"]');
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("your edit was not saved");
  // The operator's edit is still in the editor: the write was refused, not
  // silently applied over somebody else's change.
  await expect(
    page.locator(
      `[data-hook-event-editor="${SHARED_EVENT}"] [data-hook-action-command="0"]`
    )
  ).toHaveValue(EDITED_COMMAND);
  // The write still carries the revision the edit was written for, so saving
  // again cannot overwrite the change that moved the declaration.
  await expect(
    page
      .locator(`[data-hook-event-editor="${SHARED_EVENT}"]`)
      .locator('input[name="expectedRevision"]')
  ).toHaveValue(revision);
});

test("the hooks page says when the applied configuration has not been observed", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  // The applied read is a separate question from the declaration, and a
  // failure to read it is not a failure to read the declaration.
  await expect(page.getByText("Hook Events", { exact: true })).toBeVisible();
  await expect(page.getByText(NOT_OBSERVED).first()).toBeVisible();
});
