import { expect, type Locator, type Page, test } from "@playwright/test";

const TOOLS_URL = "/tools";
const NATIVE_TOOL_ID = "read_file";
const MCP_TOOL_ID = "mcp__lsp__lsp_goto_definition";
const MCP_TOOL_SOURCE_QUALIFIED_ID = "mcp:lsp:lsp_goto_definition";
const MCP_SERVER = "lsp";

function documentFitsViewport(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= globalThis.innerWidth
  );
}

/**
 * The value cell of one labelled field inside a detail section.
 *
 * `FieldBox` renders a `<dt>` label and its `<dd>` value as siblings, so the
 * value is the label's next sibling rather than a positional index: a field
 * added above another one cannot silently move the wrong value onto the wrong
 * label.
 */
function fieldValue(page: Page, section: string, label: string): Locator {
  return page.locator(
    `[data-section="${section}"] dt:text-is("${label}") + dd`
  );
}

/**
 * Console errors seen while the page was open.
 *
 * A page can render correctly on the server and still be broken in the
 * browser: a stale build serves markup whose JavaScript chunks no longer
 * exist, and the result is a page that reads right in a fetch and throws on
 * hydration. Watching the console is the only way to see that.
 */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test("the tool detail reports the catalog's source authority for an MCP tool", async ({
  page
}) => {
  const consoleErrors = collectConsoleErrors(page);
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(`${TOOLS_URL}/${MCP_TOOL_ID}`);

  // The detail page is the one place the wire name is the whole subject, so
  // the page's identity and the URL address the same qualified name.
  await expect(page.locator("[data-tool-name]")).toHaveAttribute(
    "data-tool-name",
    MCP_TOOL_ID
  );
  // The shell owns the page's single `h1`; the entity's own title is the `h2`
  // beneath it. A second `h1` for the tool would break the document outline.
  await expect(
    page.locator("main").getByRole("heading", { level: 1 })
  ).toHaveText("Tools");
  await expect(
    page.locator("main").getByRole("heading", { level: 2 })
  ).toHaveText(MCP_TOOL_ID);
  await expect(page.getByText("mcp · lsp · RuleSync MCP")).toBeVisible();

  // A complete catalog entry says so, rather than letting a partial one read
  // as if it were whole.
  await expect(page.locator("[data-tools-coverage]")).toHaveAttribute(
    "data-tools-coverage",
    "complete"
  );
  await expect(page.locator("[data-tools-validity]")).toHaveAttribute(
    "data-tools-validity",
    "valid"
  );

  const authority = "tool-source-authority";
  await expect(fieldValue(page, authority, "Source")).toHaveText("mcp");
  await expect(fieldValue(page, authority, "Server")).toHaveText(MCP_SERVER);
  await expect(fieldValue(page, authority, "Authority")).toHaveText(
    "RuleSync MCP"
  );
  await expect(
    fieldValue(page, authority, "Availability").locator("[data-status]")
  ).toHaveAttribute("data-status", "configured");

  // The canonical edit surface is the one place the operator can change the
  // tool, so it is a link to the owning surface and not a dead end.
  const editSurface = fieldValue(page, authority, "Canonical edit surface");
  await expect(
    editSurface.getByRole("link", { name: "MCP lsp" })
  ).toHaveAttribute("href", `/mcps/${MCP_SERVER}`);

  await expect(page.locator('[data-section="tool-description"]')).toContainText(
    "Jump to symbol definition."
  );

  // Role exposure is the projection the catalog actually observed, so the
  // chips are the roles it saw and no others.
  const roleLinks = page.locator('[data-section="tool-role-exposure"] a');
  await expect(roleLinks).toHaveCount(1);
  await expect(roleLinks.first()).toHaveText("worker");
  await expect(roleLinks.first()).toHaveAttribute("href", "/tools?role=worker");

  expect(consoleErrors).toEqual([]);
});

