import React from "react";

import {
  providerCliVersionLabel,
  type ProviderCliVersionView
} from "./provider-cli-version.ts";

/**
 * The version of the CLI that serves a provider.
 *
 * The version is a small fact, and it is shown as small text: the number
 * matters when an operator is comparing it with a release note, and it is
 * not worth a column of the table to say so. It sits under the provider's
 * name, where the eye looking for "which version is this provider on"
 * already is.
 *
 * The reason a version is missing is kept in the title rather than in the
 * text: "not installed" and "not read" are different problems, and the full
 * sentence belongs beside the row rather than inside it.
 */
export function ProviderCliVersionText({
  view
}: {
  readonly view: ProviderCliVersionView;
}): React.JSX.Element {
  return React.createElement(
    "span",
    {
      className: "text-xs text-fg-secondary tabular-nums",
      "data-provider-cli-version": view.status,
      title: providerCliVersionTitle(view)
    },
    providerCliVersionLabel(view)
  );
}

/** Why the version reads the way it does, in one sentence. */
export function providerCliVersionTitle(view: ProviderCliVersionView): string {
  switch (view.status) {
    case "observed": {
      return `${view.command} ${view.version}, observed ${view.observedAt}.`;
    }
    case "not-installed": {
      return view.reason;
    }
    case "not-readable": {
      return view.reason;
    }
    default: {
      return view.reason;
    }
  }
}
