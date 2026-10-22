/**
 * The canonical source editors, driven in a browser.
 *
 * The Console edits canonical RuleSync source through a compare-and-swap: the
 * editor holds the revision the page was rendered with, and the write carries
 * it. The states worth measuring are the ones where the write did not simply
 * succeed -- a source that moved while the page was open, and a projection
 * apply that failed after the source was saved -- because a page that reports
 * a save that did not happen is worse than a page that reports nothing.
 *
 * The fixture holds a real canonical source: the reads and the writes go
 * through the product's own RuleSync repository, so a conflict here is raised
 * by the rule the Runtime applies.
 */

import {
  type APIRequestContext,
  expect,
  type Page,
  test
} from "@playwright/test";

import { waitForPageContent } from "./acceptance-helpers.ts";

const FIXTURE_BASE_URL = `http://127.0.0.1:${process.env.AUTODEV_PLAYTEST_FIXTURE_PORT ?? "4311"}`;
const SKILL_NAME = "code-review";
const PROMPT_NAME = "review";
const SKILL_ROUTE = "/skills/code-review";
const PROMPT_ROUTE = "/prompts/review";
const SKILL_EDITOR = "[data-skill-content-editor]";
const PROMPT_EDITOR = '[data-prompt-content="observed"]';
const SKILL_REVISION = "[data-skill-revision]";
const EXPECTED_REVISION = 'input[name="expectedRevision"]';
const SKILL_SAVE = '[data-button="skill-content-save"]';
const PROMPT_SAVE = '[data-button="prompt-save"]';
const PROMPT_PREVIEW = '[data-button="prompt-preview"]';
const PROMPT_PREVIEW_PANEL = "[data-prompt-unsaved-preview]";
const PROMPT_PREVIEW_BODY = "[data-prompt-unsaved-preview-body]";
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const SKILL_SOURCE = `---\nname: ${SKILL_NAME}\ndescription: Review a diff for defects.\n---\n\nReview a diff for defects.\n`;
const PROMPT_SOURCE = `---\nname: ${PROMPT_NAME}\ndescription: Review the pending diff and report what changed.\n---\n\nReview the pending diff and report what changed.\n`;
/** The body the canonical source carries, and the one the saved source carries. */
const SAVED_BODY = "Review the pending diff and report what changed.";
/** The body an unsaved edit carries, which no saved source carries. */
const UNSAVED_BODY = "A body the operator has not saved yet.";
const UNSAVED_SOURCE = `---\nname: ${PROMPT_NAME}\ndescription: An edit that has not been saved.\n---\n\n${UNSAVED_BODY}\n`;
/** The sentence the canonical RuleSync parser refuses a source with. */
const FRONTMATTER_REFUSAL = /must have valid YAML frontmatter/u;
/** The sentence the fixture appends when a source moves behind the Console. */
const MOVED_MARKER = /Moved by another editor\./u;
/** The sentence an edit that lost the race carries. */
const LOST_RACE = /An edit that lost the race\./u;

/**
 * Puts the canonical sources back the way the fixture declares them.
 *
 * The write is real, so the source a spec leaves behind is the source the next
 * spec would load. Resetting it in both directions keeps a spec that fails
 * halfway from deciding what the next one measures.
 */
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
 * Arms the projection apply to fail after the canonical source was saved.
 *
 * The Runtime saves the source first and applies the projections second, so
 * the failure this produces leaves the source saved and the projections stale.
 */
