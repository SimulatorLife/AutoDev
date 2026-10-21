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

test("resource navigation does not prefetch the destination it is about to route to", () => {
  // A pointer, touch or keyboard intent on a link used to warm the
  // destination with `router.prefetch`, so that the dashboard did not start a
  // request for every visible resource when it opened. The warm-up cost the
  // navigation it was meant to help: a prefetch of a dynamic route carries
  // the loading state rather than the page, the router can join that partial
  // answer when the navigation starts, and the navigation then waits for a
  // payload that was never going to arrive. The browser acceptance measured
  // it -- the server answered the navigation request in sixteen milliseconds
  // with a complete response, and the Console stayed where it was.
  //
  // Nothing is lost by dropping it: every Console route is rendered for the
  // visit, so a cached answer would have been thrown away, and the request
  // the prefetch saved is one the page has to make anyway.
  assert.match(navigationLinkSource, /prefetch:\s*false/u);
  assert.doesNotMatch(navigationLinkSource, /router\.prefetch\s*\(/u);
  assert.doesNotMatch(navigationLinkSource, /useRouter\s*\(/u);
  assert.doesNotMatch(navigationLinkSource, /navigationIntentHandlers\s*\(/u);
  // The link holds no hook and no event handler, so it is not a client
  // boundary. `next/link` is a client component on its own.
  assert.doesNotMatch(navigationLinkSource, /^\s*(["'])use client\1/mu);
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
