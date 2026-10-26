import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const PERMISSIONS_URL = "/permissions";
const CONFLICT_OUTCOME = "conflict";

/**
 * The permission policy's controls.
 *
 * The policy is one surface with one control per setting, so a control is
 * addressed by the setting it writes rather than by where it is rendered.
 */
function approvalPolicyControl(page: Page): Locator {
  return page.locator("[data-permission-policy-approval-policy]");
}

function networkAccessControl(page: Page): Locator {
  return page.locator("[data-permission-policy-network-access]");
}

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
  sandboxMode: string;
  approvalsReviewer: string;
  networkAccess: boolean;
  webSearch: boolean;
  revision: string;
}> {
  const response = await request.get(`${FIXTURE_BASE_URL}/control/permissions`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    revision: string;
    policy: {
      approvalPolicy: string;
      sandboxMode: string;
      approvalsReviewer: string;
      networkAccess: boolean;
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

test("the policy control writes against the revision it loaded", async ({
  page,
  request
}) => {
  await resetPermissionPolicy(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PERMISSIONS_URL);

  const approvalPolicy = approvalPolicyControl(page);
  await expect(approvalPolicy).toHaveValue("on-demand");
  await expect(networkAccessControl(page)).toHaveValue("false");

  // The write is a form submission, so the page that comes back is the
  // Runtime-confirmed value rather than an optimistic one.
  await approvalPolicy.selectOption("always");

  // The write is the Runtime's, and it lands after the browser has already
  // changed the select, so the state is polled rather than read once.
  await expect
    .poll(async () => (await readPermissionPolicy(request)).approvalPolicy)
    .toBe("always");
  const held = await readPermissionPolicy(request);
  // The revision moved with the policy, so the next write has to carry the
  // new one.
  expect(held.revision).not.toBe("9".repeat(64));
  // The settings the write did not name are the ones the policy already had.
  expect(held.sandboxMode).toBe("workspace-write");
  expect(held.approvalsReviewer).toBe("operator");
});

test("a stale policy write is refused rather than overwriting somebody else's change", async ({
  page,
  request
}) => {
  await resetPermissionPolicy(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PERMISSIONS_URL);

  const before = await readPermissionPolicy(request);

  // Somebody else writes while this page is open, so the page holds a
  // revision the Runtime has already moved past.
  const moved = await request.post(
    `${FIXTURE_BASE_URL}/fixture/permissions/state?state=revision-moved`
  );
  expect(moved.ok()).toBe(true);

  await approvalPolicyControl(page).selectOption("always");

  // The refusal says what happened: the canonical policy moved under the
  // edit, so the edit was not saved and it is still here.
  const notice = page.locator(
    `[data-permission-policy-save="${CONFLICT_OUTCOME}"]`
  );
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("changed after the control was filled");

  // And nothing was written: the policy is the one the Runtime held.
  const after = await readPermissionPolicy(request);
  expect(after.approvalPolicy).toBe(before.approvalPolicy);
  expect(after.revision).not.toBe(before.revision);
});

test("the role matrix names the sandbox each role declares", async ({
  page,
  request
}) => {
  await resetPermissionPolicy(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PERMISSIONS_URL);

  // The matrix used to answer every role but the read-only ones with
  // "workspace-write", so a role declared `danger-full-access` was shown as a
  // sandboxed one. The fixture's roles declare their own modes.
  const worker = page.locator('[data-permission-mode="read-only"]');
  await expect(worker).toHaveCount(1);
  const defaultRole = page.locator('[data-permission-mode="workspace-write"]');
  await expect(defaultRole).toHaveCount(1);
});
