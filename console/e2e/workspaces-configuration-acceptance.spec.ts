import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const WORKSPACES_URL = "/workspaces";
const WORKSPACE_DETAIL_URL = "/workspaces/fixture/game";
const WORKSPACE_ID = "fixture/game";
const CONFLICT_OUTCOME = "conflict";

/**
 * The configuration control of one workspace.
 *
 * The control is the same one on the list row and on the workspace's own page,
 * so it is addressed by the workspace it acts on rather than by where it is
 * rendered.
 */
function configurationControl(page: Page): Locator {
  return page.locator(`[data-workspace-configuration="${WORKSPACE_ID}"]`);
}

/** The enablement the control writes. */
function enablementControl(page: Page): Locator {
  return page.locator(
    `[data-workspace-configuration-enabled="${WORKSPACE_ID}"]`
  );
}

/**
 * Put the fixture's workspace configuration back where a test that writes
 * starts.
 *
 * The write is real, so the fixture keeps the configuration the last write
 * left behind. This puts it back without touching the rest of the fixture's
 * state, which another session's specs also use.
 */
async function resetWorkspaceConfiguration(
  request: APIRequestContext
): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/workspaces/state?state=enabled`
  );
  expect(response.ok()).toBe(true);
}

/**
 * The configuration the Runtime currently holds for the fixture's workspace.
 */
async function readWorkspaceConfiguration(request: APIRequestContext): Promise<{
  enabled: boolean;
  baseBranch: string;
  agentRoles: string[] | null;
  revision: string;
}> {
  const response = await request.get(`${FIXTURE_BASE_URL}/control/workspaces`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    revision: string;
    workspaces: {
      id: string;
      baseBranch: string;
      enabled: boolean;
      agentRoles: string[] | null;
    }[];
  };
  const workspace = body.workspaces.find((entry) => entry.id === WORKSPACE_ID);
  expect(workspace).toBeDefined();
  return {
    enabled: workspace?.enabled ?? false,
    baseBranch: workspace?.baseBranch ?? "",
    agentRoles: workspace?.agentRoles ?? null,
    revision: body.revision
  };
}

/**
 * Leave the fixture the way the rest of the suite finds it.
 *
 * The workspace configuration is shared state: a spec that reads the
 * Workspaces list expects the workspace to be enabled, and this one leaves it
 * disabled because that is the write it is making.
 */
test.afterEach(async ({ request }) => {
  await resetWorkspaceConfiguration(request);
});

test("the workspace row writes its configuration against the revision it loaded", async ({
  page,
  request
}) => {
  await resetWorkspaceConfiguration(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(WORKSPACES_URL);

  const enablement = enablementControl(page);
  await expect(enablement).toHaveValue("true");

  // The write is a form submission, so the page that comes back is the
  // Runtime-confirmed value rather than an optimistic one.
  await enablement.selectOption("false");

  // The write is the Runtime's, and it lands after the browser has already
  // changed the select, so the state is polled rather than read once.
  await expect
    .poll(async () => (await readWorkspaceConfiguration(request)).enabled)
    .toBe(false);
  const held = await readWorkspaceConfiguration(request);
  // The revision moved with the configuration, so the next write has to carry
  // the new one.
  expect(held.revision).not.toBe("e".repeat(64));
});

test("a stale configuration write is refused rather than overwriting somebody else's change", async ({
  page,
  request
}) => {
  await resetWorkspaceConfiguration(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(WORKSPACES_URL);

  const before = await readWorkspaceConfiguration(request);

  // Somebody else writes while this page is open, so the page holds a
  // revision the Runtime has already moved past.
  const moved = await request.post(
    `${FIXTURE_BASE_URL}/fixture/workspaces/state?state=revision-moved`
  );
  expect(moved.ok()).toBe(true);

  await enablementControl(page).selectOption("false");

  // The refusal says what happened: the canonical catalog moved under the
  // edit, so the edit was not saved and it is still here.
  const notice = page.locator(
    `[data-workspace-configuration-save="${CONFLICT_OUTCOME}"]`
  );
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("changed after the control was filled");

  // And nothing was written: the configuration is the one the Runtime held.
  const after = await readWorkspaceConfiguration(request);
  expect(after.enabled).toBe(before.enabled);
  expect(after.revision).not.toBe(before.revision);
});

test("the workspace detail writes through the same control as the row", async ({
  page,
  request
}) => {
  await resetWorkspaceConfiguration(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(WORKSPACE_DETAIL_URL);

  const control = configurationControl(page);
  await expect(control).toHaveCount(1);
  const enablement = enablementControl(page);
  await expect(enablement).toHaveValue("true");

  await enablement.selectOption("false");

  await expect
    .poll(async () => (await readWorkspaceConfiguration(request)).enabled)
    .toBe(false);
});
