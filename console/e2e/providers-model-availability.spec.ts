import { expect, test } from "@playwright/test";

import { documentFitsViewport } from "./acceptance-helpers.ts";

const UNSUPPORTED_MODEL_ID = "claude-preview-unroutable";
const STALE_AVAILABILITY_TITLE = /availability is stale/u;
const MOUNTED_DOCUMENT_TOKEN = "mounted-document-1";
const TOOLS_SOURCE_MCP_URL = /\/tools\?source=mcp$/u;
const TOOLS_SOURCE_MCP_ROLE_ORCHESTRATOR_URL =
  /\/tools\?source=mcp&role=orchestrator$/u;
const TOOLS_ROLE_ORCHESTRATOR_URL = /\/tools\?role=orchestrator$/u;
const PROVIDERS_NAV_LINK_PATTERN = /^Providers/u;
const PROVIDERS_URL = /\/providers$/u;
const PROVIDERS_MODELS_URL = /\/providers\?tab=models$/u;
const PROVIDER_RESET_CONFIRMATION_PATTERN =
  /Confirm clearing role overrides, disabled models, and provider limits/u;
const CLAUDE_PROVIDER_ID = "claude";
const MODEL_ID = "sonnet";
const NOT_OBSERVED = "Not observed";
const PROVIDERS_TAB_URL = "/providers?tab=providers";
const PROVIDER_DETAIL_URL_PATTERN = /\/providers\/[A-Za-z0-9._-]+$/u;

test("Providers distinguishes live, stale, unavailable, and unsupported models", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.removeItem("autodev.console.sidebar.collapsed");
  });
  await page.goto("/providers?tab=models");

  await expect(
    page.getByRole("navigation", { name: "Providers views" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand sidebar" })
  ).toBeVisible();
  await expect(
    page.locator(`[data-provider-discovery="${CLAUDE_PROVIDER_ID}"]`)
  ).toContainText("Observed · 2 models");
  await expect(page.locator('[data-provider-discovery="codex"]')).toContainText(
    "Stale · 1 last-known models"
  );
  await expect(
    page.locator('[data-provider-discovery="copilot"]')
  ).toContainText("Unavailable");
  await expect(
    page.locator(`[data-unsupported-model="${UNSUPPORTED_MODEL_ID}"]`)
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `Open model ${UNSUPPORTED_MODEL_ID}` })
  ).toHaveCount(0);
  expect(await documentFitsViewport(page)).toBe(true);

  await page.goto(PROVIDERS_TAB_URL);
  await expect(page.locator('[data-tab-panel="providers"]')).toBeVisible();
  const currentModel = page.locator(
    `[data-select="role-model-${CLAUDE_PROVIDER_ID}-default"]`
  );
  await expect(currentModel).toBeVisible();
  const currentOptions = await currentModel
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value)
    );
  expect(currentOptions).toEqual(["", "sonnet"]);
  expect(currentOptions).not.toContain(UNSUPPORTED_MODEL_ID);

  const staleModel = page.locator('[data-select="role-model-codex-default"]');
  await expect(staleModel).toBeDisabled();
  await expect(staleModel).toHaveAttribute("title", STALE_AVAILABILITY_TITLE);
  const staleForm = page.locator('[data-role-form="codex-default"]');
  await expect(staleForm.locator('input[name="model"]')).toHaveValue(
    "gpt-6-luna"
  );
});

