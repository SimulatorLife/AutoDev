/**
 * The one owner of the Console's shared text treatments.
 *
 * Each of these four strings was being written out across the feature views --
 * 15, 27, 7 and 6 times respectively -- and the two most common had already been
 * pulled into module constants twice, under different names, in different files:
 * `FG_MUTED_TEXT_CLASS` in the tool detail view and `STATUS_HELP_CLASS` in the
 * MCP detail view, both equal to `text-xs text-fg-muted`. Three names for one
 * literal is the shape of the problem. A caller needing muted small text either
 * retyped it or guessed which local name to reuse, so one grey caption ended up
 * written a dozen ways and no reader could tell which of them was canonical.
 *
 * The names are by role rather than by size, because the role is what a caller
 * actually knows before reaching for a style: MUTED_TEXT is the colour alone,
 * MUTED_META is a small caption under a value, MUTED_BODY is a muted sentence,
 * and SECTION_LABEL is the uppercase heading above a group.
 *
 * This is deliberately type treatment only. Colour lives in the semantic theme
 * in `app/globals.css`, and spacing and layout belong with the primitives in
 * `components/`, so a caller that needs a different weight, colour or truncation
 * still writes those inline next to one of these rather than gaining a constant
 * nobody else needed.
 */
export const MUTED_TEXT_CLASS = "text-fg-muted";

export const MUTED_META_CLASS = "text-xs text-fg-muted";

export const MUTED_BODY_CLASS = "text-sm text-fg-muted";

export const SECTION_LABEL_CLASS =
  "text-xs uppercase tracking-wider text-fg-muted";

/**
 * The monospace family.
 *
 * Most of the Console's values are canonical names rather than prose -- an
 * agent role, a model id, a revision, a path, a cardinality -- and those want
 * a different treatment from the muted copy above. They were unowned while the
 * four non-monospace treatments were consolidated, so they accumulated their
 * own drift: the caption existed as both `font-mono text-xs text-fg-muted` and
 * `text-xs text-fg-muted font-mono` in three views each, which reads as two
 * deliberate treatments rather than one written twice.
 *
 * Named by role, following the same convention as above:
 *
 * - `MONO_ID` is the row's primary identifier -- the thing the row *is*.
 * - `MONO_VALUE` is a machine value inside a cell that has a label elsewhere:
 *   a duration, a cardinality, a model id.
 * - `MONO_META` is the monospace sibling of `MUTED_META`: a de-emphasised
 *   caption such as a timestamp or a path.
 *
 * Token order is fixed and identical across all three. It does not change which
 * rule wins -- Tailwind resolves same-property utilities by stylesheet order,
 * not attribute order -- but a diff between two pages should not turn on
 * whether someone happened to type the font first.
 */
export const MONO_ID_CLASS = "font-mono text-semibold text-fg";

export const MONO_VALUE_CLASS = "font-mono text-xs text-fg-secondary";

export const MONO_META_CLASS = "font-mono text-xs text-fg-muted";
