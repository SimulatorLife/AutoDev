import { expect, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

/**
 * Every provider's Status badge offers a re-check, and the re-check asks
 * Runtime to check that provider.
 *
 * The control used to ride only on a failing verdict, on the reasoning that a
 * provider nobody has looked at is not worth looking at. That reasoning is
 * wrong in both directions: routing re-probes a provider only when a request
 * is about to use it, so a verdict nobody has re-checked is only as current as
 * the moment it was observed, and a provider that has recovered reads
 * `Unavailable` until somebody looks at it again. The operator who wants to
 * know whether a provider is serving now should not have to wait for it to
 * fail first.
 *
 * So this measures the control where it happens: on every row of the Status
 * column, in the browser, as a control that is actually on the page and
 * actually reached when it is pressed. A control that renders but cannot be
 * pressed is not a control.
 */
test("every provider row offers a re-check control that asks Runtime to re-check it", async ({
  page
}) => {
  await page.goto("/providers");
  await waitForPageContent(page);

  const rowCount = await page.locator("tbody tr").count();
  expect(rowCount).toBeGreaterThan(0);

  await expect(
    page.locator("[data-provider-check-form]"),
    "every provider row carries a re-check control, not only the failing ones"
  ).toHaveCount(rowCount);

  // Each control acts on the provider its own row names, and each one is on
  // the page: a control that is present but not drawn is no control at all.
  const controls = await page
    .locator("[data-provider-check-form]")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const form = element as HTMLFormElement;
        const button = form.querySelector(
          "[data-provider-check]"
        ) as HTMLButtonElement | null;
        const provider = form.dataset.providerCheckForm ?? "";
        const box = button?.getBoundingClientRect();
        return {
          provider,
          action: form.getAttribute("action") ?? "",
          method: form.getAttribute("method") ?? "",
          fields: Array.from(form.querySelectorAll("input")).map(
            (input) => `${input.name}=${input.value}`
          ),
          accessibleName: button?.getAttribute("aria-label") ?? "",
          width: box?.width ?? 0,
          height: box?.height ?? 0
        };
      })
    );

  for (const control of controls) {
    expect(control.provider).not.toBe("");
    expect(control.action).toBe(
      `/api/providers/${encodeURIComponent(control.provider)}/check`
    );
    expect(control.method).toBe("POST");
    // The route accepts exactly these two fields and refuses anything else.
    expect(control.fields.sort()).toEqual([
      `provider=${control.provider}`,
      "returnTo=/providers"
    ]);
    expect(control.accessibleName).toBe(
      `Re-check provider ${control.provider}`
    );
    expect(control.width).toBeGreaterThan(0);
    expect(control.height).toBeGreaterThan(0);
  }

  // Pressing it asks the Runtime to re-check that provider.
  const first = controls[0]?.provider ?? "";
  const posted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /\/api\/providers\/[^/]+\/check$/u.test(new URL(request.url()).pathname)
  );
  await page
    .locator("[data-provider-check-form]")
    .first()
    .locator("[data-provider-check]")
    .click();
  const request = await posted;
  expect(new URL(request.url()).pathname).toBe(`/api/providers/${first}/check`);
  const body = request.postData();
  expect(body).toContain(`provider=${first}`);
  expect(body).toContain("returnTo=%2Fproviders");
});
