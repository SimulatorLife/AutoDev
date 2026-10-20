import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test
} from "@playwright/test";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const AGENTS_URL = "/agents";
const AGENT_DETAIL_URL = "/agents/default";
const DEFAULT_AGENT_ROLE = "default";
const ENABLED_STATUS = "enabled";
const DISABLED_STATUS = "disabled";
const CONFLICT_REFUSAL = "conflicted";
const CONFLICT_DETAIL = "Reload it and decide again.";
const STATUS_ATTRIBUTE = "data-status";

/**
 * The enablement control of one agent.
 *
 * The control is the same one on the list row and on the detail view, so it
 * is addressed by the agent it acts on rather than by where it is rendered.
 */
function enablementControl(page: Page, role: string): Locator {
  return page.locator(`[data-enablement-target="${role}"]`);
}

/**
 * Put the fixture's agent enablement back where a test that writes starts.
 *
 * The write is real, so the fixture keeps the enablement the last write left
 * behind. This puts it back without touching the rest of the fixture's state,
 * which another session's specs also use.
 */
async function resetAgentEnablement(request: APIRequestContext): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/agents/state?state=enabled`
  );
  expect(response.ok()).toBe(true);
}

/**
 * Leave the fixture the way the rest of the suite finds it.
 *
 * The agent enablement is shared state: a spec that reads the Agents list
 * expects the agent to be enabled, and this one leaves it disabled because
 * that is the write it is making. Putting it back is what keeps the two
 * specs from answering for each other.
 */
test.afterEach(async ({ request }) => {
  await resetAgentEnablement(request);
});

/**
 * The enablement the Runtime currently holds for one agent.
 */
async function readAgentEnablement(
  request: APIRequestContext
): Promise<{ enabled: boolean; revision: string }> {
  const response = await request.get(`${FIXTURE_BASE_URL}/control/agents`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    agents: {
      role: string;
      enablement: { enabled: boolean; revision: string };
    }[];
  };
  const agent = body.agents.find((entry) => entry.role === DEFAULT_AGENT_ROLE);
  expect(agent).toBeDefined();
  return {
    enabled: agent?.enablement.enabled ?? false,
    revision: agent?.enablement.revision ?? ""
  };
}

test("the Agents row disables the agent against the revision it loaded", async ({
  page,
  request
}) => {
  await resetAgentEnablement(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(AGENTS_URL);

  const control = enablementControl(page, DEFAULT_AGENT_ROLE);
  await expect(control).toHaveAttribute(STATUS_ATTRIBUTE, ENABLED_STATUS);

  // The write is a form submission, so the page that comes back is the
  // Runtime-confirmed value rather than an optimistic one.
  await control.click();
  await expect(control).toHaveAttribute(STATUS_ATTRIBUTE, DISABLED_STATUS);

  const held = await readAgentEnablement(request);
  expect(held.enabled).toBe(false);
  // The revision moved with the enablement, so the next write has to carry
  // the new one.
  expect(held.revision).not.toBe("a".repeat(64));
});

test("a stale enablement is refused rather than overwriting somebody else's change", async ({
  page,
  request
}) => {
  await resetAgentEnablement(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(AGENTS_URL);

  const before = await readAgentEnablement(request);

  // Somebody else writes while this page is open, so the page holds a
  // revision the Runtime has already moved past.
  const moved = await request.post(
    `${FIXTURE_BASE_URL}/fixture/agents/state?state=revision-moved`
  );
  expect(moved.ok()).toBe(true);

  await enablementControl(page, DEFAULT_AGENT_ROLE).click();

  // The refusal says what to do next, which is not to send the same write
  // again: the enablement changed since this page was read.
  const notice = page.locator(
    `[data-control-outcome="failed"][data-control-refusal="${CONFLICT_REFUSAL}"]`
  );
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(CONFLICT_DETAIL);

  // And nothing was written: the enablement is the one the Runtime held.
  const after = await readAgentEnablement(request);
  expect(after.enabled).toBe(before.enabled);
  expect(after.revision).not.toBe(before.revision);
});

test("the agent detail writes through the same control as the row", async ({
  page,
  request
}) => {
  await resetAgentEnablement(request);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(AGENT_DETAIL_URL);

  const control = enablementControl(page, DEFAULT_AGENT_ROLE);
  await expect(control).toHaveAttribute(STATUS_ATTRIBUTE, ENABLED_STATUS);

  await control.click();
  await expect(control).toHaveAttribute(STATUS_ATTRIBUTE, DISABLED_STATUS);

  const held = await readAgentEnablement(request);
  expect(held.enabled).toBe(false);
});
