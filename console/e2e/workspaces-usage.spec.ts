import { expect, test } from "@playwright/test";

import { documentFitsViewport } from "./acceptance-helpers.ts";

const WORKSPACES_URL = "/workspaces";
const WORKSPACE_ID = "fixture/game";
const WORKSPACE_DETAIL_URL = "/workspaces/fixture/game";
const OBSERVED_REQUESTS = "12";
const REQUESTS_ATTRIBUTE = "data-workspace-requests";
const REQUESTS_VALUE = `[${REQUESTS_ATTRIBUTE}]`;

/**
 * The Requests cell for one specific reading state.
 *
 * The attribute carries the state as its value, so the selector has to name
 * the attribute and the value together -- `[data-workspace-requests]` on its own
 * matches the cell whatever it holds, which is the opposite of what these
 * assertions ask.
 */
function requestsState(state: string): string {
  return `[${REQUESTS_ATTRIBUTE}="${state}"]`;
}

test("Workspaces reports each workspace's aggregate request count", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(WORKSPACES_URL);

  const requests = page.locator(REQUESTS_VALUE);
  await expect(requests).toHaveCount(1);
  // The count is a measurement, so it renders as the number the Usage
  // telemetry reported for this workspace.
  await expect(requests).toHaveAttribute("data-workspace-requests", "observed");
  await expect(requests).toHaveText(OBSERVED_REQUESTS);
  await expect(
    page.getByRole("link", { name: `Open workspace ${WORKSPACE_ID}` })
  ).toBeVisible();
});

test("Workspaces keeps its aggregate usage column readable at narrow and desktop widths", async ({
  page
}) => {
  await page.goto(WORKSPACES_URL);
  const table = page.locator("table");
  const expectedColumns = [
    "Repository / Workspace",
    "Base Branch",
    "Enablement",
    "Playtesting Approval",
    "Role Scope",
    "Availability",
    "Requests"
  ];
  const checkWidth = async (width: number): Promise<void> => {
    await page.setViewportSize({ width, height: 844 });
    await expect(table).toBeVisible();
    await expect(page.locator("[data-column-label]")).toHaveText(
      expectedColumns
    );

    const widths = await table.evaluate((element) => {
      const scroller = element.parentElement;
      return {
        scroller: scroller?.clientWidth ?? 0,
        table: element.scrollWidth
      };
    });
    expect(widths.table).toBeGreaterThan(0);
    if (width === 390) {
      // The table region scrolls horizontally rather than shrinking columns,
      // and the document itself never overflows.
      expect(widths.table).toBeGreaterThan(widths.scroller);
    }
    expect(await documentFitsViewport(page)).toBe(true);
  };

  await checkWidth(390);
  await checkWidth(768);
  await checkWidth(1280);
});

test("Workspaces names the reason there is no aggregate usage count", async ({
  page
}) => {
  // A Usage source the Console cannot read must not read as a workspace that
  // made no requests. The fixture answers for the workspace it knows, so the
  // Requests cell carries a measurement and never one of the two absence
  // states -- the absence states are scoped to this cell, because the rest of
  // the row legitimately renders its own (an unobserved runtime, say).
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(WORKSPACES_URL);

  await expect(page.locator(REQUESTS_VALUE)).toHaveCount(1);
  await expect(page.locator(requestsState("unavailable"))).toHaveCount(0);
  await expect(page.locator(requestsState("not-observed"))).toHaveCount(0);
  await expect(page.locator(REQUESTS_VALUE)).toHaveText(OBSERVED_REQUESTS);
});

test("the workspace detail shows the same aggregate usage the list shows", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(WORKSPACE_DETAIL_URL);

  // The detail page resolves the same reading the list row does, so the two
  // surfaces cannot drift into different vocabularies for the same fact.
  const value = page.locator(REQUESTS_VALUE);
  await expect(value).toHaveCount(1);
  await expect(value).toHaveAttribute("data-workspace-requests", "observed");
  await expect(value).toHaveText(OBSERVED_REQUESTS);
  await expect(page.getByText("Requests (24h)")).toBeVisible();
  await expect(
    page.locator('[data-section="workspace-configuration"]')
  ).toBeVisible();
  expect(await documentFitsViewport(page)).toBe(true);
});

test("the workspace detail stays inside the viewport at a narrow width", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(WORKSPACE_DETAIL_URL);

  const value = page.locator(REQUESTS_VALUE);
  await expect(value).toHaveText(OBSERVED_REQUESTS);
  await expect(value).toBeVisible();
  expect(await documentFitsViewport(page)).toBe(true);
});
