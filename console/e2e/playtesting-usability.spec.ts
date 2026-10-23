import { expect, type Locator, type Page, test } from "@playwright/test";

const SESSION_17_URL_PATTERN = /\/playtesting\/sessions\/episode-17\?/u;
const VISUAL_DEBRIEF_EPISODE_ID = "episode-visual-debrief";
const VIEW_FINDINGS_PATTERN = /view=findings/u;
const STEP_2_PATTERN = /step=2/u;
const VISUAL_DEBRIEF_STEP_0_PATTERN = /step=0/u;
const STOP_STEP_3_PATTERN = /step=3/u;
const REVIEW_STEP_1_PATTERN = /step=1/u;
const RETURN_FINDING_1_PATTERN = /returnFinding=finding-[a-f\d]{64}/u;
const PLAYTESTING_FINDINGS_VIEW_PATTERN = /\/playtesting\?view=findings/u;
const SEVERITY_MAJOR_PATTERN = /severity=major/u;
const FINDING_1_ANCHOR_PATTERN = /#finding-finding-[a-f\d]{64}$/u;
const VIEW_COMPARE_PATTERN = /view=compare/u;
const WORKSPACE_DETAIL_URL_PATTERN = /\/workspaces\/fixture\/game$/u;
const BUDGET_PREVIEW_PATTERN =
  /1 of 10 sessions · 1 concurrent worker\(s\) · 60 seconds maximum/u;
const RUN_TWO_ASSIGNMENTS_LABEL = "Start 2 adapter playtests";
const REVOKE_FORM_NAME = "Revoke playtesting approval for fixture/game";
const MAX_BUDGET_PREVIEW_PATTERN =
  /1 of 1000 sessions · 1 concurrent worker\(s\) · 60 seconds maximum/u;
const BROWSER_BATCH_ID_PATTERN = /^batch-browser-\d{3}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const RUNNING_STATUS = "running";
const COMPLETED_STATUS = "completed";
const CANCELLED_STATUS = "cancelled";
const RUN_STATUS_ATTRIBUTE = "data-status";
const ANALYSIS_STATUS_ATTRIBUTE = "data-analysis-status";
const CANCEL_RUN_ROUTE_PATTERN = /\/api\/playtesting\/runs\/[^/]+\/cancel$/u;
const ACTIVE_APPROVAL_SELECTOR = '[data-workspace-approval-state="active"]';
const LIVE_OR_IDLE_FRESHNESS_PATTERN = /live|idle/u;
const VISUAL_DRIVER_UNAVAILABLE_LABEL = "Visual driver unavailable";
const VISUAL_MODE_SELECTOR = '[data-playtesting-mode="autonomous-visual"]';
const ADAPTER_MODE_SELECTOR = '[data-playtesting-mode="adapter-accelerated"]';
const LIVE_BATCH_URL_PATTERN = /liveBatch=batch-/u;
const LAST_KNOWN_STATE_PATTERN = /not confirmed current state/iu;
const FILTERS_SUMMARY_PATTERN = /^Filters/u;
const SYNTHETIC_REVIEW_ID_PATTERN = /Review review-fixture-1 · rubric/u;
const FIXTURE_IMAGE_DIGEST = "fixture/adapter@sha256:" + "c".repeat(64);
const FIXTURE_WORKSPACE_ID = "fixture/game";
const APPROVAL_FORM_NAME = `Approve playtesting for ${FIXTURE_WORKSPACE_ID}`;
const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const PLAYTESTING_OVERVIEW_URL = "/playtesting?workspaceId=fixture%2Fgame";
const RUN_FORM_NAME = "Start an adapter-accelerated playtest";
const START_SINGLE_RUN_LABEL = "Start adapter playtest";
const RUN_STATUS_REGION_NAME = "Playtest run status";
const CUSTOMIZE_RUN_LABEL = "Customize run";
const BATCH_TIME_ANALYSIS_LABEL = "Batch, time, and analysis limits";
const ACTIVE_RUN_TEST_ID = "playtesting-active-run";
const ASSIGNMENT_OUTCOME_TEST_ID = "playtesting-assignment-outcome";
const BATCH_ID_ATTRIBUTE = "data-batch-id";
const TWO_SESSION_SELECTION_URL_PATTERN =
  /sessions=episode-17%2Cbatch-browser-\d{3}\.a-0001/u;
const ANALYST_PANEL_NAME = "Multi-session analyst review";
const START_ANALYST_REVIEW_LABEL = "Start analyst review";
const ANALYST_RUN_TEST_ID = "playtesting-analysis-run";
const PRESSED_ATTRIBUTE = "aria-pressed";
const PRESSED_VALUE = "true";
const FINDINGS_HEADING_NAME = "Findings";
const REVIEW_HYPOTHESIS_TEXT =
  "This legacy interpretation has no claim-level citation.";
const REVIEW_SUMMARY_TEXT = "Synthetic reviewed session for UI usability only.";
const REVIEW_HYPOTHESES_LABEL = "Hypotheses";
const REVIEW_OBSERVATIONS_LABEL = "Observations";
const REVIEW_RECORDED_HEADING = "What the analyst recorded";
const REVIEW_EVIDENCE_HEADING = "Evidence cited";
const REVIEW_SELECTION_URL_PATTERN = /review=review-fixture-1/u;
const REVIEW_DETAIL_SELECTOR = "[data-review-detail]";
const MODE_STATUS_ATTRIBUTE = "data-mode-status";
const VISUAL_LAUNCH_TEST_ID = "playtesting-visual-launch";
const VISUAL_SUBMIT_SELECTOR = '[data-playtesting-visual-submit="true"]';
const VISUAL_FOCUS_PLACEHOLDER_PATTERN =
  /visible controls.*do not assume hidden goals/u;
const VISUAL_TARGET_NAME = "visual-fixture-target";
const RUNS_ENDPOINT_PATH = "/api/playtesting/runs";
const LIVE_SESSION_LINKS_TEST_ID = "playtesting-live-session-links";
const WATCH_SESSION_LINK_NAME = "Watch session";
const PENDING_REQUEST_REGION_NAME = "Pending playtest request";
const REQUEST_ID_ATTRIBUTE = "data-request-id";
const VISUAL_LIVE_BATCH_URL_PATTERN = /liveBatch=batch-visual-live-001/u;

async function openNewPlaytest(page: Page): Promise<Locator> {
  await page.locator('[data-playtesting-open-dialog="true"]').click();
  const dialog = page.getByTestId("playtesting-new-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${FIXTURE_BASE_URL}/fixture/reset`);
  expect(response.ok()).toBe(true);
});

test("the persistent Play action remains visible until a workspace is selected", async ({
  page
}) => {
  await page.goto("/playtesting");
  const play = page.getByRole("button", { name: "Start playtest" });
  await expect(play).toBeVisible();
  await expect(play).toBeDisabled();
  await expect(play).toHaveAttribute(
    "title",
    "Choose a workspace before starting a playtest"
  );
  await expect(page.getByRole("combobox", { name: "Workspace" })).toBeVisible();
});

