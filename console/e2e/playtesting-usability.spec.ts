import { expect, type Locator, type Page, test } from "@playwright/test";

const SESSION_17_URL_PATTERN = /\/playtesting\/sessions\/episode-17\?/u;
const VIEW_FINDINGS_PATTERN = /view=findings/u;
const STEP_2_PATTERN = /step=2/u;
const RETURN_FINDING_1_PATTERN = /returnFinding=finding-1/u;
const PLAYTESTING_FINDINGS_VIEW_PATTERN = /\/playtesting\?view=findings/u;
const SEVERITY_MAJOR_PATTERN = /severity=major/u;
const FINDING_1_ANCHOR_PATTERN = /#finding-finding-1$/u;
const VIEW_COMPARE_PATTERN = /view=compare/u;
const WORKSPACE_DETAIL_URL_PATTERN = /\/workspaces\/fixture\/game$/u;
const BUDGET_PREVIEW_PATTERN =
  /Budget preview: 1 episode · tutorial · at most 20 steps/u;
const FIXTURE_BUILD_SHA = "a".repeat(40);
const FIXTURE_CONFIG_HASH = "b".repeat(64);
const FIXTURE_IMAGE_DIGEST = "fixture/adapter@sha256:" + "c".repeat(64);

async function fillSyntheticApprovalForm(page: Page): Promise<Locator> {
  await page.goto("/workspaces/fixture/game");
  await expect(
    page.getByRole("heading", { name: "fixture/game", exact: true })
  ).toBeVisible();
  const form = page.getByRole("form", {
    name: "Approve playtesting for fixture/game"
  });
  await expect(form).toBeVisible();
  await expect(
    form.getByLabel("Checkout root (absolute local path)")
  ).toBeVisible();
  await expect(form.getByLabel("Build SHA (Git revision)")).toBeVisible();
  await expect(
    form.getByLabel("Adapter image digest (sha256:...)")
  ).toBeVisible();
  await form
    .getByLabel("Checkout root (absolute local path)")
    .fill("/tmp/synthetic-game");
  await form
    .getByLabel("Working directory (relative to checkout)")
    .fill("server");
  await form.getByLabel("Build SHA (Git revision)").fill(FIXTURE_BUILD_SHA);
  await form.getByLabel("Game build identifier").fill("fixture-game-1");
  await form
    .getByLabel("Playtest config hash (SHA-256)")
    .fill(FIXTURE_CONFIG_HASH);
  await form
    .getByLabel("Adapter image digest (sha256:...)")
    .fill(FIXTURE_IMAGE_DIGEST);
  await form
    .getByLabel("Adapter command (comma-separated argv)")
    .fill("node, adapter.mjs");
  await form.getByLabel("Allowed scenarios (comma-separated)").fill("tutorial");
  await form.getByLabel("Allowed policies (comma-separated)").fill("random");
  await form.getByLabel("CPU cores").fill("1");
  await form.getByLabel("Memory (bytes)").fill("134217728");
  await form.getByLabel("Process count").fill("2");
  await form.getByLabel("Wall time (ms)").fill("60000");
  await form.getByLabel("Artifact bytes").fill("1048576");
  await form.getByLabel("Worker count").fill("1");
  await form.getByLabel("Episode count").fill("10");
  await form.getByLabel("Max steps / episode").fill("20");
  await form.getByLabel("Critique count").fill("0");
  await form.getByLabel("Retention (days)").fill("30");
  return form;
}

