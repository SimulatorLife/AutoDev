/**
The Tools catalogue's public surface.

The catalogue is one feature with one address, so it has one entrypoint:
the list page and the detail page render its views and ask it what the
address says, and nothing outside the feature reaches past it into the
modules that hold the rules. The address itself, the filter matching and
the usage-evidence derivation stay inside the feature, because a caller
that rebuilds any of them is a second authority for a fact the catalogue
already owns.

What leaves the feature is what a page needs to answer its own question:
the two views the pages render, the panel the detail page mounts as a
browser-side island, the reader that turns a query string into filters,
and the lookup that turns a URL id back into the catalogue entry it
addresses.
*/

export * from "./tool-identity.ts";
export * from "./ToolDetailView.ts";
export * from "./tools-list-filters.ts";
export * from "./ToolsView.ts";
export * from "./ToolUsagePanel.ts";