test("Tools source/role filters and resource/tab links navigate in place without remounting the document", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tools");

  // The catalogue takes the Console's own filter bar, so a tool can be found
  // by name as well as by facet. The count of what is in view appears only
  // once the list is narrowed; an unfiltered catalogue reports its size in the
  // stat row above it.
  await expect(page.getByRole("searchbox")).toBeVisible();
  // The exact name, because a role chip in the same row is named after the
  // tool it filters ("Filter tools exposed to worker for read_file"). A
  // substring match reaches the chip as well as the row's own link, and a
  // locator that resolves to three links cannot say which one it meant.
  await expect(
    page.getByRole("link", { name: "read_file", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "lsp_goto_definition", exact: true })
  ).toBeVisible();

  await page.evaluate((token) => {
    (
      globalThis as typeof globalThis & {
        __autodevNavigationMountToken?: string;
      }
    ).__autodevNavigationMountToken = token;
  }, MOUNTED_DOCUMENT_TOKEN);
  const readMountToken = (): Promise<string | undefined> =>
    page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __autodevNavigationMountToken?: string;
          }
        ).__autodevNavigationMountToken
    );

  await page.locator('[data-source-filter="mcp"]').click();
  await expect(page).toHaveURL(TOOLS_SOURCE_MCP_URL);
  await expect(page.getByText("Showing 1 of 2 tool entries")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "lsp_goto_definition", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "read_file", exact: true })
  ).toHaveCount(0);
  expect(await readMountToken()).toBe(MOUNTED_DOCUMENT_TOKEN);

  await page.locator('[data-role-filter="orchestrator"]').click();
  await expect(page).toHaveURL(TOOLS_SOURCE_MCP_ROLE_ORCHESTRATOR_URL);
  await expect(page.getByText("Showing 0 of 2 tool entries")).toBeVisible();
  await expect(
    page.getByText("No tool entries found matching the current criteria.")
  ).toBeVisible();
  expect(await readMountToken()).toBe(MOUNTED_DOCUMENT_TOKEN);

  await page.locator('[data-source-filter="all"]').click();
  await expect(page).toHaveURL(TOOLS_ROLE_ORCHESTRATOR_URL);
  await expect(page.getByText("Showing 1 of 2 tool entries")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "read_file", exact: true })
  ).toBeVisible();
  expect(await readMountToken()).toBe(MOUNTED_DOCUMENT_TOKEN);

  await page
    .getByRole("navigation", { name: "AutoDev Console Navigation" })
    .getByRole("link", { name: PROVIDERS_NAV_LINK_PATTERN })
    .click();
  await expect(page).toHaveURL(PROVIDERS_URL);
  await expect(page.locator('[data-tab-panel="providers"]')).toBeVisible();
  expect(await readMountToken()).toBe(MOUNTED_DOCUMENT_TOKEN);

  await page
    .getByRole("navigation", { name: "Providers views" })
    .getByRole("link", { name: "Models" })
    .click();
  await expect(page).toHaveURL(PROVIDERS_MODELS_URL);
  await expect(page.locator('[data-tab-panel="models"]')).toBeVisible();
  expect(await readMountToken()).toBe(MOUNTED_DOCUMENT_TOKEN);
});

test("Providers keeps its five-column role table readable at narrow and desktop widths", async ({
  page
}) => {
  await page.goto(PROVIDERS_TAB_URL);
  const table = page.locator('[data-tab-panel="providers"] table');
  const expectedColumns = [
    "Provider",
    "Status",
    "Active Agents",
    "Roles",
    "Agent Limits"
  ];
  const checkWidth = async (width: number): Promise<void> => {
    await page.setViewportSize({ width, height: 844 });
    await expect(table).toBeVisible();
    await expect(
      page.locator('[data-tab-panel="providers"] [data-column-label]')
    ).toHaveText(expectedColumns);

    const roleLabels = await table
      .locator("tbody [data-role-label]")
      .evaluateAll((nodes) =>
        Array.from(new Set(nodes.map((node) => node.textContent?.trim() ?? "")))
      );
    expect(roleLabels).toEqual([
      "Default",
      "Smart",
      "Orchestrator",
      "Subagent"
    ]);

    const widths = await table.evaluate((element) => {
      const scroller = element.parentElement;
      return {
        scroller: scroller?.clientWidth ?? 0,
        table: element.scrollWidth
      };
    });
    expect(widths.table).toBeGreaterThan(0);
    if (width === 390) {
      expect(widths.table).toBeGreaterThan(widths.scroller);
    }
    expect(await documentFitsViewport(page)).toBe(true);
  };

  await checkWidth(390);
  await checkWidth(768);
  await checkWidth(1280);
});

