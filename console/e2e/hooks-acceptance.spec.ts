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

test("the list links each event to its own page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/hooks");

  // The event is the item's name and the item's own address, so the card's
  // header is where the operator opens it.
  const link = page.locator(`[data-hook-event-link="${SHARED_EVENT}"]`);
  await expect(link).toHaveAttribute("href", `/hooks/${SHARED_EVENT}`);
  await link.click();

  await expect(page).toHaveURL(new RegExp(`/hooks/${SHARED_EVENT}$`, "u"));
  await expect(
    page.locator(`[data-hook-event="${SHARED_EVENT}"]`)
  ).toBeVisible();
});

test("the hook event's own page carries the same editor the list carries", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/hooks/${SHARED_EVENT}`);

  // The trail names the place the operator is on and where they came from.
  const trail = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(trail).toBeVisible();
  await expect(
    trail.getByRole("link", { name: "Hooks", exact: true })
  ).toHaveAttribute("href", "/hooks");
  await expect(trail.locator('[aria-current="page"]')).toHaveText(SHARED_EVENT);

  // The editor is the shared one, filled from the declaration rather than
  // from what the Runtime published. The two differ here, so the field can
  // only be showing one of them.
  const editor = eventEditor(page, SHARED_EVENT);
  await expect(editor).toBeVisible();
  await expect(editor.locator('[data-hook-action-command="0"]')).toHaveValue(
    DECLARED_COMMAND
  );
  // And it answers to this page: a write made here comes back here.
  await expect(editor.locator('input[name="returnTo"]')).toHaveValue(
    `/hooks/${SHARED_EVENT}`
  );
  // The origin is the same fact the card shows.
  await expect(
    page.locator(`[data-hook-origin="${SHARED_EVENT}"]`)
  ).toContainText("Declared for every target");
});

test("the hook event's own page says what the Runtime published for it", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/hooks/${SHARED_EVENT}`);

  // The projection is published for the whole declaration, and the page
  // answers the question about this event: what did the Runtime publish for
  // it, and has it caught up with the declaration.
  await expect(
    page.locator(`[data-hook-applied-event="${SHARED_EVENT}"]`)
  ).toBeVisible();
  await expect(page.locator('[data-feature="reconciliation"]')).toBeVisible();
  // The Runtime has not caught up with the declaration yet, and the page says
  // so rather than reporting convergence.
  await expect(
    page.getByText("Pending", { exact: true }).first()
  ).toBeVisible();
});

test("a write made from the event's own page answers to that page", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/hooks/${SHARED_EVENT}`);

  const editor = eventEditor(page, SHARED_EVENT);
  await editor.locator('[data-hook-action-command="0"]').fill(EDITED_COMMAND);
  await editor.getByRole("button", { name: "Save and apply" }).click();

  // The write answers to the surface it was made from: the operator comes
  // back to the event they were working on, not to the list of every event.
  await expect(page).toHaveURL(new RegExp(`/hooks/${SHARED_EVENT}$`, "u"));
  await expect(
    page.locator(
      `[data-hook-event-editor="${SHARED_EVENT}"] [data-hook-action-command="0"]`
    )
  ).toHaveValue(EDITED_COMMAND);
});

test("the hook event's own page refuses a write against a declaration that moved under it", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/hooks/${SHARED_EVENT}`);

  const editor = eventEditor(page, SHARED_EVENT);
  const command = editor.locator('[data-hook-action-command="0"]');
  const revision = await editor
    .locator('input[name="expectedRevision"]')
    .inputValue();
  await command.fill(EDITED_COMMAND);

  const moved = await request.post(`${FIXTURE_BASE_URL}/fixture/hooks/move`);
  expect(moved.ok()).toBe(true);

  await editor.getByRole("button", { name: "Save and apply" }).click();

  // The refusal is on the page the operator is on, and it names the event it
  // was about.
  const outcome = page.locator('[data-hook-declaration-save="conflict"]');
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("your edit was not saved");
  await expect(outcome).toContainText(SHARED_EVENT);
  // The operator's edit is still in the editor, and it still carries the
  // revision it was written for.
  await expect(
    page.locator(
      `[data-hook-event-editor="${SHARED_EVENT}"] [data-hook-action-command="0"]`
    )
  ).toHaveValue(EDITED_COMMAND);
  await expect(
    page
      .locator(`[data-hook-event-editor="${SHARED_EVENT}"]`)
      .locator('input[name="expectedRevision"]')
  ).toHaveValue(revision);
});

test("an event the target does not declare has no page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  // The Runtime publishes the effective declaration for the target, so an
  // event that is not in it is not declared for this target and there is
  // nothing there to edit.
  await page.goto("/hooks/subagentStart");
  await expect(
    page.getByRole("heading", { name: "Page not found" })
  ).toBeVisible();
  await expect(page.locator("[data-hook-event-editor]")).toHaveCount(0);
});
