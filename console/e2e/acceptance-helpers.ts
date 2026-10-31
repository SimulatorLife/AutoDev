import { expect, type Locator, type Page } from "@playwright/test";

/**
 * One canonical resource route and the resource it answers with.
 */
export interface CanonicalRoute {
  /** The route's path. */
  readonly path: string;
  /** The section the route belongs to, which is what the sidebar marks. */
  readonly section: string;
  /** The heading the route answers with. */
  readonly heading: string;
}

/**
 * Wait until the page's own content has replaced its loading shell, and the
 * client has taken the page over.
 *
 * The Console streams a page: the shell and its loading state arrive first
 * and the resource's own content is swapped in afterwards. Measuring the
 * shell would measure the placeholder rather than the page.
 *
 * The content arriving is not the same as the client arriving. The markup is
 * server-rendered, so the page is on the screen before the bundle that makes
 * it respond has run -- and everything the operator does with the keyboard,
 * the palette's shortcut, the filters and the write controls all belong to
 * the client. A keystroke in the gap between the two goes nowhere, and a
 * page that has been asserted against in that gap passes every check about
 * what it shows and fails every check about what it does.
 *
 * So the wait requires both, and the page publishes the difference: the
 * marker is rendered with the page's own content, so it cannot be set by the
 * loading state that stands in for a page that has not arrived.
 */
export async function waitForPageContent(page: Page): Promise<void> {
  await expect(page.locator("[data-feature]").first()).toBeVisible();
  await expect(page.locator("[data-console-loading]")).toHaveCount(0);
  await expect(
    page.locator("[data-hydration-marker][data-hydrated='true']")
  ).toHaveCount(1);
}

/**
 * Wait for a route to answer with its heading, and say *why* it did not.
 *
 * A page that never renders its heading has two very different causes, and
 * they need opposite responses. The first is a broken page: the markup is
 * there and the heading is not. The second is a server that could not answer:
 * Next's client bundle timed out loading and the framework replaced the page
 * with its own error boundary, so the heading the server rendered is gone and
 * the page says "a client-side exception has occurred".
 *
 * The second is not a page fault, and reporting it as one sends the reader
 * looking for a defect in the Console. It is what a starved machine looks
 * like: measured on a loaded box, the chunk request took 124 seconds against
 * a 120-second chunk timeout, while the same server answered that chunk in
 * 12 milliseconds once the machine was quiet.
 *
 * So the wait fails fast and says which of the two it is.
 */
export async function expectRouteHeading(
  page: Page,
  route: CanonicalRoute
): Promise<void> {
  try {
    await expect(routeHeading(page, route)).toBeVisible();
  } catch (error) {
    const boundary = await page
      .locator("text=Application error")
      .first()
      .isVisible()
      .catch(() => false);
    if (boundary) {
      throw new Error(
        `${route.path} fell back to Next's client-side error boundary: the page's ` +
          "client bundle did not load. The server could not answer in time, which " +
          "is a machine under load rather than a page that failed. Check the load " +
          "average before reading this as a Console defect."
      );
    }
    throw error;
  }
}

/**
 * The canonical resources the target state names.
 *
 * The grouping is presentation only: all fourteen resources have first-class
 * routes, and each one answers with its own resource rather than with a
 * shared surface that says something about all of them.
 */
export const CANONICAL_ROUTES: readonly CanonicalRoute[] = [
  { path: "/agents", section: "agents", heading: "Agents" },
  { path: "/providers", section: "providers", heading: "Providers" },
  { path: "/mcps", section: "mcps", heading: "MCPs" },
  { path: "/skills", section: "skills", heading: "Skills" },
  { path: "/hooks", section: "hooks", heading: "Hooks" },
  { path: "/prompts", section: "prompts", heading: "Prompts" },
  { path: "/permissions", section: "permissions", heading: "Permissions" },
  { path: "/tools", section: "tools", heading: "Tools" },
  { path: "/usage", section: "usage", heading: "Usage" },
  { path: "/evaluations", section: "evaluations", heading: "Evaluations" },
  { path: "/memory", section: "memory", heading: "Memory" },
  { path: "/playtesting", section: "playtesting", heading: "Playtesting" },
  { path: "/workspaces", section: "workspaces", heading: "Workspaces" },
  { path: "/github", section: "github", heading: "GitHub" }
];

/**
 * The detail surfaces of the resources that have one.
 *
 * A detail page carries the resource's own heading and names the item it is
 * about underneath it, so the heading here is the resource's rather than the
 * item's.
 *
 * The workspace detail is not among them: its page reads the Playtesting
 * approval panel, and that surface belongs to the session working on
 * Playtesting, so a sweep that judged it would be answering for work that is
 * not this one's to judge.
 */
