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
 * Wait until the page's own content has replaced its loading shell.
 *
 * The Console streams a page: the shell and its loading state arrive first
 * and the resource's own content is swapped in afterwards. Measuring the
 * shell would measure the placeholder rather than the page.
 */
export async function waitForPageContent(page: Page): Promise<void> {
  await expect(page.locator("[data-feature]").first()).toBeVisible();
  await expect(page.locator("[data-console-loading]")).toHaveCount(0);
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
  {
    path: "/tools/mcp__lsp__lsp_goto_definition",
    section: "tools",
    heading: "Tools"
  }
];

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
 * Four things are not a defect, and each of them is a decision rather than an
 * accident: a box that scrolls (`overflow-x: auto`) is a box that says so, a
 * truncated line (`text-overflow: ellipsis`) keeps its full text on its title,
 * a box with no width of its own is not laid out, and a visually hidden label
 * is a 1px box whose content is its intrinsic width by construction. What is
 * left is content that is silently cut off with no way to reach it -- the
 * failure this looks for.
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