test("Providers header exposes a confirmed reset and explains unavailable provider creation", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PROVIDERS_TAB_URL);

  const actions = page.getByRole("group", {
    name: "Provider configuration actions"
  });
  await expect(actions).toBeVisible();
  await expect(
    actions.getByRole("checkbox", {
      name: PROVIDER_RESET_CONFIRMATION_PATTERN
    })
  ).toHaveAttribute("required", "");
  await expect(
    actions.getByRole("button", { name: "Reset to defaults" })
  ).toBeVisible();
  await expect(
    actions.getByRole("button", { name: "Add provider" })
  ).toBeDisabled();
  await expect(
    page.getByText("Add a Runtime adapter before configuring another provider.")
  ).toBeVisible();
  expect(await documentFitsViewport(page)).toBe(true);
});

test("Provider detail reuses provider-wide controls and navigates in place", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PROVIDERS_TAB_URL);
  await page.evaluate((token) => {
    (
      globalThis as typeof globalThis & {
        __autodevProviderDetailDocumentToken?: string;
      }
    ).__autodevProviderDetailDocumentToken = token;
  }, MOUNTED_DOCUMENT_TOKEN);

  await page
    .locator('[data-tab-panel="providers"] [data-section="providers"]')
    .getByRole("link", { name: `Open provider ${CLAUDE_PROVIDER_ID}` })
    .click();
  await expect(page).toHaveURL(PROVIDER_DETAIL_URL_PATTERN);
  await expect(
    page.locator(`[data-role-form="${CLAUDE_PROVIDER_ID}-default"]`)
  ).toBeVisible();
  await expect(
    page.locator(`[data-provider-limits="${CLAUDE_PROVIDER_ID}"]`)
  ).toBeVisible();
  await expect(
    page.locator(`[data-provider-disabled="${CLAUDE_PROVIDER_ID}"]`)
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __autodevProviderDetailDocumentToken?: string;
          }
        ).__autodevProviderDetailDocumentToken
    )
  ).toBe(MOUNTED_DOCUMENT_TOKEN);
  expect(await documentFitsViewport(page)).toBe(true);

  await page.setViewportSize({ width: 1280, height: 844 });
  expect(await documentFitsViewport(page)).toBe(true);
});

test("the model detail is the model's own page, not its provider's", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(`/providers/${CLAUDE_PROVIDER_ID}/models/${MODEL_ID}`);

  // The page is about this model.
  await expect(
    page.getByRole("heading", { name: MODEL_ID, exact: true })
  ).toBeVisible();
  const details = page.locator("[data-detail-grid]");
  await expect(
    details
      .locator('dt:text-is("Provider")')
      .locator("xpath=following-sibling::dd[1]")
  ).toHaveText(CLAUDE_PROVIDER_ID);
  await expect(
    details
      .locator('dt:text-is("Tiers")')
      .locator("xpath=following-sibling::dd[1]")
  ).toHaveText("default, smart, subagent");

  // The enablement control is the model's own, and the action it offers is
  // the one the model's own state calls for: the model is enabled, so the
  // action is to disable it.
  const enablement = page.locator('[data-enablement="model"]');
  await expect(enablement).toHaveAttribute("data-enablement-target", MODEL_ID);
  await expect(enablement).toHaveText("Enabled");
  await expect(enablement).toHaveAttribute("aria-label", `Disable ${MODEL_ID}`);
  // The provider's own enablement is a different control and is not here.
  await expect(page.locator('[data-enablement="provider"]')).toHaveCount(0);

  // The Runtime has not reported the model's convergence, so the page says
  // that rather than presenting the desired state as a settled one.
  await expect(details.locator('[data-status="not-observed"]')).toBeVisible();
  // The Runtime published no live projection, so the live agent count is not
  // observed rather than measured as zero.
  await expect(
    details
      .locator('dt:text-is("Active agents")')
      .locator("xpath=following-sibling::dd[1]")
  ).toHaveText(NOT_OBSERVED);
  expect(await documentFitsViewport(page)).toBe(true);
});
