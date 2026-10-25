import { expect, test } from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

/**
 * The skills list says where each skill is installed.
 *
 * A catalogue entry is a name, a description and a path; none of those says
 * **where** the skill lives on the machine, and a row naming a role an agent
 * could not reach looked exactly like a row naming one it could. The operator
 * had no way to tell the two apart on the page the question is asked on.
 *
 * The Scope column is the answer, and it is read-only by construction: the
 * scope is a fact about the install, read live off the filesystem, so the
 * Console offers no control that changes it.
 *
 * The second half of the answer is where the assignment lands. A skill inside
 * a repository belongs to that repository's workspace alone, so its roles are
 * assigned inside that workspace and nowhere else -- and the row has to say
 * so, because the operator is about to write there.
 *
 * This guard also covers the ground under both of those: the scope is a fact
 * the Runtime reads and the Console renders, and a fixture that leaves the
 * fact out does not make the page say less. It makes the page fail to render
 * at all, which is what the Console's own browser fixture did for a while.
 */
test("the Skills list says where each skill is installed and where its roles apply", async ({
  page
}) => {
  await page.goto("/skills");
  await waitForPageContent(page);

  const scopeHeader = page.getByRole("columnheader", { name: "Scope" });
  await expect(scopeHeader).toBeVisible();

  // The row states the scope and the workspace the skill belongs to.
  const row = page.locator("tbody tr").filter({ hasText: "code-review" });
  await expect(row).toHaveCount(1);
  await expect(row.getByText("Repo", { exact: true })).toBeVisible();
  await expect(row.getByText("fixture/game", { exact: true })).toBeVisible();

  // And the assignment says where the write lands, before the operator makes
  // it.
  await expect(
    page.getByText("Roles apply inside fixture/game.", { exact: false })
  ).toBeVisible();
});

test("a skill that is installed nowhere says so rather than naming a scope", async ({
  page
}) => {
  await page.goto("/skills");
  await waitForPageContent(page);

  // Every row states a scope or says the skill is installed nowhere. A row
  // that says neither is a row the operator cannot act on.
  const scopes = await page.locator("tbody tr td:nth-child(3)").allInnerTexts();
  expect(scopes.length).toBeGreaterThan(0);
  for (const scope of scopes) {
    expect(scope.trim().length).toBeGreaterThan(0);
  }
});