async function fillSyntheticApprovalForm(page: Page): Promise<Locator> {
  await page.goto("/workspaces/fixture/game");
  await expect(
    page.getByRole("heading", { name: FIXTURE_WORKSPACE_ID, exact: true })
  ).toBeVisible();
  const form = page.getByRole("form", { name: APPROVAL_FORM_NAME });
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
  await expect(
    page.getByRole("link", { name: "Overview", exact: true })
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Latest result")).toBeVisible();
  const dialog = await openNewPlaytest(page);
  await expect(
    page.getByRole("dialog", { name: "New playtest" })
  ).toBeVisible();
  await expect(dialog).toHaveAttribute(
    "aria-labelledby",
    "playtesting-new-dialog-title"
  );
  await expect(dialog.locator(VISUAL_MODE_SELECTOR)).toContainText(
    "No visual target approved"
  );
  await expect(dialog).toContainText(
    "Adapter runs are a separate, structured-data option—not a visual-mode fallback."
  );
  await expect(dialog.getByTestId("playtesting-adapter-launch")).toContainText(
    "It does not observe the rendered UI or stand in for autonomous visual play."
  );
  const visualReadinessDetails = dialog
    .locator(VISUAL_MODE_SELECTOR)
    .getByTestId("visual-readiness-details");
  await visualReadinessDetails.locator("summary").click();
  await expect(dialog.locator(VISUAL_MODE_SELECTOR)).toContainText(
    VISUAL_DRIVER_UNAVAILABLE_LABEL
  );
  await expect(dialog.locator(ADAPTER_MODE_SELECTOR)).toHaveAttribute(
    MODE_STATUS_ATTRIBUTE,
    "check-required"
  );
  await expect(dialog.locator(ADAPTER_MODE_SELECTOR)).toContainText(
    "Approval required"
  );
  await expect(
    dialog.getByRole("link", { name: "Manage visual target permissions" })
  ).toHaveAttribute("href", WORKSPACE_DETAIL_URL_PATTERN);
  await expect(dialog.getByTestId("playtesting-run-blocked")).toContainText(
    "Approval required"
  );
  await expect(dialog.getByRole("form", { name: RUN_FORM_NAME })).toHaveCount(
    0
  );
  await expect(dialog.getByTestId("playtesting-build-context")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByText("Measurement coverage").click();
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
    page.getByRole("heading", { name: "Recent sessions" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Browse all sessions" })
  ).toBeVisible();
  await expect(page.getByText("Batches", { exact: true })).toHaveCount(0);
});

test("mobile Play dialog keeps the visual launch action visible and blocked without approval", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const dialog = await openNewPlaytest(page);
  await dialog.locator('[data-playtesting-tab="autonomous-visual"]').click();
  const launch = dialog
    .getByTestId(VISUAL_LAUNCH_TEST_ID)
    .locator(VISUAL_SUBMIT_SELECTOR);
  await expect(launch).toBeInViewport();
  const launchBox = await launch.boundingBox();
  expect(launchBox).not.toBeNull();
  expect(launchBox!.y + launchBox!.height).toBeLessThanOrEqual(844);
  await expect(launch).toBeDisabled();
  await expect(launch).toContainText("No Target Selected");
  await expect(dialog.getByTestId("visual-launch-summary")).toContainText(
    "No approved visual target is available"
  );
});

test("mobile approved Visual Play keeps the bounded launch action visible", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const readiness = await request.get(
    `${FIXTURE_BASE_URL}/fixture/visual-readiness?mode=ready`
  );
  expect(readiness.ok()).toBe(true);
  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const dialog = await openNewPlaytest(page);
  await dialog.locator(VISUAL_MODE_SELECTOR).click();
  const visual = dialog.getByTestId(VISUAL_LAUNCH_TEST_ID);
  const launch = visual.locator(VISUAL_SUBMIT_SELECTOR);
  await expect(launch).toBeEnabled();
  await expect(launch).toBeInViewport();
  const launchBox = await launch.boundingBox();
  expect(launchBox).not.toBeNull();
  expect(launchBox!.y + launchBox!.height).toBeLessThanOrEqual(844);
  await expect(
    visual.getByTestId("visual-approved-budget-details").locator("summary")
  ).toBeVisible();
});

