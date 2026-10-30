/**
 * The marker for text the Console quotes rather than renders.
 *
 * The Console renders values in its own words and its own forms: a moment is
 * a date with its clock and its zone, a state is a word, a count is a number
 * the page can vouch for. It also shows, in a handful of places, the machine's
 * own record -- the bytes a service recorded, the token it stored, the line
 * it wrote. That text is quoted, not rendered: it is shown as it was
 * recorded, because a record the Console reformatted is no longer the record.
 *
 * A recorded value can therefore hold a moment in the wire's spelling, and
 * that is not the Console answering "when did this happen" in a second
 * voice. The two are different acts, and a check that reads the rendered
 * text cannot tell them apart unless the page says which one it is showing.
 *
 * The marker is how the page says so. A region carrying it holds the
 * service's own words; the Console's checks leave it alone, and the operator
 * still sees it in the page's own form everywhere else.
 */
export const VERBATIM_DATA_ATTRIBUTE = "data-verbatim" as const;

/** The value that marks a region as the service's own words. */
export const VERBATIM_DATA_VALUE = "true" as const;
