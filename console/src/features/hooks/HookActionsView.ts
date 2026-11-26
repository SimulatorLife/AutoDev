import type { HookAction } from "@simulatorlife/autodev-core";
import React from "react";

import { CodeBlock } from "../../components/code/CodeBlock.ts";
import { DetailGrid, DetailValue } from "../../components/panels/DetailGrid.ts";
import { MUTED_META_CLASS } from "../../components/ui/text-classes.ts";

/** The same declared action representation on the list and detail pages. */
export function HookActionsView({
  actions
}: {
  readonly actions: readonly HookAction[];
}): React.JSX.Element {
  if (actions.length === 0) {
    return React.createElement("p", { className: MUTED_META_CLASS }, "No hook actions configured.");
  }
  return React.createElement(
    "ol",
    { className: "flex flex-col gap-3", "aria-label": "Declared hook actions" },
    actions.map((action, index) =>
      React.createElement(
        "li",
        { key: index, className: "flex flex-col gap-2" },
        React.createElement(
          DetailGrid,
          { columns: 2 },
          React.createElement(DetailValue, { label: "Matcher" }, action.matcher ?? "*"),
          React.createElement(DetailValue, { label: "Status message" }, action.statusMessage ?? "Not specified")
        ),
        React.createElement(CodeBlock, { content: action.command, ariaLabel: "Hook command", height: "auto" })
      )
    )
  );
}
