import { expect, type Page, test } from "@playwright/test";

/**
 * The state proxy's port.
 *
 * The Console reads the Control API through the proxy, and the proxy answers
 * in the state the spec asks for. The port is fixed because the Console is
 * started before the spec runs and its Control API address is part of that
 * start.
 */
const PROXY_PORT = Number(process.env.AUTODEV_STATE_PROXY_PORT ?? 4370);
const PROXY = `http://127.0.0.1:${String(PROXY_PORT)}`;

/**
 * Put the Control API into one state.
 *
 * The proxy answers the control route honestly, so a spec that puts the
 * service back is leaving no trace for the next one.
 */
async function setControlApiState(state: string): Promise<void> {
  const response = await fetch(`${PROXY}/__state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state })
  });
  expect(response.status).toBe(200);
}

test.afterEach(async () => {
  await setControlApiState("normal");
});

/**
 * The explicit state a page shows when it could not read its resource.
 */
function unavailableState(page: Page) {
  return page.locator('[data-status="unavailable"]').first();
}

test("a hook event whose declaration could not be applied is not an unknown event", async ({
  page
}) => {
  await setControlApiState("catalogue-invalid");
  await page.goto("/hooks/preToolUse");

  // The event is declared -- the fixture declares it, and it is declared a
  // moment ago too -- but the declaration could not be applied, so nothing
  // about it could be read. The page says so, and says why.
  const state = unavailableState(page);
  await expect(state).toBeVisible();
  await expect(state).toHaveAttribute(
    "data-error-code",
    "autodev_console_hooks_catalogue_invalid"
  );
  await expect(state).toContainText(
    "The hook declaration could not be applied."
  );

  // And it is not the not-found page. A 404 here would say the event does not
  // exist, which is a claim about the declaration that nobody made.
  await expect(page.locator('[data-testid="not-found-page"]')).toHaveCount(0);
});

test("an MCP server whose declaration could not be applied is not an unknown server", async ({
  page
}) => {
  await setControlApiState("catalogue-invalid");
  await page.goto("/mcps/lsp");

  const state = unavailableState(page);
  await expect(state).toBeVisible();
  await expect(state).toHaveAttribute(
    "data-error-code",
    "autodev_console_mcps_catalogue_invalid"
  );
  await expect(state).toContainText(
    "The MCP declaration could not be applied."
  );
  await expect(page.locator('[data-testid="not-found-page"]')).toHaveCount(0);
});

test("a tool whose catalogue could not be applied is not an unknown tool", async ({
  page
}) => {
  await setControlApiState("catalogue-invalid");
  await page.goto("/tools/read_file");

  const state = unavailableState(page);
  await expect(state).toBeVisible();
  await expect(state).toHaveAttribute(
    "data-error-code",
    "autodev_console_tools_catalogue_invalid"
  );
  await expect(page.locator('[data-testid="not-found-page"]')).toHaveCount(0);
});
