import { expect, type Locator, type Page, test } from "@playwright/test";

const MOUNTED_DOCUMENT_TOKEN = "mounted-document-1";
const LSP_SERVER = "lsp";
const ANTIGRAVITY_SERVER = "antigravity-cli";
const DOCS_SERVER = "openaiDeveloperDocs";
const NOT_OBSERVED = "Not observed";
const CONNECTED_CLAIM = /^Connected$/u;

/**
 * The tab set the target state mandates for MCP detail, in the order it
 * mandates. The detail page is the only place these nine appear, so the
 * order is part of what the page promises.
 */
const MCP_DETAIL_TAB_IDS = [
  "overview",
  "configuration",
  "connection-health",
  "tools",
  "resources",
  "prompts",
  "role-access",
  "activity",
  "errors-logs"
] as const;

/**
 * The label of the column that reports what a target override says about a
 * server. The MCP table says "Enabled" in two different columns -- the
 * default state and a target override -- so a cell's position is the only
 * thing that tells the two claims apart.
 */
const DEFAULT_STATE_COLUMN = "Default State";
const CONNECTION_COLUMN = "Connection";
const OVERRIDES_COLUMN = "Overrides";

function documentFitsViewport(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= globalThis.innerWidth
  );
}

/**
 * One row of the MCP table, found by the server's own link.
 *
 * The table has no row identity of its own, and a server name is the row's
 * primary key, so the link that carries the name is what identifies the row.
 */
function serverRow(page: Page, name: string): Locator {
  return page.locator("tbody tr").filter({
    has: page.getByRole("link", { name, exact: true })
  });
}

/**
 * One cell of one table row, found by the column's own header label.
 *
 * Reading the header's own label keeps the assertion tied to the column's
 * name rather than to its position, so a column that is reordered or
 * inserted does not silently turn one claim into another.
 */
async function cellInRow(
  page: Page,
  row: Locator,
  columnLabel: string
): Promise<Locator> {
  const labels = await page
    .locator("thead th [data-column-label]")
    .allTextContents();
  const index = labels.findIndex((label) => label.trim() === columnLabel);
  if (index === -1) {
    throw new Error(`the table has no column labelled ${columnLabel}`);
  }
  return row.locator("td").nth(index);
}

/**
 * The value of one labelled field, found by the field's own label.
 *
 * A configuration field is a `<dt>`/`<dd>` pair, and the label is the only
 * thing that names which fact the value is: the same word appears as a table
 * header, as a tab and as a value elsewhere on these pages.
 */
function fieldValue(page: Page, label: string): Locator {
  return page
    .locator(`dt:text-is("${label}")`)
    .locator("xpath=following-sibling::dd[1]");
}

/** The tab navigation of one MCP detail page. */
function detailTabs(page: Page, server: string): Locator {
  return page.getByRole("navigation", { name: `${server} detail sections` });
}

async function assertConnectionIsUnobserved(
  page: Page,
  server: string
): Promise<void> {
  const row = serverRow(page, server);
  const cell = await cellInRow(page, row, CONNECTION_COLUMN);
  await expect(cell).toHaveText(NOT_OBSERVED);
}

/**
 * One tab that cannot be answered without a live session, and the badge that
 * says so.
 */
async function assertTabIsUnobserved(
  page: Page,
  server: string,
  tabId: string,
  badge: string
): Promise<void> {
  await page.goto(`/mcps/${server}?tab=${tabId}`);
  await expect(page.locator(`[data-section="mcp-${tabId}"]`)).toBeVisible();
  await expect(page.getByText(badge)).toBeVisible();
}

