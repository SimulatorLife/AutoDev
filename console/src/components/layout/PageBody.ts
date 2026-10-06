import React from "react";

/**
 * A page's vertical rhythm: the gap between its top-level sections.
 *
 * Every view's root -- or, for a tabbed resource, each tab panel -- is a column
 * of sections at the same spacing, and it was written out by hand twenty-one
 * times. That is the target state's "a small number of consistent page
 * templates" reduced to one repeated `className`, and it is the spacing decision
 * most likely to be adjusted across the product: changing it in twenty-one
 * places means twenty-one chances to miss one, and a page whose sections sit
 * closer together than its neighbour's reads as a different product.
 *
 * `gap-6` rather than something tighter because the sections are bordered
 * panels, not a paragraph flow: the panel's own border and padding carry the
 * separation, and a smaller gap makes a stack of boxes read as one box.
 */
export const PAGE_SECTION_STACK_CLASS = "flex flex-col gap-6";

export interface PageBodyProps {
  /**
   * The resource this page renders, written to `data-feature`. It is the page's
   * stable hook for tests and browser assertions, so it belongs to the template
   * rather than being retyped beside it.
   */
  readonly feature: string;
  /**
   * Additional facts the page publishes beside its identity — whether a count
   * was observed, which coverage tier applies. Most pages publish one or two;
   * they are evidence hooks, not layout, so they stay with the page rather than
   * becoming parameters of the template.
   */
  readonly attributes?: Readonly<Record<string, string>> | undefined;
  readonly children?: React.ReactNode;
  /**
   * Element to render. `div` by default; the MCP detail page uses `article`,
   * which is the only page whose body is a self-contained account of one
   * resource rather than a list of panels. The rhythm is the same either way,
   * which is the point of routing both through here.
   */
  readonly as?: "div" | "article" | "section" | undefined;
  /**
   * Extra classes for the rare page that needs to shift itself -- a panel that
   * has to clear a sticky header, for instance. The rhythm itself is not
   * overridable: that is the whole point of owning it.
   */
  readonly className?: string | undefined;
}

/**
 * The body of a Console page: its sections, stacked at the shared rhythm.
 */
export function PageBody({
  feature,
  attributes,
  children,
  as = "div",
  className
}: PageBodyProps): React.JSX.Element {
  return React.createElement(
    as,
    {
      className: `${PAGE_SECTION_STACK_CLASS}${className === undefined ? "" : ` ${className}`}`,
      "data-feature": feature,
      ...attributes
    },
    children
  );
}
