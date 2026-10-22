import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const appNavSource = readFileSync(
  new URL("../src/components/navigation/AppNav.ts", import.meta.url),
  "utf8"
);
const tabsSource = readFileSync(
  new URL("../src/components/tabs/Tabs.ts", import.meta.url),
  "utf8"
);
const navigationLinkSource = readFileSync(
  new URL("../src/components/navigation/NavigationLink.ts", import.meta.url),
  "utf8"
);
const wholePageNavigationSource = readFileSync(
  new URL(
    "../src/components/navigation/whole-page-navigation.ts",
    import.meta.url
  ),
  "utf8"
);

test("resource navigation uses Next links instead of full-document anchors", () => {
  assert.match(
    appNavSource,
    /React\.createElement\(\s*NavigationLink,\s*brandLinkProps/u
  );
  assert.match(
    appNavSource,
    /React\.createElement\(\s*NavigationLink,\s*labelProps/u
  );
  assert.doesNotMatch(appNavSource, /React\.createElement\(\s*["']a["']/u);
});

test("view tabs use Next links while retaining URL-addressable tab state", () => {
  assert.match(tabsSource, /import \{ NavigationLink \}/u);
  assert.match(tabsSource, /React\.createElement\(NavigationLink, linkProps/u);
  assert.doesNotMatch(tabsSource, /React\.createElement\(\s*["']a["']/u);
  assert.match(tabsSource, /tabHref\(basePath, tab\.id, tabParam\)/u);
});

test("resource navigation warms the destination it is about to route to, in full", () => {
  // A pointer, touch or keyboard intent on a link warms the destination with
  // the whole page, so that the dashboard does not start a request for every
  // visible resource when it opens.
  //
  // The warm-up has to be a *full* prefetch. A partial prefetch answers with
  // the route's loading state rather than with the page; the navigation then
  // finds that answer waiting for it, applies the loading state, and waits for
  // a page that is never going to arrive. The browser acceptance measured it --
  // the server answered the navigation request in sixteen milliseconds with a
  // complete response, and the Console stayed where it was.
  //
  // Nothing is lost by the warm-up being full: every Console route is rendered
  // for the visit, so a partial answer would have been thrown away, and the
  // request the prefetch saves is one the page has to make anyway.
  assert.match(navigationLinkSource, /prefetch:\s*false/u);
  assert.match(
    navigationLinkSource,
    /warmUpWholePage\(\s*router,\s*destination\s*\)/u,
    "the warm-up has to ask for the destination's whole page"
  );
  assert.match(
    wholePageNavigationSource,
    /router\.prefetch\(href\)/u,
    "the whole-page owner asks for the page Next.js prefetches by default"
  );
  assert.doesNotMatch(
    wholePageNavigationSource,
    /kind:\s*["']auto["']/u,
    "the warm-up must never ask for a partial answer"
  );
  assert.match(navigationLinkSource, /navigationIntentHandlers\s*\(/u);
  // The warm-up is authorized by a pointer, touch or keyboard intent only, so
  // that opening a page does not start a request for every visible resource.
  assert.match(
    navigationLinkSource,
    /onMouseEnter:\s*onIntent,\s*onTouchStart:\s*onIntent,\s*onFocus:\s*onIntent/u
  );
});

test("a click navigates only once the destination's whole page has arrived", () => {
  // The warm-up is an intent, and an intent is not guaranteed: a pointer that
  // is already over the link when the operator clicks never enters it, and a
  // keyboard activation never enters it. So the click asks for the whole page
  // too.
  //
  // And the click does not navigate straight away. A navigation that dispatches
  // before the answer is in hand is the one that strands: the browser
  // acceptance measured that the address bar stayed where it was and the page
  // did not move, while the same navigation with the answer already in hand
  // committed every time. The owner waits for the answer, and then navigates.
  assert.match(navigationLinkSource, /onClick:\s*handleClick/u);
  assert.match(
    navigationLinkSource,
    /navigateToWholePage\(\s*router,\s*destination,\s*"push"/u,
    "the click has to navigate through the whole-page owner"
  );
  assert.match(
    navigationLinkSource,
    /event\.preventDefault\(\)/u,
    "the Console owns the navigation, so Next's own handler must not also run"
  );
  assert.match(
    wholePageNavigationSource,
    /await waitForWholePageAnswer\(\s*href,\s*since,\s*token/u,
    "the navigation has to wait for the answer before it leaves"
  );
  assert.match(
    wholePageNavigationSource,
    /router\.push\(href/u,
    "the owner navigates in place once the answer is in hand"
  );
});

const rootLayoutSource = readFileSync(
  new URL("../app/layout.tsx", import.meta.url),
  "utf8"
);
const internalNavigationSources = [
  ["Breadcrumbs", "../src/components/navigation/Breadcrumbs.ts"],
  ["Chips", "../src/components/tables/Chips.ts"],
  ["Pagination", "../src/components/navigation/Pagination.ts"],
  ["ClosePanelLink", "../src/components/navigation/ClosePanelLink.ts"],
  ["AgentsView", "../src/features/agents/AgentsView.ts"],
  ["ProvidersView", "../src/features/providers/ProvidersView.ts"],
  ["ProviderDetailView", "../src/features/providers/ProviderDetailView.ts"],
  ["ModelDetailView", "../src/features/providers/ModelDetailView.ts"],
  ["McpsView", "../src/features/mcps/McpsView.ts"],
  ["PromptsView", "../src/features/prompts/PromptsView.ts"],
  ["ToolDetailView", "../src/features/tools/ToolDetailView.ts"],
  ["WorkspacesView", "../src/features/workspaces/WorkspacesView.ts"],
  ["MemoryRecordsView", "../src/features/memory/MemoryRecordsView.ts"],
  ["MemoryExperiencesView", "../src/features/memory/MemoryExperiencesView.ts"],
  ["EvaluationsView", "../src/features/evaluations/EvaluationsView.ts"],
  ["UsageView", "../src/features/usage/UsageView.ts"]
].map(([name, path]) => ({
  name: name!,
  source: readFileSync(new URL(path!, import.meta.url), "utf8")
}));

const promptDetailSource = readFileSync(
  new URL("../src/features/prompts/PromptDetailView.ts", import.meta.url),
  "utf8"
);

test("same-origin resource links route in place through NavigationLink", () => {
  for (const { name, source } of internalNavigationSources) {
    assert.match(
      source,
      /NavigationLink/u,
      `${name} must use the shared Next Link wrapper for internal destinations`
    );
    assert.doesNotMatch(
      source,
      /React\.createElement\(\s*["']a["']/u,
      `${name} must not create a raw anchor for in-app routes`
    );
  }
  assert.match(
    promptDetailSource,
    /NavigationLink/u,
    "PromptDetailView must use NavigationLink for internal routes"
  );
});

test("same-origin forms are intercepted from the persistent root layout", () => {
  assert.match(rootLayoutSource, /React\.createElement\(FormNavigationOwner/u);
});
