import { expect, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

/**
 * The Console can be searched for a resource by what it is for.
 *
 * Fourteen resources live behind a sidebar of labels, and the sentence that
 * says what each one is for lives in the page's own header. An operator who
 * knows what they want -- which surface tells me about compaction, which one
 * owns the execution contract -- has no way to search for it: the labels are
 * in the rail and the purposes are in the pages.
 *
 * Every dashboard that carries this much state solves it the same way.
 * Grafana opens a command palette on `cmd+k` / `ctrl+k`, and its own
 * documentation lists what the palette is for: "search for and open
 * dashboards and folders", "locate pages within Grafana", and "initiate key
 * actions from any page in the application" (Grafana's Search documentation).
 *
 * So the palette searches the canonical navigation registry -- the same
 * registry the sidebar is built from -- by the section's name and by the
 * sentence that says what it is for. The registry is the single owner of that
 * sentence, so the palette cannot drift from the page header: it reads the
 * same words.
 *
 * The rest of the spec is about the palette behaving like a dialog rather
 * than like a list of links: it keeps the focus inside itself, it hands the
 * focus back when it closes, and it answers a search in one keystroke.
 */
test("the palette finds a resource by name and by what it is for", async ({
  page
}) => {
  await page.goto("/agents");
  await waitForPageContent(page);

  const trigger = page.locator("[data-command-palette-trigger]");
  await expect(trigger).toBeVisible();
  // The name carries the key the badge shows, because the badge is visible
  // text on the control: a visible word the name drops is a word the
  // operator can see and nobody else can.
  await expect(trigger).toHaveAttribute("aria-label", /Find a resource/u);

  await page.keyboard.press("Meta+k");
  const dialog = page.getByRole("dialog", { name: "Find a resource" });
  await expect(dialog).toBeVisible();
  // The field takes the focus, so the operator can type straight away.
  await expect(page.locator("#command-palette-input")).toBeFocused();

  // Every resource is offered, and each carries the sentence that says what
  // it is for.
  const results = page.locator("[data-command-palette] a");
  await expect(results).toHaveCount(14);
  await expect(results.first()).toContainText("Agents");
  await expect(results.first()).toContainText("Configured agent roles");

  // The purpose is searchable, which is the reason the palette exists.
  await page.locator("#command-palette-input").fill("playtest sessions");
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText("Playtesting");

  // The answer is stated, so a screen reader hears the search resolve.
  await expect(dialog.getByRole("status")).toHaveText("1 resource matches.");

  // A search that matches nothing says so rather than showing an empty list.
  await page.locator("#command-palette-input").fill("zzzznothing");
  await expect(page.getByText("No resource matches that.")).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText(
    "No resources match that search."
  );

  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("the palette does not open while the operator is typing in a field", async ({
  page
}) => {
  await page.goto("/agents");
  await waitForPageContent(page);

  // The shortcut is for reaching the palette, not for interrupting a sentence
  // the operator is writing.
  await page.evaluate(() => {
    const field = document.createElement("input");
    field.id = "palette-probe-field";
    document.body.append(field);
    field.focus();
  });
  await page.keyboard.press("Meta+k");
  await expect(
    page.getByRole("dialog", { name: "Find a resource" })
  ).toHaveCount(0);
});

test("the palette hands the focus back to its trigger when it closes", async ({
  page
}) => {
  await page.goto("/agents");
  await waitForPageContent(page);

  const trigger = page.locator("[data-command-palette-trigger]");
  await trigger.click();
  await expect(page.locator("#command-palette-input")).toBeFocused();

  // A dialog that takes the focus and drops it would leave the operator at
  // the top of the document, further from where they were than the trigger
  // they came from.
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("the palette keeps the focus inside itself", async ({ page }) => {
  await page.goto("/agents");
  await waitForPageContent(page);

  await page.keyboard.press("Meta+k");
  const dialog = page.getByRole("dialog", { name: "Find a resource" });
  await expect(dialog).toBeVisible();

  // The dialog says it is modal, so the keyboard must not walk off it into
  // the page behind the overlay.
  const results = page.locator("[data-command-palette] a");
  const last = results.last();
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#command-palette-input")).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
});

test("the palette opens the first match with Enter", async ({ page }) => {
  await page.goto("/agents");
  await waitForPageContent(page);

  await page.keyboard.press("Meta+k");
  await page.locator("#command-palette-input").fill("playtest sessions");
  await page.keyboard.press("Enter");

  // The search answers in one keystroke: the destination is the page the
  // search matched.
  await expect(page).toHaveURL(/\/playtesting$/u);
  // And the console's own rule for a navigation still holds, because the
  // palette closed by navigating rather than by being dismissed.
  await expect(page.locator("main h1")).toBeFocused();
});
