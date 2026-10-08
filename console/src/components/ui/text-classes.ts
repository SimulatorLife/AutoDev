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
/**
 * `MONO_ID` is the only one of the three that carries a weight, and it is
 * spelled `font-semibold`. It was `text-semibold`, which is not a Tailwind
 * class at all -- the font-weight scale is `font-*` -- so it emitted no rule and
 * the identifier rendered at whatever weight it inherited, across all five call
 * sites. The weight is what separates this role from its two siblings: they are
 * de-emphasised by colour (`text-fg-secondary`, `text-fg-muted`) where this one
 * is the row's subject at `text-fg`, and without the weight the three differed
 * only in greyness.
 */
export const MONO_ID_CLASS = "font-mono font-semibold text-fg";

export const MONO_VALUE_CLASS = "font-mono text-xs text-fg-secondary";

export const MONO_META_CLASS = "font-mono text-xs text-fg-muted";

/**
 * The row's identifier as the link that opens it.
 *
 * `MONO_ID_CLASS` plus the two things that make it a link rather than a label:
 * it occupies its own block so `truncate` applies, and it changes colour on
 * hover so it reads as clickable. The list views for tools and MCP servers
 * carried the whole eight-token string spelled out, which meant the definition
 * of "the thing you click to open a row" lived in whichever file was edited
 * last.
 *
 * Built from `MONO_ID_CLASS` rather than restated, because it is the same role:
 * the identifier is the row's subject on `/permissions` and `/workspaces` too,
 * where it is not a link. The extra tokens conflict with nothing in the base --
 * display, overflow, and a hover colour beside font family, weight, and colour.
 */
/**
 * The Console's link treatment for a named entity — a provider, model, agent,
 * prompt or server an operator can open.
 *
 * This is the same interactive role everywhere it appears: the thing in a cell
 * that leads to that thing's own page. It had two live treatments. `/agents` and
 * `/prompts` signalled the link by underlining on hover; `/mcps` and `/tools`
 * signalled it by shifting to the accent colour; `/github`'s provider summary
 * had already done both. So the same gesture meant three different things
 * depending on which page the operator had come from.
 *
 * Both signals, not a choice between them: the underline is the one that works
 * without perceiving the hue shift, and the colour is what ties the link to the
 * rest of the Console's accent vocabulary. `Chip` has carried exactly this pair
 * all along, which is what settled it.
 *
 * Callers compose this with whatever typeface and size the surrounding column
 * uses — a mono identifier in a dense table, the body face where the name is
 * also prose. What they do not do is choose their own hover.
 */
export const ENTITY_LINK_CLASS =
  "underline-offset-4 hover:text-accent hover:underline";

export const MONO_ID_LINK_CLASS =
  // `min-h-6` for the same reason `Chip` carries it on its anchor: this class is
  // only ever a link, so the target-size floor belongs to it rather than to
  // `MONO_ID_CLASS`, which the non-link `/permissions` and `/workspaces` rows
  // share. As composed the link was 20px tall -- 18px of line box and a 1px
  // border each side -- against a 24px minimum, with adjacent rows close enough
  // that the spacing exception did not cover it. The row is already far taller
  // than 24px, so nothing on the page moves.
  `${MONO_ID_CLASS} block min-h-6 truncate ${ENTITY_LINK_CLASS}`;