async function armCanonicalSourceApplyFailure(
  request: APIRequestContext,
  kind: "prompt" | "skill"
): Promise<void> {
  const response = await request.post(
    `${FIXTURE_BASE_URL}/fixture/canonical-source/apply-failure?kind=${kind}`
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

/**
 * The revision the page's form was rendered with.
 *
 * The write carries this revision, so it is the one a moved source makes
 * stale.
 */
async function renderedRevision(page: Page): Promise<string> {
  const revision = await page.locator(EXPECTED_REVISION).inputValue();
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(`The page carries no source revision: ${revision}`);
  }
  return revision;
}

test.beforeEach(async ({ request }) => {
  await resetCanonicalSources(request);
});

test.afterEach(async ({ request }) => {
  await resetCanonicalSources(request);
});

test("the skill editor saves the canonical source against the revision it loaded", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SKILL_ROUTE);
  await waitForPageContent(page);

  const editor = page.locator(SKILL_EDITOR);
  await expect(editor).toHaveValue(SKILL_SOURCE);
  const revision = await renderedRevision(page);
  // The page names the revision the source is at, and the form carries the
  // same one: the write is a compare-and-swap against it.
  await expect(page.locator(SKILL_REVISION)).toHaveAttribute(
    "data-skill-revision",
    revision
  );

  const edited = `${SKILL_SOURCE}\nA second paragraph.\n`;
  await editor.fill(edited);
  await page.locator(SKILL_SAVE).click();

  // The write answers with a redirect back to the page, so the page that
  // answers it is the evidence of what the write did. The revision moves with
  // the source, so waiting for it is waiting for that page.
  await expect(page.locator(EXPECTED_REVISION)).not.toHaveValue(revision);
  await expect(page).toHaveURL(new RegExp(`${SKILL_ROUTE}$`, "u"));
  await expect(page.locator(SKILL_EDITOR)).toHaveValue(edited);
  // The source moved, so the revision the page now carries is not the one it
  // was rendered with.
  await expect(page.locator(SKILL_REVISION)).not.toHaveAttribute(
    "data-skill-revision",
    revision
  );
});

test("the skill editor refuses a write against a source that moved while the page was open", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SKILL_ROUTE);
  await waitForPageContent(page);

  const editor = page.locator(SKILL_EDITOR);
  await expect(editor).toHaveValue(SKILL_SOURCE);
  const revision = await renderedRevision(page);
  await editor.fill(`${SKILL_SOURCE}\nAn edit that lost the race.\n`);

  // The source moves while the page holds the revision it loaded.
  await moveCanonicalSource(request, "skill", SKILL_NAME);
  await page.locator(SKILL_SAVE).click();

  await expect(page).toHaveURL(
    new RegExp(
      String.raw`${SKILL_ROUTE}\?save=conflict&based=[a-f0-9]{64}$`,
      "u"
    )
  );
  const outcome = page.locator('[data-skill-content-save="conflict"]');
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("your edit was not saved");
  // The page shows the source at the revision it has moved to.
  await expect(page.locator(SKILL_REVISION)).not.toHaveAttribute(
    "data-skill-revision",
    revision
  );

  // The write still carries the revision the edit was written for. A browser
  // restores the text the operator typed into the editor when the write is
  // redirected back, so a form that carried the new revision would write
  // that edit over the change that moved the source.
  await expect(page.locator(EXPECTED_REVISION)).toHaveValue(revision);

  // Saving again is refused for the same reason, and the source keeps the
  // change that moved it.
  await page.locator(SKILL_SAVE).click();
  await expect(
    page.locator('[data-skill-content-save="conflict"]')
  ).toBeVisible();
  const stored = await storedCanonicalSource(request, "skill", SKILL_NAME);
  expect(stored).toMatch(MOVED_MARKER);
  expect(stored).not.toMatch(LOST_RACE);
});

test("the prompt editor saves the canonical command against the revision it loaded", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PROMPT_ROUTE);
  await waitForPageContent(page);

  const editor = page.locator(PROMPT_EDITOR);
  await expect(editor).toHaveValue(PROMPT_SOURCE);
  const revision = await renderedRevision(page);

  const edited = `${PROMPT_SOURCE}\nA second paragraph.\n`;
  await editor.fill(edited);
  await page.locator(PROMPT_SAVE).click();

  // The revision moves with the source, so waiting for it is waiting for the
  // page that answers the write.
  await expect(page.locator(EXPECTED_REVISION)).not.toHaveValue(revision);
  await expect(page).toHaveURL(new RegExp(`${PROMPT_ROUTE}$`, "u"));
  await expect(page.locator(PROMPT_EDITOR)).toHaveValue(edited);
  // A save that succeeded has nothing to report.
  await expect(page.locator("[data-prompt-save-outcome]")).toHaveCount(0);
});