test("visual Play submits the approved focus and budget without starting a game in the synthetic fixture", async ({
  page,
  request
}) => {
  const readiness = await request.get(
    `${FIXTURE_BASE_URL}/fixture/visual-readiness?mode=ready`
  );
  expect(readiness.ok()).toBe(true);
  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const dialog = await openNewPlaytest(page);
  const visual = dialog.getByTestId(VISUAL_LAUNCH_TEST_ID);
  await expect(dialog.locator(VISUAL_MODE_SELECTOR)).toHaveAttribute(
    MODE_STATUS_ATTRIBUTE,
    "ready"
  );
  await expect(visual.locator("#visual-focus-textarea")).toHaveValue(
    VISUAL_FOCUS_PLACEHOLDER_PATTERN
  );
  await expect(visual).toContainText("Explore the Game");
  const readinessDetails = dialog.getByTestId("visual-readiness-details");
  await readinessDetails.locator("summary").click();
  const approvedTargets = readinessDetails.getByRole("list", {
    name: "Approved visual targets"
  });
  await expect(approvedTargets).toContainText(VISUAL_TARGET_NAME);
  await expect(approvedTargets).toContainText(
    "revision 1 · approval visual-fixture-approval"
  );
  await expect(visual.getByTestId("visual-target-identity")).toContainText(
    VISUAL_TARGET_NAME
  );
  await expect(visual.getByTestId("visual-target-identity")).toContainText(
    "revision 1"
  );
  await expect(
    visual.getByTestId("visual-target-build-identity")
  ).toContainText("Build identity: Not observed (URL-only target)");
  const budgetDetails = visual.getByTestId("visual-approved-budget-details");
  await expect(budgetDetails).toContainText(
    "Other approved per-episode limits"
  );
  await budgetDetails.locator("summary").click();
  await expect(budgetDetails).toContainText("60,000 ms");
  await expect(budgetDetails).toContainText("Smart requests");
  await expect(budgetDetails).toContainText("Smart tokens");
  await expect(budgetDetails).toContainText("1,000");
  await expect(budgetDetails).toContainText("1 MiB");
  await visual
    .locator("#visual-focus-textarea")
    .fill("Inspect the setup menu; do not begin a race.");
  await visual.getByRole("button", { name: "2 episodes" }).click();
  await visual.getByRole("button", { name: "10 steps" }).click();
  const launch = visual.locator(VISUAL_SUBMIT_SELECTOR);
  await expect(launch).toBeEnabled();
  const submittedRequest = page.waitForRequest(
    (candidate) =>
      candidate.url().includes(RUNS_ENDPOINT_PATH) &&
      candidate.method() === "POST"
  );
  await launch.click();
  const submitted = await submittedRequest;
  const encoded = new URLSearchParams(submitted.postData() ?? "").get(
    "launchRequest"
  );
  const launchRequest = JSON.parse(encoded ?? "null") as Record<
    string,
    unknown
  >;
  expect(launchRequest).toMatchObject({
    mode: "autonomous-visual",
    workspaceId: FIXTURE_WORKSPACE_ID,
    targetId: VISUAL_TARGET_NAME,
    policyId: "smart-direct",
    areasOfFocus: "Inspect the setup menu; do not begin a race.",
    capabilityRevision: "e".repeat(64),
    limits: {
      episodeCount: 2,
      maxStepsPerEpisode: 10,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 4,
      smartTokensPerEpisode: 1000,
      screenshotCountPerEpisode: 10,
      artifactBytesPerEpisode: 1_048_576
    }
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "Synthetic launch request captured; no browser or game was started."
  );
});

test("visual Play can Watch its exact pending session after a refreshed active-run read", async ({
  page,
  request
}) => {
  const readiness = await request.get(
    `${FIXTURE_BASE_URL}/fixture/visual-readiness?mode=run`
  );
  expect(readiness.ok()).toBe(true);
  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const dialog = await openNewPlaytest(page);
  await expect(dialog.locator(VISUAL_MODE_SELECTOR)).toHaveAttribute(
    MODE_STATUS_ATTRIBUTE,
    "ready"
  );
  const readinessDetails = dialog.getByTestId("visual-readiness-details");
  await readinessDetails.locator("summary").click();
  await expect(readinessDetails).toContainText(VISUAL_TARGET_NAME);
  await expect(readinessDetails).toContainText(
    "approval visual-fixture-approval"
  );
  const visual = dialog.getByTestId(VISUAL_LAUNCH_TEST_ID);
  await visual.locator(VISUAL_SUBMIT_SELECTOR).click();

  const expectedEpisodeId = "ep-visual-live-001-vis-assign-visual-live-001-0";
  const liveLinks = page.getByTestId(LIVE_SESSION_LINKS_TEST_ID);
  const watchLink = liveLinks.getByRole("link", {
    name: WATCH_SESSION_LINK_NAME
  });
  await expect(watchLink).toBeVisible();
  const exactHref = await watchLink.getAttribute("href");
  expect(exactHref).not.toBeNull();
  const parsedHref = new URL(exactHref!, page.url());
  expect(parsedHref.pathname).toBe(
    `/playtesting/sessions/${expectedEpisodeId}`
  );
  expect(parsedHref.searchParams.get("workspaceId")).toBe(FIXTURE_WORKSPACE_ID);
  expect(parsedHref.searchParams.get("liveBatch")).toBe(
    "batch-visual-live-001"
  );
  await expect(page).toHaveURL(LIVE_BATCH_URL_PATTERN);

  // A hard refresh drops the immediate start receipt; the exact link must
  // reappear from the workspace-scoped active-runs response alone.
  await page.reload();
  const refreshedLink = page
    .getByTestId(LIVE_SESSION_LINKS_TEST_ID)
    .getByRole("link", { name: WATCH_SESSION_LINK_NAME });
  await expect(refreshedLink).toBeVisible();
  await expect(refreshedLink).toHaveAttribute("href", exactHref!);
  await refreshedLink.click();

  const pending = page.getByTestId("session-pending-state");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("Session Initializing");
  await expect(pending).toContainText(expectedEpisodeId);
  await expect(pending).toContainText(
    "Waiting for initial frames and telemetry"
  );
});

test("visual session debrief shows frozen focus and target without claiming objective completion", async ({
  page
}) => {
  await page.goto(
    `/playtesting/sessions/${VISUAL_DEBRIEF_EPISODE_ID}?workspaceId=${encodeURIComponent(FIXTURE_WORKSPACE_ID)}`
  );
  const debrief = page.getByTestId("visual-player-debrief");
  await expect(debrief).toBeVisible();
  await expect(debrief).toContainText(
    "Explore the setup menu without starting a race."
  );
  await expect(debrief).toContainText(VISUAL_TARGET_NAME);
  await expect(debrief).toContainText("visual-fixture-approval");
  await expect(debrief).toContainText("revision 1");
  await expect(debrief).toContainText("Browser build identity");
  await expect(debrief).toContainText("Not observed");
  await expect(debrief).toContainText("URL-only target");
  await expect(debrief).toContainText("Not independently verified");
  await expect(debrief).toContainText("Inspect the setup menu.");
  await expect(debrief).toContainText("Visible setup controls");
  await expect(debrief).toContainText("Starting a race");
  await expect(debrief).toContainText("Stop at the setup menu.");
  await expect(debrief).toContainText("synthetic-fixture-model");
  const frame = page.getByAltText("Captured live visual frame at step 0");
  await expect(frame).toBeVisible();
  await expect(frame).toHaveJSProperty("naturalWidth", 1);
  await expect(
    page.getByTestId("spectator-analyst-dispatch-form")
  ).toBeVisible();
  const traceLink = debrief.getByRole("link", {
    name: "Open trace step 0"
  });
  await expect(traceLink).toHaveAttribute(
    "href",
    VISUAL_DEBRIEF_STEP_0_PATTERN
  );
  await expect(page.getByText("Verified bug", { exact: true })).toHaveCount(0);
});

test("mobile visual player debrief keeps all provenance facts within the viewport", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/playtesting/sessions/${VISUAL_DEBRIEF_EPISODE_ID}?workspaceId=${encodeURIComponent(FIXTURE_WORKSPACE_ID)}`
  );
  const debrief = page.getByTestId("visual-player-debrief");
  await expect(debrief).toBeVisible();
  await expect(
    debrief.getByRole("heading", { name: "Player debrief" })
  ).toBeVisible();
  await expect(
    debrief.locator('[data-debrief-fact="Interpreted objective"]')
  ).toContainText("Inspect the setup menu.");
  await expect(
    debrief.locator('[data-debrief-fact="Report source"]')
  ).toContainText("synthetic-fixture-model");
  const box = await debrief.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(
    await debrief.evaluate(
      (element) => element.scrollWidth > element.clientWidth
    )
  ).toBe(false);
});

test("visual session Analyze dispatch sends the selected session and shows its discovery packet receipt", async ({
  page
}) => {
  // Intercept the same-origin route so this asserts Console request/receipt UX only.
  let postedBody: string | null = null;
  await page.route("**/api/playtesting/analyses", async (route) => {
    postedBody = route.request().postData() ?? null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "ok",
        data: {
          schema: "autodev-control-playtesting-analysis-v1",
          operation: "dispatch",
          workspaceId: FIXTURE_WORKSPACE_ID,
          requested: 1,
          packets: [
            {
              episodeId: VISUAL_DEBRIEF_EPISODE_ID,
              batchId: "batch-visual-debrief",
              packetId: "packet-visual-debrief-fixture"
            }
          ],
          receipts: [],
          budget: [],
          analysis: null
        }
      })
    });
  });
  await page.goto(
    `/playtesting/sessions/${VISUAL_DEBRIEF_EPISODE_ID}?workspaceId=${encodeURIComponent(FIXTURE_WORKSPACE_ID)}`
  );
  const form = page.getByTestId("spectator-analyst-dispatch-form");
  await expect(form).toBeVisible();
  await form
    .getByRole("button", { name: "Analyze with Playtest Analyst" })
    .click();
  await expect(
    form.getByRole("button", { name: "Analysis Dispatched" })
  ).toBeVisible();
  await expect(form.getByTestId("analyst-dispatch-receipt")).toContainText(
    "Packet: packet-visual-debrief-fixture"
  );
  const requestBody = new URLSearchParams(postedBody ?? "");
  expect(requestBody.get("workspaceId")).toBe(FIXTURE_WORKSPACE_ID);
  expect(JSON.parse(requestBody.get("episodeIds") ?? "null")).toEqual([
    VISUAL_DEBRIEF_EPISODE_ID
  ]);
});

test("Playtesting overview waits for Data schema readiness before reading results", async ({
  page,
  request
}) => {
  const configured = await request.post(
    `${FIXTURE_BASE_URL}/fixture/readiness?pendingPolls=1`
  );
  expect(configured.ok()).toBe(true);

  await page.goto(PLAYTESTING_OVERVIEW_URL, { waitUntil: "networkidle" });
  const initialTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  const readinessPanel = page.locator('[data-status="initializing"]');
  await expect(
    readinessPanel.getByRole("heading", {
      name: "Playtesting data is starting up"
    })
  ).toBeVisible();
  await expect(page.getByText("Latest result")).toBeVisible({
    timeout: 20_000
  });
  await expect(readinessPanel).toHaveCount(0);
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
    initialTimeOrigin
  );
  expect(new URL(page.url()).searchParams.get("workspaceId")).toBe(
    FIXTURE_WORKSPACE_ID
  );
});

test("direct session links wait for Data schema readiness before loading evidence", async ({
  page,
  request
}) => {
  const configured = await request.post(
    `${FIXTURE_BASE_URL}/fixture/readiness?pendingPolls=1`
  );
  expect(configured.ok()).toBe(true);

  const findingId = "finding-" + "a".repeat(64);
  const sessionUrl =
    "/playtesting/sessions/episode-17?view=findings&workspaceId=fixture%2Fgame&severity=major&step=2&returnFinding=" +
    findingId;
  await page.goto(sessionUrl, { waitUntil: "networkidle" });
  const initialTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  const readinessPanel = page.locator('[data-status="initializing"]');
  await expect(
    readinessPanel.getByRole("heading", {
      name: "Playtesting data is starting up"
    })
  ).toBeVisible();
  await expect(page.getByText("Execution status", { exact: true })).toBeVisible(
    {
      timeout: 20_000
    }
  );
  await expect(readinessPanel).toHaveCount(0);
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
    initialTimeOrigin
  );
  expect(new URL(page.url()).searchParams.get("workspaceId")).toBe(
    FIXTURE_WORKSPACE_ID
  );
});

test("a loop-guard stop opens its unexecuted trace decision with the reason in view", async ({
  page
}) => {
  await page.goto(
    "/playtesting/sessions/episode-loop-guard?workspaceId=fixture%2Fgame",
    { waitUntil: "networkidle" }
  );
  const explanation = page.getByTestId("playtesting-truncation-explanation");
  await expect(explanation).toContainText(
    "loop guard stopped at step 3 after the same player-visible state and action repeated"
  );
  await expect(explanation).toContainText("That action was not executed");
  const stopStep = page.locator('[data-playtest-step="3"]');
  await expect(stopStep).toHaveAttribute("aria-current", "step");
  const stepDetails = stopStep.locator('[data-playtest-step-details="3"]');
  await expect(stepDetails).toHaveJSProperty("open", true);
  await expect(
    stepDetails.locator('[data-playtest-json="true"]')
  ).toHaveJSProperty("open", false);
  await expect(
    page.getByRole("link", { name: "Inspect stop at step 3" })
  ).toHaveAttribute("href", STOP_STEP_3_PATTERN);
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
  const initialTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole("button", { name: "Retry initialization" }).click();
  await expect(page.getByText("Latest result")).toBeVisible({
    timeout: 20_000
  });
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
    initialTimeOrigin
  );
  expect(new URL(page.url()).searchParams.get("workspaceId")).toBe(
    FIXTURE_WORKSPACE_ID
  );
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
  await expect(
    page.getByText("Execution status", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Game outcome", { exact: true })).toBeVisible();
  // The outcome badge reads the word, not the stored token: "Loss", not
  // "LOSS". Every other badge in the Console is sentence case, and the
  // vocabulary layer owns this one too.
  await expect(page.getByText("Loss", { exact: true })).toBeVisible();
  await expect(
    page.locator('pre[aria-label="Recorded data for step 2"]')
  ).toContainText("event-2");
  const frame = page.getByRole("img", {
    name: "Recorded game frame 1 at step 1"
  });
  await expect(frame).toBeVisible();
  await expect(frame).toHaveJSProperty("naturalWidth", 1);
  await expect(
    page
      .getByTestId("analyst-hypotheses-list")
      .getByText("A warning event was recorded at the cited step.")
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

test("session List/Grid preference is shareable and restored by Back", async ({
  page
}) => {
  await page.goto("/playtesting?view=sessions&workspaceId=fixture%2Fgame");
  const firstSession = page.locator('[data-session-row="episode-17"]');
  await expect(firstSession).toContainText("Adapter-accelerated");
  await expect(firstSession).toContainText("Verified aaaaaaaaaaaa");
  const list = page.getByRole("button", { name: "List view" });
  const grid = page.getByRole("button", { name: "Grid view" });
  await expect(list).toHaveAttribute(PRESSED_ATTRIBUTE, PRESSED_VALUE);
  await grid.click();
  await expect(grid).toHaveAttribute(PRESSED_ATTRIBUTE, PRESSED_VALUE);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("layout"))
    .toBe("grid");
  await page.reload();
  await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    PRESSED_ATTRIBUTE,
    PRESSED_VALUE
  );
  await page.getByRole("button", { name: "List view" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.has("layout"))
    .toBe(false);
  await page.goBack();
  await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    PRESSED_ATTRIBUTE,
    PRESSED_VALUE
  );
  await expect
    .poll(() => new URL(page.url()).searchParams.get("layout"))
    .toBe("grid");
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
  const run = nav.getByRole("link", { name: "Overview" });
  await run.focus();
  await page.keyboard.press("Tab");
  await expect(nav.getByRole("link", { name: "Sessions" })).toBeFocused();
  await page
    .locator("summary")
    .filter({ hasText: FILTERS_SUMMARY_PATTERN })
    .click();
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
    page.getByRole("form", { name: APPROVAL_FORM_NAME })
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
  const dialog = await openNewPlaytest(page);
  await expect(dialog.getByTestId("playtesting-build-context")).toContainText(
    "new commits do not need separate approval"
  );
  await expect(dialog.locator(ADAPTER_MODE_SELECTOR)).toHaveAttribute(
    MODE_STATUS_ATTRIBUTE,
    "ready"
  );
  await expect(dialog.locator(ADAPTER_MODE_SELECTOR)).toContainText(
    "Ready to run"
  );
  const form = page.getByRole("form", {
    name: RUN_FORM_NAME
  });
  await form.getByText(CUSTOMIZE_RUN_LABEL).click();
  await form.getByText(BATCH_TIME_ANALYSIS_LABEL).click();
  await expect(form.getByText(MAX_BUDGET_PREVIEW_PATTERN)).toBeVisible();
  await form.getByLabel("Additional assignments").fill("999");
  await form.getByRole("button", { name: "Generate assignments" }).click();
  await expect(form.getByRole("group", { name: "Session 10" })).toBeVisible();
  await expect(form.getByRole("group", { name: "Session 11" })).toHaveCount(0);
  await expect(
    form.getByRole("button", { name: "Show 990 more sessions" })
  ).toBeVisible();
  await expect(
    form.getByRole("button", { name: "Add session" })
  ).toBeDisabled();
  const submit = form.getByRole("button", {
    name: "Start 1000 adapter playtests"
  });
  await expect(submit).toBeEnabled();
  await submit.click();

  const runStatus = page.getByRole("region", {
    name: RUN_STATUS_REGION_NAME
  });
  await expect(runStatus).toBeVisible();
  const completedRun = runStatus.getByTestId(ACTIVE_RUN_TEST_ID).first();
  await expect(completedRun).toHaveAttribute(
    RUN_STATUS_ATTRIBUTE,
    COMPLETED_STATUS
  );
  await expect(
    completedRun.getByText("Completed", { exact: true }).first()
  ).toBeVisible();
  await expect(completedRun).toContainText(
    "1000 of 1000 assignments have a terminal result"
  );
  const assignmentDetails = completedRun.getByTestId(
    "playtesting-assignment-outcomes-disclosure"
  );
  await expect(assignmentDetails).toContainText("Assignment outcomes (1000)");
  await expect(assignmentDetails).toHaveJSProperty("open", false);
  await expect(
    assignmentDetails.getByTestId(ASSIGNMENT_OUTCOME_TEST_ID)
  ).toHaveCount(10);
  await expect(
    assignmentDetails.getByTestId(ASSIGNMENT_OUTCOME_TEST_ID).first()
  ).toBeHidden();
  await assignmentDetails.locator("summary").click();
  await expect(
    assignmentDetails.getByTestId(ASSIGNMENT_OUTCOME_TEST_ID).first()
  ).toBeVisible();
  await assignmentDetails
    .getByRole("button", { name: "Show all 990 more results" })
    .click();
  await expect(
    assignmentDetails.getByTestId(ASSIGNMENT_OUTCOME_TEST_ID)
  ).toHaveCount(1000);

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
  await openNewPlaytest(page);
  const form = page.getByRole("form", {
    name: RUN_FORM_NAME
  });
  await expect(form).toBeVisible();
  await expect(
    form.getByRole("button", { name: START_SINGLE_RUN_LABEL })
  ).toBeInViewport();
  await form.getByText(CUSTOMIZE_RUN_LABEL).click();
  await form.getByText(BATCH_TIME_ANALYSIS_LABEL).click();
  await expect(form.getByText(BUDGET_PREVIEW_PATTERN)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWidth = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  expect(mobileWidth.document).toBeLessThanOrEqual(mobileWidth.viewport);
  await page.getByRole("button", { name: "Close new playtest dialog" }).click();
  await page.goto(PLAYTESTING_OVERVIEW_URL);
  await openNewPlaytest(page);
  await expect(
    form.getByRole("button", { name: START_SINGLE_RUN_LABEL })
  ).toBeInViewport();
  await form.getByText(CUSTOMIZE_RUN_LABEL).click();
  await form.getByText(BATCH_TIME_ANALYSIS_LABEL).click();
  await page.getByRole("button", { name: "Close new playtest dialog" }).click();
  const collapseSidebar = page.getByRole("button", {
    name: "Collapse sidebar"
  });
  if (await collapseSidebar.isVisible()) await collapseSidebar.click();
  await openNewPlaytest(page);
  const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  await form
    .getByRole("group", { name: "Session 1" })
    .getByLabel("Seed")
    .fill("hold-1");
  await form.getByLabel("Additional assignments").fill("1");
  await form.getByRole("button", { name: "Generate assignments" }).click();
  await expect(
    form.getByRole("group", { name: "Session 2" }).getByLabel("Seed")
  ).toHaveValue("seed-2");
  await form
    .getByRole("group", { name: "Session 2" })
    .getByLabel("Seed")
    .fill("hold-1");
  await expect(
    form.getByRole("group", { name: "Session 1" }).getByRole("alert")
  ).toHaveText(
    "Scenario, policy, and seed must identify a unique session in this batch."
  );
  await expect(
    form.getByRole("button", { name: RUN_TWO_ASSIGNMENTS_LABEL })
  ).toBeDisabled();
  await form
    .getByRole("group", { name: "Session 2" })
    .getByLabel("Seed")
    .fill("hold-2");
  await expect(
    form.getByRole("button", { name: RUN_TWO_ASSIGNMENTS_LABEL })
  ).toBeEnabled();
  const startRequest = page.waitForRequest(
    (candidate) =>
      candidate.url().includes(RUNS_ENDPOINT_PATH) &&
      candidate.method() === "POST"
  );
  await form.getByRole("button", { name: RUN_TWO_ASSIGNMENTS_LABEL }).click();
  const submitted = await startRequest;
  const submittedLaunch = JSON.parse(
    new URLSearchParams(submitted.postData() ?? "").get("launchRequest") ??
      "null"
  ) as {
    readonly mode: string;
    readonly capabilityRevision: string;
    readonly operation: {
      readonly assignments: readonly { readonly seed: string }[];
    };
  };
  expect(submittedLaunch.mode).toBe("adapter-accelerated");
  expect(submittedLaunch.capabilityRevision).toBe("e".repeat(64));
  const submittedAssignments = submittedLaunch.operation.assignments;
  expect(submittedAssignments.map((assignment) => assignment.seed)).toEqual([
    "hold-1",
    "hold-2"
  ]);
  const runStatus = page.getByRole("region", {
    name: RUN_STATUS_REGION_NAME
  });
  await expect(runStatus).toBeVisible();
  const firstRun = runStatus.getByTestId(ACTIVE_RUN_TEST_ID).first();
  const cancelledBatchId = await firstRun.getAttribute(BATCH_ID_ATTRIBUTE);
  expect(cancelledBatchId).toMatch(BROWSER_BATCH_ID_PATTERN);
  await expect(firstRun).toContainText("Runtime accepted 2 assignments");
  await expect(firstRun.getByText("Running", { exact: true })).toBeVisible();
  const confirmedStatus = await page.evaluate(async (batchId) => {
    const response = await fetch(
      `/api/playtesting/runs/${encodeURIComponent(batchId)}?workspaceId=fixture%2Fgame`
    );
    const payload = (await response.json()) as {
      readonly kind?: string;
      readonly data?: { readonly run?: { readonly status?: string } };
    };
    return {
      httpStatus: response.status,
      runStatus: payload.data?.run?.status
    };
  }, cancelledBatchId);
  expect(confirmedStatus).toEqual({ httpStatus: 200, runStatus: "running" });

  page.once("dialog", (dialog) => void dialog.accept());
  const cancellation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      CANCEL_RUN_ROUTE_PATTERN.test(response.url())
  );
  await page.getByRole("button", { name: "Cancel batch" }).click();
  const cancellationResponse = await cancellation;
  expect(cancellationResponse.status()).toBe(202);
  // The shared status owner confirms the terminal state without a manual
  // refresh; the transient "requested" notice is not the confirmation.
  await expect(firstRun).toHaveAttribute(
    RUN_STATUS_ATTRIBUTE,
    CANCELLED_STATUS
  );
  await expect(
    firstRun.getByText("Cancelled", { exact: true }).first()
  ).toBeVisible();
  await expect(
    runStatus.getByText("Cancellation: Operator requested cancellation.", {
      exact: true
    })
  ).toBeVisible();

  await openNewPlaytest(page);
  await form
    .getByRole("group", { name: "Session 1" })
    .getByLabel("Seed")
    .fill("complete-1");
  await form
    .getByRole("group", { name: "Session 2" })
    .getByLabel("Seed")
    .fill("complete-2");
  await form.getByRole("button", { name: RUN_TWO_ASSIGNMENTS_LABEL }).click();
  const completedRun = runStatus.getByTestId(ACTIVE_RUN_TEST_ID).first();
  await expect(completedRun).not.toHaveAttribute(
    BATCH_ID_ATTRIBUTE,
    cancelledBatchId ?? ""
  );
  const completedBatchId = await completedRun.getAttribute(BATCH_ID_ATTRIBUTE);
  expect(completedBatchId).toMatch(BROWSER_BATCH_ID_PATTERN);
  await expect(completedRun).toHaveAttribute(
    RUN_STATUS_ATTRIBUTE,
    COMPLETED_STATUS
  );
  await expect(
    completedRun.getByText("Completed", { exact: true }).first()
  ).toBeVisible();
  await expect(completedRun).toHaveAttribute("data-focused", "true");
  await expect(
    completedRun.getByTestId("playtesting-run-progress")
  ).toBeVisible();
  const assignmentDisclosure = completedRun.getByTestId(
    "playtesting-assignment-outcomes-disclosure"
  );
  await assignmentDisclosure.locator("summary").click();
  const assignmentOutcomes = assignmentDisclosure.getByRole("region", {
    name: "Assignment outcomes"
  });
  await expect(assignmentOutcomes).toContainText("Execution state: completed");
  await expect(assignmentOutcomes).toContainText("Game outcome: Not observed");
  await expect(
    assignmentOutcomes.getByRole("link", {
      name: `Open session ${completedBatchId}.a-0001`
    })
  ).toBeVisible();
  await expect(
    assignmentOutcomes.getByRole("link", {
      name: `Open session ${completedBatchId}.a-0002`
    })
  ).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(
    documentTimeOrigin
  );
});

test("a lost start acknowledgement recovers the same requestId without creating a duplicate batch", async ({
  page,
  request
}) => {
  const approvalForm = await fillSyntheticApprovalForm(page);
  await approvalForm.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(ACTIVE_APPROVAL_SELECTOR)).toBeVisible();
  const failAcknowledgement = await request.post(
    `${FIXTURE_BASE_URL}/fixture/run-ack-failure?mode=once`
  );
  expect(failAcknowledgement.ok()).toBe(true);

  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const dialog = await openNewPlaytest(page);
  await dialog.getByRole("button", { name: START_SINGLE_RUN_LABEL }).click();
  const pending = page.getByRole("region", {
    name: PENDING_REQUEST_REGION_NAME
  });
  await expect(pending).toBeVisible();
  const requestId = await pending.getAttribute(REQUEST_ID_ATTRIBUTE);
  expect(requestId).toMatch(REQUEST_ID_PATTERN);
  const recoveryTab = await page.context().newPage();
  await recoveryTab.goto(PLAYTESTING_OVERVIEW_URL);
  await openNewPlaytest(recoveryTab);
  let restoredPending = recoveryTab.getByRole("region", {
    name: PENDING_REQUEST_REGION_NAME
  });
  await expect(restoredPending).toHaveAttribute(
    REQUEST_ID_ATTRIBUTE,
    requestId!
  );
  await recoveryTab.reload();
  await openNewPlaytest(recoveryTab);
  restoredPending = recoveryTab.getByRole("region", {
    name: PENDING_REQUEST_REGION_NAME
  });
  await expect(restoredPending).toHaveAttribute(
    REQUEST_ID_ATTRIBUTE,
    requestId!
  );
  const firstCountResponse = await request.get(
    `${FIXTURE_BASE_URL}/fixture/run-count`
  );
  expect(await firstCountResponse.json()).toEqual({ count: 1 });

  await restoredPending
    .getByRole("button", { name: "Check request status" })
    .click();
  const runStatus = recoveryTab.getByRole("region", {
    name: RUN_STATUS_REGION_NAME
  });
  await expect(runStatus).toBeVisible();
  const recoveredRun = runStatus.getByTestId(ACTIVE_RUN_TEST_ID).first();
  await expect(recoveredRun).toHaveAttribute(
    BATCH_ID_ATTRIBUTE,
    BROWSER_BATCH_ID_PATTERN
  );
  await expect(recoveredRun).toHaveAttribute(
    RUN_STATUS_ATTRIBUTE,
    COMPLETED_STATUS
  );
  const finalCountResponse = await request.get(
    `${FIXTURE_BASE_URL}/fixture/run-count`
  );
  expect(await finalCountResponse.json()).toEqual({ count: 1 });
});

test("a Visual retry after a transient not-found reuses the exact request and recovers its Watch session", async ({
  page,
  request
}) => {
  const readiness = await request.get(
    `${FIXTURE_BASE_URL}/fixture/visual-readiness?mode=run`
  );
  expect(readiness.ok()).toBe(true);
  const failAcknowledgement = await request.post(
    `${FIXTURE_BASE_URL}/fixture/run-ack-failure?mode=once`
  );
  expect(failAcknowledgement.ok()).toBe(true);

  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const dialog = await openNewPlaytest(page);
  await expect(dialog.locator(VISUAL_MODE_SELECTOR)).toHaveAttribute(
    MODE_STATUS_ATTRIBUTE,
    "ready"
  );
  const visual = dialog.getByTestId(VISUAL_LAUNCH_TEST_ID);
  const postStart = page.waitForRequest(
    (candidate) =>
      candidate.url().includes(RUNS_ENDPOINT_PATH) &&
      candidate.method() === "POST"
  );
  await visual.locator(VISUAL_SUBMIT_SELECTOR).click();
  const submitted = await postStart;
  const submittedPayload = new URLSearchParams(submitted.postData() ?? "").get(
    "launchRequest"
  );

  let pending = page.getByRole("region", { name: PENDING_REQUEST_REGION_NAME });
  await expect(pending).toBeVisible();
  const requestId = await pending.getAttribute(REQUEST_ID_ATTRIBUTE);
  expect(requestId).toMatch(REQUEST_ID_PATTERN);
  const firstLaunch = JSON.parse(submittedPayload ?? "null") as Record<
    string,
    unknown
  >;
  expect(firstLaunch.requestId).toBe(requestId);
  const firstCount = await request.get(`${FIXTURE_BASE_URL}/fixture/run-count`);
  expect(await firstCount.json()).toEqual({ count: 1 });
  const transientNotFound = await request.post(
    `${FIXTURE_BASE_URL}/fixture/run-by-request-not-found?mode=once`
  );
  expect(transientNotFound.ok()).toBe(true);

  await page.reload();
  const restoredDialog = await openNewPlaytest(page);
  pending = restoredDialog.getByRole("region", {
    name: PENDING_REQUEST_REGION_NAME
  });
  await expect(pending).toHaveAttribute(REQUEST_ID_ATTRIBUTE, requestId!);
  const lookupRequest = page.waitForRequest(
    (candidate) =>
      candidate.url().includes("/api/playtesting/runs/by-request") &&
      candidate.method() === "GET"
  );
  await pending.getByRole("button", { name: "Check request status" }).click();
  const lookupResponse = await lookupRequest;
  const lookupResponseUrl = lookupResponse.url();
  expect(new URL(lookupResponseUrl).searchParams.get("requestId")).toBe(
    requestId
  );
  await expect(page.getByRole("status")).toContainText(
    "Runtime has no receipt for this requestId. Retrying the exact saved payload is safe."
  );
  const retryPost = page.waitForRequest(
    (candidate) =>
      candidate.url().includes(RUNS_ENDPOINT_PATH) &&
      candidate.method() === "POST"
  );
  await pending.getByRole("button", { name: "Retry same request" }).click();
  const retried = await retryPost;
  const retriedPayload = new URLSearchParams(retried.postData() ?? "").get(
    "launchRequest"
  );
  const secondLaunch = JSON.parse(retriedPayload ?? "null") as Record<
    string,
    unknown
  >;
  expect(secondLaunch.requestId).toBe(requestId);
  expect(secondLaunch).toEqual(firstLaunch);

  const expectedEpisodeId = "ep-visual-live-001-vis-assign-visual-live-001-0";
  const watchLink = page
    .getByTestId(LIVE_SESSION_LINKS_TEST_ID)
    .getByRole("link", { name: WATCH_SESSION_LINK_NAME });
  await expect(watchLink).toBeVisible();
  await expect(watchLink).toHaveAttribute(
    "href",
    new RegExp(String.raw`/playtesting/sessions/${expectedEpisodeId}\?`, "u")
  );
  await expect(page).toHaveURL(VISUAL_LIVE_BATCH_URL_PATTERN);
  const recoveredCount = await request.get(
    `${FIXTURE_BASE_URL}/fixture/run-count`
  );
  expect(await recoveredCount.json()).toEqual({ count: 1 });
});

test("a lost Visual Play acknowledgement recovers an accepted request and Watch session after reload", async ({
  page,
  request
}) => {
  const readiness = await request.get(
    `${FIXTURE_BASE_URL}/fixture/visual-readiness?mode=run`
  );
  expect(readiness.ok()).toBe(true);
  const failAcknowledgement = await request.post(
    `${FIXTURE_BASE_URL}/fixture/run-ack-failure?mode=once`
  );
  expect(failAcknowledgement.ok()).toBe(true);

  await page.goto(PLAYTESTING_OVERVIEW_URL);
  const dialog = await openNewPlaytest(page);
  await expect(dialog.locator(VISUAL_MODE_SELECTOR)).toHaveAttribute(
    MODE_STATUS_ATTRIBUTE,
    "ready"
  );
  const visual = dialog.getByTestId(VISUAL_LAUNCH_TEST_ID);
  const postStart = page.waitForRequest(
    (candidate) =>
      candidate.url().includes(RUNS_ENDPOINT_PATH) &&
      candidate.method() === "POST"
  );
  await visual.locator(VISUAL_SUBMIT_SELECTOR).click();
  const submitted = await postStart;
  const submittedPayload = new URLSearchParams(submitted.postData() ?? "").get(
    "launchRequest"
  );
  const requestId = JSON.parse(submittedPayload ?? "null").requestId as string;

  let pending = page.getByRole("region", { name: PENDING_REQUEST_REGION_NAME });
  await expect(pending).toHaveAttribute(REQUEST_ID_ATTRIBUTE, requestId);
  const firstCount = await request.get(`${FIXTURE_BASE_URL}/fixture/run-count`);
  expect(await firstCount.json()).toEqual({ count: 1 });

  await page.reload();
  const restoredDialog = await openNewPlaytest(page);
  pending = restoredDialog.getByRole("region", {
    name: PENDING_REQUEST_REGION_NAME
  });
  await expect(pending).toHaveAttribute(REQUEST_ID_ATTRIBUTE, requestId);
  const lookupRequest = page.waitForRequest(
    (candidate) =>
      candidate.url().includes("/api/playtesting/runs/by-request") &&
      candidate.method() === "GET"
  );
  await pending.getByRole("button", { name: "Check request status" }).click();
  const lookupResponse = await lookupRequest;
  const lookupResponseUrl = lookupResponse.url();
  expect(new URL(lookupResponseUrl).searchParams.get("requestId")).toBe(
    requestId
  );

  const expectedEpisodeId = "ep-visual-live-001-vis-assign-visual-live-001-0";
  const watchLink = page
    .getByTestId(LIVE_SESSION_LINKS_TEST_ID)
    .getByRole("link", { name: WATCH_SESSION_LINK_NAME });
  await expect(watchLink).toBeVisible();
  await expect(watchLink).toHaveAttribute(
    "href",
    new RegExp(String.raw`/playtesting/sessions/${expectedEpisodeId}\?`, "u")
  );
  await expect(page).toHaveURL(VISUAL_LIVE_BATCH_URL_PATTERN);
  const recoveredCount = await request.get(
    `${FIXTURE_BASE_URL}/fixture/run-count`
  );
  expect(await recoveredCount.json()).toEqual({ count: 1 });
});

test("operator can start, watch, and analyze a completed session from the same Console flow", async ({
  page,
  request
}) => {
  const approvalForm = await fillSyntheticApprovalForm(page);
  await approvalForm.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(ACTIVE_APPROVAL_SELECTOR)).toBeVisible();

  await page.goto(PLAYTESTING_OVERVIEW_URL);
  await openNewPlaytest(page);
  const runForm = page.getByRole("form", {
    name: RUN_FORM_NAME
  });
  await runForm.getByRole("button", { name: START_SINGLE_RUN_LABEL }).click();
  const runStatus = page.getByRole("region", {
    name: RUN_STATUS_REGION_NAME
  });
  await expect(runStatus).toBeVisible();
  const runRow = runStatus.getByTestId(ACTIVE_RUN_TEST_ID).first();
  const batchId = await runRow.getAttribute(BATCH_ID_ATTRIBUTE);
  expect(batchId).toMatch(BROWSER_BATCH_ID_PATTERN);
  await expect(runRow).toHaveAttribute(RUN_STATUS_ATTRIBUTE, COMPLETED_STATUS);
  await expect(
    runRow.getByText("Completed", { exact: true }).first()
  ).toBeVisible();

  const episodeId = `${batchId}.a-0001`;
  const selectedEpisodeIds = ["episode-17", episodeId];
  const assignmentDisclosure = runRow.getByTestId(
    "playtesting-assignment-outcomes-disclosure"
  );
  await assignmentDisclosure.locator("summary").click();
  await expect(
    assignmentDisclosure.getByRole("link", {
      name: `Open session ${episodeId}`
    })
  ).toBeVisible();
  await page.goto("/playtesting?view=sessions&workspaceId=fixture%2Fgame");
  await page
    .getByRole("checkbox", {
      name: "Include session episode-17 in analyst review"
    })
    .check();
  await page
    .getByRole("checkbox", {
      name: `Include session ${episodeId} in analyst review`
    })
    .check();
  await expect(page.getByTestId("playtesting-selection-count")).toHaveText(
    "2 of 40 selected"
  );
  await expect(page).toHaveURL(TWO_SESSION_SELECTION_URL_PATTERN);
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
  await contributingSession.hover();
  await page.waitForTimeout(250);
  await contributingSession.click();
  await expect(page).toHaveURL(
    new RegExp(String.raw`/playtesting/sessions/${episodeId}\?`, "u")
  );
  const reviewUrl = new URL(page.url());
  expect(reviewUrl.searchParams.get("workspaceId")).toBe(FIXTURE_WORKSPACE_ID);
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
  await expect(
    page.getByRole("link", { name: "Analyze this session" })
  ).toHaveAttribute(
    "href",
    new RegExp(String.raw`view=sessions[^]*sessions=${episodeId}`, "u")
  );
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
  const statusDisclosure = page.getByTestId(
    "playtesting-run-status-disclosure"
  );
  if (
    !(await statusDisclosure.evaluate(
      (node) => (node as HTMLDetailsElement).open
    ))
  ) {
    await statusDisclosure.locator("summary").click();
  }
  const panel = page.getByRole("region", { name: RUN_STATUS_REGION_NAME });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute(
    "data-freshness",
    LIVE_OR_IDLE_FRESHNESS_PATTERN
  );

  await openNewPlaytest(page);
  const form = page.getByRole("form", {
    name: RUN_FORM_NAME
  });
  await expect(form).toBeVisible();
  await expect(
    form.getByRole("button", { name: START_SINGLE_RUN_LABEL })
  ).toBeInViewport();
  await form.getByText(CUSTOMIZE_RUN_LABEL).click();
  await form.getByLabel("Additional assignments").fill("1");
  await form.getByRole("button", { name: "Generate assignments" }).click();
  await expect(form.getByRole("group", { name: "Session 2" })).toBeVisible();
  await form
    .getByRole("group", { name: "Session 1" })
    .getByLabel("Seed")
    .fill("hold-1");
  await form
    .getByRole("group", { name: "Session 2" })
    .getByLabel("Seed")
    .fill("hold-2");
  await form.getByRole("button", { name: RUN_TWO_ASSIGNMENTS_LABEL }).click();

  // No Refresh click: the batch appears because the view polls the owner.
  const batch = panel.getByTestId(ACTIVE_RUN_TEST_ID).first();
  await expect(batch).toBeVisible();
  await expect(batch).toHaveAttribute(RUN_STATUS_ATTRIBUTE, RUNNING_STATUS);
  await expect(
    batch.getByText("Running", { exact: true }).first()
  ).toBeVisible();

  // The focused batch is address state, so refresh restores it.
  await expect(batch).toHaveAttribute("data-focused", "true");
  await expect(batch.getByTestId("playtesting-run-progress")).toBeVisible();

  // Active status exposes the owner-confirmed request and elapsed budget but
  // does not invent a completion count the Runtime has not published yet.
  await expect(batch).toContainText("Runtime accepted 2 assignments");
  await expect(batch).toContainText("Elapsed");
  await expect(batch).not.toContainText("Assignments succeeded");
  await expect(page).toHaveURL(LIVE_BATCH_URL_PATTERN);
  await page.reload();
  const reloaded = page.getByRole("region", { name: RUN_STATUS_REGION_NAME });
  await expect(
    reloaded.getByTestId(ACTIVE_RUN_TEST_ID).first()
  ).toHaveAttribute("data-focused", "true");

  // An unreadable read is an explicit state, and the last known frame is
  // labelled as last known rather than badged as current.
  const response = await request.get(
    `${FIXTURE_BASE_URL}/fixture/runs-read-fail?mode=on`
  );
  expect(response.ok()).toBe(true);
  try {
    const degraded = page.getByRole("region", { name: RUN_STATUS_REGION_NAME });
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
  await expect(run).toHaveAttribute(
    ANALYSIS_STATUS_ATTRIBUTE,
    COMPLETED_STATUS,
    {
      timeout: 15_000
    }
  );
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
  await expect(run).toHaveAttribute(
    ANALYSIS_STATUS_ATTRIBUTE,
    COMPLETED_STATUS
  );
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

test("an analyst hypothesis opens its review as addressable detail under the list", async ({
  page
}) => {
  await page.goto("/playtesting?view=findings&workspaceId=fixture%2Fgame");
  await expect(
    page.getByRole("heading", { name: FINDINGS_HEADING_NAME })
  ).toBeVisible();
  await page.waitForLoadState("networkidle");

  // The list shows the analyst's own conclusion, clamped for scanning.
  const hypothesis = page.locator("[data-review-open]").first();
  await expect(hypothesis).toBeVisible();
  await expect(hypothesis).toHaveText(REVIEW_HYPOTHESIS_TEXT);

  await hypothesis.hover();
  await page.waitForTimeout(250);
  await hypothesis.click();

  // The open review is address state: the link is shareable and Back returns
  // to it still open.
  await expect(page).toHaveURL(REVIEW_SELECTION_URL_PATTERN, {
    timeout: 20_000
  });
  const detail = page.locator(REVIEW_DETAIL_SELECTOR);
  await expect(detail).toBeVisible();
  // The detail leads the page: the panel a row opens is on screen, not four
  // thousand pixels under the row that opened it.
  const detailBox = await detail.boundingBox();
  const tableBox = await page
    .locator("[data-review-open]")
    .first()
    .boundingBox();
  expect(detailBox).not.toBeNull();
  expect(tableBox).not.toBeNull();
  expect(detailBox!.y).toBeLessThan(tableBox!.y);
  await expect(detail).toContainText(REVIEW_HYPOTHESIS_TEXT);
  await expect(detail).toContainText(REVIEW_HYPOTHESES_LABEL);
  await expect(detail).toContainText(REVIEW_OBSERVATIONS_LABEL);
  await expect(detail).toContainText(REVIEW_RECORDED_HEADING);
  await expect(detail).toContainText(REVIEW_SUMMARY_TEXT);
  await expect(detail).toContainText(REVIEW_EVIDENCE_HEADING);

  // A refresh keeps the review open: the selection is in the address, not in
  // a piece of client state that a reload would lose.
  await page.reload();
  await expect(page.locator(REVIEW_DETAIL_SELECTOR)).toBeVisible({
    timeout: 20_000
  });

  // And the close control returns to the list with the selection dropped.
  await page.getByRole("link", { name: "Close review detail" }).click();
  await expect(page).not.toHaveURL(REVIEW_SELECTION_URL_PATTERN, {
    timeout: 20_000
  });
  await expect(page.locator(REVIEW_DETAIL_SELECTOR)).toHaveCount(0);
  await expect(page.locator("[data-review-open]").first()).toBeVisible();
});

test("the overview shows what the analyst concluded, and opens it", async ({
  page
}) => {
  await page.goto("/playtesting?view=overview&workspaceId=fixture%2Fgame");
  await page.waitForLoadState("networkidle");

  // The overview counted the conclusions and showed none of them. The
  // conclusion is the reason an operator comes to this view, so it is here.
  const conclusions = page.locator("[data-overview-conclusion]");
  await expect(conclusions.first()).toBeVisible();
  await expect(conclusions.first()).toHaveText(REVIEW_HYPOTHESIS_TEXT);

  // It is a link, and it opens the review's own detail rather than a copy of
  // it somewhere else.
  await conclusions.first().click();
  await expect(page).toHaveURL(REVIEW_SELECTION_URL_PATTERN, {
    timeout: 20_000
  });
  await expect(page.locator(REVIEW_DETAIL_SELECTOR)).toBeVisible();
  await expect(page.locator(REVIEW_DETAIL_SELECTOR)).toContainText(
    REVIEW_HYPOTHESIS_TEXT
  );
});

test("a hypothesis row keeps its counts and says how to read the review", async ({
  page
}) => {
  await page.goto("/playtesting?view=findings&workspaceId=fixture%2Fgame");
  await page.waitForLoadState("networkidle");

  const row = page.locator("[data-review-row]").first();
  await expect(row).toBeVisible();
  // The counts are how a reader tells one hypothesis from six, so they are
  // on every row and not only on the rows whose conclusion was short.
  await expect(row).toContainText("Discovery review");
  await expect(row).toContainText("hypothesis");
  // The way into the review is stated.
  await expect(page.locator("[data-review-read]").first()).toBeVisible();
});