export const DETAIL_ROUTES: readonly CanonicalRoute[] = [
  { path: "/agents/default", section: "agents", heading: "Agents" },
  { path: "/providers/claude", section: "providers", heading: "Providers" },
  {
    path: "/providers/claude/models/sonnet",
    section: "providers",
    heading: "Providers"
  },
  { path: "/mcps/lsp", section: "mcps", heading: "MCPs" },
  { path: "/prompts/review", section: "prompts", heading: "Prompts" },
  { path: "/skills/code-review", section: "skills", heading: "Skills" },
  { path: "/hooks/preToolUse", section: "hooks", heading: "Hooks" },
  {
    path: "/tools/mcp__lsp__lsp_goto_definition",
    section: "tools",
    heading: "Tools"
  }
];

/**
 * The surfaces that are a section's own view rather than the section itself.
 *
 * A section reached with a view chosen is a different surface from the section:
 * the Memory page's tabs, the Playtesting page's four views, the Evaluations
 * page's comparisons and the Usage dashboard's live scope each carry their own
 * tables, and the canonical route never reaches them. A sweep that stops at
 * the sections cannot report on any of them.
 *
 * Their heading is their section's heading, because a view is a view of that
 * section and says so the same way its detail pages do.
 */
export const SUBSURFACE_ROUTES: readonly CanonicalRoute[] = [
  {
    path: "/memory?tab=experiences&experienceId=exp-0001",
    section: "memory",
    heading: "Memory"
  },
  { path: "/memory?tab=cohorts", section: "memory", heading: "Memory" },
  {
    path: "/memory?tab=records&workspaceId=fixture%2Fgame&recordId=mem-0001",
    section: "memory",
    heading: "Memory"
  },
  {
    path: "/playtesting/sessions/episode-17?workspaceId=fixture%2Fgame",
    section: "playtesting",
    heading: "Playtesting"
  },
  {
    path: "/playtesting/sessions/episode-visual-debrief?workspaceId=fixture%2Fgame",
    section: "playtesting",
    heading: "Playtesting"
  },
  {
    path: "/playtesting?view=overview&workspaceId=fixture%2Fgame",
    section: "playtesting",
    heading: "Playtesting"
  },
  {
    path: "/playtesting?view=sessions&workspaceId=fixture%2Fgame",
    section: "playtesting",
    heading: "Playtesting"
  },
  {
    path: "/playtesting?view=findings&workspaceId=fixture%2Fgame",
    section: "playtesting",
    heading: "Playtesting"
  },
  {
    path: "/playtesting?view=compare&workspaceId=fixture%2Fgame",
    section: "playtesting",
    heading: "Playtesting"
  },
  {
    path: "/evaluations?tab=comparisons",
    section: "evaluations",
    heading: "Evaluations"
  },
  {
    path: "/usage?range=ACTIVE_SESSIONS",
    section: "usage",
    heading: "Usage"
  }
];

/**
 * Every surface the Console's own sweeps walk.
 *
 * The canonical routes are the Console's sections and the detail routes are
 * its resources. The Memory page's tabs are surfaces of a surface, and so is
 * the claim drawer behind a claim's link -- a sweep that stops at the sections
 * never reaches either of them, and what it cannot reach it cannot report.
 */
/**
 * Every surface the Console's own sweeps walk, with the heading each answers.
 *
 * One list, so that a surface is named once: the sweeps that need only a path
 * take the paths, and the sweeps that need a heading -- the responsive one,
 * which waits for the page's own name before it measures anything -- take the
 * routes.
 */
export const SWEEP_SURFACES: readonly CanonicalRoute[] = [
  ...CANONICAL_ROUTES,
  ...DETAIL_ROUTES,
  ...SUBSURFACE_ROUTES
];

export const SWEEP_ROUTES: readonly string[] = SWEEP_SURFACES.map(
  (route) => route.path
);

/**
 * The heading a route answers with.
 */
export function routeHeading(page: Page, route: CanonicalRoute): Locator {
  return page.getByRole("heading", { name: route.heading, level: 1 });
}

/**
 * Whether the document is no wider than the window it is read in.
 *
 * A page that scrolls sideways is not narrow, it is broken: the operator has
 * to scroll to read a row, and the scrollbar at the bottom of the window is
 * the only cue that there is more to the right.
 */
export function documentFitsViewport(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= globalThis.innerWidth
  );
}

/**
 * The headings of a document, in the order they appear.
 */
export interface HeadingStructure {
  /** One heading, with the level it was written at. */
  readonly level: number;
  /** The heading's text. */
  readonly text: string;
}

/**
 * The headings of a document and the identifiers it repeats.
 *
 * A heading that skips a level (`h2` straight to `h4`) tells a screen reader
 * that something is missing between them, and a repeated identifier makes a
 * fragment link and a label point at the first of the two rather than the one
 * the author meant.
 */
export interface DocumentStructure {
  /** The headings, in document order. */
  readonly headings: readonly HeadingStructure[];
  /** The identifiers that appear more than once. */
  readonly duplicateIds: readonly string[];
}

