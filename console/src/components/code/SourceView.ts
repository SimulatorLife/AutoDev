"use client";

import React, { useState } from "react";

import { Button } from "../forms/Button.ts";
import { CodeBlock } from "./CodeBlock.ts";
import { MUTED_TEXT_CLASS } from "../ui/text-classes.ts";

/**
 * Two views of one already loaded source revision; no fetch or mutation.
 *
 * `source` is null when the canonical source was not read. The rendered view
 * still answers the question the page asks -- the values the source states --
 * and the raw view says that there is no source to show rather than opening an
 * empty document, so "not observed" is never rendered as "empty".
 */
export function SourceView({
  source,
  format,
  rendered
}: {
  readonly source: string | null;
  readonly format: "JSONC" | "Source" | "TOML";
  readonly rendered: React.ReactNode;
}): React.JSX.Element {
  const [raw, setRaw] = useState(false);
  return React.createElement(
    "div",
    {
      className: "flex flex-col gap-3",
      "data-source-view": raw ? "source" : "rendered"
    },
    React.createElement(
      "div",
      {
        role: "group",
        "aria-label": "Source representation",
        className: "flex flex-wrap gap-1"
      },
      ...[false, true].map((value) =>
        React.createElement(
          Button,
          {
            key: String(value),
            type: "button",
            variant: raw === value ? "secondary" : "quiet",
            // A source that was not read has no raw view to open, so the
            // control that would open it is disabled rather than answering
            // with an empty document.
            disabled: value && source === null,
            dataAttributes: { "aria-pressed": String(raw === value) },
            onClick: () => setRaw(value)
          },
          value ? format : "Rendered"
        )
      )
    ),
    raw
      ? source === null
        ? React.createElement(
            "p",
            {
              className: MUTED_TEXT_CLASS,
              role: "status",
              "data-source-unavailable": "true"
            },
            "The canonical source was not read."
          )
        : React.createElement(CodeBlock, {
            content: source,
            height: "primary",
            ariaLabel: "Canonical source"
          })
      : React.createElement("div", { "data-source-rendered": "true" }, rendered)
  );
}
