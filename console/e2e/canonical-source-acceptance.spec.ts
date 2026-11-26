/** Read-only source and rendered content share one loaded revision. */

import {
  type APIRequestContext,
  expect,
  type Page,
  test
} from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const cases = [
  { kind: "skill", name: "code-review", path: "/skills/code-review", body: "Review a diff for defects." },
  { kind: "prompt", name: "review", path: "/prompts/review", body: "Review the pending diff and report what changed." }
] as const;
const MOVED_MARKER = "Moved by another editor.";

async function resetCanonicalSources(
  request: APIRequestContext
): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/canonical-source/reset`
  );
  expect(response.ok()).toBe(true);
}

/**
 * Moves a canonical source without the Console knowing.
 *
 * The page that has the source open holds the revision it was rendered with,
 * so moving the source here is what makes its next write a conflict rather
 * than a silent overwrite of somebody else's edit.
 */
async function moveCanonicalSource(
  request: APIRequestContext,
  kind: "prompt" | "skill",
  name: string
): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/canonical-source/move?kind=${kind}&name=${name}`
  );
  expect(response.ok()).toBe(true);
}

/**
 * The canonical source as the service holds it.
 *
 * This is the source itself rather than the page's copy of it: a write that
 * was refused must leave the source as it was, and only the service can say
 * what it holds.
 */
async function storedCanonicalSource(
  request: APIRequestContext,
  kind: "prompt" | "skill",
  name: string
): Promise<string> {
  const path =
    kind === "skill"
      ? `/control/skills/${name}/content`
      : `/control/prompts/${name}`;
  const response = await request.get(`${FIXTURE_BASE_URL}${path}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { readonly content: string };
  return body.content;
}

test.beforeEach(async ({ request }) => {
  await resetCanonicalSources(request);
});

test.afterEach(async ({ request }) => {
  await resetCanonicalSources(request);
});

for (const item of cases) {
  test(`${item.kind} displays the loaded revision, not a later source, until reload`, async ({ page, request }) => {
    const original = await storedCanonicalSource(request, item.kind, item.name);
    await page.goto(item.path);
    await waitForPageContent(page);
    const view = page.locator("[data-source-view]");
    await expect(view.locator("[data-source-rendered]")).toContainText(item.body);

    await moveCanonicalSource(request, item.kind, item.name);
    const moved = await storedCanonicalSource(request, item.kind, item.name);
    expect(moved).not.toBe(original);
    expect(moved).toContain(MOVED_MARKER);

    const mutations: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/") && request.method() !== "GET") mutations.push(request.url());
    });
    const source = view.getByRole("button", { name: "Source", exact: true });
    await source.click();
    expect(await view.getByLabel("Canonical source").textContent()).toBe(original);
    await expect(source).toBeFocused();
    await view.getByRole("button", { name: "Rendered", exact: true }).click();
    await expect(view.locator("[data-source-rendered]")).not.toContainText(MOVED_MARKER);
    expect(mutations).toEqual([]);
    expect(await storedCanonicalSource(request, item.kind, item.name)).toBe(moved);
    await expect(page.locator("textarea, form[method=POST]")).toHaveCount(0);

    await page.reload();
    await waitForPageContent(page);
    await expect(view.locator("[data-source-rendered]")).toContainText(MOVED_MARKER);
    await source.click();
    expect(await view.getByLabel("Canonical source").textContent()).toBe(moved);
  });
}