async function assertFitsViewport(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/mcps/${LSP_SERVER}`);
  expect(await documentFitsViewport(page)).toBe(true);
}

test("MCPs keeps the declared default state, the missing declaration and the unobserved connection apart", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/mcps");

  // The source was read, and what it says is published rather than implied.
  await expect(page.locator("[data-mcp-source-validity]")).toHaveAttribute(
    "data-mcp-source-validity",
    "true"
  );
  // The connection was not observed, and the page says so instead of
  // rendering an unobserved connection as a connected one.
  await expect(page.locator("[data-mcp-connection-observed]")).toHaveAttribute(
    "data-mcp-connection-observed",
    "false"
  );
  await expect(page.getByText("Configured MCPs")).toBeVisible();

  const lsp = serverRow(page, LSP_SERVER);
  await expect(
    lsp.getByRole("link", { name: LSP_SERVER, exact: true })
  ).toHaveAttribute("href", "/mcps/lsp");
  const lspDefaultState = await cellInRow(page, lsp, DEFAULT_STATE_COLUMN);
  await expect(lspDefaultState).toHaveText("Enabled");
  const lspDeclaration = await cellInRow(page, lsp, "RuleSync");
  await expect(lspDeclaration).toHaveText("Canonical");
  const lspTransport = await cellInRow(page, lsp, "Transport");
  await expect(lspTransport).toHaveText("STDIO");
  await assertConnectionIsUnobserved(page, LSP_SERVER);
  const lspOverrides = await cellInRow(page, lsp, OVERRIDES_COLUMN);
  const lspOverride = lspOverrides.locator("[data-chips] > li > span[title]");
  await expect(lspOverride).toHaveText("codex");
  await expect(lspOverride).toHaveAttribute("title", "codex: enabled");
  await expect(lspOverride.locator("[data-status]")).toHaveAttribute(
    "aria-label",
    "Enabled"
  );

  // A server that exists only in a target projection has no observed default
  // state, which is not the same fact as being disabled.
  const antigravity = serverRow(page, ANTIGRAVITY_SERVER);
  const antigravityDefaultState = await cellInRow(
    page,
    antigravity,
    DEFAULT_STATE_COLUMN
  );
  await expect(antigravityDefaultState).toHaveText("Disabled");
  const antigravityDeclaration = await cellInRow(page, antigravity, "RuleSync");
  await expect(antigravityDeclaration).toHaveText("Missing");
  const antigravityOverrides = await cellInRow(
    page,
    antigravity,
    OVERRIDES_COLUMN
  );
  const antigravityOverride = antigravityOverrides.locator(
    "[data-chips] > li > span[title]"
  );
  await expect(antigravityOverride).toHaveAttribute("title", "codex: disabled");
  await expect(antigravityOverride.locator("[data-status]")).toHaveAttribute(
    "aria-label",
    "Disabled"
  );

  // A server with no target override says that it has none, rather than
  // leaving the cell blank.
  const docs = serverRow(page, DOCS_SERVER);
  const docsDefaultState = await cellInRow(page, docs, DEFAULT_STATE_COLUMN);
  await expect(docsDefaultState).toHaveText(NOT_OBSERVED);
  const docsTransport = await cellInRow(page, docs, "Transport");
  await expect(docsTransport).toHaveText("HTTP");
  const docsOverrides = await cellInRow(page, docs, OVERRIDES_COLUMN);
  await expect(docsOverrides).toHaveText("None");
  await assertConnectionIsUnobserved(page, DOCS_SERVER);

  // Not one row claims a connection: the Connection column is the same
  // unobserved state on every row.
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await assertConnectionIsUnobserved(page, LSP_SERVER);
  await assertConnectionIsUnobserved(page, ANTIGRAVITY_SERVER);
  await assertConnectionIsUnobserved(page, DOCS_SERVER);
  await expect(page.getByText(CONNECTED_CLAIM)).toHaveCount(0);
});

test("the MCP detail separates the declaration it has from the connection it has not observed", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/mcps/${LSP_SERVER}`);

  // The nine tabs the target state names, in the order it names them.
  const tabs = detailTabs(page, LSP_SERVER).locator("[data-tab-item]");
  await expect(tabs).toHaveCount(MCP_DETAIL_TAB_IDS.length);
  expect(
    await tabs.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.tabItem)
    )
  ).toEqual([...MCP_DETAIL_TAB_IDS]);

  // Overview is the tab a detail page opens on.
  await expect(page.locator('[data-section="mcp-overview"]')).toBeVisible();
  await expect(
    detailTabs(page, LSP_SERVER).locator('[data-tab-item="overview"]')
  ).toHaveAttribute("aria-current", "page");

  await expect(page.getByText("Desired state")).toBeVisible();
  await expect(page.getByText("Enabled by default")).toBeVisible();
  await expect(page.getByText("Transport: STDIO")).toBeVisible();

  // The runtime connection is the one thing a declaration cannot prove, and
  // the page says that rather than showing a connected state.
  await expect(page.getByText("Runtime connection")).toBeVisible();
  await expect(
    page.getByText(
      "A canonical declaration does not prove that a server is connected or healthy."
    )
  ).toBeVisible();

  await expect(page.getByText("Source validation")).toBeVisible();
  await expect(page.getByText("RuleSync source valid")).toBeVisible();

  // Nothing on the page claims a live connection.
  await expect(page.getByText(CONNECTED_CLAIM)).toHaveCount(0);
  await expect(
    page.locator('[data-section="mcp-overview"] [data-status="not-observed"]')
  ).toHaveCount(1);
});

