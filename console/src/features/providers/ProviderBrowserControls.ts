import type { ControlApiProviderBrowser } from "@simulatorlife/autodev-core";
import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

/**
 * The opencli providers' Dedicated browser toggle.
 *
 * Off (the default) drives the operator's own Chrome through opencli's Browser
 * Bridge extension, in its "OpenCLI" tab group. On drives an AutoDev-owned
 * Chrome for Testing with its own profile, so agents never switch tabs in the
 * Chrome the operator is using. One setting covers every opencli provider.
 *
 * The row states the current value and its one button applies the opposite.
 * The button is the shared secondary `Button`: switching browsers is a
 * submission, and neither value is a warning -- the operator's own Chrome is a
 * normal way to run, not a degraded one. The page that renders after the
 * redirect shows the Runtime-confirmed value; nothing is applied
 * optimistically.
 */
export function ProviderBrowserControls({
  provider,
  browser,
  returnTo
}: {
  readonly provider: string;
  readonly browser: ControlApiProviderBrowser;
  readonly returnTo: string;
}): React.JSX.Element {
  const stateLabel = browser.dedicated ? "On" : "Off";
  const actionLabel = browser.dedicated ? "Turn off" : "Turn on";
  return React.createElement(
    "div",
    { className: "flex flex-col gap-2" },
    React.createElement(
      "form",
      {
        role: "group",
        method: "POST",
        action: `/api/providers/${encodeURIComponent(provider)}/browser`,
        className: "inline-flex items-center gap-3",
        "data-provider-browser-form": provider
      },
      React.createElement("input", {
        type: "hidden",
        name: "provider",
        value: provider
      }),
      React.createElement("input", {
        type: "hidden",
        name: "dedicated",
        value: String(!browser.dedicated)
      }),
      React.createElement("input", {
        type: "hidden",
        name: "returnTo",
        value: returnTo
      }),
      React.createElement(
        "span",
        {
          className: "text-sm",
          "data-provider-browser": browser.dedicated ? "dedicated" : "extension"
        },
        `Dedicated browser: ${stateLabel}`
      ),
      React.createElement(
        Button,
        {
          type: "submit",
          variant: "secondary",
          size: "compact",
          title: browser.dedicated
            ? "Switch to your own Chrome with the OpenCLI extension"
            : "Switch to the dedicated Chrome for Testing",
          testId: "provider-browser-toggle"
        },
        actionLabel
      )
    ),
    React.createElement(
      "p",
      { className: MUTED_META_CLASS },
      browser.dedicated
        ? "Turns run in a separate Chrome for Testing window with its own profile; sign in to each site there once."
        : "Turns run in your own Chrome, in the OpenCLI tab group, through the OpenCLI Browser Bridge extension."
    )
  );
}
