import { expect, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

/**
 * A control that shows a state names that state.
 *
 * The agent and model enablement pills wear the item's current value and
 * activate the opposite, so one control carries both facts. The accessible
 * name has to carry them too: `aria-label` overrides the button's content, so
 * a name that carried only the action left the state reachable by sight alone.
 *
 * Read out of the accessibility tree, every agent row's pill used to announce
 * "Disable browser-tester" -- and nothing said whether any of them was
 * currently enabled. The visible word was the state, and it never reached
 * assistive technology.
 *
 * This is a rendering claim, so it is measured where it happens: the browser's
 * own accessible name for the control, against the word the control shows.
 */
test("the agent enablement pill names the state it shows", async ({ page }) => {
  await page.goto("/agents");
  await waitForPageContent(page);

  const pills = page.locator('[data-enablement="agent"]');
  const count = await pills.count();
  expect(count, "the agents page renders enablement pills").toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const pill = pills.nth(index);
    const shown = ((await pill.textContent()) ?? "").trim();
    expect(shown.length, "the pill shows its state as a word").toBeGreaterThan(
      0
    );

    // The accessible name has to contain the word that is visible, which is
    // WCAG 2.5.3's Label in Name, and it has to state the action as well.
    await expect(pill).toHaveAccessibleName(new RegExp(`^${shown}: `));
  }
});
