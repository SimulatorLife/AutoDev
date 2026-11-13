"use client";

import React from "react";

import { Button } from "../../components/forms/Button.ts";
import { MUTED_BODY_CLASS } from "../../components/ui/text-classes.ts";

/**
 * What a provider reset clears, stated once for the dialog and its tests.
 */
export const PROVIDER_RESET_SCOPE =
  "Runtime provider overrides: role assignments, provider disables, model disables, and provider agent limits, reset to static-config defaults.";

/**
 * What a provider reset leaves untouched, shown beside the cleared scope.
 */
export const PROVIDER_RESET_PRESERVES =
  "It does not edit config/model-routing.json and preserves Agent admission, provider discovery snapshots, live health/cooldown, and Runtime concurrency limits.";

/**
 * The Reset to defaults control and the confirmation it opens.
 *
 * The reset is a destructive write, so the control only opens a native modal
 * dialog; nothing is posted until the operator presses the explicit confirm
 * button inside it. The native modal gives the focus containment, Escape
 * dismissal and inert background the operator relies on, and the form it
 * submits is the same same-origin route with the same `confirm` field, so the
 * route's authorization and CSRF checks are unchanged.
 */
export function ProviderResetDialog({
  returnTo
}: {
  readonly returnTo: string;
}): React.JSX.Element {
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  const open = (): void => {
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.showModal();
  };
  const close = (): void => {
    dialogRef.current?.close();
  };

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      Button,
      {
        variant: "secondary",
        testId: "provider-reset",
        ariaControls: "provider-reset-dialog",
        onClick: open
      },
      "Reset to defaults"
    ),
    React.createElement(
      "dialog",
      {
        id: "provider-reset-dialog",
        ref: dialogRef,
        "aria-labelledby": titleId,
        "aria-describedby": descriptionId,
        "data-provider-reset-dialog": "true",
        className:
          "m-auto w-[min(28rem,calc(100vw-2rem))] rounded border border-border-strong bg-surface p-4 text-fg backdrop:bg-black/50",
        // Dismissal returns the focus to the control that opened the dialog.
        onClose: () => openerRef.current?.focus(),
        // A click on the backdrop lands on the dialog element itself.
        onClick: (event: React.MouseEvent<HTMLDialogElement>) => {
          if (event.target === event.currentTarget) close();
        }
      },
      React.createElement(
        "form",
        {
          action: "/api/providers/reset",
          method: "post",
          className: "flex flex-col gap-3",
          "data-provider-reset-form": "true"
        },
        React.createElement("input", {
          type: "hidden",
          name: "returnTo",
          value: returnTo
        }),
        React.createElement("input", {
          type: "hidden",
          name: "confirm",
          value: "true"
        }),
        React.createElement(
          "h2",
          { id: titleId, className: "text-base font-semibold" },
          "Reset provider settings to defaults?"
        ),
        React.createElement(
          "p",
          { id: descriptionId, className: "text-sm" },
          "This clears " + PROVIDER_RESET_SCOPE
        ),
        React.createElement(
          "p",
          { className: MUTED_BODY_CLASS },
          PROVIDER_RESET_PRESERVES
        ),
        React.createElement(
          "div",
          { className: "flex justify-end gap-2" },
          React.createElement(
            Button,
            {
              variant: "secondary",
              testId: "provider-reset-cancel",
              onClick: close
            },
            "Cancel"
          ),
          React.createElement(
            Button,
            {
              type: "submit",
              variant: "destructive",
              testId: "provider-reset-confirm"
            },
            "Reset provider settings"
          )
        )
      )
    )
  );
}
