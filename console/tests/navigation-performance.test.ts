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
