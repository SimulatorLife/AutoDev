import { expect, type Page, test } from "@playwright/test";

const WORKSPACES_URL = "/workspaces";
const WORKSPACE_ID = "fixture/game";
const OBSERVED_REQUESTS = "12";

function documentFitsViewport(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= globalThis.innerWidth
  );
}

test("Workspaces reports each workspace's aggregate request count", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(WORKSPACES_URL);

  const requests = page.locator("[data-workspace-requests]");
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

  await expect(page.locator("[data-workspace-requests]")).toHaveCount(1);
  await expect(
    page.locator('[data-workspace-requests="unavailable"]')
  ).toHaveCount(0);
  await expect(
    page.locator('[data-workspace-requests="not-observed"]')
  ).toHaveCount(0);
  await expect(page.locator("[data-workspace-requests]")).toHaveText(
    OBSERVED_REQUESTS
  );
});
