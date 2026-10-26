import { expect, type Locator, type Page, test } from "@playwright/test";

import { documentFitsViewport } from "./acceptance-helpers.ts";

const MOUNTED_DOCUMENT_TOKEN = "mounted-document-1";
/** The list the Agent trail's ancestor names. */
const AGENTS_LIST_URL = /\/agents$/u;
const AGENT_ROLE = "default";
const SKILL_NAME = "code-review";
const PROMPT_NAME = "review";
const MCP_SERVER = "lsp";
const MCP_TOOL_ID = "mcp__lsp__lsp_goto_definition";
const WORKSPACE_ID = "fixture/game";
const PROVIDER_ID = "claude";
const MODEL_ID = "sonnet";
const HOOK_EVENT = "preToolUse";

/**
 * One entry of a breadcrumb trail.
 *
 * An ancestor is a destination the operator can go back to, so it carries an
 * `href`. The current page is where the operator already is, so it carries
 * none: a trail that links to the page it is on offers a navigation that
 * goes nowhere.
 */
interface TrailEntry {
  readonly label: string;
  readonly href: string | null;
}

/**
 * One detail surface and the trail it presents.
 */
interface DetailSurface {
  readonly url: string;
  readonly trail: readonly TrailEntry[];
}

const AGENT_SURFACE: DetailSurface = {
  url: `/agents/${AGENT_ROLE}`,
  trail: [
    { label: "Agents", href: "/agents" },
    { label: AGENT_ROLE, href: null }
  ]
};

const SKILL_SURFACE: DetailSurface = {
  url: `/skills/${SKILL_NAME}`,
  trail: [
    { label: "Skills", href: "/skills" },
    { label: SKILL_NAME, href: null }
  ]
};

const PROMPT_SURFACE: DetailSurface = {
  url: `/prompts/${PROMPT_NAME}`,
  trail: [
    { label: "Prompts", href: "/prompts" },
    { label: PROMPT_NAME, href: null }
  ]
};

const MCP_SURFACE: DetailSurface = {
  url: `/mcps/${MCP_SERVER}`,
  trail: [
    { label: "MCPs", href: "/mcps" },
    { label: MCP_SERVER, href: null }
  ]
};

const TOOL_SURFACE: DetailSurface = {
  url: `/tools/${MCP_TOOL_ID}`,
  trail: [
    { label: "Tools", href: "/tools" },
    { label: MCP_TOOL_ID, href: null }
  ]
};

const WORKSPACE_SURFACE: DetailSurface = {
  url: `/workspaces/${WORKSPACE_ID}`,
  trail: [
    { label: "Workspaces", href: "/workspaces" },
    { label: WORKSPACE_ID, href: null }
  ]
};

const PROVIDER_SURFACE: DetailSurface = {
  url: `/providers/${PROVIDER_ID}`,
  trail: [
    { label: "Providers", href: "/providers" },
    { label: PROVIDER_ID, href: null }
  ]
};

const MODEL_SURFACE: DetailSurface = {
  url: `/providers/${PROVIDER_ID}/models/${MODEL_ID}`,
  trail: [
    { label: "Providers", href: "/providers" },
    { label: PROVIDER_ID, href: `/providers/${PROVIDER_ID}` },
    { label: MODEL_ID, href: null }
  ]
};

const HOOK_SURFACE: DetailSurface = {
  url: `/hooks/${HOOK_EVENT}`,
  trail: [
    { label: "Hooks", href: "/hooks" },
    { label: HOOK_EVENT, href: null }
  ]
};

/**
 * The breadcrumb landmark of one page.
 *
 * The landmark is named, so it is found by its own name rather than by being
 * the first `<nav>` on the page: the detail pages carry other navigation
 * (the MCP tab bar, the Providers tab bar), and a trail that silently
 * borrowed another's name would still pass an unnamed search.
 */
function breadcrumbTrail(page: Page): Locator {
  return page.getByRole("navigation", { name: "Breadcrumb" });
}

/**
 * The trail of a page that has finished loading.
 *
 * The Console streams a page: the route's shell arrives first with the
 * section's loading state, and the page's own content is swapped in once the
 * server has the data. Until that swap the trail is in the document but is
 * not in the accessibility tree, so reading it then reads nothing. Waiting
 * for the trail to be visible is also the claim worth making: a trail the
 * operator cannot see is not a trail.
 */
async function visibleBreadcrumbTrail(page: Page): Promise<Locator> {
  const landmark = breadcrumbTrail(page);
  await expect(landmark).toBeVisible();
  return landmark;
}

/**
 * The trail of one surface, read as the operator reads it.
 *
 * The separators are decoration and are hidden from assistive technology, so
 * they are removed before the labels are read: a trail that reads
 * "Agents / default" is a sentence with a slash in it rather than a list of
 * places.
 */
