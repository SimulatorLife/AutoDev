/**
 * Console panel system.
 *
 * The Console's content sits in bordered, elevated surface boxes. Which box a
 * region uses depends on what the region contains, not on which view it happens
 * to live in, so those choices are named here rather than retyped at each call
 * site. The feature views had accumulated 17 spellings of the same three boxes
 * between them — including one that wrote the identical classes in a different
 * order, which reads as drift to anyone comparing two pages.
 *
 * The shape and the surface colour are exported separately on purpose. Tailwind
 * resolves two utilities that set the same property by their order in the
 * generated stylesheet, not by their order in the class attribute, so a caller
 * cannot write `` `${DETAIL_PANEL_CLASS} bg-error/10` `` and expect the tint to
 * win — the composed `bg-surface` does. A caller that needs a severity tint
 * must start from `DETAIL_PANEL_SHAPE`, which carries no colour to conflict
 * with.
 */

const PANEL_SHAPE = "rounded-lg border shadow";

/**
 * A detail panel's box without its surface colour — the starting point for a
 * panel whose severity is not the default, such as the failure shell every route
 * renders when a resource cannot be loaded.
 */
export const DETAIL_PANEL_SHAPE = `${PANEL_SHAPE} p-6`;

/**
 * A detail page's primary panel. Holds field groups and other roomy content,
 * so it carries the most padding.
 */
export const DETAIL_PANEL_CLASS = `${DETAIL_PANEL_SHAPE} border-border bg-surface`;

/**
 * A list page's primary panel. Wraps a dense table, which brings its own row
 * rhythm, so the box stays a little tighter than a detail panel.
 */
export const LIST_PANEL_CLASS = `${PANEL_SHAPE} p-5 border-border bg-surface`;

/**
 * A box inside another panel. It has no shadow of its own: stacking an
 * elevation shadow inside an already elevated panel produces two competing
 * edges and reads as a mistake rather than as nesting.
 */
export const NESTED_PANEL_CLASS =
  "rounded-lg border border-border bg-surface p-5";

/**
 * The box a filter bar sits in. Denser than a list panel because it holds one
 * row of controls rather than a table: the row needs to stay a row, and the
 * padding around it should not push it toward wrapping earlier than its
 * contents require.
 */
export const FILTER_PANEL_CLASS = `${PANEL_SHAPE} p-4 border-border bg-surface`;
