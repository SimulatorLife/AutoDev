/**
The JSONC source view of a read-only declaration.

The selector is the one the skills and prompts pages already use, so the
acceptance drives it the same way: the rendered side is what the page is
showing, the raw side is the canonical source with its comments, and
switching is a presentation action that writes nothing.
*/

import { type APIRequestContext, expect, test } from "@playwright/test";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;

const cases = [
  {
    path: "/hooks",
    resource: "/control/hooks",
    // A comment the source holds and a serialization of it would not.
    sourceMarker: "// The hook every target inherits.",
    renderedMarker: "preToolUse"
  },
  {
    path: "/hooks/preToolUse",
    resource: "/control/hooks",
    sourceMarker: "// The hook every target inherits.",
    renderedMarker: "Declared for"
  },
  {
    path: "/permissions",
    resource: "/control/permissions",
    sourceMarker: "// The portable policy the session runs under.",
    renderedMarker: "on-request"
  }
] as const;

/**
The revision the service publishes for a resource.

It is the revision the page shows, so the two views of the declaration are
known to describe the same bytes rather than merely the same file.
*/
async function publishedRevision(
  request: APIRequestContext,
  resource: string
): Promise<string> {
  const response = await request.get(`${FIXTURE_BASE_URL}${resource}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { readonly revision: string };
  return body.revision;
}

for (const item of cases) {
  test(`${item.path} offers the canonical source beside the rendered declaration`, async ({
    page,
    request
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    // Switching a view is a presentation action. A read-only declaration has
    // no write, so the page must not post one to switch views.
    const mutations: string[] = [];
    page.on("request", (sent) => {
      if (sent.url().includes("/api/") && sent.method() !== "GET") {
        mutations.push(sent.url());
      }
    });

    await page.goto(item.path);

    // The revision the page names is the revision of the source it shows.
    const revision = await publishedRevision(request, item.resource);
    await expect(
      page.getByText(`revision ${revision.slice(0, 12)}`)
    ).toBeVisible();

    const view = page.locator("[data-source-view]");
    await expect(view).toHaveCount(1);
    // The page opens on the rendered side.
    await expect(view.locator("[data-source-rendered]")).toContainText(
      item.renderedMarker
    );

    const source = view.getByRole("button", { name: "JSONC", exact: true });
    await source.click();
    await expect(view).toHaveAttribute("data-source-view", "source");
    // The raw view is the canonical source: the comment is in it, and a
    // serialization of the declaration would not carry it.
    await expect(view.getByLabel("Canonical source")).toContainText(
      item.sourceMarker
    );
    expect(mutations).toEqual([]);

    // The rendered side is still there to go back to, and going back writes
    // nothing either.
    await view.getByRole("button", { name: "Rendered", exact: true }).click();
    await expect(view).toHaveAttribute("data-source-view", "rendered");
    expect(mutations).toEqual([]);
  });
}