function readTrail(landmark: Locator): Promise<readonly string[]> {
  return landmark.locator("ol > li").evaluateAll((nodes) =>
    nodes.map((node) => {
      const copy = (node as HTMLElement).cloneNode(true) as HTMLElement;
      copy
        .querySelectorAll('[aria-hidden="true"]')
        .forEach((hidden) => hidden.remove());
      return (copy.textContent ?? "").trim();
    })
  );
}
/**
 * One detail surface's trail, asserted in full.
 *
 * The claims are the ones the shared component makes: one landmark, an
 * ordered list, every ancestor a native link to the place it names, the
 * current page marked as the current page and not linked, and no
 * placeholder destination anywhere in the trail.
 */
async function assertTrail(page: Page, surface: DetailSurface): Promise<void> {
  await page.goto(surface.url);

  const landmark = await visibleBreadcrumbTrail(page);
  await expect(landmark).toHaveCount(1);

  const items = landmark.locator("ol > li");
  await expect(items).toHaveCount(surface.trail.length);

  await Promise.all(
    surface.trail.map(async (entry, index) => {
      const item = items.nth(index);
      if (entry.href === null) {
        // The current page: marked for assistive technology, and not a link
        // back to itself.
        await expect(item.locator('[aria-current="page"]')).toHaveText(
          entry.label
        );
        await expect(item.getByRole("link")).toHaveCount(0);
        return;
      }
      const ancestor = item.getByRole("link", {
        name: entry.label,
        exact: true
      });
      await expect(ancestor).toHaveCount(1);
      await expect(ancestor).toHaveAttribute("href", entry.href);
      await expect(item.locator('[aria-current="page"]')).toHaveCount(0);
    })
  );

  // A placeholder destination is a link that goes nowhere, and a trail with
  // one teaches the operator that the trail is decoration.
  await expect(landmark.locator('a[href="#"]')).toHaveCount(0);

  // The separators are decoration, so they are hidden from assistive
  // technology; the trail reads as a list of places, not as a sentence with
  // slashes in it.
  await expect(landmark.locator('[aria-hidden="true"]')).toHaveCount(
    surface.trail.length - 1
  );
}

test("every detail surface presents one breadcrumb landmark with its ancestors as links", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  await assertTrail(page, AGENT_SURFACE);
  await assertTrail(page, SKILL_SURFACE);
  await assertTrail(page, PROMPT_SURFACE);
  await assertTrail(page, MCP_SURFACE);
  await assertTrail(page, TOOL_SURFACE);
  await assertTrail(page, WORKSPACE_SURFACE);
  await assertTrail(page, PROVIDER_SURFACE);
  await assertTrail(page, MODEL_SURFACE);
  await assertTrail(page, HOOK_SURFACE);
});

test("the breadcrumb trail names the place the operator is on, in the order it was walked", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto(MODEL_SURFACE.url);
  // The model is under its provider, which is under the catalog. A trail
  // that named only the model would make the operator recall which provider
  // they are looking at.
  expect(await readTrail(await visibleBreadcrumbTrail(page))).toEqual([
    "Providers",
    PROVIDER_ID,
    MODEL_ID
  ]);

  await page.goto(AGENT_SURFACE.url);
  expect(await readTrail(await visibleBreadcrumbTrail(page))).toEqual([
    "Agents",
    AGENT_ROLE
  ]);
});

test("a breadcrumb ancestor leads back to its list without remounting the document", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto(AGENT_SURFACE.url);
  const trail = await visibleBreadcrumbTrail(page);
  await page.evaluate((token) => {
    (
      globalThis as typeof globalThis & {
        __autodevNavigationMountToken?: string;
      }
    ).__autodevNavigationMountToken = token;
  }, MOUNTED_DOCUMENT_TOKEN);

  await trail.getByRole("link", { name: "Agents", exact: true }).click();

  await expect(page).toHaveURL(AGENTS_LIST_URL);
  // The list the ancestor named is the page that opened, and the trail is
  // gone because the list is not a detail page.
  await expect(page.getByText("Ready Agents", { exact: true })).toBeVisible();
  await expect(breadcrumbTrail(page)).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __autodevNavigationMountToken?: string;
          }
        ).__autodevNavigationMountToken
    )
  ).toBe(MOUNTED_DOCUMENT_TOKEN);
});

test("the trail keeps its labels inside the page at a phone width", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  // The longest trail and the longest label in it: a canonical identifier is
  // one unbreakable token, so it is the trail that has to give way rather
  // than the page.
  await page.goto(MODEL_SURFACE.url);
  await visibleBreadcrumbTrail(page);
  expect(await documentFitsViewport(page)).toBe(true);

  await page.goto(TOOL_SURFACE.url);
  const trail = await visibleBreadcrumbTrail(page);
  expect(await documentFitsViewport(page)).toBe(true);

  // A truncated label keeps its full text reachable, so an operator can
  // still read which tool the page is about.
  await expect(trail.locator('[aria-current="page"]')).toHaveAttribute(
    "title",
    MCP_TOOL_ID
  );
});
