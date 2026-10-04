import React from "react";

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
}

export interface TabNavProps {
  /** Accessible label for the surrounding `<nav>` landmark. */
  readonly navLabel: string;
  /** Route path the tab links are relative to, e.g. `/mcps/playwright`. */
  readonly basePath: string;
  readonly tabs: readonly TabDefinition[];
  readonly activeTabId: string;
  /** Query parameter name carrying the active tab id. Defaults to `tab`. */
  readonly tabParam?: string;
  /** Optional URL builder when a page must preserve additional query state. */
  readonly hrefFor?: ((tabId: string) => string) | undefined;
}

const DEFAULT_TAB_PARAM = "tab";

/**
 * Builds a deterministic, server-addressable URL for a tab: `basePath?tab=id`.
 */
export function tabHref(
  basePath: string,
  tabId: string,
  tabParam: string = DEFAULT_TAB_PARAM
): string {
  return `${basePath}?${encodeURIComponent(tabParam)}=${encodeURIComponent(tabId)}`;
}

/**
 * Resolves the active tab id from a raw (possibly missing or invalid) query
 * value. Any value that does not match a known tab id falls back to
 * `fallbackTabId` so an unknown/missing `?tab=` never renders a blank or
 * mismatched panel.
 */
export function resolveActiveTabId(
  tabs: readonly TabDefinition[],
  requestedTabId: string | undefined,
  fallbackTabId: string
): string {
  if (
    requestedTabId !== undefined &&
    tabs.some((tab) => tab.id === requestedTabId)
  ) {
    return requestedTabId;
  }
  return fallbackTabId;
}

/**
 * Shared, server-rendered tab navigation primitive.
 *
 * Renders a real `<nav>` landmark containing native `<a href>` links, one
 * per tab, with `aria-current="page"` marking the active tab. There is no
 * client-side hydration or state: navigating between tabs is a normal
 * full-URL navigation (`?tab=<id>`), so every tab is independently
 * addressable, bookmarkable, and shareable.
 *
 * This intentionally does NOT use the ARIA `tablist`/`tab`/`tabpanel` widget
 * roles, because those roles carry a contract of arrow-key roving-tabindex
 * interaction that this primitive does not implement. Using plain link
 * semantics keeps the navigation correctly operable by keyboard and screen
 * reader users without an unmet ARIA contract.
 */
export function TabNav({
  navLabel,
  basePath,
  tabs,
  activeTabId,
  tabParam = DEFAULT_TAB_PARAM,
  hrefFor
}: TabNavProps): React.JSX.Element {
  return React.createElement(
    "nav",
    {
      "aria-label": navLabel,
      className: "flex flex-wrap gap-1 border-b border-slate-800"
    },
    React.createElement(
      "ul",
      { className: "flex flex-wrap gap-1 list-none p-0 m-0" },
      ...tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return React.createElement(
          "li",
          { key: tab.id },
          React.createElement(
            "a",
            {
              href: hrefFor
                ? hrefFor(tab.id)
                : tabHref(basePath, tab.id, tabParam),
              "aria-current": isActive ? "page" : undefined,
              "data-tab-item": tab.id,
              className: `inline-block px-4 py-2.5 text-sm font-medium border-b-2 transition-colors no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 ${
                isActive
                  ? "border-emerald-400 text-emerald-300 bg-slate-900/40"
                  : "border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700"
              }`
            },
            tab.label
          )
        );
      })
    )
  );
}
