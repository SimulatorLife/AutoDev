import { expect, type Page, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers";

/**
 * The session the Control API fixture answers for.
 *
 * The same id is used by the fixture's own diagnostics routes and by the
 * acceptance, so a link the Console builds for a session reaches the fixture's
 * session rather than a session that does not exist.
 */
const SESSION_ID = "01a0ba14-d54c-78f2-9367-3f80e9a8f75f";
/** The worker thread of that session. */
const WORKER_THREAD_ID = "01a0ba16-d54c-78f2-9367-3f80e9a8f75f";

/** The Session ID control in the page's top filter bar. */
function sessionField(page: Page) {
  return page.locator('[data-text-field="usage-session-id"]');
}

/** The Apply filters button of the top filter bar. */
function applyButton(page: Page) {
  return page.locator('[data-button="usage-apply"]');
}

/** The fleet-wide metrics the page renders when it is not scoped to a session. */
function fleetMetrics(page: Page) {
  return page.getByText("Requests & model usage");
}

test("a session id in the top filter bar scopes the whole page to that session", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/usage");
  await waitForPageContent(page);

  await sessionField(page).fill(SESSION_ID);
  await applyButton(page).click();
  await page.waitForURL(new RegExp(`sessionId=${SESSION_ID}`, "u"));
  await waitForPageContent(page);

  // The whole page is the session's, so the fleet's own metrics are gone.
  await expect(fleetMetrics(page)).toHaveCount(0);
  await expect(page.locator('[data-usage-session-scoped="true"]')).toHaveCount(
    1
  );
  await expect(page.getByText("Clear session")).toBeVisible();
  await expect(page.locator('[data-tab-item="overview"]')).toBeVisible();

  // The session's own evidence is on the page.
  await expect(page.getByText(WORKER_THREAD_ID).first()).toBeVisible();
});

test("the session's tabs keep the session scope and show that tab's evidence", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/usage?range=24H&sessionId=${SESSION_ID}`);
  await waitForPageContent(page);

  await page.locator('[data-tab-item="threads"]').click();
  await page.waitForURL(/tab=threads/u);
  expect(new URL(page.url()).searchParams.get("sessionId")).toBe(SESSION_ID);
  await expect(page.getByText("ImplementationCoder").first()).toBeVisible();

  await page.locator('[data-tab-item="failures"]').click();
  await page.waitForURL(/tab=failures/u);
  expect(new URL(page.url()).searchParams.get("sessionId")).toBe(SESSION_ID);
  await expect(page.getByText("pretooluse-hook").first()).toBeVisible();

  await page.locator('[data-tab-item="requests"]').click();
  await page.waitForURL(/tab=requests/u);
  expect(new URL(page.url()).searchParams.get("sessionId")).toBe(SESSION_ID);
  await expect(page.getByText("probe_unavailable").first()).toBeVisible();
});

test("the threads tab shows role, provider and model, and the prompt size toggles units", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    "/usage?range=24H&sessionId=" +
      SESSION_ID +
      "&tab=threads&threadId=" +
      WORKER_THREAD_ID
  );
  await waitForPageContent(page);

  const threads = page.getByRole("table", { name: "Session threads" });
  for (const header of ["Role", "Model provider", "Model"]) {
    await expect(
      threads.getByRole("columnheader", { name: header, exact: true })
    ).toBeVisible();
  }

  const toggle = page.locator(
    '[data-inline-display-toggle="initial-developer-prompt"]'
  );
  await expect(toggle).toHaveCSS("cursor", "pointer");
  await expect(toggle).toHaveCSS("text-decoration-style", "dotted");
  await expect(toggle).toHaveText("1,200 bytes");
  // The fixture carries independent byte and character counts; tokens were not observed.
  await toggle.click();
  await expect(toggle).toHaveText("1,188 characters");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveText("Not observed (tokens)");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveText("1,200 bytes");
});

test("the spans tab pages through a session longer than one page", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/usage?range=24H&sessionId=${SESSION_ID}&tab=spans`);
  await waitForPageContent(page);

  const pagination = page.getByRole("navigation", { name: "Spans pagination" });
  await expect(pagination).toBeVisible();
  await expect(pagination).toContainText("1–50 of 250");

  // Page 5 is the page past the 200th span: the old wall stopped at 200.
  await pagination.getByRole("link", { name: "Page 5" }).click();
  await page.waitForURL(/spanOffset=200/u);
  await expect(pagination).toContainText("201–250 of 250");
  expect(new URL(page.url()).searchParams.get("sessionId")).toBe(SESSION_ID);
});

test("an invalid session id fails closed and keeps the fleet off the page", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/usage");
  await waitForPageContent(page);

  await sessionField(page).fill("process-fallback");
  await applyButton(page).click();
  await page.waitForURL(/sessionId=process-fallback/u);
  await waitForPageContent(page);

  await expect(
    page.getByText("not a valid AutoDev session identity")
  ).toBeVisible();
  await expect(fleetMetrics(page)).toHaveCount(0);
});

test("clearing the session returns the page to the fleet usage", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/usage?range=24H&sessionId=${SESSION_ID}`);
  await waitForPageContent(page);

  await page.getByText("Clear session").click();
  await page.waitForURL((url) => !url.searchParams.has("sessionId"));
  await waitForPageContent(page);

  await expect(fleetMetrics(page)).toBeVisible();
  await expect(page.locator('[data-usage-session-scoped="false"]')).toHaveCount(
    1
  );
});

test("the fleet's recent sessions link into a session's diagnostics", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/usage?view=sessions");
  await waitForPageContent(page);

  await expect(page.locator('[data-fleet-diagnostics="true"]')).toHaveCount(1);
  const sessionLink = page.locator("a").filter({ hasText: SESSION_ID }).first();
  await expect(sessionLink).toBeVisible();
  await sessionLink.click();
  await page.waitForURL(/sessionId=/u);
  await waitForPageContent(page);

  expect(new URL(page.url()).searchParams.get("sessionId")).toBe(SESSION_ID);
  await expect(page.getByText("Clear session")).toBeVisible();
});

test("the fleet's hook denials summarize the policy that blocked what", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/usage?view=hooks");
  await waitForPageContent(page);

  await expect(page.getByText("no-secrets").first()).toBeVisible();
  await expect(page.getByText("cat .env").first()).toBeVisible();
});