test("the tool detail addresses the same entry by its source-qualified name", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  // The catalog exposes three identities for one entry. All of them have to
  // reach the same page, or a link written against one of them 404s.
  await page.goto(`${TOOLS_URL}/${MCP_TOOL_SOURCE_QUALIFIED_ID}`);

  await expect(page.locator("[data-tool-name]")).toHaveAttribute(
    "data-tool-name",
    MCP_TOOL_ID
  );
  await expect(fieldValue(page, "tool-source-authority", "Server")).toHaveText(
    MCP_SERVER
  );
});

test("the tool detail does not invent a usage count for an unobserved tool", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(`${TOOLS_URL}/${MCP_TOOL_ID}`);

  const historicalUse = page.locator('[data-section="tool-historical-use"]');
  // The Usage fixture observed no calls for this tool. The page says that,
  // rather than rendering a zero, because a zero is a measurement and
  // nothing measured this.
  await expect(
    historicalUse.locator("[data-status]"),
    "the absence of usage evidence is an explicit status, not a count"
  ).toHaveAttribute("data-status", "not-observed");
  await expect(historicalUse).toContainText("No recorded tool calls");
  await expect(historicalUse).toContainText(
    "the count is not rendered as zero"
  );
  // The measured fields are absent rather than present and empty: a field
  // labelled "Calls (24h)" with a blank value would read as zero to anyone
  // scanning the page.
  await expect(page.getByText("Calls (24h)")).toHaveCount(0);
  await expect(page.getByText("Errors (24h)")).toHaveCount(0);

  // Every outcome leads to the one surface an operator can act on.
  await expect(
    historicalUse.getByRole("link", { name: "Open Usage →" })
  ).toHaveAttribute("href", "/usage");
});

test("a native tool reports no server and no canonical edit surface", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto(`${TOOLS_URL}/${NATIVE_TOOL_ID}`);

  await expect(page.locator("[data-tool-name]")).toHaveAttribute(
    "data-tool-name",
    NATIVE_TOOL_ID
  );
  await expect(
    page.locator("main").getByRole("heading", { level: 2 })
  ).toHaveText(NATIVE_TOOL_ID);

  const authority = "tool-source-authority";
  await expect(fieldValue(page, authority, "Source")).toHaveText("native");
  // A native tool has no MCP server, and the page says "Not configured"
  // rather than leaving the field blank.
  await expect(fieldValue(page, authority, "Server")).toHaveText(
    "Not configured"
  );
  await expect(fieldValue(page, authority, "Authority")).toHaveText(
    "Codex native"
  );

  // There is no owning surface to link to, so the field is an absence note
  // and not a link that goes nowhere.
  const editSurface = fieldValue(page, authority, "Canonical edit surface");
  await expect(editSurface).toContainText("No canonical edit surface");
  await expect(editSurface.getByRole("link")).toHaveCount(0);

  const roleLinks = page.locator('[data-section="tool-role-exposure"] a');
  await expect(roleLinks).toHaveCount(2);
  await expect(roleLinks.nth(0)).toHaveText("orchestrator");
  await expect(roleLinks.nth(1)).toHaveText("worker");

  // The catalog shipped no description for this entry, and the page says so
  // instead of leaving an empty panel.
  await expect(page.locator('[data-section="tool-description"]')).toContainText(
    "No description is shipped with this tool"
  );
});

test("the tool detail stays inside the viewport at narrow and desktop widths", async ({
  page
}) => {
  await page.goto(`${TOOLS_URL}/${MCP_TOOL_ID}`);

  const checkWidth = async (width: number): Promise<void> => {
    await page.setViewportSize({ width, height: 844 });
    await expect(
      page.locator("main").getByRole("heading", { level: 2 })
    ).toBeVisible();
    await expect(
      page.locator('[data-section="tool-source-authority"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-section="tool-historical-use"]')
    ).toBeVisible();
    expect(await documentFitsViewport(page)).toBe(true);
  };

  await checkWidth(390);
  await checkWidth(768);
  await checkWidth(1280);
});
