import React from "react";

/**
 * A single breadcrumb trail item. Items with an `href` render as native
 * anchor links; items without an `href` render as non-link spans. The last
 * entry in the trail is treated as the current page and additionally
 * receives `aria-current="page"` so assistive tech identifies it as the
 * present location without offering a stale self-link.
 */
export interface BreadcrumbItem {
  /** Visible text for the item. */
  readonly label: string;
  /**
   * Destination URL for ancestor items. Omit to render the item as a
   * non-link span (for example, on the current page or when an ancestor
   * has no canonical destination yet). The component never falls back to a
   * placeholder `href="#"`.
   */
  readonly href?: string;
}

export interface BreadcrumbsProps {
  /**
   * Ordered list of ancestor items followed by the current page item. The
   * last entry is treated as the current page; only its `label` is required.
   */
  readonly items: readonly [BreadcrumbItem, ...BreadcrumbItem[]];
  /** Accessible label override for the surrounding `<nav>`. Defaults to "Breadcrumb". */
  readonly ariaLabel?: string | undefined;
}

/**
 * Both item shapes truncate. A breadcrumb label is a canonical identifier and
 * can be one long unbreakable token, so the trail has to ellipsize inside its
 * container rather than push the page sideways; `title` keeps the full label
 * reachable on hover and the text stays selectable for copy.
 */
const ITEM_LINK_CLASS =
  "min-w-0 truncate rounded-sm text-accent hover:brightness-110 hover:underline";
const ITEM_PLAIN_CLASS = "min-w-0 truncate rounded-sm text-fg font-medium";
const SEPARATOR_CLASS = "mx-2 select-none text-fg-muted";

/**
 * Server-renderable breadcrumbs landmark.
 *
 * Renders a single `<nav aria-label="Breadcrumb"><ol>...</ol></nav>` with
 * ancestor items that carry an `href` rendered as native `<a href>` links
 * (visible keyboard focus state, no client-side routing required) and any
 * ancestor without an `href` rendered as a non-link span. The final item is
 * always the current page, rendered as a non-link `<span aria-current="page">`.
 * The trail starts with the supplied ancestors and always ends on the current
 * page; no synthetic "Home" entry is added and no placeholder `href="#"` is
 * ever emitted.
 */
export function Breadcrumbs({
  items,
  ariaLabel
}: BreadcrumbsProps): React.JSX.Element {
  const navLabel = ariaLabel ?? "Breadcrumb";
  const lastIndex = items.length - 1;

  return React.createElement(
    "nav",
    {
      "aria-label": navLabel,
      // `min-w-0` so the trail can shrink inside a flex column, and
      // `max-w-full` so it is bounded by its container rather than by its
      // longest label.
      className: "min-w-0 max-w-full text-xs"
    },
    React.createElement(
      "ol",
      {
        className:
          "flex min-w-0 max-w-full flex-wrap items-center list-none p-0 m-0"
      },
      ...items.map((item, index) => {
        const isCurrent = index === lastIndex;
        return React.createElement(
          "li",
          {
            key: `${item.label}-${index}`,
            className: "flex min-w-0 max-w-full items-center"
          },
          renderItem(item, isCurrent),
          isCurrent
            ? null
            : React.createElement(
                "span",
                {
                  "aria-hidden": "true",
                  className: SEPARATOR_CLASS
                },
                "/"
              )
        );
      })
    )
  );
}

function renderItem(
  item: BreadcrumbItem,
  isCurrent: boolean
): React.JSX.Element {
  if (isCurrent) {
    return React.createElement(
      "span",
      {
        "aria-current": "page",
        className: ITEM_PLAIN_CLASS,
        title: item.label
      },
      item.label
    );
  }
  if (item.href) {
    return React.createElement(
      "a",
      {
        href: item.href,
        className: ITEM_LINK_CLASS,
        title: item.label
      },
      item.label
    );
  }
  return React.createElement(
    "span",
    { className: ITEM_PLAIN_CLASS, title: item.label },
    item.label
  );
}
