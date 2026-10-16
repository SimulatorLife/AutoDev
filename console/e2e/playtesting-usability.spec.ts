import { expect, type Locator, type Page, test } from "@playwright/test";

const SESSION_17_URL_PATTERN = /\/playtesting\/sessions\/episode-17\?/u;
const VIEW_FINDINGS_PATTERN = /view=findings/u;
const STEP_2_PATTERN = /step=2/u;
const REVIEW_STEP_1_PATTERN = /step=1/u;
const RETURN_FINDING_1_PATTERN = /returnFinding=finding-[a-f\d]{64}/u;
const PLAYTESTING_FINDINGS_VIEW_PATTERN = /\/playtesting\?view=findings/u;
const SEVERITY_MAJOR_PATTERN = /severity=major/u;
const FINDING_1_ANCHOR_PATTERN = /#finding-finding-[a-f\d]{64}$/u;
const VIEW_COMPARE_PATTERN = /view=compare/u;
const WORKSPACE_DETAIL_URL_PATTERN = /\/workspaces\/fixture\/game$/u;
const BUDGET_PREVIEW_PATTERN =
  /Batch budget preview: 1 of 10 per-batch episode assignments/u;
const RUN_TWO_ASSIGNMENTS_LABEL = "Run 2 approved assignments";
const REVOKE_FORM_NAME = "Revoke playtesting approval for fixture/game";
const MAX_BUDGET_PREVIEW_PATTERN =
  /Batch budget preview: 1 of 1000 per-batch episode assignments/u;
