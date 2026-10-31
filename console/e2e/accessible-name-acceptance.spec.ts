import { expect, test } from "@playwright/test";

import { SWEEP_ROUTES, waitForPageContent } from "./acceptance-helpers.ts";

/**
 * Every control has a name.
 *
 * The label-in-name acceptance checks that a control's name *contains* what the
 * control shows. That is the other half of the rule, and it needs its own
 * guard: a control with no name at all has nothing to contain, so it passes a
 * name comparison vacuously, and a control the operator can see but a screen
 * reader cannot name is invisible to the person using one.
 *
 * The name is read from the browser's accessibility tree rather than from the
 * markup, because the markup is not what a screen reader says. An `aria-label`
 * replaces a control's own content, so a button whose text is "Enabled" can
 * be named something else entirely, and a control whose name comes from a
 * hidden label has no name in the source to find.
 *
 * The roles are the ones an operator reaches for: the things that take a
 * click, a focus, a keystroke or a selection.
 */
const CONTROL_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "tab",
  "option"
]);

const ROUTES = SWEEP_ROUTES;

for (const path of ROUTES) {
  test(`${path} names every control it renders`, async ({ page }) => {
    await page.goto(path);
    await waitForPageContent(page);

    // The tree the browser builds for assistive technology.
    const client = await page.context().newCDPSession(page);
    await client.send("Accessibility.enable");
    const { nodes } = await client.send("Accessibility.getFullAXTree");

    const unnamed: string[] = [];
    for (const node of nodes) {
      const role = node.role?.value;
      if (role === undefined || !CONTROL_ROLES.has(role)) continue;
      // A node the tree ignores is not a control the operator can meet.
      if (node.ignored === true) continue;
      const name = node.name?.value ?? "";
      if (name.trim().length === 0) unnamed.push(role);
    }

    expect(
      unnamed,
      `${path} renders ${String(unnamed.length)} control(s) with no accessible name`
    ).toEqual([]);
  });
}
