import type { ControlApiProviderLinks } from "@simulatorlife/autodev-core";
import React from "react";

import { ACTION_LINK_CLASS } from "../../components/ui/text-classes.ts";

const LINK_LABELS: Readonly<
  Record<
    keyof ControlApiProviderLinks,
    { readonly text: string; readonly noun: string }
  >
> = {
  usage: { text: "Usage", noun: "usage page" },
  documentation: { text: "Docs", noun: "documentation" }
};

/**
 * The provider's own external Usage and Documentation pages, as the Runtime
 * reports them from the routing config. The Console owns no URL list: a
 * provider without a configured page simply has no link for it.
 */
export function ProviderExternalLinks({
  provider,
  links
}: {
  readonly provider: string;
  readonly links: ControlApiProviderLinks;
}): React.JSX.Element | null {
  const entries = (
    Object.keys(LINK_LABELS) as (keyof ControlApiProviderLinks)[]
  ).flatMap((kind) => {
    const href = links[kind];
    return href === null ? [] : [{ kind, href }];
  });
  if (entries.length === 0) return null;
  return React.createElement(
    "span",
    {
      className: "flex flex-wrap items-center gap-x-2 text-xs",
      "data-provider-links": provider
    },
    ...entries.map(({ kind, href }) =>
      React.createElement(
        "a",
        {
          key: kind,
          href,
          target: "_blank",
          rel: "noopener noreferrer",
          className: ACTION_LINK_CLASS,
          "data-provider-link": kind,
          "aria-label": `Open ${provider} ${LINK_LABELS[kind].noun} in a new tab`
        },
        `${LINK_LABELS[kind].text} ↗`
      )
    )
  );
}