const BROWSER_BATCH_ID_PATTERN = /^batch-browser-\d{3}$/u;
const RUNNING_STATUS = "running";
const ANALYSIS_STATUS_ATTRIBUTE = "data-analysis-status";
const CANCEL_RUN_ROUTE_PATTERN = /\/api\/playtesting\/runs\/[^/]+\/cancel$/u;
const ACTIVE_APPROVAL_SELECTOR = '[data-workspace-approval-state="active"]';
const LIVE_OR_IDLE_FRESHNESS_PATTERN = /live|idle/u;
const LIVE_BATCH_URL_PATTERN = /liveBatch=batch-/u;
const LAST_KNOWN_STATE_PATTERN = /not confirmed current state/iu;
const SYNTHETIC_REVIEW_ID_PATTERN = /Review review-fixture-1 · rubric/u;
const FIXTURE_IMAGE_DIGEST = "fixture/adapter@sha256:" + "c".repeat(64);
const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const PLAYTESTING_OVERVIEW_URL = "/playtesting?workspaceId=fixture%2Fgame";
const RUN_FORM_NAME = "Run an approved Playtesting batch";
const RUN_STATUS_REGION_NAME = "Server-confirmed run status";
const ANALYST_PANEL_NAME = "Multi-session analyst review";
const START_ANALYST_REVIEW_LABEL = "Start analyst review";
const ANALYST_RUN_TEST_ID = "playtesting-analysis-run";

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${FIXTURE_BASE_URL}/fixture/reset`);
  expect(response.ok()).toBe(true);
});

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
  await expect(
    form.getByLabel("Adapter image digest (sha256:...)")
  ).toBeVisible();
  await form
    .getByLabel("Checkout root (absolute local path)")
    .fill("/tmp/synthetic-game");
  await form
    .getByLabel("Working directory (relative to checkout)")
    .fill("server");
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
  await page.goto(PLAYTESTING_OVERVIEW_URL);
  await expect(
    page.getByRole("navigation", { name: "Playtesting views" })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(page.getByText("Latest batch")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Metric coverage" })
  ).toBeVisible();
  await expect(
    page.locator('[data-coverage-cell="legal-action-rejection"]')
  ).toContainText("3/3 opportunities");
  await expect(
    page.locator('[data-coverage-cell="legal-action-rejection"]')
  ).toContainText("Covered");
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

test("Playtesting overview waits for Data schema readiness before reading results", async ({
  page,
  request
}) => {
  const configured = await request.post(
    `${FIXTURE_BASE_URL}/fixture/readiness?pendingPolls=1`
  );
  expect(configured.ok()).toBe(true);

  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const readinessPanel = page.locator('[data-status="initializing"]');
  await expect(
    readinessPanel.getByRole("heading", {
      name: "Playtesting data is starting up"
    })
  ).toBeVisible();
  await expect(page.getByText("Latest batch")).toBeVisible({ timeout: 10_000 });
  await expect(readinessPanel).toHaveCount(0);
});

test("direct session links wait for Data schema readiness before loading evidence", async ({
  page,
  request
}) => {
  const configured = await request.post(
    `${FIXTURE_BASE_URL}/fixture/readiness?pendingPolls=1`
  );
  expect(configured.ok()).toBe(true);

  const browserReadiness = page.waitForResponse(
    async (response) => {
      if (
        response.request().method() !== "GET" ||
        !response.url().includes("/api/playtesting/readiness")
      ) {
        return false;
      }
      const payload = (await response.json().catch(() => null)) as {
        readonly kind?: unknown;
        readonly data?: { readonly status?: unknown };
      } | null;
      return payload?.kind === "ok" && payload.data?.status === "ready";
    },
    { timeout: 20_000 }
  );
  const sessionRefresh = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes("/playtesting/sessions/episode-17") &&
      response.url().includes("_rsc"),
    { timeout: 20_000 }
  );
  await page.goto(
    "/playtesting/sessions/episode-17?workspaceId=fixture%2Fgame",
    { waitUntil: "networkidle" }
  );
  const readinessPanel = page.locator('[data-status="initializing"]');
  await expect(
    readinessPanel.getByRole("heading", {
      name: "Playtesting data is starting up"
    })
  ).toBeVisible();
  await browserReadiness;
  await sessionRefresh;
  await expect(page.getByText("Execution status")).toBeVisible({
    timeout: 10_000
  });
  await expect(readinessPanel).toHaveCount(0);
});

test("operator retries unavailable Playtesting schema initialization from the overview", async ({
  page,
  request
}) => {
  const configured = await request.post(
    `${FIXTURE_BASE_URL}/fixture/readiness?unavailable=on`
  );
  expect(configured.ok()).toBe(true);

  await page.goto(PLAYTESTING_OVERVIEW_URL);
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("heading", { name: "Playtesting data is unavailable" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry initialization" }).click();
  await expect(page.getByText("Latest batch")).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("heading", { name: "Playtesting data is unavailable" })
  ).toHaveCount(0);
});

test("operator records a version-checked owner decision without deploying or changing approval", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/playtesting?view=compare&workspaceId=fixture%2Fgame");
  const fitsViewport = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );
  expect(fitsViewport).toBe(true);
  const decisionForm = page.getByRole("form", {
    name: "Record owner decision for comparison-1"
  });
  await expect(decisionForm).toBeVisible();
  const disposition = decisionForm.getByLabel("Disposition");
  const reasonField = decisionForm.getByLabel("Decision reason");
  const reviewButton = decisionForm.getByRole("button", {
    name: "Review decision"
  });
  await expect(disposition).toHaveValue("hold");
  await expect(
    decisionForm.getByRole("option", { name: "Promote eligible candidate" })
  ).toHaveCount(0);
  await disposition.focus();
  await page.keyboard.press("Tab");
  await expect(reasonField).toBeFocused();
  await reasonField.fill("Wait for a fresh confirmation cohort.");
  await page.keyboard.press("Tab");
  await expect(reviewButton).toBeFocused();
  await reviewButton.click();
  await expect(decisionForm).toBeVisible();
  await expect(
    page.getByText(
      "Confirm the immutable hold decision. No release or deployment will be performed."
    )
  ).toBeVisible();
  await expect(
    page.getByText("No owner decision recorded", { exact: true })
  ).toBeVisible();
  await decisionForm.getByRole("button", { name: "Confirm hold" }).click();
  await expect(
    page.getByText("Recorded hold. No release or deployment was performed.")
  ).toBeVisible();
  await expect(
    page.getByText(
      "hold by console-e2e-operator: Wait for a fresh confirmation cohort."
    )
  ).toBeVisible();
  await expect(decisionForm).toHaveCount(0);
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
  await expect(
    page.getByText("A warning event was recorded at the cited step.")
  ).toBeVisible();
  const claimCitation = page.locator('[data-review-claim-evidence="event-1"]');
  await expect(claimCitation).toBeVisible();
  await expect(claimCitation).toHaveAttribute("href", REVIEW_STEP_1_PATTERN);
  await expect(page.getByText("No citations recorded")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Review completeness and follow-up"
    })
  ).toBeVisible();
  await expect(
    page.getByText("This fixture contains one session and no batch synthesis.")
  ).toBeVisible();
  await expect(
    page.getByText("The policy may have missed the warning.")
  ).toBeVisible();
  await expect(
    page.getByText("Review the cited warning in the selected replay.")
  ).toBeVisible();
  const backLink = page.getByRole("link", { name: "Back to findings" });
  await backLink.hover();
  await page.waitForTimeout(250);
  await backLink.click();
  await expect(page).toHaveURL(PLAYTESTING_FINDINGS_VIEW_PATTERN);
  await expect(page).toHaveURL(SEVERITY_MAJOR_PATTERN);
  await expect(page).toHaveURL(FINDING_1_ANCHOR_PATTERN);
  await expect(page.locator('[id^="finding-finding-"]')).toBeVisible();
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

test("workspace approval is an accessible checkout form that tracks the latest commit", async ({
  page
}) => {
  const form = await fillSyntheticApprovalForm(page);

  let documentNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documentNavigations += 1;
  });
  await form.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(ACTIVE_APPROVAL_SELECTOR)).toBeVisible();
  await expect(
    page.getByText(
      "Latest commit of the checkout, resolved at each batch start",
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    page.getByRole("form", {
      name: REVOKE_FORM_NAME
    })
  ).toBeVisible();
  await expect(page).toHaveURL(WORKSPACE_DETAIL_URL_PATTERN);
  expect(documentNavigations).toBe(0);
  const revokeForm = page.getByRole("form", {
    name: REVOKE_FORM_NAME
  });
  await revokeForm
    .getByLabel("Revocation reason")
    .fill("Synthetic usability fixture only");
  await revokeForm
    .getByRole("button", {
      name: REVOKE_FORM_NAME
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

test("batch composer generates and submits the full bounded 1,000-assignment inventory", async ({
  page
}) => {
  const approvalForm = await fillSyntheticApprovalForm(page);
  await approvalForm.getByLabel("Episode count").fill("1000");
  await approvalForm.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(ACTIVE_APPROVAL_SELECTOR)).toBeVisible();

  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const form = page.getByRole("form", {
    name: RUN_FORM_NAME
  });
  await expect(page.getByText(MAX_BUDGET_PREVIEW_PATTERN)).toBeVisible();
  await form.getByLabel("Additional assignments").fill("999");
  await form.getByRole("button", { name: "Generate assignments" }).click();
  await expect(
    form.getByRole("group", { name: "Assignment 10" })
  ).toBeVisible();
  await expect(form.getByRole("group", { name: "Assignment 11" })).toHaveCount(
    0
  );
  await expect(
    form.getByRole("button", { name: "Show 990 more assignments" })
  ).toBeVisible();
  await expect(
    form.getByRole("button", { name: "Add assignment" })
  ).toBeDisabled();
  const submit = form.getByRole("button", {
    name: "Run 1000 approved assignments"
  });
  await expect(submit).toBeEnabled();
  await submit.click();

  const runStatus = page.getByRole("region", {
    name: RUN_STATUS_REGION_NAME
  });
  await expect(runStatus).toBeVisible();
  await expect(
    page.getByText(
      "The Runtime confirmed an approved batch of 1000 assignments.",
      { exact: true }
    )
  ).toBeVisible();

  await page.goto("/workspaces/fixture/game");
  const revokeForm = page.getByRole("form", {
    name: REVOKE_FORM_NAME
  });
  await revokeForm
    .getByLabel("Revocation reason")
    .fill("Synthetic usability fixture only");
  await revokeForm
    .getByRole("button", {
      name: REVOKE_FORM_NAME
    })
    .click();
  await expect(
    page.locator('[data-workspace-approval-state="revoked"]')
  ).toBeVisible();
});

test("approved run start, automatic status watching, and cancellation stay in the Console without document navigation", async ({
  page
}) => {
  const approvalForm = await fillSyntheticApprovalForm(page);
  await approvalForm.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(ACTIVE_APPROVAL_SELECTOR)).toBeVisible();

  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const form = page.getByRole("form", {
    name: RUN_FORM_NAME
  });
  await expect(form).toBeVisible();
  await expect(page.getByText(BUDGET_PREVIEW_PATTERN)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWidth = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  expect(mobileWidth.document).toBeLessThanOrEqual(mobileWidth.viewport);
  const collapseSidebar = page.getByRole("button", {
    name: "Collapse sidebar"
  });
  if (await collapseSidebar.isVisible()) await collapseSidebar.click();

  const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  await form.getByLabel("Seed 1").fill("hold");
  await form.getByLabel("Additional assignments").fill("1");
  await form.getByRole("button", { name: "Generate assignments" }).click();
  await expect(form.getByLabel("Seed 2")).toHaveValue("seed-2");
  await form.getByLabel("Seed 2").fill("hold");
  await expect(
    form.getByRole("group", { name: "Assignment 1" }).getByRole("alert")
  ).toHaveText("Scenario, policy, and seed must identify a unique assignment.");
  await expect(
    form.getByRole("button", { name: RUN_TWO_ASSIGNMENTS_LABEL })
  ).toBeDisabled();
  await form.getByLabel("Seed 2").fill("seed-2");
  await expect(
    form.getByRole("button", { name: RUN_TWO_ASSIGNMENTS_LABEL })
  ).toBeEnabled();
  await form.getByRole("button", { name: RUN_TWO_ASSIGNMENTS_LABEL }).click();
  const runStatus = page.getByRole("region", {
    name: RUN_STATUS_REGION_NAME
  });
  await expect(runStatus).toBeVisible();
  const cancelledBatchId = await runStatus.locator("strong").textContent();
  expect(cancelledBatchId).toMatch(BROWSER_BATCH_ID_PATTERN);
  await expect(
    page.getByText(
      "The Runtime confirmed an approved batch of 2 assignments.",
      {
        exact: true
      }
    )
  ).toBeVisible();
  await expect(runStatus.getByText("Running", { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  const cancellation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      CANCEL_RUN_ROUTE_PATTERN.test(response.url())
  );
  await page.getByRole("button", { name: "Request cancellation" }).click();
  const cancellationResponse = await cancellation;
  expect(cancellationResponse.status()).toBe(202);
  // The shared status owner confirms the terminal state without a manual
  // refresh; the transient "requested" notice is not the confirmation.
  await expect(runStatus.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Cancellation: Operator requested cancellation.", {
      exact: true
    })
  ).toBeVisible();

  await form.getByLabel("Seed 1").fill("complete-1");
  await form.getByLabel("Seed 2").fill("complete-2");
  await form.getByRole("button", { name: RUN_TWO_ASSIGNMENTS_LABEL }).click();
  await expect(runStatus.locator("strong")).not.toHaveText(
    cancelledBatchId ?? ""
  );
  const completedBatchId = await runStatus.locator("strong").textContent();
  expect(completedBatchId).toMatch(BROWSER_BATCH_ID_PATTERN);
  await expect(
    page
      .getByRole("region", { name: RUN_STATUS_REGION_NAME })
      .getByText("Completed", { exact: true })
  ).toBeVisible();
  const assignmentOutcomes = runStatus.getByRole("region", {
    name: "Assignment outcomes"
  });
  await expect(assignmentOutcomes).toContainText("Execution state: completed");
  await expect(assignmentOutcomes).toContainText("Game outcome: Unclassified");
  await expect(
    assignmentOutcomes.getByRole("link", {
      name: `Open session episode-${completedBatchId}-a-0001`
    })
  ).toBeVisible();
  await expect(
    assignmentOutcomes.getByRole("link", {
      name: `Open session episode-${completedBatchId}-a-0002`
    })
  ).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(
    documentTimeOrigin
  );
});

test("operator can start, watch, and analyze a completed session from the same Console flow", async ({
  page,
  request
}) => {
  const approvalForm = await fillSyntheticApprovalForm(page);
  await approvalForm.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(ACTIVE_APPROVAL_SELECTOR)).toBeVisible();

  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const runForm = page.getByRole("form", {
    name: RUN_FORM_NAME
  });
  await runForm
    .getByRole("button", { name: "Run 1 approved assignment" })
    .click();
  const runStatus = page.getByRole("region", {
    name: RUN_STATUS_REGION_NAME
  });
  await expect(runStatus).toBeVisible();
  const batchId = await runStatus.locator("strong").textContent();
  expect(batchId).toMatch(BROWSER_BATCH_ID_PATTERN);
  await expect(runStatus.getByText("Completed", { exact: true })).toBeVisible();

  const episodeId = `episode-${batchId}-a-0001`;
  const selectedEpisodeIds = ["episode-17", episodeId];
  await expect(
    runStatus.getByRole("link", { name: `Open session ${episodeId}` })
  ).toBeVisible();
  await page.goto(
    `/playtesting?view=sessions&workspaceId=fixture%2Fgame&sessions=${encodeURIComponent(selectedEpisodeIds.join(","))}`
  );
  const analystPanel = page.getByRole("region", {
    name: ANALYST_PANEL_NAME
  });
  await expect(analystPanel).toHaveAttribute("data-selected", "2");
  await analystPanel
    .getByRole("button", { name: START_ANALYST_REVIEW_LABEL })
    .click();
  const analystRun = analystPanel.getByTestId(ANALYST_RUN_TEST_ID);
  await expect(analystRun).toHaveAttribute(
    ANALYSIS_STATUS_ATTRIBUTE,
    "completed"
  );
  await expect(analystRun).toContainText(
    "Analyst process completed; 2 of 2 selected sessions have a persisted review."
  );
  const synthesis = analystRun.getByTestId(
    "playtesting-cross-session-synthesis"
  );
  await expect(synthesis).toBeVisible();
  await expect(synthesis).toContainText("hypotheses only");
  await expect(synthesis).toContainText(
    "Grounded in 2 of 2 packet-eligible selected sessions"
  );
  await expect(synthesis).toContainText("warning consistently precedes");
  const metricAggregation = synthesis.getByTestId(
    "playtesting-metric-aggregation"
  );
  await expect(metricAggregation).toHaveAttribute(
    "data-aggregation-status",
    "available"
  );
  const metricRow = metricAggregation.getByTestId(
    "playtesting-metric-aggregate"
  );
  await expect(metricRow).toContainText("legal-action-rejection@1");
  await expect(metricRow).toContainText("0 / 3 proportion · ratio 0");
  await expect(metricRow).toContainText("independent N 1");
  await expect(
    metricRow.getByRole("link", { name: "Open episode-17" })
  ).toBeVisible();
  const synthesisClaim = synthesis.getByTestId(
    "playtesting-cross-session-claim"
  );
  await expect(synthesisClaim).toContainText("Both packets show the warning");
  await expect(
    synthesisClaim.getByRole("link", {
      name: `episode-17: event event-1 at step 1`
    })
  ).toBeVisible();
  await expect(
    synthesisClaim.getByRole("link", {
      name: `${episodeId}: event event-1 at step 1`
    })
  ).toBeVisible();
  await expect(
    synthesis.getByRole("link", {
      name: `Open contributing session ${episodeId}`
    })
  ).toBeVisible();
  const hideProcessHistory = await request.get(
    `${FIXTURE_BASE_URL}/fixture/analyst-history?mode=missing`
  );
  expect(hideProcessHistory.ok()).toBe(true);
  const sessionsUrl = `/playtesting?view=sessions&workspaceId=fixture%2Fgame&sessions=${encodeURIComponent(selectedEpisodeIds.join(","))}`;
  await page.goto(sessionsUrl);
  const persistedSynthesis = page.getByTestId(
    "playtesting-persisted-cross-session-synthesis"
  );
  await expect(persistedSynthesis).toBeVisible();
  await expect(page.getByTestId(ANALYST_RUN_TEST_ID)).toHaveCount(0);
  await expect(persistedSynthesis).toContainText(
    "Saved batch-level synthesis; task status may have expired."
  );
  await expect(
    persistedSynthesis.getByTestId("playtesting-metric-aggregate")
  ).toContainText("legal-action-rejection@1");
  const persistedClaim = persistedSynthesis.getByTestId(
    "playtesting-cross-session-claim"
  );
  await expect(persistedClaim).toContainText("Both packets show the warning");
  const contributingSession = persistedSynthesis.getByRole("link", {
    name: `Open contributing session ${episodeId}`
  });
  await expect(contributingSession).toBeVisible();
  await page.waitForLoadState("networkidle");
  await contributingSession.click();
  await expect(page).toHaveURL(
    new RegExp(String.raw`/playtesting/sessions/${episodeId}\?`, "u")
  );
  const reviewUrl = new URL(page.url());
  expect(reviewUrl.searchParams.get("workspaceId")).toBe("fixture/game");
  await expect(
    page.getByRole("heading", { name: "Analyst review" })
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic reviewed session for UI usability only.", {
      exact: true
    })
  ).toBeVisible();
  await expect(
    page.getByText(
      new RegExp(
        String.raw`Review review-analysis-browser-\d{3}-${episodeId} · rubric`,
        "u"
      )
    )
  ).toBeVisible();
});

/**
 * The live view must be driven by the operator doing nothing, and an unreadable
 * read must be visible rather than silent. The fixture's run read is switched
 * off explicitly here so a passing run cannot be explained by the panel never
 * having polled.
 */
test("live batches appear without operator action, and an unreadable read is stated", async ({
  page,
  request
}) => {
  const approvalForm = await fillSyntheticApprovalForm(page);
  await approvalForm.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(ACTIVE_APPROVAL_SELECTOR)).toBeVisible();

  await page.goto("/playtesting?workspaceId=fixture/game");
  const panel = page.getByRole("region", { name: "Live batches" });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute(
    "data-freshness",
    LIVE_OR_IDLE_FRESHNESS_PATTERN
  );

  const form = page.getByRole("form", {
    name: RUN_FORM_NAME
  });
  await expect(form).toBeVisible();
  await form.getByLabel("Additional assignments").fill("1");
  await form.getByRole("button", { name: "Generate assignments" }).click();
  await expect(form.getByLabel("Seed 2")).toBeVisible();
  await form.getByLabel("Seed 1").fill("hold");
  await form.getByLabel("Seed 2").fill("hold-2");
  await form.getByRole("button", { name: RUN_TWO_ASSIGNMENTS_LABEL }).click();

  // No Refresh click: the batch appears because the view polls the owner.
  const batch = panel.getByTestId("playtesting-active-run").first();
  await expect(batch).toBeVisible();
  await expect(batch).toHaveAttribute("data-status", RUNNING_STATUS);

  // The focused batch is address state, so refresh restores it.
  await batch.getByRole("button", { name: "Show progress" }).click();
  await expect(batch).toHaveAttribute("data-focused", "true");

  // The tiles name the owner's own counts. A tile pointed at a field the
  // Runtime does not produce renders "not observed" forever, which is what
  // four of these did before the keys were bound to PlaytestCompletionCounts.
  await expect(batch).toContainText("Assignments started");
  await expect(batch).toContainText("Assignments completed");
  await expect(batch).not.toContainText("Assignments succeeded");
  await expect(batch).not.toContainText("Assignments quota-blocked");
  await expect(page).toHaveURL(LIVE_BATCH_URL_PATTERN);
  await page.reload();
  const reloaded = page.getByRole("region", { name: "Live batches" });
  await expect(
    reloaded.getByTestId("playtesting-active-run").first()
  ).toHaveAttribute("data-focused", "true");

  // An unreadable read is an explicit state, and the last known frame is
  // labelled as last known rather than badged as current.
  const response = await request.get(
    `${FIXTURE_BASE_URL}/fixture/runs-read-fail?mode=on`
  );
  expect(response.ok()).toBe(true);
  try {
    const degraded = page.getByRole("region", { name: "Live batches" });
    await expect(degraded).toHaveAttribute("data-freshness", "unavailable", {
      timeout: 20_000
    });
    await expect(degraded.getByText(LAST_KNOWN_STATE_PATTERN)).toBeVisible();
    await expect(
      degraded.getByTestId("playtesting-active-run-lastknown")
    ).toBeVisible();
  } finally {
    await request.get(`${FIXTURE_BASE_URL}/fixture/runs-read-fail?mode=off`);
  }

  // Progress is announced politely and does not move focus.
  await expect(panel.locator("[aria-live='polite']")).toHaveCount(1);
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe(
    "HTML"
  );
});

test("Console dispatches analyst work, shows stale status, and links to the persisted review", async ({
  page,
  request
}) => {
  await page.goto(
    "/playtesting?view=sessions&workspaceId=fixture%2Fgame&sessions=episode-17"
  );
  const panel = page.getByRole("region", {
    name: ANALYST_PANEL_NAME
  });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Analyze selected sessions" })
  ).toBeVisible();
  const submit = panel.getByRole("button", {
    name: START_ANALYST_REVIEW_LABEL
  });
  await expect(submit).toBeEnabled();
  await submit.click();

  const run = panel.getByTestId(ANALYST_RUN_TEST_ID).first();
  await expect(run).toHaveAttribute(ANALYSIS_STATUS_ATTRIBUTE, RUNNING_STATUS);
  const statusFailure = await request.get(
    `${FIXTURE_BASE_URL}/fixture/analyses-read-fail?mode=on`
  );
  expect(statusFailure.ok()).toBe(true);
  await expect(run).toHaveAttribute(ANALYSIS_STATUS_ATTRIBUTE, "stale", {
    timeout: 10_000
  });
  await expect(run).toContainText("Last known status");
  const statusRecovered = await request.get(
    `${FIXTURE_BASE_URL}/fixture/analyses-read-fail?mode=off`
  );
  expect(statusRecovered.ok()).toBe(true);
  await expect(run).toHaveAttribute(ANALYSIS_STATUS_ATTRIBUTE, "completed", {
    timeout: 15_000
  });
  const reviewLink = run.getByRole("link", {
    name: "Open hypothesis review for episode-17"
  });
  await expect(reviewLink).toBeVisible();
  await reviewLink.hover();
  await page.waitForTimeout(250);
  await reviewLink.click();
  await expect(page).toHaveURL(SESSION_17_URL_PATTERN);
  await expect(page.getByText("Analyst review")).toBeVisible();
  await expect(page.getByText(SYNTHETIC_REVIEW_ID_PATTERN)).toBeVisible();
  await expect(
    page.getByText("Synthetic reviewed session for UI usability only.", {
      exact: true
    })
  ).toBeVisible();
});

test("the full 40-session critique ceiling reaches Runtime without truncation", async ({
  page
}) => {
  const episodeIds = [
    "episode-17",
    ...Array.from({ length: 39 }, (_, index) => `unknown-${String(index + 1)}`)
  ];
  await page.goto(
    `/playtesting?view=sessions&workspaceId=fixture%2Fgame&sessions=${encodeURIComponent(episodeIds.join(","))}`
  );
  const panel = page.getByRole("region", {
    name: ANALYST_PANEL_NAME
  });
  await expect(panel).toHaveAttribute("data-selected", "40");
  const dispatchRequest = page.waitForRequest(
    (request) =>
      request.url().includes("/api/playtesting/analyses") &&
      request.method() === "POST"
  );
  await panel.getByRole("button", { name: START_ANALYST_REVIEW_LABEL }).click();
  const request = await dispatchRequest;
  const form = new URLSearchParams(request.postData() ?? "");
  expect(JSON.parse(form.get("episodeIds") ?? "null")).toEqual(episodeIds);
  const run = panel.getByTestId(ANALYST_RUN_TEST_ID).first();
  await expect(run).toHaveAttribute(ANALYSIS_STATUS_ATTRIBUTE, RUNNING_STATUS);
  await expect(run).toHaveAttribute(ANALYSIS_STATUS_ATTRIBUTE, "completed");
  await expect(run).toContainText(
    "Analyst process completed; 1 of 40 selected sessions have a persisted review."
  );
  await expect(run.getByTestId("playtesting-analysis-receipt")).toHaveCount(39);
  await expect(run.getByTestId("playtesting-analysis-review-link")).toHaveCount(
    1
  );
});

test("an oversized shared analyst selection is refused without truncation", async ({
  page
}) => {
  const oversized = Array.from(
    { length: 41 },
    (_, index) => `episode-${String(index + 1)}`
  ).join(",");
  await page.goto(
    `/playtesting?view=sessions&workspaceId=fixture%2Fgame&sessions=${encodeURIComponent(oversized)}`
  );
  const panel = page.getByRole("region", {
    name: ANALYST_PANEL_NAME
  });
  await expect(panel).toHaveAttribute("data-selected", "0");
  await expect(
    panel.getByTestId("playtesting-selection-invalid-query")
  ).toContainText("nothing was truncated or started");
  await expect(
    panel.getByRole("button", { name: START_ANALYST_REVIEW_LABEL })
  ).toBeDisabled();
});