test("the MCP configuration tab shows the declaration's own fields and no others", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/mcps/${LSP_SERVER}?tab=configuration`);

  await expect(
    page.locator('[data-section="mcp-configuration"]')
  ).toBeVisible();
  await expect(fieldValue(page, "Transport")).toHaveText("stdio");
  await expect(fieldValue(page, "Command")).toHaveText("npx");
  await expect(fieldValue(page, "Arguments")).toHaveText(
    "-y @modelcontextprotocol/server-lsp"
  );
  await expect(fieldValue(page, "Working directory")).toHaveText("/workspace");
  // Environment values are withheld; only the keys are shown.
  await expect(
    fieldValue(page, "Environment keys (values withheld)")
  ).toHaveText("LSP_ROOT");
  await expect(fieldValue(page, "Default tools approval mode")).toHaveText(
    "on-request"
  );
  await expect(
    page.getByText("codex: enabled | mode: never | tools: lsp_goto_definition")
  ).toBeVisible();

  // A server declared over HTTP has an endpoint and no command, and the tab
  // does not render an empty box for the fields it does not have.
  await page.goto(`/mcps/${DOCS_SERVER}?tab=configuration`);
  await expect(fieldValue(page, "Endpoint URL")).toHaveText(
    "https://docs.example.test/mcp"
  );
  await expect(page.locator('dt:text-is("Command")')).toHaveCount(0);
  await expect(page.locator('dt:text-is("Working directory")')).toHaveCount(0);
  await expect(page.getByText("No explicit target overrides.")).toBeVisible();
});

test("the MCP tabs that need a live session say that they have not observed one", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  await assertTabIsUnobserved(
    page,
    LSP_SERVER,
    "connection-health",
    "Probe status: Not observed"
  );
  await assertTabIsUnobserved(
    page,
    LSP_SERVER,
    "resources",
    "Resources inventory: Not observed"
  );
  await assertTabIsUnobserved(
    page,
    LSP_SERVER,
    "prompts",
    "Prompts inventory: Not observed"
  );
  await assertTabIsUnobserved(
    page,
    LSP_SERVER,
    "activity",
    "Activity: Not observed"
  );
  await assertTabIsUnobserved(
    page,
    LSP_SERVER,
    "errors-logs",
    "Error logs: Not observed"
  );

  // The Tools tab projects an allowlist, never a live inventory, and the
  // projection it has is not observed either -- so it says so instead of
  // listing the tools the catalog knows about as if the server exposed them.
  await page.goto(`/mcps/${LSP_SERVER}?tab=tools`);
  await expect(page.locator('[data-section="mcp-tools"]')).toBeVisible();
  await expect(
    page.locator('[data-tool-allowlist-projection="unknown"]')
  ).toBeVisible();
  await expect(
    page.getByText(
      "The Tools capability projection was not observed; the configured tool allowlist cannot be read."
    )
  ).toBeVisible();
  await expect(page.locator("[data-enumerated-tool-count]")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "lsp_goto_definition" })
  ).toHaveCount(0);
});

test("the MCP detail shows the roles the catalog assigned and no others", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/mcps/${LSP_SERVER}?tab=role-access`);

  await expect(page.locator('[data-section="mcp-role-access"]')).toBeVisible();
  await expect(page.getByText("worker", { exact: true })).toBeVisible();
  await expect(page.getByText("orchestrator", { exact: true })).toBeVisible();

  await page.goto(`/mcps/${ANTIGRAVITY_SERVER}?tab=role-access`);
  await expect(
    page.getByText("No roles assigned to this server.")
  ).toBeVisible();
});

test("the MCP detail tabs navigate in place without remounting the document", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/mcps/${LSP_SERVER}`);

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

  await assertTabNavigationKeepsTheDocument(
    page,
    readMountToken,
    "configuration"
  );
  await assertTabNavigationKeepsTheDocument(
    page,
    readMountToken,
    "role-access"
  );
  await assertTabNavigationKeepsTheDocument(
    page,
    readMountToken,
    "errors-logs"
  );
});

/**
 * One tab click, and the two things it has to keep true: the URL says which
 * tab is open, and the document was not remounted to get there.
 */
async function assertTabNavigationKeepsTheDocument(
  page: Page,
  readMountToken: () => Promise<string | undefined>,
  tabId: string
): Promise<void> {
  const tabs = detailTabs(page, LSP_SERVER);
  await tabs.locator(`[data-tab-item="${tabId}"]`).click();
  await expect(page).toHaveURL(
    new RegExp(String.raw`/mcps/${LSP_SERVER}\?tab=${tabId}$`, "u")
  );
  await expect(page.locator(`[data-section="mcp-${tabId}"]`)).toBeVisible();
  expect(await readMountToken()).toBe(MOUNTED_DOCUMENT_TOKEN);
}

test("the MCP detail fits narrow and desktop widths", async ({ page }) => {
  await assertFitsViewport(page, 390);
  await assertFitsViewport(page, 768);
  await assertFitsViewport(page, 1280);
});