test("the prompt editor refuses a write against a command that moved while the page was open", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PROMPT_ROUTE);
  await waitForPageContent(page);

  const editor = page.locator(PROMPT_EDITOR);
  await expect(editor).toHaveValue(PROMPT_SOURCE);
  const revision = await renderedRevision(page);
  await editor.fill(`${PROMPT_SOURCE}\nAn edit that lost the race.\n`);

  await moveCanonicalSource(request, "prompt", PROMPT_NAME);
  await page.locator(PROMPT_SAVE).click();

  await expect(page).toHaveURL(
    new RegExp(
      String.raw`${PROMPT_ROUTE}\?save=conflict&based=[a-f0-9]{64}$`,
      "u"
    )
  );
  await expect(
    page.locator('[data-prompt-save-outcome="conflict"]')
  ).toBeVisible();
  // The write still carries the revision the edit was written for, so the
  // edit cannot be written over the change that moved the source.
  await expect(page.locator(EXPECTED_REVISION)).toHaveValue(revision);

  // Saving again is refused for the same reason, and the source keeps the
  // change that moved it.
  await page.locator(PROMPT_SAVE).click();
  await expect(
    page.locator('[data-prompt-save-outcome="conflict"]')
  ).toBeVisible();
  const stored = await storedCanonicalSource(request, "prompt", PROMPT_NAME);
  expect(stored).toMatch(MOVED_MARKER);
  expect(stored).not.toMatch(LOST_RACE);
});

test("the prompt editor reports a failed apply instead of claiming the projections were applied", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PROMPT_ROUTE);
  await waitForPageContent(page);

  const editor = page.locator(PROMPT_EDITOR);
  await expect(editor).toHaveValue(PROMPT_SOURCE);
  await editor.fill(`${PROMPT_SOURCE}\nA change whose projection fails.\n`);

  // The source is saved and the projection apply fails afterwards, which is
  // the state the Runtime reports separately.
  await armCanonicalSourceApplyFailure(request, "prompt");
  await page.locator(PROMPT_SAVE).click();

  await expect(page).toHaveURL(
    new RegExp(String.raw`${PROMPT_ROUTE}\?save=apply-failed$`, "u")
  );
  const outcome = page.locator('[data-prompt-save-outcome="apply-failed"]');
  await expect(outcome).toBeVisible();
  // The message says the apply failed. It does not say the change was
  // applied, because the projection was not.
  await expect(outcome).toContainText("apply failed");
  await expect(outcome).not.toContainText("was applied");
  // The source was saved, so the page's editor holds what was written.
  const stored = await storedCanonicalSource(request, "prompt", PROMPT_NAME);
  expect(stored).toContain("A change whose projection fails.");
});

test("the prompt editor previews the unsaved source without saving it", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PROMPT_ROUTE);
  await waitForPageContent(page);

  const editor = page.locator(PROMPT_EDITOR);
  await expect(editor).toHaveValue(PROMPT_SOURCE);

  // The editor holds the edit, and the edit has not been saved: the preview is
  // the only thing that has happened.
  await editor.fill(UNSAVED_SOURCE);
  await page.locator(PROMPT_PREVIEW).click();

  const preview = page.locator(PROMPT_PREVIEW_PANEL);
  await expect(preview).toHaveAttribute(
    "data-prompt-unsaved-preview",
    "observed"
  );
  const body = page.locator(PROMPT_PREVIEW_BODY);
  await expect(body).toContainText(UNSAVED_BODY);
  // The preview shows the body the unsaved source carries, not the body the
  // saved source carries.
  await expect(body).not.toContainText(SAVED_BODY);

  // A preview writes nothing. The canonical source is what it was, so the edit
  // the operator looked at is still only in the editor.
  const stored = await storedCanonicalSource(request, "prompt", PROMPT_NAME);
  expect(stored).toContain(SAVED_BODY);
  expect(stored).not.toContain(UNSAVED_BODY);
});

test("the prompt editor reports the parser's refusal for a source the parser refuses", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PROMPT_ROUTE);
  await waitForPageContent(page);

  const editor = page.locator(PROMPT_EDITOR);
  await editor.fill("A source with no front matter.\n");
  await page.locator(PROMPT_PREVIEW).click();

  await expect(page.locator(PROMPT_PREVIEW_PANEL)).toHaveAttribute(
    "data-prompt-unsaved-preview",
    "invalid"
  );
  // The refusal is the parser's own reason, not the page's opinion of it.
  await expect(page.locator(PROMPT_PREVIEW_BODY)).toContainText(
    FRONTMATTER_REFUSAL
  );
  // A refused preview is still a preview: nothing was written.
  const stored = await storedCanonicalSource(request, "prompt", PROMPT_NAME);
  expect(stored).not.toContain("A source with no front matter.");
});