test("workspace overview distinguishes batches, episodes, findings, and comparisons", async ({
  page
}) => {
  await page.goto("/playtesting?workspaceId=fixture%2Fgame");
  await expect(
    page.getByRole("navigation", { name: "Playtesting views" })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(page.getByText("Latest batch")).toBeVisible();
  await expect(
    page.getByText("fixture/game · disabled", { exact: false })
  ).toHaveCount(0);
  await expect(
    page.getByText("Batches", { exact: true }).first()
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Episodes" })).toBeVisible();
  await expect(
    page.getByText("Findings", { exact: true }).first()
  ).toBeVisible();
  await expect(
    page.getByText("Comparisons", { exact: true }).first()
  ).toBeVisible();
});

test("finding witness opens its exact replay step, then Back restores filtered list and anchor", async ({
  page
}) => {
  await page.goto(
    "/playtesting?view=findings&workspaceId=fixture%2Fgame&severity=major"
  );
  await expect(page.getByRole("heading", { name: "Findings" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const witnessLink = page.getByRole("link", { name: "Open witness" });
  await witnessLink.hover();
  await page.waitForTimeout(250);
  await witnessLink.click();
  await expect(page).toHaveURL(SESSION_17_URL_PATTERN);
  await expect(page).toHaveURL(VIEW_FINDINGS_PATTERN);
  await expect(page).toHaveURL(STEP_2_PATTERN);
  await expect(page).toHaveURL(RETURN_FINDING_1_PATTERN);
  await expect(page.getByText("Execution status")).toBeVisible();
  await expect(page.getByText("Game outcome")).toBeVisible();
  await expect(page.getByText("LOSS", { exact: true })).toBeVisible();
  await expect(
    page.locator('pre[aria-label="Recorded data for step 2"]')
  ).toContainText("event-2");
  const frame = page.getByRole("img", {
    name: "Recorded game frame 1 at step 1"
  });
  await expect(frame).toBeVisible();
  await expect(frame).toHaveJSProperty("naturalWidth", 1);
  const backLink = page.getByRole("link", { name: "Back to findings" });
  await backLink.hover();
  await page.waitForTimeout(250);
  await backLink.click();
  await expect(page).toHaveURL(PLAYTESTING_FINDINGS_VIEW_PATTERN);
  await expect(page).toHaveURL(SEVERITY_MAJOR_PATTERN);
  await expect(page).toHaveURL(FINDING_1_ANCHOR_PATTERN);
  await expect(page.locator("#finding-finding-1")).toBeVisible();
});

test("mobile session list has no horizontal page overflow and tabs are keyboard navigable", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/playtesting?view=sessions&workspaceId=fixture%2Fgame");
  await page.waitForLoadState("networkidle");
  const width = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);

  const nav = page.getByRole("navigation", { name: "Playtesting views" });
  const overview = nav.getByRole("link", { name: "Overview" });
  await overview.focus();
  await page.keyboard.press("Tab");
  await expect(nav.getByRole("link", { name: "Sessions" })).toBeFocused();
  await expect(
    page.getByRole("form", { name: "Playtesting filters" })
  ).toBeVisible();
  const compareLink = nav.getByRole("link", { name: "Compare" });
  await compareLink.hover();
  await page.waitForTimeout(250);
  await compareLink.click();
  await expect(page).toHaveURL(VIEW_COMPARE_PATTERN);
});

test("workspace approval is an accessible explicit exact-build form", async ({
  page
}) => {
  const form = await fillSyntheticApprovalForm(page);

  let documentNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documentNavigations += 1;
  });
  await form.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.locator('[data-workspace-approval-state="active"]')
  ).toBeVisible();
  await expect(
    page.getByText(FIXTURE_BUILD_SHA, { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("form", {
      name: "Revoke playtesting approval for fixture/game"
    })
  ).toBeVisible();
  await expect(page).toHaveURL(WORKSPACE_DETAIL_URL_PATTERN);
  expect(documentNavigations).toBe(0);
  const revokeForm = page.getByRole("form", {
    name: "Revoke playtesting approval for fixture/game"
  });
  await revokeForm
    .getByLabel("Revocation reason")
    .fill("Synthetic usability fixture only");
  await revokeForm
    .getByRole("button", {
      name: "Revoke playtesting approval for fixture/game"
    })
    .click();
  await expect(
    page.locator('[data-workspace-approval-state="revoked"]')
  ).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Approve playtesting for fixture/game" })
  ).toBeVisible();
  await expect(page).toHaveURL(WORKSPACE_DETAIL_URL_PATTERN);
  expect(documentNavigations).toBe(0);
  const responseBody = await page.locator("body").textContent();
  expect(responseBody ?? "").not.toContain(
    "playtesting-browser-fixture-token-0000000000000000000000000000000000000000000000000000000000000000"
  );
});

test("approved run start, status refresh, and cancellation stay in the Console without document navigation", async ({
  page
}) => {
  const approvalForm = await fillSyntheticApprovalForm(page);
  await approvalForm.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.locator('[data-workspace-approval-state="active"]')
  ).toBeVisible();

  await page.goto("/playtesting?workspaceId=fixture%2Fgame");
  const form = page.getByRole("form", {
    name: "Run one approved Playtesting episode"
  });
  await expect(form).toBeVisible();
  await expect(page.getByText(BUDGET_PREVIEW_PATTERN)).toBeVisible();

  let documentNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documentNavigations += 1;
  });
  await form.getByLabel("Seed").fill("hold");
  await form.getByRole("button", { name: "Run one approved episode" }).click();
  await expect(
    page.getByText("batch-browser-001", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("The Runtime confirmed this approved episode assignment.", {
      exact: true
    })
  ).toBeVisible();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Request cancellation" }).click();
  await expect(
    page.getByText(
      "Cancellation was requested; refresh status to confirm its terminal disposition.",
      {
        exact: true
      }
    )
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh server status" }).click();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  expect(documentNavigations).toBe(0);
});
