import { type APIRequestContext, expect, test } from "@playwright/test";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const PERMISSIONS_URL = "/permissions";

/**
 * Put the fixture's permission policy back where a test that writes starts.
 *
 * The write is real, so the fixture keeps the policy the last write left
 * behind. This puts it back without touching the rest of the fixture's state,
 * which another session's specs also use.
 */
async function resetPermissionPolicy(
  request: APIRequestContext
): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/permissions/state?state=reset`
  );
  expect(response.ok()).toBe(true);
}

/**
 * The policy the Runtime currently holds.
 */
async function readPermissionPolicy(request: APIRequestContext): Promise<{
  approvalPolicy: string;
  approvalsReviewer: string;
  webSearch: boolean;
  revision: string;
}> {
  const response = await request.get(`${FIXTURE_BASE_URL}/control/permissions`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    revision: string;
    policy: {
      approvalPolicy: string;
      approvalsReviewer: string;
      webSearch: boolean;
    };
  };
  return { ...body.policy, revision: body.revision };
}

/**
 * Leave the fixture the way the rest of the suite finds it.
 *
 * The permission policy is shared state: another spec reads the Permissions
 * page, and this one changes it because that is the write it is making.
 */
test.afterEach(async ({ request }) => {
  await resetPermissionPolicy(request);
});

test("the permission policy is read-only and reflects an observed source revision", async ({
  page,
  request
}) => {
  await resetPermissionPolicy(request);
  const before = await readPermissionPolicy(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PERMISSIONS_URL);
  const policy = page.getByRole("region", { name: "Permission Policy" });
  await expect(
    policy.getByText(before.approvalPolicy, { exact: true })
  ).toBeVisible();
  await expect(
    policy.getByText(before.approvalsReviewer, { exact: true })
  ).toBeVisible();
  await expect(
    policy.getByText(before.webSearch ? "Enabled" : "Disabled", { exact: true })
  ).toBeVisible();
  await expect(policy.locator("form, input, select, textarea")).toHaveCount(0);
  await expect(
    policy.getByText(`revision ${before.revision.slice(0, 12)}`)
  ).toBeVisible();

  const moved = await request.post(
    `${FIXTURE_BASE_URL}/fixture/permissions/state?state=revision-moved`
  );
  expect(moved.ok()).toBe(true);
  const after = await readPermissionPolicy(request);
  expect(after.revision).not.toBe(before.revision);
  await page.reload();
  await expect(
    policy.getByText(`revision ${after.revision.slice(0, 12)}`)
  ).toBeVisible();
  expect(await readPermissionPolicy(request)).toEqual(after);
});

test("the role matrix names each role's access level", async ({
  page,
  request
}) => {
  await resetPermissionPolicy(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PERMISSIONS_URL);

  const readOnlyRoles = page.locator('[data-permission-access="read-only"]');
  await expect(readOnlyRoles).toHaveCount(1);
  const readWriteRoles = page.locator('[data-permission-access="read-write"]');
  await expect(readWriteRoles).toHaveCount(2);
});