/**
 * Read the headings and the repeated identifiers of a rendered document.
 *
 * The headings are the page's own: the navigation carries its own group
 * headings, and those are a separate landmark rather than part of the page's
 * outline.
 */
export function documentStructure(page: Page): Promise<DocumentStructure> {
  return page.evaluate(() => {
    const headings = Array.from(
      document.querySelectorAll(
        "main h1, main h2, main h3, main h4, main h5, main h6"
      )
    ).map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: (element.textContent ?? "").trim()
    }));

    const seen = new Set<string>();
    const duplicateIds: string[] = [];
    for (const element of Array.from(document.querySelectorAll("[id]"))) {
      const id = element.getAttribute("id") ?? "";
      if (id.length === 0) continue;
      if (seen.has(id)) {
        duplicateIds.push(id);
      }
      seen.add(id);
    }

    return { headings, duplicateIds };
  });
}

/**
 * A piece of content that does not fit the box holding it.
 */
export interface ClippedContent {
  /** What the element is, so the finding can be found in the source. */
  readonly description: string;
  /** How much wider the content is than the box that holds it. */
  readonly overflowPx: number;
}

/**
 * The content a page holds that its own box cannot show.
 *
 * Five things are not a defect, and each of them is a decision rather than an
 * accident: a box that scrolls (`overflow-x: auto`) is a box that says so, a
 * truncated line (`text-overflow: ellipsis`) keeps its full text on its title,
 * a box with no width of its own is not laid out, a visually hidden label is a
 * 1px box whose content is its intrinsic width by construction, and content
 * inside a closed disclosure is not on the page at all. What is left is
 * content that is silently cut off with no way to reach it -- the failure this
 * looks for.
 *
 * The closed disclosure is the one that needed the browser's answer rather than
 * the source's. A `<details>` that is closed hides its content with
 * `content-visibility`, so the content still reports a box -- and a box whose
 * content is wider than it reads as a clip to anything that measures. The
 * operator cannot see any of it: the disclosure is closed, and opening it
 * re-lays it out. `checkVisibility()` is the question the source cannot answer
 * and the browser can: is this content rendered at all?
 *
 * A form control's own value is not that. An `<input>` reports its value's
 * width as its scroll width, so a filled field narrower than its value reads
 * here as a 23px clip -- but the field is the operator's own editable value:
 * focusing it scrolls the value into view and selecting it takes the whole of
 * it, and the text is not layout that the page is hiding. A `<select>` and a
 * `<textarea>` already scroll, so they never reach this check at all.
 */
export function clippedContent(page: Page): Promise<readonly ClippedContent[]> {
  return page.evaluate(() => {
    const findings: Array<{ description: string; overflowPx: number }> = [];
    for (const element of Array.from(document.querySelectorAll("main *"))) {
      const style = globalThis.getComputedStyle(element);
      if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
      if (style.textOverflow === "ellipsis") continue;
      if (element.clientWidth === 0) continue;
      if (element.tagName === "INPUT") continue;
      // Content inside a closed disclosure is not rendered, so it cannot be
      // read as cut off: nobody is looking at it, and opening the disclosure
      // lays it out again.
      if (!element.checkVisibility()) continue;
      // A visually hidden label is a 1px box; its content is wider than it by
      // definition and always has been.
      const box = element.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      const overflowPx = element.scrollWidth - element.clientWidth;
      if (overflowPx <= 1) continue;
      const classes = element.getAttribute("class") ?? "";
      findings.push({
        description: `${element.tagName.toLowerCase()}${classes.length === 0 ? "" : `.${classes.split(" ").filter(Boolean).slice(0, 4).join(".")}`}`,
        overflowPx
      });
    }
    return findings;
  });
}

/**
 * How much of the page's own heading its box cannot show.
 *
 * The heading is the one piece of the page that says which page it is, and it
 * is drawn in the header rather than in the body, so the sweep that looks for
 * clipped content never sees it. It is also the one piece that has to be
 * readable without a pointer: a phone has no hover, so a heading that only
 * exists in a tooltip is a heading nobody on a phone can read.
 */
export function headingClipping(page: Page): Promise<number> {
  return page.evaluate(() => {
    const heading = document.querySelector("h1");
    if (heading === null) return 0;
    return Math.max(0, heading.scrollWidth - heading.clientWidth);
  });
}

/**
 * One stat card of a page, addressed by its title.
 *
 * The cards are definition lists, so the title is the term and the value and
 * the subtitle belong to the same list. Addressing the card by its term
 * keeps an assertion about the card rather than about a number, which
 * appears in several places on a page -- a sidebar badge, a filter summary
 * and a pager can all carry the same figure.
 */
export function statCard(page: Page, title: string): Locator {
  return page.locator("dl").filter({
    has: page.locator("dt").filter({ hasText: title })
  });
}

/**
 * The stat grid of a page, the row of cards above its content.
 */
export function statGrid(page: Page): Locator {
  return page.locator("[data-stat-grid]");
}
