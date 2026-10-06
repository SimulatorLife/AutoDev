/**
 * Console panel system.
 *
 * The Console's content sits in bordered, elevated surface boxes. Which box a
 * region uses depends on what the region contains, not on which view it happens
 * to live in, so those choices are named here rather than retyped at each call
 * site. The feature views had accumulated 17 spellings of the same three boxes
 * between them — including one that wrote the identical classes in a different
 * order, which reads as drift to anyone comparing two pages.
 */

/**
 * A detail page's primary panel. Holds field groups and other roomy content,
 * so it carries the most padding.
 */
export const DETAIL_PANEL_CLASS =
  "rounded-lg border border-border bg-surface p-6 shadow";

/**
 * A list page's primary panel. Wraps a dense table, which brings its own row
 * rhythm, so the box stays a little tighter than a detail panel.
 */
export const LIST_PANEL_CLASS =
  "rounded-lg border border-border bg-surface p-5 shadow";

/**
 * A box inside another panel. It has no shadow of its own: stacking an
 * elevation shadow inside an already elevated panel produces two competing
 * edges and reads as a mistake rather than as nesting.
 */
export const NESTED_PANEL_CLASS =
  "rounded-lg border border-border bg-surface p-5";
