import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { navigationIntentHandlers } from "../src/components/navigation/NavigationLink.ts";

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

test("dynamic route prefetch is limited to pointer, touch, or keyboard intent", () => {
  assert.match(navigationLinkSource, /useState\(false\)/u);
  assert.match(navigationLinkSource, /prefetch: prefetchOnIntent/u);
  assert.match(
    navigationLinkSource,
    /\.\.\.navigationIntentHandlers\(prefetch\)/u
  );
  let intentCount = 0;
  const handlers = navigationIntentHandlers(() => {
    intentCount += 1;
  });
  handlers.onMouseEnter();
  handlers.onTouchStart();
  handlers.onFocus();
  assert.equal(intentCount, 3);
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
  ["WorkspacesView", "../src/features/workspaces/WorkspacesView.ts"],
  ["MemoryRecordsView", "../src/features/memory/MemoryRecordsView.ts"],
  ["EvaluationsView", "../src/features/evaluations/EvaluationsView.ts"],
  ["UsageView", "../src/features/usage/UsageView.ts"]
].map(([name, path]) => ({
  name: name!,
  source: readFileSync(new URL(path!, import.meta.url), "utf8")
}));

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
});

test("same-origin forms are intercepted from the persistent root layout", () => {
  assert.match(rootLayoutSource, /React\.createElement\(FormNavigationOwner/u);
});
