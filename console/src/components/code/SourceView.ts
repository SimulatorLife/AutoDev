"use client";

import React, { useState } from "react";

import { Button } from "../forms/Button.ts";
import { CodeBlock } from "./CodeBlock.ts";

/** Two views of one already loaded source revision; no fetch or mutation. */
export function SourceView({
  source,
  format,
  rendered
}: {
  readonly source: string;
  readonly format: "JSONC" | "Source" | "TOML";
  readonly rendered: React.ReactNode;
}): React.JSX.Element {
  const [raw, setRaw] = useState(false);
  return React.createElement(
    "div",
    { className: "flex flex-col gap-3", "data-source-view": raw ? "source" : "rendered" },
    React.createElement(
      "div",
      { role: "group", "aria-label": "Source representation", className: "flex flex-wrap gap-1" },
      ...[false, true].map((value) =>
        React.createElement(
          Button,
          {
            key: String(value),
            type: "button",
            variant: raw === value ? "secondary" : "quiet",
            dataAttributes: { "aria-pressed": String(raw === value) },
            onClick: () => setRaw(value)
          },
          value ? format : "Rendered"
        )
      )
    ),
    raw
      ? React.createElement(CodeBlock, {
          content: source,
          height: "primary",
          ariaLabel: "Canonical source"
        })
      : React.createElement("div", { "data-source-rendered": "true" }, rendered)
  );
}
