import { expect, test } from "@playwright/test";

import {
  CANONICAL_ROUTES,
  DETAIL_ROUTES,
  waitForPageContent
} from "./acceptance-helpers.ts";

/**
 * Every landmark the Console renders is named.
 *
 * A landmark is a region an operator can jump to, and they find it by its
 * name: the breadcrumb trail is found as "Breadcrumb" rather than as the first
 * navigation on the page, and the filter bars are found as "Usage filters" or
 * "Skill filters". The Console's own filter bar says why it names its form --
 * "an accessible name, so the form is a named landmark rather than an
 * anonymous one" -- and that rule was not held everywhere.
 *
 * The write surfaces inside table cells are where it was not held. Each row
 * of the providers table, the agents table and the skills table carries a form
 * that submits a write, and Chromium exposes an unnamed `<form>` as a
 * landmark: nineteen of them on the providers page, each one called "form",
 * each one naming nothing. A landmark list of thirty-four anonymous entries
 * is not a list an operator can use, and the cells those forms live in are
 * already groups.
 *
 * So a write surface is a group of controls rather than a landmark, and the
 * landmarks that are left are the ones an operator would want to jump to.
 *
 * The names are also unique within a kind, because a name that two landmarks
 * share is a name that finds the wrong one.
 */
const NAMED_LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "navigation",
  "region",
  "search"
]);

const ROUTES = [...CANONICAL_ROUTES, ...DETAIL_ROUTES];

for (const route of ROUTES) {
  test(`${route.path} names every landmark it renders`, async ({ page }) => {
    await page.goto(route.path);
    await waitForPageContent(page);

    // The tree the browser builds for assistive technology.
    const client = await page.context().newCDPSession(page);
    await client.send("Accessibility.enable");
    const { nodes } = await client.send("Accessibility.getFullAXTree");

    const landmarks = nodes.filter((node) => {
      const role = node.role?.value;
      if (role === undefined) return false;
      if (!NAMED_LANDMARK_ROLES.has(role) && role !== "main") {
        return false;
      }
      return node.ignored !== true;
    });

    const unnamed = landmarks
      .filter(
        (node) =>
          node.role?.value !== "main" &&
          (node.name?.value ?? "").trim().length === 0
      )
      .map((node) => node.role?.value ?? "landmark");

    expect(
      unnamed,
      `${route.path} renders ${String(unnamed.length)} landmark(s) with no name`
    ).toEqual([]);

    // Two landmarks of one kind may not share a name.
    const byRole = new Map<string, string[]>();
    for (const landmark of landmarks) {
      const role = landmark.role?.value ?? "landmark";
      const names = byRole.get(role) ?? [];
      names.push((landmark.name?.value ?? "").trim());
      byRole.set(role, names);
    }
    const ambiguous = [...byRole.entries()]
      .filter(([, names]) => new Set(names).size < names.length)
      .map(([role, names]) => `${role}: ${names.join(" | ")}`);

    expect(
      ambiguous,
      `${route.path} renders landmarks that share a name: ${ambiguous.join("; ")}`
    ).toEqual([]);
  });
}
